import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";

async function setup(options: { isRejected?: (candidate: { id: string; title: string }) => Promise<boolean> } = {}) {
  const storage = new Storage115Simulator({
    packs: {
      old_pack: { files: [{ path: "Show - 13 [CR 1080p].mkv", sizeBytes: 1_400_000_000 }, { path: "Show - 24 [CR 1080p].mkv", sizeBytes: 1_400_000_000 }] },
      cand_new13: { files: [{ path: "[Nekomoe] Show - 13 [1080p].mkv", sizeBytes: 1_100_000_000 }] },
      cand_cr13: { files: [{ path: "Show - 13 [CR 1080p].mkv", sizeBytes: 1_400_000_000 }] },
    },
  });
  const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
  const season = await storage.createDirectory({ name: "Season 01", parentId: "root" });
  // The simulator has no seeding API: land the "old" episodes straight into the season
  // dir — exactly how an earlier run would have left them.
  await storage.transferCandidate({ candidateId: "old_pack", intoDirectoryId: season });
  const oldFiles = await storage.listTree({ directoryId: season });
  const old13 = oldFiles.find((f) => f.path.includes("13"))!.id;
  const old24 = oldFiles.find((f) => f.path.includes("24"))!.id;
  const rejected: unknown[] = [];
  const results: unknown[] = [];
  const sandbox = new TaskSandbox({
    provider: new FakeResourceProviderV2({
      results: {
        Show: [
          { id: "cand_new13", title: "[Nekomoe] Show 13 1080p" },
          { id: "cand_cr13", title: "Show 13 [CR 1080p]" },
        ],
      },
    }),
    storage, stagingDirectoryId: staging, targetSeasonDirectoryIds: { 1: season }, need: [],
    replace: {
      requestedEpisodes: ["S01E13", "S01E24"],
      onReject: async (items) => { rejected.push(...items); },
      onReport: async (r) => { results.push(...r); },
      isRejected: options.isRejected ?? (async () => false),
    },
  });
  await sandbox.captureProtectedFiles();
  return { sandbox, storage, season, staging, rejected, results, old13, old24, oldPaths: oldFiles.map((f) => f.path) };
}

describe("TaskSandbox — replace", () => {
  it("rejectCurrentSource records name+size of files that are really in the season, and adds the episodes to the need", async () => {
    const { sandbox, rejected, old13, oldPaths } = await setup();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    const path13 = oldPaths.find((p) => p.includes("13"))!; // the pack may nest files in a wrapper dir
    expect(rejected).toEqual([{ episode: "S01E13", label: "Show - 13 [CR 1080p].mkv", sizeBytes: 1_400_000_000, reason: "发蓝", path: `Season 01/${path13}` }]);
    expect(sandbox.needed()).toContain("S01E13");
    await expect(sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: ["nope"], reason: "x" })).rejects.toThrow(/NOT_IN_TARGET/);
  });

  it("rejectCurrentSource needs at least one current file, and refuses outside a replace run", async () => {
    const { sandbox } = await setup();
    await expect(sandbox.rejectCurrentSource({ episodes: ["S01E99"], fileIds: [], reason: "x" })).rejects.toThrow(/NO_FILES/);
    expect(sandbox.needed()).not.toContain("S01E99");
    const plain = new TaskSandbox({ provider: new FakeResourceProviderV2() });
    expect(plain.hasReplace()).toBe(false);
    await expect(plain.rejectCurrentSource({ episodes: [], fileIds: ["x"], reason: "x" })).rejects.toThrow(/NO_REPLACE/);
    await expect(plain.reportReplacement({ results: [] })).rejects.toThrow(/NO_REPLACE/);
  });

  it("files that existed before the run can never be deleted", async () => {
    const { sandbox, old13 } = await setup();
    await expect(sandbox.deleteFiles({ directory: "season", season: 1, fileIds: [old13] })).rejects.toThrow(/PROTECTED/);
  });

  it("reportReplacement: replaced needs a mark AND a succeeded transfer; not_found passes through; missing episodes default to not_found", async () => {
    const { sandbox, results, old13 } = await setup();
    await sandbox.searchResources("Show");
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", note: "换好了" }] }),
    ).rejects.toThrow(/NOT_MARKED/);
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    // FakeResourceProviderV2 ids are passed through as-is (no alias layer): use its own ids.
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    await sandbox.markObtained({ codes: ["S01E13"] });
    await sandbox.reportReplacement({
      results: [
        { episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", note: "喵萌版" },
        { episode: "S01E24", outcome: "not_found", note: "只有同一份 CR" },
      ],
    });
    expect(results).toMatchObject([
      { episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", note: "喵萌版" },
      { episode: "S01E24", outcome: "not_found", note: "只有同一份 CR" },
    ]);
  });

  it("reportReplacement refuses a replaced episode whose candidate never landed this run", async () => {
    const { sandbox } = await setup();
    await sandbox.markObtained({ codes: ["S01E13"] });
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", note: "x" }] }),
    ).rejects.toThrow(/NO_TRANSFER/);
  });

  it("finalizeReplacement reports every requested episode the agent never reported as not_found", async () => {
    const { sandbox, results } = await setup();
    await sandbox.finalizeReplacement();
    expect(results).toMatchObject([
      { episode: "S01E13", outcome: "not_found" },
      { episode: "S01E24", outcome: "not_found" },
    ]);
  });

  it("finalizeReplacement also covers an episode the agent rejected (read from the user's words) but never reported", async () => {
    const { sandbox, results, old24 } = await setup();
    // S01E24 is requested; the agent also rejects its file under an episode it read
    // from the message text (S01E25 has no tag) and then reports nothing.
    await sandbox.rejectCurrentSource({ episodes: ["S01E25"], fileIds: [old24], reason: "音画不同步" });
    await sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "not_found", note: "没找到" }] });
    await sandbox.finalizeReplacement();
    expect(results).toMatchObject([
      { episode: "S01E13", outcome: "not_found", note: "没找到" },
      { episode: "S01E24", outcome: "not_found" },
      { episode: "S01E25", outcome: "not_found" },
    ]);
  });

  it("transferCandidate refuses a candidate the user rejected, and proceeds when it is not rejected", async () => {
    const seen: Array<{ id: string; title: string }> = [];
    const { sandbox } = await setup({
      isRejected: async (candidate) => {
        seen.push(candidate);
        return candidate.id === "cand_cr13";
      },
    });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_cr13" })).rejects.toThrow(
      /SANDBOX_CANDIDATE_REJECTED/,
    );
    expect(seen).toContainEqual({ id: "cand_cr13", title: "Show 13 [CR 1080p]" });
    const ok = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    expect(ok.attempt.status).toBe("succeeded");
  });
});

describe("TaskSandbox — replace (movie: the movie dir is also staging)", () => {
  async function movieSetup(isRejected: (candidate: { id: string; title: string }) => Promise<boolean> = async () => false) {
    const storage = new Storage115Simulator({
      packs: {
        old_film: {
          files: [
            { path: "Film.2023.1080p.WEB.mkv", sizeBytes: 4_000 },
            { path: "Film.2023.1080p.WEB.srt", sizeBytes: 10 },
            { path: "extras/poster.jpg", sizeBytes: 5 },
          ],
        },
        rej_share: { files: [{ path: "Film.2023.1080p.WEB.mkv", sizeBytes: 4_000 }] },
        good_share: { files: [{ path: "Film (2023)/Film.2023.2160p.REMUX.mkv", sizeBytes: 9_000 }] },
      },
      linkKinds: { rej_share: "share", good_share: "share" },
    });
    const movieDir = await storage.createDirectory({ name: "Film (2023)", parentId: "root" });
    await storage.transferCandidate({ candidateId: "old_film", intoDirectoryId: movieDir });
    const old = await storage.listTree({ directoryId: movieDir });
    const results: unknown[] = [];
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({
        results: { film: [{ id: "rej_share", title: "Film 2023 1080p WEB" }, { id: "good_share", title: "Film 2023 2160p REMUX" }] },
      }),
      storage,
      stagingDirectoryId: movieDir,
      targetMovieDirectoryId: movieDir,
      need: ["MOVIE"],
      replace: {
        requestedEpisodes: ["MOVIE"],
        onReject: async () => {},
        onReport: async (r) => { results.push(...r); },
        isRejected,
      },
    });
    await sandbox.captureProtectedFiles();
    return { sandbox, storage, movieDir, old, results };
  }

  it("the old film cannot be moved, renamed or deleted even though it sits in staging", async () => {
    const { sandbox, old } = await movieSetup();
    const video = old.find((f) => f.isVideo)!;
    const sub = old.find((f) => f.isSubtitle)!;
    await expect(sandbox.moveToSeason({ moves: [{ fileIds: [video.id] }] })).rejects.toThrow(/PROTECTED/);
    await expect(sandbox.deleteFiles({ directory: "staging", fileIds: [video.id] })).rejects.toThrow(/PROTECTED/);
    const renamed = await sandbox.renameSubtitle({ renames: [{ fileId: sub.id, newName: "Other.srt" }] });
    expect(renamed.renamed).toEqual([]);
    expect(renamed.errors?.[0]?.error).toMatch(/PROTECTED/);
  });

  it("flattenMovie lifts the new film out of its wrapper but leaves every old file where it was", async () => {
    const { sandbox, storage, movieDir, old } = await movieSetup();
    await sandbox.searchResources("film");
    await sandbox.transferUntilLanded({ candidateIds: ["good_share"] });
    const { movie } = await sandbox.flattenMovie();
    for (const file of old) expect(movie).toContainEqual(expect.objectContaining({ id: file.id, path: file.path }));
    expect(movie.some((f) => f.path === "Film.2023.2160p.REMUX.mkv")).toBe(true);
    expect((await storage.listTree({ directoryId: movieDir })).length).toBe(old.length + 1);
  });

  it("transferUntilLanded skips a rejected candidate (recorded as a failed attempt) and lands the next one", async () => {
    const { sandbox } = await movieSetup(async (candidate) => candidate.id === "rej_share");
    await sandbox.searchResources("film");
    const result = await sandbox.transferUntilLanded({ candidateIds: ["rej_share", "good_share"] });
    expect(result.attempts).toEqual([
      { candidateId: "rej_share", status: "failed", providerMessage: "user rejected" },
      { candidateId: "good_share", status: "succeeded" },
    ]);
    expect(result.transferredCandidateId).toBe("good_share");
  });

  it("a succeeded transferUntilLanded candidate counts as landed for reportReplacement", async () => {
    const { sandbox, results } = await movieSetup();
    await sandbox.searchResources("film");
    await sandbox.transferUntilLanded({ candidateIds: ["good_share"] });
    await sandbox.markObtained({ codes: ["MOVIE"] });
    await sandbox.reportReplacement({ results: [{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", note: "4K REMUX" }] });
    expect(results).toMatchObject([{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share" }]);
  });
});
