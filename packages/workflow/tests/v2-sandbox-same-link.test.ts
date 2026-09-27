import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator, type StorageV2 } from "../src/acquisition-v2/storage-115-simulator.js";

/**
 * One PanSou link shows up under two titles. The agent never sees the url, so
 * nothing but a link identity on the sandbox can stop the second transfer.
 */
const SAME = "pan123:same";

async function tvSandbox(options: {
  ids: string[];
  linkOf: (candidateId: string) => string | null;
  packs?: Record<string, { files: Array<{ path: string; sizeBytes: number }> }>;
  failureMessages?: Record<string, string>;
}) {
  const provider = new FakeResourceProviderV2({
    results: { show: options.ids.map((id) => ({ id, title: `title ${id}` })) },
  });
  const storage = new Storage115Simulator({
    ...(options.packs ? { packs: options.packs } : {}),
    ...(options.failureMessages ? { failureMessages: options.failureMessages } : {}),
  });
  const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
  const season = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId: staging,
    targetSeasonDirectoryIds: { 1: season },
    need: ["S01E01"],
    linkOf: options.linkOf,
  });
  const snapshotId = (await sandbox.searchResources("show")).snapshot!.id;
  return { sandbox, snapshotId };
}

async function movieSandbox(options: {
  ids: string[];
  linkOf: (candidateId: string) => string | null;
  packs?: Record<string, { files: Array<{ path: string; sizeBytes: number }> }>;
  linkKinds: Record<string, "share" | "magnet">;
  failureMessages?: Record<string, string>;
}) {
  const provider = new FakeResourceProviderV2({
    results: { film: options.ids.map((id) => ({ id, title: `title ${id}` })) },
  });
  const storage = new Storage115Simulator({
    ...(options.packs ? { packs: options.packs } : {}),
    linkKinds: options.linkKinds,
    ...(options.failureMessages ? { failureMessages: options.failureMessages } : {}),
  });
  const movieDir = await storage.createDirectory({ name: "Film (2026)", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId: movieDir,
    targetMovieDirectoryId: movieDir,
    need: ["MOVIE"],
    linkOf: options.linkOf,
  });
  await sandbox.searchResources("film");
  return { sandbox };
}

const oneFile = (name: string) => ({ files: [{ path: name, sizeBytes: 1 }] });

describe("TaskSandbox — same link is not transferred twice in one run", () => {
  it("refuses transferCandidate when an earlier transfer of that link already landed files", async () => {
    const { sandbox, snapshotId } = await tvSandbox({
      ids: ["a", "b"],
      linkOf: (id) => (id === "a" || id === "b" ? SAME : null),
      packs: { a: oneFile("a.mkv"), b: oneFile("b.mkv") },
    });
    await sandbox.transferCandidate({ snapshotId, candidateId: "a" });

    await expect(sandbox.transferCandidate({ snapshotId, candidateId: "b" })).rejects.toThrow(
      /^SANDBOX_SAME_LINK: b is the same link as a, whose files already landed this run — inspect them instead of transferring again/,
    );
  });

  it("allows the second candidate when the first transfer of that link landed nothing", async () => {
    const { sandbox, snapshotId } = await tvSandbox({
      ids: ["dead", "live"],
      linkOf: (id) => (id === "dead" || id === "live" ? SAME : null),
      packs: { live: oneFile("live.mkv") },
      failureMessages: { dead: "链接已过期" },
    });
    const first = await sandbox.transferCandidate({ snapshotId, candidateId: "dead" });
    expect(first.attempt.materializedFileIds).toEqual([]);

    const second = await sandbox.transferCandidate({ snapshotId, candidateId: "live" });
    expect(second.attempt.status).toBe("succeeded");
    expect(second.attempt.materializedFileIds.length).toBeGreaterThan(0);
  });

  it("allows a candidate whose link is different", async () => {
    const { sandbox, snapshotId } = await tvSandbox({
      ids: ["a", "b"],
      linkOf: (id) => `link:${id}`,
      packs: { a: oneFile("a.mkv"), b: oneFile("b.mkv") },
    });
    await sandbox.transferCandidate({ snapshotId, candidateId: "a" });

    const second = await sandbox.transferCandidate({ snapshotId, candidateId: "b" });
    expect(second.attempt.status).toBe("succeeded");
  });

  it("transferUntilLanded skips a same-link candidate and continues with the rest", async () => {
    const { sandbox } = await movieSandbox({
      ids: ["a", "b", "c"],
      linkOf: (id) => (id === "c" ? "pan123:other" : SAME),
      packs: { a: oneFile("a.mkv"), c: oneFile("c.mkv") },
      linkKinds: { a: "share", b: "share", c: "share" },
    });
    await sandbox.transferCandidate({ snapshotId: (await sandbox.searchResources("film")).snapshot!.id, candidateId: "a" });

    const result = await sandbox.transferUntilLanded({ candidateIds: ["b", "c"] });

    expect(result.attempts).toEqual([
      { candidateId: "b", status: "failed", providerMessage: "same link as a already landed this run" },
      { candidateId: "c", status: "succeeded" },
    ]);
    expect(result.transferredCandidateId).toBe("c");
  });

  it("transferUntilLanded does not skip a link whose earlier attempt landed nothing", async () => {
    const { sandbox } = await movieSandbox({
      ids: ["dead", "live"],
      linkOf: () => SAME,
      packs: { live: oneFile("live.mkv") },
      linkKinds: { dead: "share", live: "share" },
      failureMessages: { dead: "链接已过期" },
    });

    const result = await sandbox.transferUntilLanded({ candidateIds: ["dead", "live"] });

    expect(result.attempts[0]).toMatchObject({ candidateId: "dead", status: "failed" });
    expect(result.attempts[0]!.providerMessage).not.toMatch(/same link/);
    expect(result.transferredCandidateId).toBe("live");
  });

  it("a succeeded transfer that materialized no file does not block transferCandidate", async () => {
    const { sandbox, snapshotId, transferred } = await emptySuccessSandbox("tv");
    const first = await sandbox.transferCandidate({ snapshotId, candidateId: "a" });
    expect(first.attempt).toMatchObject({ status: "succeeded", materializedFileIds: [] });

    const second = await sandbox.transferCandidate({ snapshotId, candidateId: "b" });
    expect(second.attempt.status).toBe("succeeded");
    expect(transferred).toEqual(["a", "b"]);
  });

  it("a succeeded transfer that materialized no file does not block transferUntilLanded", async () => {
    const { sandbox, transferred } = await emptySuccessSandbox("movie");
    const first = await sandbox.transferUntilLanded({ candidateIds: ["a"] });
    expect(first.transferredCandidateId).toBe("a");
    expect(first.attempts[0]).toMatchObject({ status: "succeeded" });

    const second = await sandbox.transferUntilLanded({ candidateIds: ["b"] });
    expect(second.attempts).toEqual([{ candidateId: "b", status: "succeeded" }]);
    expect(second.transferredCandidateId).toBe("b");
    expect(transferred).toEqual(["a", "b"]);
  });

  it("reserves the link before the transfer await, so two concurrent transferCandidate calls hit storage once", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const { sandbox, snapshotId } = await aliasedSandbox({
      ids: ["a", "b"],
      kind: "tv",
      transferCandidate: async (input) => {
        calls.push(input.candidateId);
        await gate.promise;
        return { status: "succeeded", materializedFileIds: [`${input.candidateId}-file`] };
      },
    });
    const pending = Promise.allSettled([
      sandbox.transferCandidate({ snapshotId, candidateId: "a" }),
      sandbox.transferCandidate({ snapshotId, candidateId: "b" }),
    ]);
    expect(calls).toEqual(["a"]);
    gate.resolve();
    const [first, second] = await pending;
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(String((second as PromiseRejectedResult).reason)).toBe(
      "Error: SANDBOX_SAME_LINK: b is the same link as a, which is being transferred right now — wait for that result and inspect it instead of transferring again",
    );
  });

  it("a transferUntilLanded that overlaps an in-flight transferCandidate of the same link does not transfer", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const { sandbox, snapshotId } = await aliasedSandbox({
      ids: ["a", "b"],
      kind: "movie",
      transferCandidate: async (input) => {
        calls.push(input.candidateId);
        if (input.candidateId !== "a") return { status: "succeeded", materializedFileIds: ["b-file"] };
        await gate.promise;
        return { status: "succeeded", materializedFileIds: ["a-file"] };
      },
    });
    const inflight = sandbox.transferCandidate({ snapshotId, candidateId: "a" });
    const until = await sandbox.transferUntilLanded({ candidateIds: ["b"] });
    expect(calls).toEqual(["a"]);
    expect(until.attempts).toEqual([
      {
        candidateId: "b",
        status: "failed",
        providerMessage:
          "same link as a, which is being transferred right now — wait for that result and inspect it instead of transferring again",
      },
    ]);
    gate.resolve();
    await inflight;
  });

  it("releases the reservation when the in-flight transfer materializes nothing, so a later alias transfers", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const { sandbox, snapshotId } = await aliasedSandbox({
      ids: ["a", "b", "c"],
      kind: "tv",
      transferCandidate: async (input) => {
        calls.push(input.candidateId);
        if (input.candidateId === "a") {
          await gate.promise;
          return { status: "succeeded", materializedFileIds: [] };
        }
        return { status: "succeeded", materializedFileIds: ["c-file"] };
      },
    });
    const inflight = sandbox.transferCandidate({ snapshotId, candidateId: "a" });
    await expect(sandbox.transferCandidate({ snapshotId, candidateId: "b" })).rejects.toThrow(
      /SANDBOX_SAME_LINK: b is the same link as a, which is being transferred right now/,
    );
    gate.resolve();
    await inflight;
    const later = await sandbox.transferCandidate({ snapshotId, candidateId: "c" });
    expect(later.attempt.materializedFileIds).toEqual(["c-file"]);
    expect(calls).toEqual(["a", "c"]);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function aliasedSandbox(options: {
  ids: string[];
  kind: "tv" | "movie";
  transferCandidate: StorageV2["transferCandidate"];
}): Promise<{ sandbox: TaskSandbox; snapshotId: string }> {
  const storage: StorageV2 = {
    async createDirectory() {
      return "dir";
    },
    transferCandidate: options.transferCandidate,
    candidateLinkKind: () => "share",
    async listTree() {
      return [];
    },
    async listSubdirectories() {
      return [];
    },
    async moveFiles() {
      return { moved: [] };
    },
    async renameFile() {},
    async deleteFiles() {
      return { deleted: [] };
    },
    async removeDirectory() {
      return { removed: [] };
    },
    async transferSubtitleUrls() {
      return [];
    },
  };
  const sandbox = new TaskSandbox({
    provider: new FakeResourceProviderV2({
      results: { show: options.ids.map((id) => ({ id, title: id })) },
    }),
    storage,
    stagingDirectoryId: "staging",
    ...(options.kind === "movie" ? { targetMovieDirectoryId: "staging" } : { targetSeasonDirectoryIds: { 1: "season" } }),
    need: options.kind === "movie" ? ["MOVIE"] : ["S01E01"],
    linkOf: () => SAME,
  });
  const snapshotId = (await sandbox.searchResources("show")).snapshot!.id;
  return { sandbox, snapshotId };
}

/** A returns succeeded with nothing materialized — the status flag without files. */
async function emptySuccessSandbox(kind: "tv" | "movie"): Promise<{ sandbox: TaskSandbox; snapshotId: string; transferred: string[] }> {
  const transferred: string[] = [];
  const storage: StorageV2 = {
    async createDirectory() {
      return "dir";
    },
    async transferCandidate(input) {
      transferred.push(input.candidateId);
      if (input.candidateId === "a") return { status: "succeeded", materializedFileIds: [] };
      return { status: "succeeded", materializedFileIds: ["b-file"] };
    },
    candidateLinkKind: () => "share",
    async listTree() {
      return [];
    },
    async listSubdirectories() {
      return [];
    },
    async moveFiles() {
      return { moved: [] };
    },
    async renameFile() {},
    async deleteFiles() {
      return { deleted: [] };
    },
    async removeDirectory() {
      return { removed: [] };
    },
    async transferSubtitleUrls() {
      return [];
    },
  };
  const provider = new FakeResourceProviderV2({
    results: { show: [{ id: "a", title: "A" }, { id: "b", title: "B" }] },
  });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId: "staging",
    ...(kind === "movie" ? { targetMovieDirectoryId: "staging" } : { targetSeasonDirectoryIds: { 1: "season" } }),
    need: kind === "movie" ? ["MOVIE"] : ["S01E01"],
    linkOf: () => SAME,
  });
  const snapshotId = (await sandbox.searchResources("show")).snapshot!.id;
  return { sandbox, transferred, snapshotId };
}
