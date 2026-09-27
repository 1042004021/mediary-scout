import type { NotificationEvent } from "./domain.js";
import { formatBytes } from "./notification-report.js";
import type { StorageExecutor } from "./ports.js";
import { isActiveWorkflowStatus, type WorkflowRepository } from "./repository.js";

const REPORTED_SETTING_KEY = "staging_leftover_reported";

export interface StagingJanitorDrive {
  accountId: string;
  storageId: string;
  status: "active" | "frozen";
  /** Drive brand. pan123 listings are spaced; other brands are not (115 paces itself). */
  provider: string;
  tvCid: string | null;
  animeCid: string | null;
  executor: Partial<Pick<StorageExecutor, "listChildDirectories" | "listTree" | "removeDirectory">>;
}

export interface StagingJanitorClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const PAN123_MIN_INTERVAL_MS = 1500;
/** One paced call can paginate. 123 answers the burst with code=100011. Two backoffs, then give up. */
const RATE_LIMIT_BACKOFF_MS = [3000, 6000];

function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /code=100011|请勿频繁操作/.test(message);
}

const realtimeClock: StagingJanitorClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function minIntervalMs(provider: string): number {
  return provider === "pan123" ? PAN123_MIN_INTERVAL_MS : 0;
}

/** Start-to-start gap. The first call does not wait. gap 0 never sleeps.
 *  A code=100011 / 请勿频繁操作 waits 3s then 6s and retries; the third such
 *  failure, or any other error, propagates. */
function pacerFor(gapMs: number, clock: StagingJanitorClock): <T>(run: () => Promise<T>) => Promise<T> {
  let last = Number.NEGATIVE_INFINITY;
  return async function pace<T>(run: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      if (gapMs > 0 && Number.isFinite(last)) {
        const wait = gapMs - (clock.now() - last);
        if (wait > 0) {
          await clock.sleep(wait);
        }
      }
      if (gapMs > 0) {
        last = clock.now();
      }
      try {
        return await run();
      } catch (error) {
        const backoff = RATE_LIMIT_BACKOFF_MS[attempt];
        if (backoff === undefined || !isRateLimited(error)) {
          throw error;
        }
        attempt += 1;
        await clock.sleep(backoff);
      }
    }
  };
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

function cursorKey(storageId: string): string {
  return `staging_janitor_cursor:${storageId}`;
}

interface Leftover {
  showName: string;
  directoryId: string;
  directoryName: string;
  fileCount: number;
  totalBytes: number;
  /** listTree still saw no files, but the directory has subdirectories. */
  unknownContents: boolean;
}

const ADVICE = "这些文件不在季目录里，请到网盘手动处理。";
/** Deeper than the executors' default (6). A real pack's files sit inside a few wrappers. */
const JANITOR_LIST_DEPTH = 20;

function leftoverLine(item: Leftover): string {
  if (item.unknownContents) {
    return `${item.showName} / ${item.directoryName}：有子目录，文件数未知`;
  }
  return `${item.showName} / ${item.directoryName}：${item.fileCount} 个文件，${formatBytes(item.totalBytes)}`;
}

function leftoverBody(items: Leftover[]): string {
  const lines = items.slice(0, 10).map(leftoverLine);
  if (items.length > 10) {
    const totalBytes = items
      .filter((item) => !item.unknownContents)
      .reduce((sum, item) => sum + item.totalBytes, 0);
    lines.push(`…等共 ${items.length} 个目录，合计 ${formatBytes(totalBytes)}`);
  }
  lines.push(ADVICE);
  return lines.join("\n");
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

/** One notice for every newly found non-empty orphan of this drive. Returns how
 *  many directories it remembered. A duplicate sweep id writes nothing. */
async function recordLeftovers(
  repository: SweepRepository,
  drive: StagingJanitorDrive,
  items: Leftover[],
  reported: Set<string>,
  now: string,
): Promise<number> {
  if (items.length === 0) {
    return 0;
  }
  const runId = `staging-janitor:${drive.storageId}`;
  const seasonId = `staging-janitor-season:${drive.storageId}`;
  const titleId = `staging-janitor-title:${drive.storageId}`;
  const notification: NotificationEvent = {
    id: `staging_leftover:${drive.storageId}:${now}`,
    workflowRunId: runId,
    kind: "staging_leftover",
    title: `网盘暂存目录残留（${items.length} 个）`,
    body: leftoverBody(items),
    createdAt: now,
    trigger: "user",
  };
  const existing = await repository.getWorkflowRunSnapshot(runId, {
    accountId: drive.accountId,
    connectedStorageId: drive.storageId,
  });
  if (existing?.notifications.some((item) => item.id === notification.id)) {
    return 0;
  }
  if (existing) {
    await repository.saveWorkflowRunSnapshot({
      ...existing,
      notifications: [...existing.notifications, notification],
    });
  } else {
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
  for (const item of items) {
    reported.add(reportedToken(drive.storageId, item.directoryId));
  }
  await saveReported(repository, drive.accountId, reported);
  return items.length;
}

async function sweepDrive(
  drive: StagingJanitorDrive,
  repository: SweepRepository,
  now: string,
  clock: StagingJanitorClock,
): Promise<{ removed: number; reported: number; notRemoved: number }> {
  if (drive.status !== "active" || !canSweep(drive.executor)) {
    return { removed: 0, reported: 0, notRemoved: 0 };
  }
  const executor = drive.executor;
  const pace = pacerFor(minIntervalMs(drive.provider), clock);
  const reported = await loadReported(repository, drive.accountId);
  const pending: Leftover[] = [];
  let removed = 0;
  let notRemoved = 0;

  const shows: Array<{ id: string; name: string }> = [];
  for (const categoryId of [drive.tvCid, drive.animeCid]) {
    if (!categoryId) {
      continue;
    }
    // A category listing that throws has no show id. Leave the previous cursor.
    shows.push(...(await pace(() => executor.listChildDirectories(categoryId))));
  }

  const savedCursor = await repository.getAccountSetting(drive.accountId, cursorKey(drive.storageId));
  const cursorIndex = savedCursor ? shows.findIndex((show) => show.id === savedCursor) : -1;
  const start = cursorIndex < 0 ? 0 : cursorIndex;

  const flush = (): Promise<number> => recordLeftovers(repository, drive, pending.splice(0), reported, now);

  for (let index = start; index < shows.length; index += 1) {
    const show = shows[index]!;
    try {
      const children = await pace(() => executor.listChildDirectories(show.id));
      for (const child of children) {
        const runId = stagingRunId(child.name);
        if (!runId) {
          continue;
        }
        const snapshot = await repository.getWorkflowRunSnapshot(runId, drive.accountId);
        if (snapshot && isActiveWorkflowStatus(snapshot.workflowRun.status)) {
          continue;
        }
        const tree = await pace(() => executor.listTree({ directoryId: child.id, maxDepth: JANITOR_LIST_DEPTH }));
        // Still empty after a deep walk: a subdirectory means files may sit further
        // down. Do not delete, and do not report a made-up zero.
        const subdirs = tree.length === 0 ? await pace(() => executor.listChildDirectories(child.id)) : [];
        if (tree.length === 0 && subdirs.length === 0) {
          const result = await pace(() => executor.removeDirectory(child.id));
          if (result.removed) {
            removed += 1;
          } else {
            notRemoved += 1;
          }
          continue;
        }
        if (reported.has(reportedToken(drive.storageId, child.id))) {
          continue;
        }
        const unknownContents = tree.length === 0;
        const totalBytes = unknownContents
          ? 0
          : tree.reduce((sum, file) => sum + (Number.isFinite(file.sizeBytes) ? file.sizeBytes : 0), 0);
        pending.push({
          showName: show.name,
          directoryId: child.id,
          directoryName: child.name,
          fileCount: tree.length,
          totalBytes,
          unknownContents,
        });
      }
    } catch (error) {
      await repository.setAccountSetting(drive.accountId, cursorKey(drive.storageId), show.id);
      await flush();
      throw error;
    }
  }

  const newlyReported = await flush();
  await repository.setAccountSetting(drive.accountId, cursorKey(drive.storageId), "");
  return { removed, reported: newlyReported, notRemoved };
}

/**
 * Daily-patrol pass over leftover `staging-<runId>` dirs. Empty orphans (the run
 * is not queued/running — missing counts) are removed. Non-empty ones are kept
 * and reported once per drive per sweep: a prior run may have marked those
 * episodes obtained while the files never left staging.
 *
 * ponytail: one fresh executor per drive, so the 115 guard still caps a single
 * sweep (~295 listings). A listing throw stores `staging_janitor_cursor:<storageId>`
 * (the show dir id) and the next sweep continues there. pan123 calls are spaced
 * 1500ms; other brands are not. Sequential on purpose.
 */
export async function sweepOrphanStagingDirs(input: {
  repository: SweepRepository;
  drives: StagingJanitorDrive[];
  now: string;
  clock?: StagingJanitorClock;
  log?: (line: string) => void;
}): Promise<void> {
  const log = input.log ?? ((line: string) => console.log(line));
  const clock = input.clock ?? realtimeClock;
  for (const drive of input.drives) {
    try {
      const counts = await sweepDrive(drive, input.repository, input.now, clock);
      const removal =
        counts.notRemoved > 0
          ? `removed ${counts.removed} empty (${counts.notRemoved} could not be removed)`
          : `removed ${counts.removed} empty`;
      log(
        `[patrol] staging janitor ${drive.storageId}: ${removal}, reported ${counts.reported} non-empty`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[patrol] staging janitor ${drive.storageId}: failed: ${message}`);
    }
  }
}
