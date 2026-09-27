import type { NotificationEvent } from "./domain.js";
import { formatBytes } from "./notification-report.js";
import type { StorageExecutor } from "./ports.js";
import { isActiveWorkflowStatus, type WorkflowRepository } from "./repository.js";

const REPORTED_SETTING_KEY = "staging_leftover_reported";

export interface StagingJanitorDrive {
  accountId: string;
  storageId: string;
  status: "active" | "frozen";
  tvCid: string | null;
  animeCid: string | null;
  executor: Partial<Pick<StorageExecutor, "listChildDirectories" | "listTree" | "removeDirectory">>;
}

type SweepRepository = Pick<
  WorkflowRepository,
  "getWorkflowRunSnapshot" | "getAccountSetting" | "setAccountSetting" | "saveWorkflowRunSnapshot"
>;

type CapableExecutor = Pick<StorageExecutor, "listChildDirectories" | "listTree" | "removeDirectory">;

function canSweep(executor: StagingJanitorDrive["executor"]): executor is CapableExecutor {
  return (
    typeof executor.listChildDirectories === "function" &&
    typeof executor.listTree === "function" &&
    typeof executor.removeDirectory === "function"
  );
}

/** `staging-<runId>` → runId. Anything else (Season 01, extras, a bare "staging") is not ours. */
function stagingRunId(name: string): string | null {
  const match = /^staging-(.+)$/.exec(name);
  return match?.[1] ? match[1] : null;
}

function reportedToken(storageId: string, directoryId: string): string {
  return `${storageId}:${directoryId}`;
}

async function loadReported(repository: SweepRepository, accountId: string): Promise<Set<string>> {
  const raw = await repository.getAccountSetting(accountId, REPORTED_SETTING_KEY);
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

async function saveReported(repository: SweepRepository, accountId: string, ids: Set<string>): Promise<void> {
  await repository.setAccountSetting(accountId, REPORTED_SETTING_KEY, JSON.stringify([...ids].sort()));
}

async function recordLeftover(
  repository: SweepRepository,
  drive: StagingJanitorDrive,
  showName: string,
  directoryId: string,
  directoryName: string,
  fileCount: number,
  totalBytes: number,
  now: string,
): Promise<void> {
  const runId = `staging-janitor:${drive.storageId}`;
  const seasonId = `staging-janitor-season:${drive.storageId}`;
  const titleId = `staging-janitor-title:${drive.storageId}`;
  const notification: NotificationEvent = {
    id: `staging_leftover:${drive.storageId}:${directoryId}`,
    workflowRunId: runId,
    kind: "staging_leftover",
    title: showName,
    body:
      `${showName} 的暂存目录 ${directoryName} 还有 ${fileCount} 个文件（${formatBytes(totalBytes)}），没有删除。` +
      "这些文件不在季目录里，请到网盘手动处理。",
    createdAt: now,
    trigger: "user",
  };
  const existing = await repository.getWorkflowRunSnapshot(runId, {
    accountId: drive.accountId,
    connectedStorageId: drive.storageId,
  });
  if (existing) {
    if (existing.notifications.some((item) => item.id === notification.id)) {
      return;
    }
    await repository.saveWorkflowRunSnapshot({
      ...existing,
      notifications: [...existing.notifications, notification],
    });
    return;
  }
  await repository.saveWorkflowRunSnapshot({
    accountId: drive.accountId,
    connectedStorageId: drive.storageId,
    title: {
      id: titleId,
      tmdbId: 0,
      type: "tv",
      title: "暂存残留",
      originalTitle: "",
      year: 0,
      aliases: [],
    },
    season: {
      id: seasonId,
      mediaTitleId: titleId,
      seasonNumber: 0,
      status: "completed",
      qualityPreference: "",
      storageDirectoryId: "",
      totalEpisodes: 0,
      latestAiredEpisode: 0,
      latestAiredSource: "unknown",
    },
    workflowRun: {
      id: runId,
      kind: "type3_monitor",
      status: "reserved",
      trackedSeasonId: seasonId,
      startedAt: now,
      finishedAt: null,
      auditEvents: [],
    },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [notification],
  });
}

async function sweepDrive(
  drive: StagingJanitorDrive,
  repository: SweepRepository,
  now: string,
): Promise<{ removed: number; reported: number }> {
  if (drive.status !== "active" || !canSweep(drive.executor)) {
    return { removed: 0, reported: 0 };
  }
  const executor = drive.executor;
  const reported = await loadReported(repository, drive.accountId);
  let removed = 0;
  let newlyReported = 0;
  for (const categoryId of [drive.tvCid, drive.animeCid]) {
    if (!categoryId) {
      continue;
    }
    const shows = await executor.listChildDirectories(categoryId);
    for (const show of shows) {
      const children = await executor.listChildDirectories(show.id);
      for (const child of children) {
        const runId = stagingRunId(child.name);
        if (!runId) {
          continue;
        }
        const snapshot = await repository.getWorkflowRunSnapshot(runId, drive.accountId);
        if (snapshot && isActiveWorkflowStatus(snapshot.workflowRun.status)) {
          continue;
        }
        const tree = await executor.listTree({ directoryId: child.id });
        if (tree.length === 0) {
          const result = await executor.removeDirectory(child.id);
          if (result.removed) {
            removed += 1;
          }
          continue;
        }
        const token = reportedToken(drive.storageId, child.id);
        if (reported.has(token)) {
          continue;
        }
        const totalBytes = tree.reduce((sum, file) => sum + (Number.isFinite(file.sizeBytes) ? file.sizeBytes : 0), 0);
        await recordLeftover(repository, drive, show.name, child.id, child.name, tree.length, totalBytes, now);
        reported.add(token);
        await saveReported(repository, drive.accountId, reported);
        newlyReported += 1;
      }
    }
  }
  return { removed, reported: newlyReported };
}

/**
 * Daily-patrol pass over leftover `staging-<runId>` dirs. Empty orphans (the run
 * is not queued/running — missing counts) are removed. Non-empty ones are kept
 * and reported once per directory: a prior run may have marked those episodes
 * obtained while the files never left staging.
 *
 * ponytail: one fresh executor per drive, so the 115 guard starts at zero. A
 * library whose show walk exceeds the agent wall stops that drive for today and
 * the next patrol starts from the top. Sequential on purpose.
 */
export async function sweepOrphanStagingDirs(input: {
  repository: SweepRepository;
  drives: StagingJanitorDrive[];
  now: string;
  log?: (line: string) => void;
}): Promise<void> {
  const log = input.log ?? ((line: string) => console.log(line));
  for (const drive of input.drives) {
    try {
      const counts = await sweepDrive(drive, input.repository, input.now);
      log(
        `[patrol] staging janitor ${drive.storageId}: removed ${counts.removed} empty, reported ${counts.reported} non-empty`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[patrol] staging janitor ${drive.storageId}: failed: ${message}`);
    }
  }
}
