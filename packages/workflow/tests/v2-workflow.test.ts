import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2Workflow, type RunAcquisitionV2WorkflowRequest } from "../src/acquisition-v2/workflow-v2.js";
import { runTvAcquisitionV2 } from "../src/acquisition-v2/run-tv-v2.js";
import { stagingLeaksOf } from "../src/acquisition-v2/directory-lifecycle.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import type { ResourceProvider } from "../src/ports.js";
import type { MediaTitle, ResourceSnapshot } from "../src/domain.js";
import type { JevJudge, JevJudgeInput } from "../src/jev-judge.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-06-14T00:00:00.000Z",
    }),
  };
}

/** Model that searches once then honestly reports no coverage. */
function searchThenReportModel() {
  let i = 0;
  const tool = (name: string, input: unknown) => ({
    content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  });
  return new MockLanguageModelV3({
    doGenerate: async () => {
      i += 1;
      if (i === 1) return tool("searchResources", { keyword: "show" });
      if (i === 2) return tool("reportNoCoverage", { reason: "no candidates" });
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

describe("runAcquisitionV2Workflow — outer orchestration (dirs → sync → agent → reconcile)", () => {
  it("ensures dirs, computes the cross-season need, runs the agent, reconciles", async () => {
    const executor = new FakeStorageExecutor();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model: searchThenReportModel(),
      workflowRunId: "run-1",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
    });

    // directory tree was verify-or-created
    expect(result.directories.seasonDirectoryIds[1]).toBeDefined();
    expect(result.directories.stagingDirectoryId).toContain(result.directories.showDirectoryId);
    // the need was computed from empty storage (all three aired episodes missing)
    expect(result.missingBefore).toEqual(["S01E01", "S01E02", "S01E03"]);
    // nothing covered them → still missing after reconcile (honest gap)
    expect(result.stillMissing).toEqual(["S01E01", "S01E02", "S01E03"]);
    expect(result.outcome.transferAttempts).toEqual([]);
  });

  it("no-op when nothing is missing: the agent (model) is never invoked", async () => {
    const executor = new FakeStorageExecutor();
    let modelCalled = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        modelCalled = true;
        throw new Error("model should not be called on a no-op run");
      },
    });
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model,
      workflowRunId: "run-2",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 0 }], // nothing aired → nothing missing
      qualityPreference: "1080p",
    });

    expect(modelCalled).toBe(false);
    expect(result.missingBefore).toEqual([]);
    expect(result.outcome.transferAttempts).toEqual([]);
  });

  it("实有 comes from the DB marks (priorObtained), NOT a 115 scan — it narrows the need and drives obtained", async () => {
    const executor = new FakeStorageExecutor();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model: searchThenReportModel(), // finds no new coverage this run
      workflowRunId: "run-3",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
      priorObtained: ["S01E01"], // the DB already has E01 (agent marked it before)
    });

    // The need is aired − DB实有 = {E02,E03}; E01 is NOT re-needed (the old code
    // scanned an empty 115 and would have re-needed all three).
    expect(result.missingBefore).toEqual(["S01E02", "S01E03"]);
    // obtained reflects the DB mark; stillMissing is the rest.
    expect(result.obtained).toEqual(["S01E01"]);
    expect(result.stillMissing).toEqual(["S01E02", "S01E03"]);
  });

  it("records a staging_leaked audit event when the staging dir survives the harness cleanup (123 silent-no-op delete)", async () => {
    // 2026-09-20: 123's file/trash answered code:0 and deleted nothing; the
    // executor said {removed:true}; 80 staging dirs / ~1.4 TB piled up unseen.
    // Model that with an executor whose removeDirectory is a silent no-op and
    // assert the leak is visible in the run's audit trail.
    class SilentNoopDeleteExecutor extends FakeStorageExecutor {
      override async removeDirectory(): Promise<{ removed: boolean }> {
        return { removed: true }; // lies, exactly like production did
      }
    }
    const executor = new SilentNoopDeleteExecutor();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model: searchThenReportModel(),
      workflowRunId: "run-leak",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
    });

    const leak = result.auditEvents.find((event) => event.type === "staging_leaked");
    expect(leak).toBeDefined();
    expect(leak?.data).toMatchObject({ stagingDirectoryId: result.directories.stagingDirectoryId });
    expect(leak?.message).toContain("staging");
  });

  it("records staging_cleanup_unverified when removal fails and the read-back cannot run", async () => {
    // Provisioning also lists children. Only the cleanup's read-back (the listing
    // that follows removeDirectory) is the one that must fail closed.
    class BlindCleanupExecutor extends FakeStorageExecutor {
      private cleanupStarted = false;
      override async removeDirectory(): Promise<{ removed: boolean }> {
        this.cleanupStarted = true;
        throw new Error("PAN115_RATE_LIMIT: API call budget exhausted before deleteItems");
      }
      override async listChildDirectories(parentId: string): Promise<Array<{ id: string; name: string }>> {
        if (this.cleanupStarted) {
          throw new Error("PAN115_RATE_LIMIT: API call budget exhausted before listItems");
        }
        return super.listChildDirectories(parentId);
      }
    }
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor: new BlindCleanupExecutor(),
      model: searchThenReportModel(),
      workflowRunId: "run-unverified",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
    });
    const event = result.auditEvents.find((item) => item.type === "staging_cleanup_unverified");
    expect(event).toBeDefined();
    expect(event?.message).toContain("budget exhausted before deleteItems");
    expect(event?.data).toMatchObject({ showDirectoryId: result.directories.showDirectoryId });
    expect(result.auditEvents.some((item) => item.type === "staging_leaked")).toBe(false);
  });

  it("records NO staging_leaked event when the cleanup really removed the staging dir", async () => {
    const executor = new FakeStorageExecutor();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model: searchThenReportModel(),
      workflowRunId: "run-clean",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
    });
    expect(result.auditEvents.some((event) => event.type === "staging_leaked")).toBe(false);
    // and the fake really dropped it
    const children = await executor.listChildDirectories(result.directories.showDirectoryId);
    expect(children.some((child) => child.id === result.directories.stagingDirectoryId)).toBe(false);
  });

  it("carries the leak on the thrown error when the body FAILS and the staging dir survives (Copilot #260 r1)", async () => {
    // The throw path is exactly the one the harness guard exists for (斗破苍穹). If
    // the agent dies AND the delete silently no-ops, the leak must still reach the
    // persisted failed run — the success-path audit append never runs here, so the
    // leak rides on the error itself for the failure handler to pick up.
    class SilentNoopDeleteExecutor extends FakeStorageExecutor {
      override async removeDirectory(): Promise<{ removed: boolean }> {
        return { removed: true };
      }
    }
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("agent model unavailable");
      },
    });
    let caught: unknown;
    try {
      await runAcquisitionV2Workflow({
        provider: emptyProvider(),
        executor: new SilentNoopDeleteExecutor(),
        model,
        workflowRunId: "run-leak-throw",
        title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
        categoryParentId: "tv_root",
        seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
        qualityPreference: "1080p",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("agent model unavailable"); // original error, not a wrapper
    const leaks = stagingLeaksOf(caught);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.stagingDirectoryId).toContain("staging-run-leak-throw");
    // The failure path has no `directories` to consult: the leak itself names the
    // show dir (the fake nests ids, so staging id starts with its parent's id).
    expect(leaks[0]?.showDirectoryId).toBeTruthy();
    expect(leaks[0]?.stagingDirectoryId.startsWith(leaks[0]!.showDirectoryId)).toBe(true);
  });

  it("carries NO leak on the thrown error when the cleanup really removed staging", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("agent model unavailable");
      },
    });
    let caught: unknown;
    try {
      await runAcquisitionV2Workflow({
        provider: emptyProvider(),
        executor: new FakeStorageExecutor(),
        model,
        workflowRunId: "run-clean-throw",
        title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
        categoryParentId: "tv_root",
        seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
        qualityPreference: "1080p",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(stagingLeaksOf(caught)).toEqual([]);
  });
});

describe("runAcquisitionV2Workflow forwards jevJudge to the orchestrator", () => {
  it("the judge is invoked for the pre-warm search when supplied", async () => {
    const seen: JevJudgeInput[] = [];
    const jevJudge: JevJudge = { judgeCandidates: async (input) => { seen.push(input); return { scores: {}, model: "m" }; } };
    // One real candidate so the prefilter has something to judge (empty snapshots skip the judge).
    const provider: ResourceProvider = {
      search: async ({ keyword }) => ({
        id: `snap_${keyword}`, provider: "pansou", keyword, createdAt: "2026-09-19T00:00:00.000Z",
        candidates: [{ id: "c1", snapshotId: `snap_${keyword}`, index: 0, title: "Show S01", type: "115", source: "pansou", providerPayload: {} }],
      }),
    };
    await runAcquisitionV2Workflow({
      provider,
      executor: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      workflowRunId: "run-jev",
      title: { name: "Show", year: 2024, aliases: ["The Show"], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
      jevJudge,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.target).toEqual({ kind: "tv", title: "Show", aliases: ["The Show"], year: 2024 });
  });
});

describe("runAcquisitionV2Workflow — user request (replace_request run)", () => {
  const ALL_13 = Array.from({ length: 13 }, (_, n) => `S01E${String(n + 1).padStart(2, "0")}`);
  const userRequest: NonNullable<RunAcquisitionV2WorkflowRequest["userRequest"]> = {
    requestedEpisodes: ["S01E13"],
    prompt: { messages: [{ body: "13 发蓝", episodeTags: ["S01E13"], createdAt: "2026-09-26T08:00:00.000Z" }], rejected: [], pending: [] },
    rejectedStore: { list: async () => [], add: async () => undefined },
  };

  /** A library where every aired episode is already in (DB marks) and the season dir
   *  holds the file the user complains about. */
  async function seededExecutor() {
    const executor = new FakeStorageExecutor();
    const showId = await executor.createDirectory({ name: "Show (2024) {tmdb-42}", parentId: "tv_root" });
    const seasonId = await executor.createDirectory({ name: "Season 01", parentId: showId });
    executor.seedDirectoryFiles(seasonId, [
      { id: "old13", storageDirectoryId: seasonId, name: "Show - 13 [CR 1080p].mkv", sizeBytes: 1_400_000_000, episodeCode: "S01E13", providerFileId: "old13" },
    ]);
    return { executor, seasonId };
  }

  /** Rejects the current E13, finds nothing different, reports not_found. Records
   *  the first system prompt and tool names it was given. */
  function rejectThenNotFoundModel() {
    const seen = { calls: 0, system: "", tools: [] as string[] };
    const tool = (name: string, input: unknown) => ({
      content: [{ type: "tool-call" as const, toolCallId: `c${seen.calls}`, toolName: name, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
      usage: USAGE,
      warnings: [],
    });
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seen.calls += 1;
        if (seen.calls === 1) {
          seen.system = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
          seen.tools = (options.tools ?? []).map((t) => t.name);
          return tool("rejectCurrentSource", { rejections: [{ episode: "S01E13", fileIds: ["old13"] }], reason: "发蓝" });
        }
        if (seen.calls === 2) return tool("reportReplacement", { results: [{ episode: "S01E13", outcome: "not_found", note: "只找到同一版本" }] });
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });
    return { model, seen };
  }

  it("user request on a fully obtained show: the agent still runs, and E13 stays obtained when it is not replaced", async () => {
    const { executor, seasonId } = await seededExecutor();
    const { model, seen } = rejectThenNotFoundModel();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model,
      workflowRunId: "run-ur",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 13 }],
      qualityPreference: "1080p",
      priorObtained: ALL_13,
      userRequest,
    });

    expect(seen.calls).toBeGreaterThan(0);
    // The request reached the prompt and the replace tools were registered.
    expect(seen.system).toContain("USER REQUESTS");
    expect(seen.system).toContain("13 发蓝");
    expect(seen.tools).toEqual(expect.arrayContaining(["rejectCurrentSource", "reportReplacement"]));
    // The old file is still there, so E13 never falls back to missing.
    expect(result.missingBefore).toEqual([]);
    expect(result.obtained).toContain("S01E13");
    expect(result.stillMissing).toEqual([]);
    expect(result.replacement).toEqual({
      results: [{ episode: "S01E13", outcome: "not_found", note: "只找到同一版本" }],
      rejected: [expect.objectContaining({ episode: "S01E13", label: "Show - 13 [CR 1080p].mkv" })],
      oldFiles: ["Season 01/Show - 13 [CR 1080p].mkv"],
      identified: true,
    });
    expect((await executor.listTree({ directoryId: seasonId })).map((f) => f.providerFileId)).toContain("old13");
  });

  it("an episode declared file-less, marked after another episode's transfer and reported not_found, is not reconciled as obtained", async () => {
    const executor = new FakeStorageExecutor({
      transferOutcomes: {
        cand_new13: {
          status: "succeeded",
          providerMessage: "ok",
          files: [{ id: "new13", storageDirectoryId: "staging", name: "[Nekomoe] Show 13.mkv", sizeBytes: 1_000_000_000, episodeCode: "S01E13", providerFileId: "new13" }],
        },
      },
    });
    const showId = await executor.createDirectory({ name: "Show (2024) {tmdb-42}", parentId: "tv_root" });
    const seasonId = await executor.createDirectory({ name: "Season 01", parentId: showId });
    executor.seedDirectoryFiles(seasonId, [
      { id: "old13", storageDirectoryId: seasonId, name: "Show - 13 [CR 1080p].mkv", sizeBytes: 1_400_000_000, episodeCode: "S01E13", providerFileId: "old13" },
    ]);
    // Every search (the raw pre-search "Show" included) returns the one new E13 release.
    const provider: ResourceProvider = {
      search: async ({ keyword }) => ({
        id: `snap_${keyword}`,
        provider: "pansou",
        keyword,
        createdAt: "2026-09-26T08:00:00.000Z",
        candidates: [
          { id: "cand_new13", snapshotId: `snap_${keyword}`, index: 0, title: "[Nekomoe] Show 13 [1.0G]", type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"b".repeat(40)}` } },
        ],
      }),
    };
    let calls = 0;
    const tool = (name: string, input: unknown) => ({
      content: [{ type: "tool-call" as const, toolCallId: `c${calls}`, toolName: name, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
      usage: USAGE,
      warnings: [],
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) return tool("rejectCurrentSource", { rejections: [{ episode: "S01E13", fileIds: ["old13"] }], reason: "发蓝" });
        // E24 was never obtained — no file to reject, declared instead.
        if (calls === 2) return tool("rejectCurrentSource", { rejections: [{ episode: "S01E24", fileIds: [] }], reason: "24 也要" });
        // The raw pre-search is the first snapshot the agent sees (s1).
        if (calls === 3) return tool("transferCandidate", { snapshotId: "s1", candidateId: "s1-1" });
        if (calls === 4) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["new13"] }] });
        // Something landed, so the marks are accepted — E24's too, though only E13 landed.
        if (calls === 5) return tool("markObtained", { codes: ["S01E13", "S01E24"] });
        if (calls === 6) {
          return tool("reportReplacement", {
            results: [
              { episode: "S01E13", outcome: "replaced", candidateId: "s1-1", fileIds: ["new13"], note: "喵萌版" },
              { episode: "S01E24", outcome: "not_found", note: "没找到" },
            ],
          });
        }
        if (calls === 7) return tool("finish", {});
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });
    const ALL_BUT_24 = Array.from({ length: 23 }, (_, n) => `S01E${String(n + 1).padStart(2, "0")}`);

    const result = await runAcquisitionV2Workflow({
      provider,
      executor,
      model,
      workflowRunId: "run-ur-e24",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 24 }],
      qualityPreference: "1080p",
      priorObtained: ALL_BUT_24,
      userRequest,
    });

    expect(result.missingBefore).toEqual(["S01E24"]);
    expect(result.replacement?.results).toEqual([
      expect.objectContaining({ episode: "S01E13", outcome: "replaced", candidateId: "cand_new13" }),
      { episode: "S01E24", outcome: "not_found", note: "没找到" },
    ]);
    // E13 was obtained before and was replaced; E24 got only a mark, never a replacement.
    expect(result.obtained).toContain("S01E13");
    expect(result.obtained).not.toContain("S01E24");
    expect(result.stillMissing).toEqual(["S01E24"]);
  });

  it("a replace run skips the landed-size read: old + new files would add up to a meaningless size, and the notification drops it anyway", async () => {
    const { executor } = await seededExecutor();
    const { model } = rejectThenNotFoundModel();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model,
      workflowRunId: "run-ur-size",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 13 }],
      qualityPreference: "1080p",
      priorObtained: ALL_13,
      userRequest,
    });

    // The season dir holds the old E13 video, so an unconditional read would report it.
    expect(result.landedFileCount).toBeUndefined();
    expect(result.landedBytes).toBeUndefined();
  });

  it("no user request on a fully obtained show: the no-op short-circuit still skips the agent", async () => {
    const { executor } = await seededExecutor();
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        throw new Error("model should not be called on a no-op run");
      },
    });
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model,
      workflowRunId: "run-noop",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 13 }],
      qualityPreference: "1080p",
      priorObtained: ALL_13,
    });
    expect(calls).toBe(0);
    expect(result.replacement).toBeUndefined();
  });

  it("runTvAcquisitionV2 forwards the user request and hands the replacement back with the bridged result", async () => {
    const { executor } = await seededExecutor();
    const { model, seen } = rejectThenNotFoundModel();
    const title = { id: "tmdb_tv_42", tmdbId: 42, type: "tv", title: "Show", year: 2024, aliases: [] } as unknown as MediaTitle;
    const result = await runTvAcquisitionV2({
      title,
      mode: "type3",
      seasons: [{ seasonNumber: 1, totalEpisodes: 13, latestAiredEpisode: 13, qualityPreference: "1080p" }],
      categoryParentId: "tv_root",
      resourceProvider: emptyProvider(),
      storage: executor,
      model,
      workflowRunId: "run-ur-tv",
      priorObtained: ALL_13,
      userRequest,
      now: () => "2026-09-26T08:00:00.000Z",
    });
    expect(seen.tools).toContain("rejectCurrentSource");
    expect(result.replacement?.results).toEqual([{ episode: "S01E13", outcome: "not_found", note: "只找到同一版本" }]);
    expect(result.seasons[0]!.episodes.find((e) => e.episodeCode === "S01E13")?.obtained).toBe(true);
  });
});
