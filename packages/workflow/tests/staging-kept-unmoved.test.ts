import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2Workflow } from "../src/acquisition-v2/workflow-v2.js";
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

  override async listTree(): Promise<Array<{ path: string; providerFileId: string; sizeBytes: number }>> {
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
  return { sandbox, storage, first: first!.id, second: second!.id };
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
    const event = stagingFailureAuditEvents.length
      ? null
      : null;
    const { stagingKeptAuditEvent } = await import("../src/acquisition-v2/directory-lifecycle.js");
    expect(stagingKeptAuditEvent(kept[0]!).type).toBe("staging_kept_unmoved_files");
    expect(stagingKeptAuditEvent(kept[0]!).message).toBe(
      "staging 目录里还有 14 个移动失败、没进季目录的文件，已保留不删：stg",
    );
    expect(event).toBeNull();
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
    const kept = result.auditEvents.find((event) => event.type === "staging_kept_unmoved_files");
    expect(kept?.message).toContain("1 个移动失败");
    expect(kept?.data).toMatchObject({
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
