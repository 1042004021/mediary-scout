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
});

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
