import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2Workflow } from "../src/acquisition-v2/workflow-v2.js";
import { readSkillSection } from "../src/acquisition-v2/skill.js";
import { buildTvAnimeSystemPrompt } from "../src/acquisition-v2/task-agents.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import {
  stagingFailureAuditEvents,
  stagingKeptUnmovedOf,
  withStagingCleanup,
} from "../src/acquisition-v2/directory-lifecycle.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";
import type { MediaTitle, TrackedSeason, WorkflowRun } from "../src/domain.js";
import type { PersistedWorkflowRunSnapshot, PersistWorkflowRunSnapshotInput } from "../src/repository.js";
import { handleWorkflowRunFailure } from "../src/worker.js";

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

function tool(name: string, input: unknown, id: number) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: `c${id}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  };
}

/** Staging listTree always shows stuck-1, so moveToSeason accepts that id. */
class StuckFileExecutor extends FakeStorageExecutor {
  readonly removed: string[] = [];
  moveAttempts = 0;
  failMoves = 1;
  deleted: string[] = [];
  /** The moveToSeason preflight listing is refused (115 wall), before any move. */
  failPreflight = false;

  override async listTree(): Promise<Array<{ path: string; providerFileId: string; sizeBytes: number }>> {
    if (this.failPreflight) {
      throw new Error("PAN115_RATE_LIMIT: API call budget exhausted before listItems");
    }
    return [{ path: "ep.mkv", providerFileId: "stuck-1", sizeBytes: 10 }];
  }

  override async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }> {
    this.moveAttempts += 1;
    if (this.moveAttempts <= this.failMoves) {
      throw new Error("PAN115_RATE_LIMIT: API call budget exhausted before moveItems");
    }
    return { moved: input.fileIds };
  }

  override async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    this.deleted = input.fileIds;
    return { deleted: input.fileIds };
  }

  override async removeDirectory(directoryId: string): Promise<{ removed: boolean }> {
    this.removed.push(directoryId);
    return super.removeDirectory(directoryId);
  }
}

function workflowRequest(executor: StuckFileExecutor, model: MockLanguageModelV3) {
  return {
    provider: emptyProvider(),
    executor,
    model,
    workflowRunId: "run-keep",
    title: { name: "欺诈游戏", year: 2024, aliases: [], tmdbId: 42 },
    categoryParentId: "tv_root",
    seasons: [{ seasonNumber: 1, latestAiredEpisode: 1 }],
    qualityPreference: "1080p",
  };
}

async function stagedSandbox() {
  const provider = new FakeResourceProviderV2({
    results: { show: [{ id: "pack", title: "Show S01" }] },
  });
  const storage = new Storage115Simulator({
    packs: { pack: { files: [{ path: "Show/Show - 01.mkv", sizeBytes: 9 }, { path: "Show/Show - 02.mkv", sizeBytes: 8 }] } },
  });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const season = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: season },
    need: ["S01E01", "S01E02"],
  });
  const search = await sandbox.searchResources("show");
  const transfer = await sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "pack" });
  const [first, second] = transfer.staging;
  return { sandbox, storage, stagingDirectoryId, first: first!.id, second: second!.id };
}

describe("TaskSandbox unmoved files", () => {
  it("remembers file ids from a failed move, drops them after a later successful move", async () => {
    const { sandbox, storage, first, second } = await stagedSandbox();
    let fail = true;
    storage.moveFiles = async (input) => {
      if (fail) {
        throw new Error("budget");
      }
      return { moved: input.fileIds };
    };
    await expect(sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first, second] }] })).rejects.toThrow(/MOVE_NOT_DONE/);
    expect(sandbox.unmovedStagingFileIds().sort()).toEqual([first, second].sort());

    fail = false;
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first] }] });
    expect(sandbox.unmovedStagingFileIds()).toEqual([second]);
  });

  it("drops unmoved ids that deleteFiles actually deletes", async () => {
    const { sandbox, storage, first, second } = await stagedSandbox();
    storage.moveFiles = async () => {
      throw new Error("budget");
    };
    await expect(sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first, second] }] })).rejects.toThrow(/MOVE_NOT_DONE/);
    storage.moveFiles = async (input) => ({ moved: input.fileIds });
    await sandbox.deleteFiles({ directory: "staging", fileIds: [first] });
    expect(sandbox.unmovedStagingFileIds()).toEqual([second]);
  });
});

describe("discardStaging refuses while a failed move's files are still in staging", () => {
  function watchRemove(storage: Storage115Simulator) {
    const calls: string[] = [];
    const real = storage.removeDirectory.bind(storage);
    storage.removeDirectory = async (input) => {
      calls.push(input.directoryId);
      return real(input);
    };
    return calls;
  }

  it("a failed move makes discardStaging throw and not remove the directory", async () => {
    const { sandbox, storage, first, second } = await stagedSandbox();
    const removed = watchRemove(storage);
    storage.moveFiles = async () => {
      throw new Error("budget");
    };
    await expect(sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first, second] }] })).rejects.toThrow(/MOVE_NOT_DONE/);
    await expect(sandbox.discardStaging()).rejects.toThrow(
      `SANDBOX_STAGING_HOLDS_UNMOVED: 2 file(s) whose move failed are still in staging (${first}, ${second}) — move them into their season with moveToSeason, or deleteFiles them on purpose, before discarding staging`,
    );
    expect(removed).toEqual([]);
    expect((await sandbox.inspectStaging()).map((file) => file.id).sort()).toEqual([first, second].sort());
  });

  it("a later successful move of the same files lets discardStaging remove staging", async () => {
    const { sandbox, storage, stagingDirectoryId, first, second } = await stagedSandbox();
    const removed = watchRemove(storage);
    const realMove = storage.moveFiles.bind(storage);
    let fail = true;
    storage.moveFiles = async (input) => {
      if (fail) {
        throw new Error("budget");
      }
      return realMove(input);
    };
    await expect(sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first, second] }] })).rejects.toThrow(/MOVE_NOT_DONE/);
    fail = false;
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first, second] }] });
    const result = await sandbox.discardStaging();
    expect(result.removed.length).toBeGreaterThan(0);
    expect(removed).toEqual([stagingDirectoryId]);
    await expect(sandbox.inspectStaging()).rejects.toThrow(/SIM_DIR_NOT_FOUND/);
  });

  it("deleteFiles of the unmoved ids lets discardStaging remove staging", async () => {
    const { sandbox, storage, stagingDirectoryId, first, second } = await stagedSandbox();
    const removed = watchRemove(storage);
    storage.moveFiles = async () => {
      throw new Error("budget");
    };
    await expect(sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first, second] }] })).rejects.toThrow(/MOVE_NOT_DONE/);
    storage.moveFiles = async (input) => ({ moved: input.fileIds });
    await sandbox.deleteFiles({ directory: "staging", fileIds: [first, second] });
    const result = await sandbox.discardStaging();
    expect(result.removed.length).toBeGreaterThan(0);
    expect(removed).toEqual([stagingDirectoryId]);
    await expect(sandbox.inspectStaging()).rejects.toThrow(/SIM_DIR_NOT_FOUND/);
  });

  it("with no failed move, discardStaging still removes staging", async () => {
    const { sandbox, storage, stagingDirectoryId } = await stagedSandbox();
    const removed = watchRemove(storage);
    const result = await sandbox.discardStaging();
    expect(result.removed.length).toBeGreaterThan(0);
    expect(removed).toEqual([stagingDirectoryId]);
    await expect(sandbox.inspectStaging()).rejects.toThrow(/SIM_DIR_NOT_FOUND/);
  });

  it("TV playbook and task prompt say discardStaging is refused while unmoved files remain", () => {
    const sentence = "discardStaging is refused while files whose move failed are still in staging.";
    expect(readSkillSection("tv")).toContain(sentence);
    expect(buildTvAnimeSystemPrompt({})).toContain(sentence);
  });
});

describe("moveToSeason preflight listing failure", () => {
  it("holds every requested id when the staging listing is refused", async () => {
    const { sandbox, storage, first, second } = await stagedSandbox();
    storage.listTree = async () => {
      throw new Error("PAN115_RATE_LIMIT: API call budget exhausted before listItems");
    };
    await expect(sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first, second] }] })).rejects.toThrow(
      new RegExp(`MOVE_NOT_DONE: these files did NOT move \\(${first}, ${second}\\)\\.`),
    );
    expect(sandbox.unmovedStagingFileIds()).toEqual([first, second]);
  });

  it("does not hold an id the sandbox itself rejected as not in staging", async () => {
    const { sandbox } = await stagedSandbox();
    await expect(sandbox.moveToSeason({ moves: [{ season: 1, fileIds: ["not-in-staging"] }] })).rejects.toThrow(
      /SANDBOX_FILES_NOT_IN_STAGING/,
    );
    expect(sandbox.unmovedStagingFileIds()).toEqual([]);
  });
});

async function twoSeasonSandbox() {
  const provider = new FakeResourceProviderV2({
    results: { show: [{ id: "pack", title: "Show" }] },
  });
  const storage = new Storage115Simulator({
    packs: { pack: { files: [{ path: "Show/E01.mkv", sizeBytes: 9 }, { path: "Show/E02.mkv", sizeBytes: 8 }] } },
  });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const season1 = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const season2 = await storage.createDirectory({ name: "Season 2", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: season1, 2: season2 },
    need: ["S01E01", "S02E01"],
  });
  const search = await sandbox.searchResources("show");
  const transfer = await sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "pack" });
  const [first, second] = transfer.staging;
  return { sandbox, storage, first: first!.id, second: second!.id };
}

describe("a multi-season move holds every requested id", () => {
  it("keeps the later season's ids when an earlier move throws", async () => {
    const { sandbox, storage, first, second } = await twoSeasonSandbox();
    storage.moveFiles = async () => {
      throw new Error("PAN115_RATE_LIMIT: API call budget exhausted before moveItems");
    };
    await expect(
      sandbox.moveToSeason({
        moves: [
          { season: 1, fileIds: [first] },
          { season: 2, fileIds: [second] },
        ],
      }),
    ).rejects.toThrow(/MOVE_NOT_DONE/);
    expect(sandbox.unmovedStagingFileIds().sort()).toEqual([first, second].sort());
  });

  it("clears every id after each season move succeeds", async () => {
    const { sandbox, first, second } = await twoSeasonSandbox();
    await sandbox.moveToSeason({
      moves: [
        { season: 1, fileIds: [first] },
        { season: 2, fileIds: [second] },
      ],
    });
    expect(sandbox.unmovedStagingFileIds()).toEqual([]);
  });
});

describe("a partial move tracks only the ids that stayed behind", () => {
  it("moveFiles returning moved: [f1] for [f1, f2] leaves only f2 unmoved, and moving f2 then allows discardStaging", async () => {
    const { sandbox, storage, stagingDirectoryId, first, second } = await stagedSandbox();
    const removed: string[] = [];
    const realRemove = storage.removeDirectory.bind(storage);
    storage.removeDirectory = async (input) => {
      removed.push(input.directoryId);
      return realRemove(input);
    };
    const realMove = storage.moveFiles.bind(storage);
    let partial = true;
    storage.moveFiles = async (input) => {
      if (partial) {
        return { moved: [first] };
      }
      return realMove(input);
    };
    await expect(sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first, second] }] })).rejects.toThrow(
      new RegExp(`MOVE_NOT_DONE: these files did NOT move \\(${second}\\)\\.`),
    );
    expect(sandbox.unmovedStagingFileIds()).toEqual([second]);
    partial = false;
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [second] }] });
    await sandbox.discardStaging();
    expect(removed).toEqual([stagingDirectoryId]);
  });

  it("a moveFiles that throws still marks every requested id unmoved", async () => {
    const { sandbox, storage, first, second } = await stagedSandbox();
    storage.moveFiles = async () => {
      throw new Error("PAN115_RATE_LIMIT: API call budget exhausted before moveItems");
    };
    await expect(sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [first, second] }] })).rejects.toThrow(/MOVE_NOT_DONE/);
    expect(sandbox.unmovedStagingFileIds()).toEqual([first, second]);
  });
});

describe("withStagingCleanup keeps staging when unmoved files remain", () => {
  it("does not remove the dir and records staging_kept_unmoved_files", async () => {
    const removed: string[] = [];
    const kept: Array<{ stagingDirectoryId: string; showDirectoryId: string; fileCount: number }> = [];
    const executor = {
      async removeDirectory(id: string) {
        removed.push(id);
        return { removed: true };
      },
      async listChildDirectories() {
        return [{ id: "stg", name: "staging-run" }];
      },
    };
    const result = await withStagingCleanup(
      {
        executor,
        stagingDirectoryId: "stg",
        parentDirectoryId: "show",
        keep: () => ({ fileCount: 14 }),
        onKept: (event) => kept.push(event),
      },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(removed).toEqual([]);
    expect(kept).toEqual([{ stagingDirectoryId: "stg", showDirectoryId: "show", fileCount: 14 }]);
    const { stagingKeptAuditEvent } = await import("../src/acquisition-v2/directory-lifecycle.js");
    expect(stagingKeptAuditEvent(kept[0]!).type).toBe("staging_kept_unmoved_files");
    expect(stagingKeptAuditEvent(kept[0]!).message).toBe(
      "staging 目录里还有 14 个移动失败、没进季目录的文件，已保留不删：stg",
    );
  });

  it("still removes staging when keep returns null", async () => {
    const removed: string[] = [];
    const executor = {
      async removeDirectory(id: string) {
        removed.push(id);
        return { removed: true };
      },
      async listChildDirectories() {
        return [];
      },
    };
    await withStagingCleanup(
      {
        executor,
        stagingDirectoryId: "stg",
        parentDirectoryId: "show",
        onLeak: () => undefined,
        keep: () => null,
      },
      async () => "ok",
    );
    expect(removed).toEqual(["stg"]);
  });
});

describe("runAcquisitionV2Workflow does not delete files whose move failed", () => {
  it("return path: keeps the staging dir and records the audit event", async () => {
    const executor = new StuckFileExecutor();
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["stuck-1"] }] }, step);
        return tool("finish", {}, step);
      },
    });
    const result = await runAcquisitionV2Workflow(workflowRequest(executor, model));
    const kept = result.auditEvents.filter((event) => event.type === "staging_kept_unmoved_files");
    expect(kept).toHaveLength(1);
    expect(result.auditEvents.some((event) => event.type === "staging_leaked" || event.type === "staging_cleanup_unverified")).toBe(false);
    expect(kept[0]?.message).toContain("1 个移动失败");
    expect(kept[0]?.data).toMatchObject({
      fileCount: 1,
      stagingDirectoryId: result.directories.stagingDirectoryId,
      showDirectoryId: result.directories.showDirectoryId,
    });
    expect(executor.removed).not.toContain(result.directories.stagingDirectoryId);
    const children = await executor.listChildDirectories(result.directories.showDirectoryId);
    expect(children.some((child) => child.id === result.directories.stagingDirectoryId)).toBe(true);
  });

  it("throw path: attaches the kept event and does not remove staging", async () => {
    const executor = new StuckFileExecutor();
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["stuck-1"] }] }, step);
        throw new Error("agent model unavailable");
      },
    });
    let caught: unknown;
    try {
      await runAcquisitionV2Workflow(workflowRequest(executor, model));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("agent model unavailable");
    const kept = stagingKeptUnmovedOf(caught);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.fileCount).toBe(1);
    const failureEvents = stagingFailureAuditEvents(caught);
    expect(failureEvents.map((event) => event.type)).toEqual(["staging_kept_unmoved_files"]);
    expect(executor.removed).toEqual([]);
  });

  it("a later successful move of the same file allows normal cleanup", async () => {
    const executor = new StuckFileExecutor();
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1 || step === 2) {
          return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["stuck-1"] }] }, step);
        }
        return tool("finish", {}, step);
      },
    });
    const result = await runAcquisitionV2Workflow(workflowRequest(executor, model));
    expect(result.auditEvents.some((event) => event.type === "staging_kept_unmoved_files")).toBe(false);
    expect(executor.removed).toContain(result.directories.stagingDirectoryId);
  });

  it("deleteFiles of the unmoved file allows normal cleanup", async () => {
    const executor = new StuckFileExecutor();
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["stuck-1"] }] }, step);
        if (step === 2) return tool("deleteFiles", { directory: "staging", fileIds: ["stuck-1"] }, step);
        return tool("finish", {}, step);
      },
    });
    const result = await runAcquisitionV2Workflow(workflowRequest(executor, model));
    expect(executor.deleted).toEqual(["stuck-1"]);
    expect(result.auditEvents.some((event) => event.type === "staging_kept_unmoved_files")).toBe(false);
    expect(executor.removed).toContain(result.directories.stagingDirectoryId);
  });

  it("preflight listing refusal keeps staging even though the move never started", async () => {
    const executor = new StuckFileExecutor();
    executor.failPreflight = true;
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["stuck-1"] }] }, step);
        return tool("finish", {}, step);
      },
    });
    const result = await runAcquisitionV2Workflow(workflowRequest(executor, model));
    const kept = result.auditEvents.filter((event) => event.type === "staging_kept_unmoved_files");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.data).toMatchObject({ fileCount: 1 });
    expect(executor.removed).not.toContain(result.directories.stagingDirectoryId);
  });

  it("keeps staging when the first of two season moves throws before the second runs", async () => {
    const executor = new StuckFileExecutor();
    executor.failMoves = 1;
    executor.listTree = async () => [
      { path: "E01.mkv", providerFileId: "f1", sizeBytes: 10 },
      { path: "E02.mkv", providerFileId: "f2", sizeBytes: 10 },
    ];
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) {
          return tool(
            "moveToSeason",
            {
              moves: [
                { season: 1, fileIds: ["f1"] },
                { season: 2, fileIds: ["f2"] },
              ],
            },
            step,
          );
        }
        return tool("finish", {}, step);
      },
    });
    const result = await runAcquisitionV2Workflow({
      ...workflowRequest(executor, model),
      seasons: [
        { seasonNumber: 1, latestAiredEpisode: 1 },
        { seasonNumber: 2, latestAiredEpisode: 1 },
      ],
    });
    const kept = result.auditEvents.filter((event) => event.type === "staging_kept_unmoved_files");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.data).toMatchObject({ fileCount: 2 });
    expect(executor.removed).not.toContain(result.directories.stagingDirectoryId);
  });

  it("a run with no failed move still removes staging and records no kept event", async () => {
    const executor = new StuckFileExecutor();
    executor.failMoves = 0;
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        return tool("finish", {}, step);
      },
    });
    const result = await runAcquisitionV2Workflow(workflowRequest(executor, model));
    expect(result.auditEvents.some((event) => event.type === "staging_kept_unmoved_files")).toBe(false);
    expect(executor.removed).toContain(result.directories.stagingDirectoryId);
  });
});

describe("staging_kept_unmoved_files persist", () => {
  it("handleWorkflowRunFailure writes the event onto the failed run", async () => {
    const { attachStagingKeptUnmoved } = await import("../src/acquisition-v2/directory-lifecycle.js");
    const title: MediaTitle = {
      id: "tmdb_tv_1",
      tmdbId: 1,
      type: "tv",
      title: "欺诈游戏",
      originalTitle: "Liar Game",
      year: 2024,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "tmdb_tv_1_s1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "show",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    const workflowRun: WorkflowRun = {
      id: "r1",
      kind: "type3_monitor",
      status: "running",
      trackedSeasonId: season.id,
      startedAt: "2026-09-27T03:00:00.000Z",
      finishedAt: null,
      auditEvents: [],
    };
    const claimed = {
      accountId: "acct_default",
      connectedStorageId: "cs_1",
      title,
      season,
      workflowRun,
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      obtainedEpisodes: [],
      providerAheadEpisodes: [],
    } as PersistedWorkflowRunSnapshot;
    const error = attachStagingKeptUnmoved(new Error("agent model unavailable"), [
      { stagingDirectoryId: "stg", showDirectoryId: "show", fileCount: 14 },
    ]);
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed,
      error,
      repository: { saveWorkflowRunSnapshot: save },
      now: () => "2026-09-27T03:30:00.000Z",
    });
    const saved = save.mock.calls[0]![0];
    const event = saved.workflowRun.auditEvents.find(
      (item: { type: string }) => item.type === "staging_kept_unmoved_files",
    );
    expect(event?.message).toBe("staging 目录里还有 14 个移动失败、没进季目录的文件，已保留不删：stg");
    expect(event?.data).toEqual({ stagingDirectoryId: "stg", showDirectoryId: "show", fileCount: 14 });
  });
});
