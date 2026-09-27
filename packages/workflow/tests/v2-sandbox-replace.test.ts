import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { RealResourceProviderV2 } from "../src/acquisition-v2/real-provider-adapter.js";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";

async function setup(
  options: { isRejected?: (candidate: { id: string; title: string }) => Promise<boolean>; alreadyRejectedEpisodes?: string[] } = {},
) {
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
      // Stored rejections are only passed on a pending-only re-check (no message), as in the orchestrator.
      hasMessages: options.alreadyRejectedEpisodes === undefined,
      // The message (when there is one) names its episodes.
      untaggedMessages: 0,
      ...(options.alreadyRejectedEpisodes ? { alreadyRejectedEpisodes: options.alreadyRejectedEpisodes } : {}),
      onReject: async (items) => { rejected.push(...items); },
      onReport: async (r) => { results.push(...r); },
    },
    ...(options.isRejected ? { isRejected: options.isRejected } : {}),
  });
  await sandbox.captureProtectedFiles();
  /** Rejects the current file of the requested episode the test is not about, so the
   *  reject-before-transfer gate (every requested episode) opens. */
  const rejectE24 = () => sandbox.rejectCurrentSource({ episodes: ["S01E24"], fileIds: [old24], reason: "发蓝" });
  return { sandbox, storage, season, staging, rejected, results, old13, old24, rejectE24, oldPaths: oldFiles.map((f) => f.path) };
}

describe("TaskSandbox — replace", () => {
  it("rejectCurrentSource records name+size of files that are really in the season, and adds the episodes to the need", async () => {
    const { sandbox, rejected, old13, oldPaths } = await setup();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    const path13 = oldPaths.find((p) => p.includes("13"))!; // the pack may nest files in a wrapper dir
    expect(rejected).toEqual([{ episode: "S01E13", label: "Show - 13 [CR 1080p].mkv", sizeBytes: 1_400_000_000, reason: "发蓝", path: `Season 01/${path13}` }]);
    expect((await sandbox.finish()).missing).toContain("S01E13");
    await expect(sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: ["nope"], reason: "x" })).rejects.toThrow(/NOT_IN_TARGET/);
  });

  it("rejectCurrentSource needs at least one current file, and refuses outside a replace run", async () => {
    const { sandbox } = await setup();
    // No episodes and no files: nothing to act on. (Episodes with fileIds [] is the
    // no-old-file declaration — see the reject-before-transfer tests.)
    await expect(sandbox.rejectCurrentSource({ episodes: [], fileIds: [], reason: "x" })).rejects.toThrow(/NO_FILES/);
    const plain = new TaskSandbox({ provider: new FakeResourceProviderV2() });
    expect(plain.hasReplace()).toBe(false);
    await expect(plain.rejectCurrentSource({ episodes: [], fileIds: ["x"], reason: "x" })).rejects.toThrow(/NO_REPLACE/);
    await expect(plain.reportReplacement({ results: [] })).rejects.toThrow(/NO_REPLACE/);
  });

  it("rejectCurrentSource on a TV run needs episode codes in this run's seasons", async () => {
    const { sandbox, old13 } = await setup();
    await expect(sandbox.rejectCurrentSource({ episodes: [], fileIds: [old13], reason: "x" })).rejects.toThrow(
      /SANDBOX_EPISODES_REQUIRED/,
    );
    for (const bad of ["MOVIE", "13", "S1E13", "S02E13"]) {
      await expect(sandbox.rejectCurrentSource({ episodes: [bad], fileIds: [old13], reason: "x" })).rejects.toThrow(
        `SANDBOX_EPISODE_OUT_OF_SCOPE: ${bad}`,
      );
    }
    expect((await sandbox.finish()).missing).toEqual([]);
  });

  it("rejectCurrentSource refuses a file that landed during this run (only pre-run files), without re-listing the season", async () => {
    const { sandbox, storage, season, old13 } = await setup();
    await storage.transferCandidate({ candidateId: "cand_new13", intoDirectoryId: season });
    const landed = (await storage.listTree({ directoryId: season })).find((f) => f.path.includes("Nekomoe"))!.id;
    await expect(sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [landed], reason: "x" })).rejects.toThrow(
      /SANDBOX_FILES_NOT_IN_TARGET/,
    );
    // The pre-run map is the source of truth: no listTree call at reject time.
    let listed = 0;
    const listTree = storage.listTree.bind(storage);
    storage.listTree = async (input) => { listed += 1; return listTree(input); };
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    expect(listed).toBe(0);
  });

  it("reportReplacement validates episode codes and only accepts requested or rejected episodes", async () => {
    const { sandbox, results, old24 } = await setup();
    await expect(sandbox.reportReplacement({ results: [{ episode: "S02E01", outcome: "not_found", note: "" }] })).rejects.toThrow(
      /SANDBOX_EPISODE_OUT_OF_SCOPE/,
    );
    await expect(sandbox.reportReplacement({ results: [{ episode: "S01E25", outcome: "not_found", note: "" }] })).rejects.toThrow(
      /SANDBOX_EPISODE_NOT_REQUESTED/,
    );
    await sandbox.rejectCurrentSource({ episodes: ["S01E25"], fileIds: [old24], reason: "x" });
    await sandbox.reportReplacement({ results: [{ episode: "S01E25", outcome: "not_found", note: "没找到" }] });
    expect(results).toMatchObject([{ episode: "S01E25", outcome: "not_found" }]);
  });

  it("reportReplacement: conflicting outcomes in one call are refused; same-outcome duplicates keep the first", async () => {
    const { sandbox, results } = await setup();
    await expect(
      sandbox.reportReplacement({
        results: [
          { episode: "S01E13", outcome: "not_found", note: "a" },
          { episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", note: "b" },
        ],
      }),
    ).rejects.toThrow(/SANDBOX_REPORT_CONFLICT/);
    expect(results).toEqual([]);
    const out = await sandbox.reportReplacement({
      results: [
        { episode: "S01E13", outcome: "not_found", note: "first" },
        { episode: "S01E13", outcome: "not_found", note: "second" },
      ],
    });
    expect(out).toEqual({ recorded: 1, ignored: [] });
    expect(results).toMatchObject([{ episode: "S01E13", outcome: "not_found", note: "first" }]);
  });

  it("reportReplacement: an earlier not_found can be upgraded to replaced; other repeats are ignored and listed", async () => {
    const { sandbox, results, old13, rejectE24 } = await setup();
    await sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "not_found", note: "还没找到" }] });
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    const out = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: out.attempt.materializedFileIds }] });
    await sandbox.markObtained({ codes: ["S01E13"] });
    const up = await sandbox.reportReplacement({
      results: [{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", fileIds: out.attempt.materializedFileIds, note: "喵萌版" }],
    });
    expect(up).toEqual({ recorded: 1, ignored: [] });
    const again = await sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "not_found", note: "x" }] });
    expect(again).toEqual({ recorded: 0, ignored: [{ episode: "S01E13", reason: "already reported replaced" }] });
    await sandbox.finalizeReplacement();
    expect(results).toMatchObject([
      { episode: "S01E13", outcome: "not_found" },
      { episode: "S01E13", outcome: "replaced", candidateId: "cand_new13" },
      { episode: "S01E24", outcome: "not_found" },
    ]);
    expect(results).toHaveLength(3);
  });

  it("markObtained of a requested or rejected episode is refused until a transfer lands this run (the old file does not count)", async () => {
    const { sandbox, old13, old24, rejectE24 } = await setup();
    await expect(sandbox.markObtained({ codes: ["S01E13"] })).rejects.toThrow(/SANDBOX_REPLACEMENT_NOT_LANDED: S01E13/);
    // Rejected (not requested) episodes are guarded too; the whole call is refused.
    await sandbox.rejectCurrentSource({ episodes: ["S01E25"], fileIds: [old24], reason: "x" });
    await expect(sandbox.markObtained({ codes: ["S01E01", "S01E25"] })).rejects.toThrow(/SANDBOX_REPLACEMENT_NOT_LANDED: S01E25/);
    expect((await sandbox.finish()).obtained).toEqual([]);
    // An episode nobody asked about can still be marked.
    await sandbox.markObtained({ codes: ["S01E01"] });
    // After a successful transfer the requested episode can be marked.
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "x" });
    await rejectE24();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    await expect(sandbox.markObtained({ codes: ["S01E13"] })).resolves.toEqual({ confirmed: ["S01E13"] });
  });

  it("an episode marked before it was rejected does not meet coverage (nor block a transfer) until it is reported replaced", async () => {
    const { sandbox, old13, old24, rejectE24 } = await setup();
    // Not requested yet → the mark is accepted...
    await sandbox.markObtained({ codes: ["S01E25"] });
    // ...then the agent rejects its current file: it joins the need as a guarded episode.
    await sandbox.rejectCurrentSource({ episodes: ["S01E25"], fileIds: [old24], reason: "x" });
    expect(sandbox.isCoverageMet()).toBe(false);
    expect((await sandbox.finish()).missing).toEqual(["S01E25"]);
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "x" });
    await rejectE24();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    const out = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    expect(out.attempt.status).toBe("succeeded");
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: out.attempt.materializedFileIds }] });
    // Something landed, but S01E25's mark is still its old file: it counts only once
    // reported replaced. The requested S01E13/S01E24 still need their own marks.
    expect(sandbox.isCoverageMet()).toBe(false);
    expect((await sandbox.finish()).missing).toEqual(["S01E25", "S01E13", "S01E24"]);
    await sandbox.reportReplacement({
      results: [{ episode: "S01E25", outcome: "replaced", candidateId: "cand_new13", fileIds: out.attempt.materializedFileIds, note: "x" }],
    });
    expect((await sandbox.finish()).missing).toEqual(["S01E13", "S01E24"]);
  });

  it("coverage is per episode: landing a genuinely missing episode does not let the requested one's old mark count", async () => {
    const storage = new Storage115Simulator({
      packs: {
        old_pack: { files: [{ path: "Show - 13 [CR 1080p].mkv", sizeBytes: 1_400_000_000 }] },
        cand_e14: { files: [{ path: "Show - 14 [CR 1080p].mkv", sizeBytes: 1_400_000_000 }] },
        cand_new13: { files: [{ path: "[Nekomoe] Show - 13 [1080p].mkv", sizeBytes: 1_100_000_000 }] },
      },
    });
    const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
    const season = await storage.createDirectory({ name: "Season 01", parentId: "root" });
    await storage.transferCandidate({ candidateId: "old_pack", intoDirectoryId: season });
    const old13 = (await storage.listTree({ directoryId: season }))[0]!.id;
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({
        results: { Show: [{ id: "cand_e14", title: "Show 14" }, { id: "cand_new13", title: "[Nekomoe] Show 13" }] },
      }),
      storage, stagingDirectoryId: staging, targetSeasonDirectoryIds: { 1: season },
      // E13 is obtained but requested; E14 is genuinely missing.
      need: ["S01E13", "S01E14"],
      replace: { requestedEpisodes: ["S01E13"], hasMessages: true, untaggedMessages: 0, onReject: async () => {}, onReport: async () => {} },
    });
    await sandbox.captureProtectedFiles();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_e14" });
    // Something landed, so the marks are accepted — but E13's is still the old file.
    await sandbox.markObtained({ codes: ["S01E13", "S01E14"] });
    expect(sandbox.isCoverageMet()).toBe(false);
    expect((await sandbox.finish()).missing).toEqual(["S01E13"]);
    // Transfers are still allowed: E13 has not been replaced.
    const out13 = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    expect(out13.attempt.status).toBe("succeeded");
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: out13.attempt.materializedFileIds }] });
    expect(sandbox.isCoverageMet()).toBe(false);
    await sandbox.reportReplacement({
      results: [{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", fileIds: out13.attempt.materializedFileIds, note: "喵萌版" }],
    });
    expect(sandbox.isCoverageMet()).toBe(true);
    expect((await sandbox.finish()).missing).toEqual([]);
  });

  it("a normal (non-replace) run marks and meets coverage without any transfer", async () => {
    const sandbox = new TaskSandbox({ provider: new FakeResourceProviderV2(), need: ["S01E13"] });
    await expect(sandbox.markObtained({ codes: ["S01E13"] })).resolves.toEqual({ confirmed: ["S01E13"] });
    expect(sandbox.isCoverageMet()).toBe(true);
  });

  it("a guarded episode leaves the sandbox obtained only once reported replaced: one declared file-less, marked after an unrelated transfer and reported not_found, does not", async () => {
    const storage = new Storage115Simulator({
      packs: {
        old_pack: { files: [{ path: "Show - 13 [CR 1080p].mkv", sizeBytes: 1_400_000_000 }] },
        cand_new13: { files: [{ path: "[Nekomoe] Show - 13 [1080p].mkv", sizeBytes: 1_100_000_000 }] },
        cand_e14: { files: [{ path: "Show - 14 [CR 1080p].mkv", sizeBytes: 1_400_000_000 }] },
      },
    });
    const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
    const season = await storage.createDirectory({ name: "Season 01", parentId: "root" });
    await storage.transferCandidate({ candidateId: "old_pack", intoDirectoryId: season });
    const old13 = (await storage.listTree({ directoryId: season }))[0]!.id;
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({
        results: { Show: [{ id: "cand_new13", title: "[Nekomoe] Show 13" }, { id: "cand_e14", title: "Show 14" }] },
      }),
      storage, stagingDirectoryId: staging, targetSeasonDirectoryIds: { 1: season },
      // E14 is a plain gap; E13 is obtained but requested.
      need: ["S01E14"],
      replace: { requestedEpisodes: ["S01E13"], hasMessages: true, untaggedMessages: 0, onReject: async () => {}, onReport: async () => {} },
    });
    await sandbox.captureProtectedFiles();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    // E24 has no file in the library: declared, not rejected — guarded all the same.
    await sandbox.rejectCurrentSource({ episodes: ["S01E24"], fileIds: [], reason: "24 集也要换" });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    const new13 = (await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).attempt.materializedFileIds;
    const e14 = (await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_e14" })).attempt.materializedFileIds;
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [...new13, ...e14] }] });
    // Any landed transfer unlocks the marks — E24's too, though nothing of E24 landed.
    await sandbox.markObtained({ codes: ["S01E13", "S01E14", "S01E24"] });
    // Not reported yet: only the plain gap leaves the sandbox obtained.
    expect((await sandbox.finish()).obtained).toEqual(["S01E14"]);
    await sandbox.reportReplacement({
      results: [
        { episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", fileIds: new13, note: "喵萌版" },
        { episode: "S01E24", outcome: "not_found", note: "没找到" },
      ],
    });
    const summary = await sandbox.finish();
    expect(summary.obtained).toEqual(["S01E13", "S01E14"]);
    expect(summary.missing).toEqual(["S01E24"]);
    // The agent's own finish tool tells the same story.
    await expect(sandbox.declareFinish()).resolves.toMatchObject({ obtained: ["S01E13", "S01E14"], missing: ["S01E24"] });
  });

  it("outside a replace run every marked code leaves the sandbox unchanged, beyond-need codes included", async () => {
    const sandbox = new TaskSandbox({ provider: new FakeResourceProviderV2(), need: ["S01E13", "S01E14"] });
    await sandbox.markObtained({ codes: ["S01E14", "S01E13", "S01E15"] });
    expect((await sandbox.finish()).obtained).toEqual(["S01E13", "S01E14", "S01E15"]);
  });

  it("files that existed before the run can never be deleted", async () => {
    const { sandbox, old13 } = await setup();
    await expect(sandbox.deleteFiles({ directory: "season", season: 1, fileIds: [old13] })).rejects.toThrow(/PROTECTED/);
  });

  it("reportReplacement: replaced needs a mark AND a succeeded transfer; not_found passes through; missing episodes default to not_found", async () => {
    const { sandbox, results, old13, rejectE24 } = await setup();
    await sandbox.searchResources("Show");
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", note: "换好了" }] }),
    ).rejects.toThrow(/NOT_MARKED/);
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    // FakeResourceProviderV2 ids are passed through as-is (no alias layer): use its own ids.
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    const out = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: out.attempt.materializedFileIds }] });
    await sandbox.markObtained({ codes: ["S01E13"] });
    await sandbox.reportReplacement({
      results: [
        { episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", fileIds: out.attempt.materializedFileIds, note: "喵萌版" },
        { episode: "S01E24", outcome: "not_found", note: "只有同一份 CR" },
      ],
    });
    expect(results).toMatchObject([
      { episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", fileIds: out.attempt.materializedFileIds, note: "喵萌版" },
      { episode: "S01E24", outcome: "not_found", note: "只有同一份 CR" },
    ]);
  });

  it("reportReplacement refuses a replaced episode whose candidate never landed this run", async () => {
    const { sandbox, old13, rejectE24 } = await setup();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    // Another candidate landed (so the mark is allowed), but not the one reported.
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    const out = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_cr13" });
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: out.attempt.materializedFileIds }] });
    await sandbox.markObtained({ codes: ["S01E13"] });
    await expect(
      sandbox.reportReplacement({
        results: [{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", fileIds: out.attempt.materializedFileIds, note: "x" }],
      }),
    ).rejects.toThrow(/NO_TRANSFER/);
  });

  it("finish (the agent's tool) is refused while a requested or rejected episode is unreported; the summary stays readable", async () => {
    const { sandbox, old24 } = await setup();
    await sandbox.rejectCurrentSource({ episodes: ["S01E25"], fileIds: [old24], reason: "x" });
    await expect(sandbox.declareFinish()).rejects.toThrow("SANDBOX_REPORT_REQUIRED: S01E13,S01E24,S01E25");
    await sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "not_found", note: "没有" }] });
    await expect(sandbox.declareFinish()).rejects.toThrow("SANDBOX_REPORT_REQUIRED: S01E24,S01E25");
    // The workflow's own end-of-run summary is never gated.
    await expect(sandbox.finish()).resolves.toMatchObject({ coverageMet: false });
    await sandbox.reportReplacement({
      results: [
        { episode: "S01E24", outcome: "not_found", note: "没有" },
        { episode: "S01E25", outcome: "not_found", note: "没有" },
      ],
    });
    await expect(sandbox.declareFinish()).resolves.toMatchObject({ coverageMet: false, missing: ["S01E25"] });
  });

  it("finish outside a replace run is the plain summary", async () => {
    const sandbox = new TaskSandbox({ provider: new FakeResourceProviderV2(), need: ["S01E13"] });
    await expect(sandbox.declareFinish()).resolves.toEqual(await sandbox.finish());
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
    const { sandbox, old13, rejectE24 } = await setup({
      isRejected: async (candidate) => {
        seen.push(candidate);
        return candidate.id === "cand_cr13";
      },
    });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_cr13" })).rejects.toThrow(
      /SANDBOX_CANDIDATE_REJECTED/,
    );
    expect(seen).toContainEqual({ id: "cand_cr13", title: "Show 13 [CR 1080p]" });
    const ok = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    expect(ok.attempt.status).toBe("succeeded");
  });
});

describe("TaskSandbox — replace: finish needs an identified episode when the run carries a message", () => {
  const NO_EPISODE_IDENTIFIED =
    "SANDBOX_NO_EPISODE_IDENTIFIED: work out from the user's words which episode(s) they mean, call rejectCurrentSource for them (fileIds [] for an episode with no file), then reportReplacement";

  /** A TV replace run on a season that holds the user's current E13. */
  async function tvRun(replace: { requestedEpisodes: string[]; hasMessages: boolean; untaggedMessages: number }) {
    const storage = new Storage115Simulator({ packs: { old_pack: { files: [{ path: "Show - 13.mkv", sizeBytes: 1 }] } } });
    const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
    const season = await storage.createDirectory({ name: "Season 01", parentId: "root" });
    await storage.transferCandidate({ candidateId: "old_pack", intoDirectoryId: season });
    const old13 = (await storage.listTree({ directoryId: season }))[0]!.id;
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2(),
      storage, stagingDirectoryId: staging, targetSeasonDirectoryIds: { 1: season }, need: [],
      replace: { ...replace, onReject: async () => {}, onReport: async () => {} },
    });
    await sandbox.captureProtectedFiles();
    return { sandbox, old13 };
  }

  it("TV, message without tags: finish is refused until an episode is identified from the words; then only the reports are required", async () => {
    // Nothing is requested up front: the message has no episode tags.
    const { sandbox } = await tvRun({ requestedEpisodes: [], hasMessages: true, untaggedMessages: 1 });
    await expect(sandbox.declareFinish()).rejects.toThrow(NO_EPISODE_IDENTIFIED);
    // The workflow's own end-of-run summary is never gated.
    await expect(sandbox.finish()).resolves.toMatchObject({ obtained: [], missing: [] });
    // The agent reads "第 5 集" from the words; there is no file of it here.
    await sandbox.rejectCurrentSource({ episodes: ["S01E05"], fileIds: [], reason: "第 5 集没字幕" });
    await expect(sandbox.declareFinish()).rejects.toThrow("SANDBOX_REPORT_REQUIRED: S01E05");
    await sandbox.reportReplacement({ results: [{ episode: "S01E05", outcome: "not_found", note: "没找到" }] });
    await expect(sandbox.declareFinish()).resolves.toMatchObject({ coverageMet: false, missing: ["S01E05"] });
  });

  it("an untagged message beside an older 待换 episode: reporting the 待换 one is not enough — finish waits for an episode identified THIS run", async () => {
    // E13 is still waiting from an earlier request; the new message names no episode.
    const { sandbox } = await tvRun({ requestedEpisodes: ["S01E13"], hasMessages: true, untaggedMessages: 1 });
    await sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "not_found", note: "还是没有" }] });
    await expect(sandbox.declareFinish()).rejects.toThrow(NO_EPISODE_IDENTIFIED);
    expect(sandbox.identifiedThisRun()).toBe(false);
    // The agent reads "第 5 集" from the new message; there is no file of it here.
    await sandbox.rejectCurrentSource({ episodes: ["S01E05"], fileIds: [], reason: "第 5 集也发蓝" });
    expect(sandbox.identifiedThisRun()).toBe(true);
    await expect(sandbox.declareFinish()).rejects.toThrow("SANDBOX_REPORT_REQUIRED: S01E05");
    await sandbox.reportReplacement({ results: [{ episode: "S01E05", outcome: "not_found", note: "没找到" }] });
    await expect(sandbox.declareFinish()).resolves.toMatchObject({ coverageMet: false });
  });

  it("any episode identified this run lifts it — rejecting the 待换 episode's current file too (which message an episode came from is the agent's call)", async () => {
    const { sandbox, old13 } = await tvRun({ requestedEpisodes: ["S01E13"], hasMessages: true, untaggedMessages: 1 });
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "还是发蓝" });
    await sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "not_found", note: "没找到" }] });
    await expect(sandbox.declareFinish()).resolves.toMatchObject({ coverageMet: false });
  });

  it("tagged messages only: reporting every requested episode is enough, nothing has to be identified from words", async () => {
    const { sandbox } = await tvRun({ requestedEpisodes: ["S01E13"], hasMessages: true, untaggedMessages: 0 });
    await sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "not_found", note: "没找到" }] });
    await expect(sandbox.declareFinish()).resolves.toMatchObject({ coverageMet: false });
    expect(sandbox.identifiedThisRun()).toBe(false);
  });

  it("a pending-only re-check (no message) is not asked to identify anything from words", async () => {
    const { sandbox } = await tvRun({ requestedEpisodes: [], hasMessages: false, untaggedMessages: 0 });
    await expect(sandbox.declareFinish()).resolves.toMatchObject({ obtained: [], missing: [] });
  });

  it("a movie message without tags requests the film itself: finish only needs MOVIE reported", async () => {
    const storage = new Storage115Simulator({ packs: {} });
    const movieDir = await storage.createDirectory({ name: "Film (2023)", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2(),
      storage, stagingDirectoryId: movieDir, targetMovieDirectoryId: movieDir, need: ["MOVIE"],
      // runQueuedReplaceRequest requests ["MOVIE"] for an untagged movie message, and the
      // orchestrator counts no untagged message on a movie run: its message means the film.
      replace: { requestedEpisodes: ["MOVIE"], hasMessages: true, untaggedMessages: 0, onReject: async () => {}, onReport: async () => {} },
    });
    await sandbox.captureProtectedFiles();
    await expect(sandbox.declareFinish()).rejects.toThrow("SANDBOX_REPORT_REQUIRED: MOVIE");
    await sandbox.reportReplacement({ results: [{ episode: "MOVIE", outcome: "not_found", note: "没有别的版本" }] });
    await expect(sandbox.declareFinish()).resolves.toMatchObject({ coverageMet: false, missing: ["MOVIE"] });
  });
});

describe("TaskSandbox — replace: reject before transfer", () => {
  it("a transfer before rejectCurrentSource is refused; after rejecting every requested episode it goes through", async () => {
    const { sandbox, storage, staging, old13, rejectE24 } = await setup();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).rejects.toThrow(/SANDBOX_REJECT_FIRST/);
    expect(await storage.listTree({ directoryId: staging })).toEqual([]);
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    const ok = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    expect(ok.attempt.status).toBe("succeeded");
  });

  it("rejecting only one of two requested episodes keeps the gate closed and names the other", async () => {
    const { sandbox, storage, staging, old13 } = await setup();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).rejects.toThrow(
      /SANDBOX_REJECT_FIRST: S01E24 not rejected yet/,
    );
    expect(await storage.listTree({ directoryId: staging })).toEqual([]);
  });

  it("rejecting both requested episodes (one call each, or one call for both) opens the gate", async () => {
    const one = await setup();
    await one.sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [one.old13], reason: "发蓝" });
    await one.sandbox.rejectCurrentSource({ episodes: ["S01E24"], fileIds: [one.old24], reason: "发蓝" });
    const snap1 = (await one.sandbox.searchResources("Show")).snapshot!;
    await expect(one.sandbox.transferCandidate({ snapshotId: snap1.id, candidateId: "cand_new13" })).resolves.toMatchObject({
      attempt: { status: "succeeded" },
    });
    const both = await setup();
    await both.sandbox.rejectCurrentSource({ episodes: ["S01E13", "S01E24"], fileIds: [both.old13, both.old24], reason: "发蓝" });
    const snap2 = (await both.sandbox.searchResources("Show")).snapshot!;
    await expect(both.sandbox.transferCandidate({ snapshotId: snap2.id, candidateId: "cand_new13" })).resolves.toMatchObject({
      attempt: { status: "succeeded" },
    });
  });

  it("an episode declared to have no old file here (fileIds []) is covered without writing a rejection", async () => {
    const { sandbox, rejected, results, old13 } = await setup();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await expect(sandbox.rejectCurrentSource({ episodes: ["S01E24"], fileIds: [], reason: "库里没有这一集" })).resolves.toEqual({
      rejected: 0,
      declaredNoFile: ["S01E24"],
    });
    expect(rejected).toEqual([expect.objectContaining({ episode: "S01E13" })]);
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).resolves.toMatchObject({
      attempt: { status: "succeeded" },
    });
    // The declaration still makes the episode part of the request: it is guarded,
    // needed and has to be reported.
    await expect(sandbox.declareFinish()).rejects.toThrow("SANDBOX_REPORT_REQUIRED: S01E13,S01E24");
    await sandbox.finalizeReplacement();
    expect(results).toMatchObject([{ episode: "S01E13" }, { episode: "S01E24", outcome: "not_found" }]);
  });

  it("an episode read from the words (not requested) can be declared file-less and then reported", async () => {
    const { sandbox, old13, old24 } = await setup();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13", "S01E24"], fileIds: [old13, old24], reason: "发蓝" });
    await sandbox.rejectCurrentSource({ episodes: ["S01E05"], fileIds: [], reason: "库里没有" });
    await expect(sandbox.reportReplacement({ results: [{ episode: "S01E05", outcome: "not_found", note: "没找到" }] })).resolves.toEqual({
      recorded: 1,
      ignored: [],
    });
    await expect(sandbox.rejectCurrentSource({ episodes: ["S02E01"], fileIds: [], reason: "x" })).rejects.toThrow(
      /SANDBOX_EPISODE_OUT_OF_SCOPE/,
    );
  });

  it("untagged TV message (no requested episodes): one rejectCurrentSource call opens the gate", async () => {
    const storage = new Storage115Simulator({
      packs: {
        old_pack: { files: [{ path: "Show - 13.mkv", sizeBytes: 1 }, { path: "Show - 24.mkv", sizeBytes: 1 }] },
        cand_new13: { files: [{ path: "[Nekomoe] Show - 13.mkv", sizeBytes: 2 }] },
      },
    });
    const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
    const season = await storage.createDirectory({ name: "Season 01", parentId: "root" });
    await storage.transferCandidate({ candidateId: "old_pack", intoDirectoryId: season });
    const old13 = (await storage.listTree({ directoryId: season })).find((f) => f.path.includes("13"))!.id;
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: { Show: [{ id: "cand_new13", title: "[Nekomoe] Show 13" }] } }),
      storage, stagingDirectoryId: staging, targetSeasonDirectoryIds: { 1: season }, need: [],
      replace: { requestedEpisodes: [], hasMessages: true, untaggedMessages: 1, onReject: async () => {}, onReport: async () => {} },
    });
    await sandbox.captureProtectedFiles();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).rejects.toThrow(/SANDBOX_REJECT_FIRST/);
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).resolves.toMatchObject({
      attempt: { status: "succeeded" },
    });
  });

  it("pending-only re-check: a stored rejection for one episode plus a rejection this run for the other opens the gate", async () => {
    const { sandbox, old24 } = await setup({ alreadyRejectedEpisodes: ["S01E13"] });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).rejects.toThrow(
      /SANDBOX_REJECT_FIRST: S01E24 not rejected yet/,
    );
    await sandbox.rejectCurrentSource({ episodes: ["S01E24"], fileIds: [old24], reason: "发蓝" });
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).resolves.toMatchObject({
      attempt: { status: "succeeded" },
    });
  });

  it("escape hatch: every requested episode already has a stored rejection", async () => {
    const { sandbox } = await setup({ alreadyRejectedEpisodes: ["S01E13", "S01E24"] });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    const ok = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    expect(ok.attempt.status).toBe("succeeded");
  });

  it("a stored rejection for only some requested episodes does not open the gate", async () => {
    const { sandbox } = await setup({ alreadyRejectedEpisodes: ["S01E13"] });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).rejects.toThrow(/SANDBOX_REJECT_FIRST/);
  });

  it("escape hatch: the target dirs held nothing when the run started (nothing to reject)", async () => {
    const storage = new Storage115Simulator({ packs: { cand_new13: { files: [{ path: "[Nekomoe] Show - 13.mkv", sizeBytes: 1 }] } } });
    const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
    const season = await storage.createDirectory({ name: "Season 01", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: { Show: [{ id: "cand_new13", title: "[Nekomoe] Show 13" }] } }),
      storage, stagingDirectoryId: staging, targetSeasonDirectoryIds: { 1: season }, need: [],
      replace: { requestedEpisodes: ["S01E13"], hasMessages: true, untaggedMessages: 0, onReject: async () => {}, onReport: async () => {} },
    });
    // Before the capture the sandbox does not know the dirs are empty: still gated.
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).rejects.toThrow(/SANDBOX_REJECT_FIRST/);
    await sandbox.captureProtectedFiles();
    const ok = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    expect(ok.attempt.status).toBe("succeeded");
  });

  it("transferUntilLanded (movie) is gated the same way", async () => {
    const storage = new Storage115Simulator({
      packs: { old_film: { files: [{ path: "Film.mkv", sizeBytes: 4_000 }] }, good_share: { files: [{ path: "Film.2160p.mkv", sizeBytes: 9_000 }] } },
      linkKinds: { good_share: "share" },
    });
    const movieDir = await storage.createDirectory({ name: "Film (2023)", parentId: "root" });
    await storage.transferCandidate({ candidateId: "old_film", intoDirectoryId: movieDir });
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: { film: [{ id: "good_share", title: "Film 2160p" }] } }),
      storage, stagingDirectoryId: movieDir, targetMovieDirectoryId: movieDir, need: ["MOVIE"],
      replace: { requestedEpisodes: ["MOVIE"], hasMessages: true, untaggedMessages: 0, onReject: async () => {}, onReport: async () => {} },
    });
    await sandbox.captureProtectedFiles();
    await sandbox.searchResources("film");
    await expect(sandbox.transferUntilLanded({ candidateIds: ["good_share"] })).rejects.toThrow(/SANDBOX_REJECT_FIRST/);
    const old = (await storage.listTree({ directoryId: movieDir }))[0]!;
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [old.id], reason: "假片" });
    await expect(sandbox.transferUntilLanded({ candidateIds: ["good_share"] })).resolves.toMatchObject({ transferredCandidateId: "good_share" });
  });

  it("the gate never applies outside a replace run", async () => {
    const storage = new Storage115Simulator({ packs: { cand_new13: { files: [{ path: "Show - 13.mkv", sizeBytes: 1 }] } } });
    const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: { Show: [{ id: "cand_new13", title: "Show 13" }] } }),
      storage, stagingDirectoryId: staging, need: ["S01E13"],
    });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" })).resolves.toMatchObject({
      attempt: { status: "succeeded" },
    });
  });

  it("after a rejection the cached raw snapshot and deduped searches no longer show the rejected copy; the transfer guard still refuses it", async () => {
    let rejectedNow = false;
    const { sandbox, old13, rejectE24 } = await setup({ isRejected: async (c) => rejectedNow && c.id === "cand_cr13" });
    await sandbox.primeRawSnapshot("Show");
    expect(sandbox.viewResourceSnapshot().document).toContain("cand_cr13");
    const rawId = (await sandbox.searchResources("Show")).snapshot!.id;
    rejectedNow = true; // the store now holds the rejection (what onReject writes)
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    const view = sandbox.viewResourceSnapshot();
    expect(view.document).not.toContain("cand_cr13");
    expect(view.document).toContain("cand_new13");
    expect(view.candidateCount).toBe(1);
    const again = await sandbox.searchResources("Show");
    expect(again.deduped).toBe(true);
    expect(again.snapshot!.candidates.map((c) => c.id)).toEqual(["cand_new13"]);
    // The observed snapshot is intact (persistence / validation), so a remembered id
    // resolves — and is refused by the transfer guard, not as an unseen candidate.
    expect(sandbox.hasObservedSnapshot(rawId)).toBe(true);
    await expect(sandbox.transferCandidate({ snapshotId: rawId, candidateId: "cand_cr13" })).rejects.toThrow(/SANDBOX_CANDIDATE_REJECTED/);
  });
});

describe("TaskSandbox — replace: a failed attempt that still landed files", () => {
  it("counts as landed for markObtained and reportReplacement (quark marks some landings failed)", async () => {
    const { sandbox, storage, old13, results, rejectE24 } = await setup();
    const transfer = storage.transferCandidate.bind(storage);
    storage.transferCandidate = async (input) => ({ ...(await transfer(input)), status: "failed" as const, providerMessage: "partial" });
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    const out = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    expect(out.attempt.status).toBe("failed");
    expect(out.attempt.materializedFileIds.length).toBeGreaterThan(0);
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: out.attempt.materializedFileIds }] });
    await expect(sandbox.markObtained({ codes: ["S01E13"] })).resolves.toEqual({ confirmed: ["S01E13"] });
    await sandbox.reportReplacement({
      results: [{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", fileIds: out.attempt.materializedFileIds, note: "x" }],
    });
    expect(results).toMatchObject([{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13" }]);
  });

  it("a failed attempt that landed nothing still does not count", async () => {
    const { sandbox, storage, old13, rejectE24 } = await setup();
    storage.transferCandidate = async (input) => ({ candidateId: input.candidateId, status: "failed" as const, materializedFileIds: [], providerMessage: "dead" });
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    await expect(sandbox.markObtained({ codes: ["S01E13"] })).rejects.toThrow(/SANDBOX_REPLACEMENT_NOT_LANDED/);
  });

  it("transferUntilLanded: a failed-but-landed attempt counts for reportReplacement", async () => {
    const storage = new Storage115Simulator({
      packs: { old_film: { files: [{ path: "Film.mkv", sizeBytes: 4_000 }] }, good_share: { files: [{ path: "Film.2160p.mkv", sizeBytes: 9_000 }] } },
      linkKinds: { good_share: "share" },
    });
    const movieDir = await storage.createDirectory({ name: "Film (2023)", parentId: "root" });
    await storage.transferCandidate({ candidateId: "old_film", intoDirectoryId: movieDir });
    const results: unknown[] = [];
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: { film: [{ id: "good_share", title: "Film 2160p" }] } }),
      storage, stagingDirectoryId: movieDir, targetMovieDirectoryId: movieDir, need: ["MOVIE"],
      replace: { requestedEpisodes: ["MOVIE"], hasMessages: true, untaggedMessages: 0, onReject: async () => {}, onReport: async (r) => { results.push(...r); } },
    });
    await sandbox.captureProtectedFiles();
    const old = (await storage.listTree({ directoryId: movieDir }))[0]!;
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [old.id], reason: "假片" });
    const transfer = storage.transferCandidate.bind(storage);
    storage.transferCandidate = async (input) => ({ ...(await transfer(input)), status: "failed" as const, providerMessage: "partial" });
    await sandbox.searchResources("film");
    const { landed } = await sandbox.transferUntilLanded({ candidateIds: ["good_share"] });
    // The agent tells the new film from the old one in the landed listing.
    const newFilm = landed.find((f) => f.id !== old.id)!.id;
    await sandbox.markObtained({ codes: ["MOVIE"] });
    await sandbox.reportReplacement({ results: [{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: [newFilm], note: "4K" }] });
    expect(results).toMatchObject([{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: [newFilm] }]);
  });
});

describe("TaskSandbox — replace: a replaced needs the NEW file in a target dir, not just staging", () => {
  it("TV: transfer + markObtained + reportReplacement('replaced') WITHOUT moveToSeason is recorded not_found (stays 待换)", async () => {
    const { sandbox, results, old13, rejectE24 } = await setup();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    // The new file lands in STAGING only — the agent never moves it into the season dir.
    const landed = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    const [new13] = landed.attempt.materializedFileIds;
    await sandbox.markObtained({ codes: ["S01E13"] });
    const out = await sandbox.reportReplacement({
      results: [{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", fileIds: [new13!], note: "喵萌版" }],
    });
    // Recorded, but as not_found (its file never reached the season dir) — never replaced.
    expect(out.recorded).toBe(1);
    expect(out.notInTarget).toEqual([{ episode: "S01E13", reason: expect.stringContaining(`not in the target directory now: ${new13}`) }]);
    expect(out.notInTarget![0]!.reason).toContain("moveToSeason it into the season directory, then report S01E13 again");
    expect(results).toMatchObject([{ episode: "S01E13", outcome: "not_found" }]);
    expect(results).not.toContainEqual(expect.objectContaining({ outcome: "replaced" }));
    // Stays 待换: the episode is still missing and coverage is not met.
    expect(sandbox.isCoverageMet()).toBe(false);
    expect((await sandbox.finish()).missing).toContain("S01E13");
  });

  it("TV: transfer + moveToSeason + markObtained + reportReplacement('replaced') is accepted", async () => {
    const { sandbox, results, old13, rejectE24 } = await setup();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await rejectE24();
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    const out = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand_new13" });
    // Move the new file into the season dir beside the old one — the real flow.
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: out.attempt.materializedFileIds }] });
    await sandbox.markObtained({ codes: ["S01E13"] });
    const res = await sandbox.reportReplacement({
      results: [{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", fileIds: out.attempt.materializedFileIds, note: "喵萌版" }],
    });
    expect(res).toEqual({ recorded: 1, ignored: [] });
    expect(results).toMatchObject([{ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13", note: "喵萌版" }]);
  });

  it("a non-replace run is unaffected: transfer + moveToSeason + markObtained meets coverage (no replace gate)", async () => {
    const storage = new Storage115Simulator({ packs: { cand01: { files: [{ path: "Show - 01.mkv", sizeBytes: 1 }] } } });
    const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
    const season = await storage.createDirectory({ name: "Season 01", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: { Show: [{ id: "cand01", title: "Show 01" }] } }),
      storage, stagingDirectoryId: staging, targetSeasonDirectoryIds: { 1: season }, need: ["S01E01"],
    });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    const out = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "cand01" });
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: out.attempt.materializedFileIds }] });
    await sandbox.markObtained({ codes: ["S01E01"] });
    expect(sandbox.isCoverageMet()).toBe(true);
    expect(sandbox.hasReplace()).toBe(false);
    await expect(sandbox.reportReplacement({ results: [] })).rejects.toThrow(/NO_REPLACE/);
  });
});

describe("TaskSandbox — replace: a replaced names that episode's own new file(s), checked per episode", () => {
  /** E13 + E24 requested, both current files already rejected (so transfers are open).
   *  c13 carries only an E13, c24 only an E24, pack a season pack with both, c13sub an
   *  E13 video with its subtitle. Which file is which episode is the agent's call — the
   *  system never reads the names. */
  async function fileSetup() {
    const storage = new Storage115Simulator({
      packs: {
        old_pack: { files: [{ path: "Show - 13 [CR 1080p].mkv", sizeBytes: 1_400_000_000 }, { path: "Show - 24 [CR 1080p].mkv", sizeBytes: 1_400_000_000 }] },
        c13: { files: [{ path: "[Nekomoe] Show - 13 [1080p].mkv", sizeBytes: 1_100_000_000 }] },
        c24: { files: [{ path: "[Nekomoe] Show - 24 [1080p].mkv", sizeBytes: 1_100_000_000 }] },
        pack: { files: [{ path: "[Pack] Show S01/Show - 13.mkv", sizeBytes: 1_000_000_000 }, { path: "[Pack] Show S01/Show - 24.mkv", sizeBytes: 1_000_000_000 }] },
        // A release that ships its own subtitle beside the video.
        c13sub: { files: [{ path: "[SubGroup] Show - 13.mkv", sizeBytes: 1_200_000_000 }, { path: "[SubGroup] Show - 13.chs.ass", sizeBytes: 60_000 }] },
      },
    });
    const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
    const season = await storage.createDirectory({ name: "Season 01", parentId: "root" });
    await storage.transferCandidate({ candidateId: "old_pack", intoDirectoryId: season });
    const oldFiles = await storage.listTree({ directoryId: season });
    const old13 = oldFiles.find((f) => f.path.includes("13"))!.id;
    const old24 = oldFiles.find((f) => f.path.includes("24"))!.id;
    const results: Array<Record<string, unknown>> = [];
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({
        results: {
          Show: [
            { id: "c13", title: "[Nekomoe] Show 13" },
            { id: "c24", title: "[Nekomoe] Show 24" },
            { id: "pack", title: "[Pack] Show S01" },
            { id: "c13sub", title: "[SubGroup] Show 13 内封字幕" },
          ],
        },
      }),
      storage, stagingDirectoryId: staging, targetSeasonDirectoryIds: { 1: season }, need: [],
      replace: { requestedEpisodes: ["S01E13", "S01E24"], hasMessages: true, untaggedMessages: 0, onReject: async () => {}, onReport: async (r) => { results.push(...r); } },
    });
    await sandbox.captureProtectedFiles();
    await sandbox.rejectCurrentSource({ episodes: ["S01E13"], fileIds: [old13], reason: "发蓝" });
    await sandbox.rejectCurrentSource({ episodes: ["S01E24"], fileIds: [old24], reason: "发蓝" });
    const snap = (await sandbox.searchResources("Show")).snapshot!;
    /** Transfer one candidate into staging; the ids it materialized. */
    const land = async (candidateId: string) => (await sandbox.transferCandidate({ snapshotId: snap.id, candidateId })).attempt.materializedFileIds;
    const moveIn = (fileIds: string[]) => sandbox.moveToSeason({ moves: [{ season: 1, fileIds }] });
    return { sandbox, storage, results, old13, land, moveIn };
  }

  it("E24 cannot ride on E13's new file: once E13 is reported with it, E24 naming it is REUSED; a made-up id is UNKNOWN", async () => {
    const { sandbox, results, land, moveIn } = await fileSetup();
    const [new13] = await land("c13");
    await moveIn([new13!]);
    // Something landed, so both marks are accepted — E24's is still its old file.
    await sandbox.markObtained({ codes: ["S01E13", "S01E24"] });
    await sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "replaced", candidateId: "c13", fileIds: [new13!], note: "喵萌版" }] });
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E24", outcome: "replaced", candidateId: "c13", fileIds: [new13!], note: "x" }] }),
    ).rejects.toThrow(`SANDBOX_REPLACEMENT_FILE_REUSED: ${new13} already backs S01E13`);
    // No E24 file exists: whatever id the agent makes up was not downloaded this run.
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E24", outcome: "replaced", candidateId: "c13", fileIds: ["made_up"], note: "x" }] }),
    ).rejects.toThrow("SANDBOX_REPLACEMENT_FILE_UNKNOWN: made_up were not downloaded this run");
    expect(results).toEqual([expect.objectContaining({ episode: "S01E13", outcome: "replaced", candidateId: "c13" })]);
    // E24 stays 待换: still missing, and its 待换 row is left for the next patrol.
    expect((await sandbox.finish()).missing).toEqual(["S01E24"]);
  });

  it("one file named for two episodes in the same call is refused and nothing is recorded", async () => {
    const { sandbox, results, land, moveIn } = await fileSetup();
    const [new13] = await land("c13");
    await moveIn([new13!]);
    await sandbox.markObtained({ codes: ["S01E13", "S01E24"] });
    await expect(
      sandbox.reportReplacement({
        results: [
          { episode: "S01E13", outcome: "replaced", candidateId: "c13", fileIds: [new13!], note: "a" },
          { episode: "S01E24", outcome: "replaced", candidateId: "c13", fileIds: [new13!], note: "b" },
        ],
      }),
    ).rejects.toThrow(`SANDBOX_REPLACEMENT_FILE_REUSED: ${new13} already backs S01E13`);
    expect(results).toEqual([]);
  });

  it("a replaced with no fileIds is refused", async () => {
    const { sandbox, results, land, moveIn } = await fileSetup();
    const [new13] = await land("c13");
    await moveIn([new13!]);
    await sandbox.markObtained({ codes: ["S01E13"] });
    for (const fileIds of [undefined, []]) {
      await expect(
        sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "replaced", candidateId: "c13", ...(fileIds ? { fileIds } : {}), note: "x" }] }),
      ).rejects.toThrow(/SANDBOX_REPLACEMENT_FILES_REQUIRED: S01E13/);
    }
    expect(results).toEqual([]);
  });

  it("naming the OLD (pre-run) file is UNKNOWN — it was not downloaded this run", async () => {
    const { sandbox, results, old13, land, moveIn } = await fileSetup();
    const [new13] = await land("c13");
    await moveIn([new13!]);
    await sandbox.markObtained({ codes: ["S01E13"] });
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "replaced", candidateId: "c13", fileIds: [old13], note: "x" }] }),
    ).rejects.toThrow(`SANDBOX_REPLACEMENT_FILE_UNKNOWN: ${old13} were not downloaded this run`);
    expect(results).toEqual([]);
  });

  it("a file downloaded by c24 reported under c13 is a CANDIDATE_MISMATCH", async () => {
    const { sandbox, results, land, moveIn } = await fileSetup();
    const [new13] = await land("c13");
    const [new24] = await land("c24");
    await moveIn([new13!, new24!]);
    await sandbox.markObtained({ codes: ["S01E24"] });
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E24", outcome: "replaced", candidateId: "c13", fileIds: [new24!], note: "x" }] }),
    ).rejects.toThrow(`SANDBOX_REPLACEMENT_FILE_CANDIDATE_MISMATCH: ${new24} was downloaded by c24, not c13`);
    expect(results).toEqual([]);
  });

  it("a season pack that carries both episodes: each named with its own file, both are replaced", async () => {
    const { sandbox, results, land, moveIn } = await fileSetup();
    await land("pack");
    // The agent tells the two files apart from the staging tree.
    const staged = await sandbox.inspectStaging();
    const a = staged.find((f) => f.path.endsWith("Show - 13.mkv"))!.id;
    const b = staged.find((f) => f.path.endsWith("Show - 24.mkv"))!.id;
    await moveIn([a, b]);
    await sandbox.markObtained({ codes: ["S01E13", "S01E24"] });
    await expect(
      sandbox.reportReplacement({
        results: [
          { episode: "S01E13", outcome: "replaced", candidateId: "pack", fileIds: [a], note: "整季包" },
          { episode: "S01E24", outcome: "replaced", candidateId: "pack", fileIds: [b], note: "整季包" },
        ],
      }),
    ).resolves.toEqual({ recorded: 2, ignored: [] });
    expect(results).toMatchObject([
      { episode: "S01E13", outcome: "replaced", candidateId: "pack", fileIds: [a] },
      { episode: "S01E24", outcome: "replaced", candidateId: "pack", fileIds: [b] },
    ]);
    expect((await sandbox.finish()).missing).toEqual([]);
  });

  it("an episode whose named file is still in staging is recorded not_found; moved in and re-reported, it is upgraded", async () => {
    const { sandbox, results, land, moveIn } = await fileSetup();
    const [new13] = await land("c13");
    const [new24] = await land("c24");
    // Only E13's new file reaches the season; E24's stays in staging.
    await moveIn([new13!]);
    await sandbox.markObtained({ codes: ["S01E13", "S01E24"] });
    await expect(
      sandbox.reportReplacement({
        results: [
          { episode: "S01E13", outcome: "replaced", candidateId: "c13", fileIds: [new13!], note: "a" },
          { episode: "S01E24", outcome: "replaced", candidateId: "c24", fileIds: [new24!], note: "b" },
        ],
      }),
    ).resolves.toEqual({
      recorded: 2,
      ignored: [],
      // Told back, so the agent can move it in and report again this run.
      notInTarget: [{ episode: "S01E24", reason: expect.stringContaining(`not in the target directory now: ${new24}`) }],
    });
    expect(results).toMatchObject([
      { episode: "S01E13", outcome: "replaced", candidateId: "c13" },
      { episode: "S01E24", outcome: "not_found", note: expect.stringContaining("暂存") },
    ]);
    expect(results[1]).not.toHaveProperty("candidateId");
    expect((await sandbox.finish()).missing).toEqual(["S01E24"]);
    await moveIn([new24!]);
    await sandbox.reportReplacement({ results: [{ episode: "S01E24", outcome: "replaced", candidateId: "c24", fileIds: [new24!], note: "b" }] });
    expect(results[2]).toMatchObject({ episode: "S01E24", outcome: "replaced", candidateId: "c24", fileIds: [new24!] });
    expect((await sandbox.finish()).missing).toEqual([]);
  });

  it("a replaced must name the new VIDEO: a subtitle alone is refused (NO_VIDEO); the video with its subtitle is accepted", async () => {
    const { sandbox, results, land, moveIn } = await fileSetup();
    const [video, sub] = await land("c13sub");
    await moveIn([video!, sub!]);
    await sandbox.markObtained({ codes: ["S01E13"] });
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "replaced", candidateId: "c13sub", fileIds: [sub!], note: "x" }] }),
    ).rejects.toThrow("SANDBOX_REPLACEMENT_NO_VIDEO: S01E13 — name the new video file (subtitles alone don't count)");
    expect(results).toEqual([]);
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "replaced", candidateId: "c13sub", fileIds: [video!, sub!], note: "带中字" }] }),
    ).resolves.toEqual({ recorded: 1, ignored: [] });
    expect(results).toMatchObject([{ episode: "S01E13", outcome: "replaced", candidateId: "c13sub", fileIds: [video, sub] }]);
  });

  it("a new video moved in and then deleted is recorded not_found — the target dirs are read when reporting", async () => {
    const { sandbox, results, land, moveIn } = await fileSetup();
    const [new13] = await land("c13");
    await moveIn([new13!]);
    // A clean-up gone wrong: the new file is not protected, so it can be deleted again.
    await sandbox.deleteFiles({ directory: "season", season: 1, fileIds: [new13!] });
    await sandbox.markObtained({ codes: ["S01E13"] });
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "replaced", candidateId: "c13", fileIds: [new13!], note: "喵萌版" }] }),
    ).resolves.toEqual({
      recorded: 1,
      ignored: [],
      notInTarget: [{ episode: "S01E13", reason: expect.stringContaining(`not in the target directory now: ${new13}`) }],
    });
    // Never replaced: no candidate or files go out (nothing for episode_sources); still 待换.
    expect(results).toEqual([{ episode: "S01E13", outcome: "not_found", note: expect.stringContaining("删") }]);
    expect((await sandbox.finish()).missing).toContain("S01E13");
  });

  it("reads the target dirs once per report call, and not at all when nothing is reported replaced", async () => {
    const { sandbox, storage, land, moveIn } = await fileSetup();
    await land("pack");
    const staged = await sandbox.inspectStaging();
    const a = staged.find((f) => f.path.endsWith("Show - 13.mkv"))!.id;
    const b = staged.find((f) => f.path.endsWith("Show - 24.mkv"))!.id;
    await moveIn([a, b]);
    await sandbox.markObtained({ codes: ["S01E13", "S01E24"] });
    const listed: string[] = [];
    const listTree = storage.listTree.bind(storage);
    storage.listTree = async (input) => {
      listed.push(input.directoryId);
      return listTree(input);
    };
    await sandbox.reportReplacement({ results: [{ episode: "S01E13", outcome: "not_found", note: "先记一下" }] });
    expect(listed).toEqual([]);
    await sandbox.reportReplacement({
      results: [
        { episode: "S01E13", outcome: "replaced", candidateId: "pack", fileIds: [a], note: "整季包" },
        { episode: "S01E24", outcome: "replaced", candidateId: "pack", fileIds: [b], note: "整季包" },
      ],
    });
    // One season dir, listed once for both episodes.
    expect(listed).toHaveLength(1);
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
        hasMessages: true,
        untaggedMessages: 0,
        onReject: async () => {},
        onReport: async (r) => { results.push(...r); },
      },
      isRejected,
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
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [old.find((f) => f.isVideo)!.id], reason: "x" });
    await sandbox.searchResources("film");
    await sandbox.transferUntilLanded({ candidateIds: ["good_share"] });
    const { movie } = await sandbox.flattenMovie();
    for (const file of old) expect(movie).toContainEqual(expect.objectContaining({ id: file.id, path: file.path }));
    expect(movie.some((f) => f.path === "Film.2023.2160p.REMUX.mkv")).toBe(true);
    expect((await storage.listTree({ directoryId: movieDir })).length).toBe(old.length + 1);
  });

  it("transferUntilLanded skips a rejected candidate (recorded as a failed attempt) and lands the next one", async () => {
    const { sandbox, old } = await movieSetup(async (candidate) => candidate.id === "rej_share");
    await sandbox.searchResources("film");
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [old.find((f) => f.isVideo)!.id], reason: "x" });
    const result = await sandbox.transferUntilLanded({ candidateIds: ["rej_share", "good_share"] });
    expect(result.attempts).toEqual([
      { candidateId: "rej_share", status: "failed", providerMessage: "user rejected" },
      { candidateId: "good_share", status: "succeeded" },
    ]);
    expect(result.transferredCandidateId).toBe("good_share");
  });

  it("rejectCurrentSource on a movie run accepts only [] or [\"MOVIE\"]", async () => {
    const { sandbox, old } = await movieSetup();
    const video = old.find((f) => f.isVideo)!.id;
    await expect(sandbox.rejectCurrentSource({ episodes: ["S01E01"], fileIds: [video], reason: "x" })).rejects.toThrow(
      /SANDBOX_EPISODE_OUT_OF_SCOPE/,
    );
    await sandbox.rejectCurrentSource({ episodes: ["MOVIE"], fileIds: [video], reason: "x" });
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [video], reason: "x" });
    await expect(sandbox.reportReplacement({ results: [{ episode: "S01E01", outcome: "not_found", note: "" }] })).rejects.toThrow(
      /SANDBOX_EPISODE_OUT_OF_SCOPE/,
    );
  });

  it("a succeeded transferUntilLanded candidate counts as landed for reportReplacement", async () => {
    const { sandbox, results, old } = await movieSetup();
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [old.find((f) => f.isVideo)!.id], reason: "x" });
    await sandbox.searchResources("film");
    const { landed } = await sandbox.transferUntilLanded({ candidateIds: ["good_share"] });
    const newFilm = landed.find((f) => f.path.endsWith("Film.2023.2160p.REMUX.mkv"))!.id;
    await sandbox.markObtained({ codes: ["MOVIE"] });
    await sandbox.reportReplacement({
      results: [{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: [newFilm], note: "4K REMUX" }],
    });
    expect(results).toMatchObject([{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share" }]);
  });

  it("a movie transferCandidate lands straight in the movie dir, so replaced is accepted with no moveToSeason", async () => {
    const { sandbox, results, old } = await movieSetup();
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [old.find((f) => f.isVideo)!.id], reason: "假片" });
    const snap = (await sandbox.searchResources("film")).snapshot!;
    // A movie's staging IS the movie dir, so the materialized file is already in-target.
    const out = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "good_share" });
    await sandbox.markObtained({ codes: ["MOVIE"] });
    await sandbox.reportReplacement({
      results: [{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: out.attempt.materializedFileIds, note: "4K REMUX" }],
    });
    expect(results).toMatchObject([{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share" }]);
  });

  it("a movie replaced must name the NEW film: the old film's id is UNKNOWN (it sits in the same dir)", async () => {
    const { sandbox, results, old } = await movieSetup();
    const oldVideo = old.find((f) => f.isVideo)!.id;
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [oldVideo], reason: "假片" });
    const snap = (await sandbox.searchResources("film")).snapshot!;
    const out = await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "good_share" });
    const [newFilm] = out.attempt.materializedFileIds;
    await sandbox.markObtained({ codes: ["MOVIE"] });
    await expect(
      sandbox.reportReplacement({ results: [{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: [oldVideo], note: "x" }] }),
    ).rejects.toThrow(`SANDBOX_REPLACEMENT_FILE_UNKNOWN: ${oldVideo} were not downloaded this run`);
    expect(results).toEqual([]);
    await sandbox.reportReplacement({ results: [{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: [newFilm!], note: "4K REMUX" }] });
    expect(results).toMatchObject([{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: [newFilm] }]);
  });

  it("a new film lifted out of its wrapper by flattenMovie is still found when reported", async () => {
    const { sandbox, results, old } = await movieSetup();
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [old.find((f) => f.isVideo)!.id], reason: "假片" });
    await sandbox.searchResources("film");
    const { landed } = await sandbox.transferUntilLanded({ candidateIds: ["good_share"] });
    const newFilm = landed.find((f) => f.path.endsWith("Film.2023.2160p.REMUX.mkv"))!.id;
    await sandbox.flattenMovie();
    await sandbox.markObtained({ codes: ["MOVIE"] });
    await sandbox.reportReplacement({ results: [{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: [newFilm], note: "4K REMUX" }] });
    expect(results).toMatchObject([{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: [newFilm] }]);
  });

  it("a new film deleted again before the report is recorded not_found", async () => {
    const { sandbox, results, old } = await movieSetup();
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [old.find((f) => f.isVideo)!.id], reason: "假片" });
    const snap = (await sandbox.searchResources("film")).snapshot!;
    const [newFilm] = (await sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "good_share" })).attempt.materializedFileIds;
    await sandbox.deleteFiles({ directory: "staging", fileIds: [newFilm!] });
    await sandbox.markObtained({ codes: ["MOVIE"] });
    const out = await sandbox.reportReplacement({
      results: [{ episode: "MOVIE", outcome: "replaced", candidateId: "good_share", fileIds: [newFilm!], note: "4K REMUX" }],
    });
    expect(out.notInTarget).toEqual([{ episode: "MOVIE", reason: expect.stringContaining(`not in the target directory now: ${newFilm}`) }]);
    // A movie has no staging of its own to move from: no moveToSeason hint.
    expect(out.notInTarget![0]!.reason).not.toContain("moveToSeason");
    expect(results).toEqual([{ episode: "MOVIE", outcome: "not_found", note: expect.any(String) }]);
  });
});

describe("TaskSandbox — replace: the transfer-time rejection check behind the alias layer", () => {
  // The production chain: a domain provider with long real ids → RealResourceProviderV2
  // (the agent sees short aliases s1-1, s1-2) → TaskSandbox. The rejection check must
  // see each candidate's real title, whatever id the agent passed. (The sandbox keeps
  // the adapter's AGENT-FACING snapshots, so the lookup is by alias — this locks that in;
  // the adapter's own observedSnapshots hold the real ids and must never be the source.)
  async function aliasSetup() {
    const titles = ["Film 2023 1080p WEB 4.0G", "Film 2023 2160p REMUX"];
    const inner: ResourceProvider = {
      search: async ({ keyword }): Promise<ResourceSnapshot> => ({
        id: "pansou_run_hash",
        provider: "pansou",
        keyword,
        createdAt: "2026-09-26T00:00:00.000Z",
        candidates: titles.map((title, index) => ({
          id: `pansou_run_hash_candidate_${index + 1}`, snapshotId: "pansou_run_hash", index, title, type: "115", source: "pansou",
          providerPayload: { url: `https://115.com/s/share${index + 1}` },
        })),
      }),
    };
    const provider = new RealResourceProviderV2({ provider: inner, registry: new CandidateRegistry(), workflowRunId: "run-1" });
    // The simulator transfers by the id the agent passes (the alias), like RealStorageV2 via the registry.
    const storage = new Storage115Simulator({
      packs: {
        old_film: { files: [{ path: "Film.2023.1080p.WEB.mkv", sizeBytes: 4_000_000_000 }] },
        "s1-1": { files: [{ path: "Film.2023.1080p.WEB.mkv", sizeBytes: 4_000_000_000 }] },
        "s1-2": { files: [{ path: "Film.2023.2160p.REMUX.mkv", sizeBytes: 9_000_000_000 }] },
      },
      linkKinds: { "s1-1": "share", "s1-2": "share" },
    });
    const movieDir = await storage.createDirectory({ name: "Film (2023)", parentId: "root" });
    await storage.transferCandidate({ candidateId: "old_film", intoDirectoryId: movieDir });
    const seen: Array<{ id: string; title: string }> = [];
    const sandbox = new TaskSandbox({
      provider, storage, stagingDirectoryId: movieDir, targetMovieDirectoryId: movieDir, need: ["MOVIE"],
      replace: { requestedEpisodes: ["MOVIE"], hasMessages: true, untaggedMessages: 0, onReject: async () => {}, onReport: async () => {} },
      // Stands in for the orchestrator's name+size fingerprint against the rejected file.
      isRejected: async (candidate) => {
        seen.push(candidate);
        return candidate.title === "Film 2023 1080p WEB 4.0G";
      },
    });
    await sandbox.captureProtectedFiles();
    const old = (await storage.listTree({ directoryId: movieDir }))[0]!;
    await sandbox.rejectCurrentSource({ episodes: [], fileIds: [old.id], reason: "假片" });
    return { sandbox, seen };
  }

  it("transferUntilLanded refuses a same-title copy under another link (the agent passed an alias)", async () => {
    const { sandbox, seen } = await aliasSetup();
    const snap = (await sandbox.searchResources("film")).snapshot!;
    expect(snap.candidates.map((c) => c.id)).toEqual(["s1-1", "s1-2"]);
    const result = await sandbox.transferUntilLanded({ candidateIds: ["s1-1", "s1-2"] });
    expect(seen).toContainEqual({ id: "s1-1", title: "Film 2023 1080p WEB 4.0G" });
    expect(result.attempts[0]).toEqual({ candidateId: "s1-1", status: "failed", providerMessage: "user rejected" });
    expect(result.transferredCandidateId).toBe("s1-2");
  });

  it("transferCandidate sees the same title for the same alias", async () => {
    const { sandbox, seen } = await aliasSetup();
    const snap = (await sandbox.searchResources("film")).snapshot!;
    await expect(sandbox.transferCandidate({ snapshotId: snap.id, candidateId: "s1-1" })).rejects.toThrow(/SANDBOX_CANDIDATE_REJECTED/);
    expect(seen).toContainEqual({ id: "s1-1", title: "Film 2023 1080p WEB 4.0G" });
  });
});
