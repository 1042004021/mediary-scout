import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository, sweepOrphanStagingDirs, type StagingJanitorDrive } from "../src/index.js";
import type { WorkflowRun } from "../src/domain.js";
import type { PersistedWorkflowRunSnapshot } from "../src/repository.js";

const NOW = "2026-09-27T03:00:00.000Z";

interface Dir {
  id: string;
  name: string;
  parentId: string;
}
interface StoredFile {
  dirId: string;
  path: string;
  providerFileId: string;
  sizeBytes: number;
}

function memoryDrive(seed: { dirs: Dir[]; files?: StoredFile[] }) {
  const dirs = seed.dirs.map((dir) => ({ ...dir }));
  const files = (seed.files ?? []).map((file) => ({ ...file }));
  const removed: string[] = [];
  const executor = {
    async listChildDirectories(parentId: string) {
      return dirs.filter((dir) => dir.parentId === parentId).map((dir) => ({ id: dir.id, name: dir.name }));
    },
    async listTree(input: { directoryId: string; maxDepth?: number }) {
      const maxDepth = input.maxDepth ?? 6;
      const dirIds = new Set<string>();
      const walk = (dirId: string, depth: number) => {
        if (depth > maxDepth) return;
        dirIds.add(dirId);
        for (const dir of dirs) {
          if (dir.parentId === dirId) walk(dir.id, depth + 1);
        }
      };
      walk(input.directoryId, 1);
      return files
        .filter((file) => dirIds.has(file.dirId))
        .map((file) => ({ path: file.path, providerFileId: file.providerFileId, sizeBytes: file.sizeBytes }));
    },
    async listSubdirectories(input: { directoryId: string; maxDepth?: number }) {
      const maxDepth = input.maxDepth ?? 6;
      const results: Array<{ id: string; path: string }> = [];
      const walk = (dirId: string, prefix: string, depth: number) => {
        if (depth > maxDepth) return;
        for (const dir of dirs) {
          if (dir.parentId !== dirId) continue;
          const path = `${prefix}${dir.name}`;
          results.push({ id: dir.id, path });
          walk(dir.id, `${path}/`, depth + 1);
        }
      };
      walk(input.directoryId, "", 1);
      return results;
    },
    async removeDirectory(id: string) {
      removed.push(id);
      const drop = new Set<string>();
      const stack = [id];
      while (stack.length > 0) {
        const current = stack.pop()!;
        drop.add(current);
        for (const dir of dirs) {
          if (dir.parentId === current) stack.push(dir.id);
        }
      }
      for (let index = dirs.length - 1; index >= 0; index -= 1) {
        if (drop.has(dirs[index]!.id)) dirs.splice(index, 1);
      }
      for (let index = files.length - 1; index >= 0; index -= 1) {
        if (drop.has(files[index]!.dirId)) files.splice(index, 1);
      }
      return { removed: true as const };
    },
  };
  return { executor, removed, dirs, files };
}

function drive(partial: Partial<StagingJanitorDrive> & Pick<StagingJanitorDrive, "storageId" | "executor">): StagingJanitorDrive {
  return {
    accountId: "acct",
    status: "active",
    provider: "pan115",
    tvCid: "tv",
    animeCid: null,
    ...partial,
  };
}

async function saveRun(
  repo: InMemoryWorkflowRepository,
  run: Pick<WorkflowRun, "id" | "status"> & Partial<WorkflowRun>,
): Promise<void> {
  await repo.saveWorkflowRunSnapshot({
    accountId: "acct",
    connectedStorageId: "drive-good",
    title: {
      id: "title_show",
      tmdbId: 7,
      type: "tv",
      title: "Show A",
      originalTitle: "Show A",
      year: 2024,
      aliases: [],
    },
    season: {
      id: "title_show_s1",
      mediaTitleId: "title_show",
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "showA",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    },
    workflowRun: {
      kind: "type3_monitor",
      trackedSeasonId: "title_show_s1",
      startedAt: NOW,
      finishedAt: null,
      auditEvents: [],
      ...run,
    },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

/** A finished run so the show dir id is a tracked season's storage dir, and the title is not active. */
async function saveTracked(
  repo: InMemoryWorkflowRepository,
  storageId: string,
  showId: string,
  titleName: string,
  tmdbId: number,
): Promise<void> {
  const titleId = `title_${tmdbId}`;
  await repo.saveWorkflowRunSnapshot({
    accountId: "acct",
    connectedStorageId: storageId,
    title: {
      id: titleId,
      tmdbId,
      type: "tv",
      title: titleName,
      originalTitle: titleName,
      year: 2024,
      aliases: [],
    },
    season: {
      id: `${titleId}_s1`,
      mediaTitleId: titleId,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: showId,
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    },
    workflowRun: {
      id: `done-${tmdbId}`,
      kind: "type3_monitor",
      status: "succeeded",
      trackedSeasonId: `${titleId}_s1`,
      startedAt: "2026-09-26T00:00:00.000Z",
      finishedAt: "2026-09-26T01:00:00.000Z",
      auditEvents: [],
    },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

function stagingDir(run: PersistedWorkflowRunSnapshot): string {
  const event = run.workflowRun.auditEvents.find((item) => item.type === "staging_recovery_queued");
  const id = event?.data?.["stagingDirectoryId"];
  return typeof id === "string" ? id : "";
}

async function recoveriesOf(repo: InMemoryWorkflowRepository, storageId: string): Promise<PersistedWorkflowRunSnapshot[]> {
  return (await repo.listActiveWorkflowRuns({ accountId: "acct", connectedStorageId: storageId })).filter(
    (run) => run.workflowRun.kind === "staging_recovery",
  );
}

function library() {
  return memoryDrive({
    dirs: [
      { id: "tv", name: "TV", parentId: "root" },
      { id: "anime", name: "Anime", parentId: "root" },
      { id: "showA", name: "Show A", parentId: "tv" },
      { id: "season", name: "Season 01", parentId: "showA" },
      { id: "extras", name: "extras", parentId: "showA" },
      { id: "stg-active", name: "staging-run-active", parentId: "showA" },
      { id: "stg-empty", name: "staging-run-empty", parentId: "showA" },
      { id: "stg-full", name: "staging-run-full", parentId: "showA" },
      { id: "showB", name: "Show B", parentId: "anime" },
      { id: "stg-anime-empty", name: "staging-run-anime-empty", parentId: "showB" },
    ],
    files: [
      { dirId: "stg-full", path: "a.mkv", providerFileId: "f1", sizeBytes: 2 * 1024 * 1024 },
      { dirId: "stg-full", path: "b.mkv", providerFileId: "f2", sizeBytes: 1024 * 1024 },
    ],
  });
}

describe("sweepOrphanStagingDirs", () => {
  it("removes empty orphans, does not queue a recovery while the title has an active run, and never notifies", async () => {
    const repo = new InMemoryWorkflowRepository();
    await saveRun(repo, { id: "run-active", status: "running" });
    const disk = library();
    const logs: string[] = [];
    const good = drive({
      storageId: "drive-good",
      tvCid: "tv",
      animeCid: "anime",
      executor: disk.executor,
    });

    await sweepOrphanStagingDirs({ repository: repo, drives: [good], now: NOW, log: (line) => logs.push(line) });

    expect(disk.removed.sort()).toEqual(["stg-anime-empty", "stg-empty"]);
    expect(disk.dirs.map((dir) => dir.id)).toEqual(
      expect.arrayContaining(["season", "extras", "stg-active", "stg-full"]),
    );
    expect(disk.dirs.some((dir) => dir.id === "stg-empty")).toBe(false);

    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
    const recoveries = (await repo.listActiveWorkflowRuns({ accountId: "acct", connectedStorageId: "drive-good" })).filter(
      (run) => run.workflowRun.kind === "staging_recovery",
    );
    expect(recoveries).toEqual([]);
    const tracked = await repo.listTrackedSeasonStates("acct");
    expect(tracked.some((state) => state.title.id.startsWith("staging-janitor"))).toBe(false);
    expect(tracked.some((state) => state.title.id === "title_show")).toBe(true);
    expect(logs.some((line) => /drive-good: removed 2 empty, queued 0 recovery/.test(line))).toBe(true);

    await sweepOrphanStagingDirs({ repository: repo, drives: [good], now: NOW, log: () => undefined });
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
    expect(disk.dirs.some((dir) => dir.id === "stg-full")).toBe(true);
    expect(disk.removed.filter((id) => id === "stg-full")).toEqual([]);
  });

  it("a drive that throws does not stop the next drive", async () => {
    const repo = new InMemoryWorkflowRepository();
    const disk = memoryDrive({
      dirs: [
        { id: "tv", name: "TV", parentId: "root" },
        { id: "show", name: "Next Show", parentId: "tv" },
        { id: "stg-empty", name: "staging-run-gone", parentId: "show" },
      ],
    });
    const logs: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [
        drive({
          storageId: "drive-broken",
          executor: {
            async listChildDirectories() {
              throw new Error("drive down");
            },
            async listTree() {
              throw new Error("drive down");
            },
            async removeDirectory() {
              throw new Error("drive down");
            },
          },
        }),
        drive({ storageId: "drive-next", executor: disk.executor }),
      ],
    });
    expect(disk.removed).toEqual(["stg-empty"]);
    expect(logs.some((line) => /drive-next: removed 1 empty, queued 0 recovery/.test(line))).toBe(true);
    expect(logs.some((line) => /drive-broken: failed: drive down/.test(line))).toBe(true);
  });

  it("skips a frozen drive", async () => {
    const repo = new InMemoryWorkflowRepository();
    const disk = memoryDrive({
      dirs: [
        { id: "tv", name: "TV", parentId: "root" },
        { id: "show", name: "Frozen Show", parentId: "tv" },
        { id: "stg-empty", name: "staging-run-frozen", parentId: "show" },
      ],
    });
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [drive({ storageId: "drive-frozen", status: "frozen", executor: disk.executor })],
    });
    expect(disk.removed).toEqual([]);
    expect(disk.dirs.some((dir) => dir.id === "stg-empty")).toBe(true);
  });

  it("queues one staging_recovery for a settled non-empty orphan and does not queue it again", async () => {
    const repo = new InMemoryWorkflowRepository();
    const disk = memoryDrive({
      dirs: [
        { id: "tv", name: "TV", parentId: "root" },
        { id: "showA", name: "Show A", parentId: "tv" },
        { id: "stg-a", name: "staging-run-a", parentId: "showA" },
        { id: "showB", name: "Show B", parentId: "tv" },
        { id: "stg-b", name: "staging-run-b", parentId: "showB" },
      ],
      files: [
        { dirId: "stg-a", path: "a.mkv", providerFileId: "a", sizeBytes: 2 * 1024 * 1024 },
        { dirId: "stg-b", path: "b.mkv", providerFileId: "b", sizeBytes: 1024 * 1024 },
      ],
    });
    await saveTracked(repo, "drive-batch", "showA", "Show A", 11);
    await saveTracked(repo, "drive-batch", "showB", "Show B", 12);
    const good = drive({ storageId: "drive-batch", executor: disk.executor });
    await sweepOrphanStagingDirs({ repository: repo, drives: [good], now: "2026-09-27T03:00:00.000Z" });
    const first = await recoveriesOf(repo, "drive-batch");
    expect(first.map((run) => stagingDir(run)).sort()).toEqual(["stg-a", "stg-b"]);
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);

    await sweepOrphanStagingDirs({ repository: repo, drives: [good], now: "2026-09-28T03:00:00.000Z" });
    const again = await recoveriesOf(repo, "drive-batch");
    expect(again.map((run) => run.workflowRun.id).sort()).toEqual(first.map((run) => run.workflowRun.id).sort());
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
  });

  it("does not queue when a recovery for that staging dir is already queued and the show itself is idle", async () => {
    // A recovery stored on this show is an active run, so the busy-title set
    // skips the show before the per-dir lookup. Recording it under another title
    // that names the same dir is the case only findActiveStagingRecovery decides.
    const repo = new InMemoryWorkflowRepository();
    const disk = memoryDrive({
      dirs: [
        { id: "tv", name: "TV", parentId: "root" },
        { id: "showA", name: "Show A", parentId: "tv" },
        { id: "stg-a", name: "staging-run-old", parentId: "showA" },
      ],
      files: [{ dirId: "stg-a", path: "a.mkv", providerFileId: "a", sizeBytes: 2 * 1024 * 1024 }],
    });
    await saveTracked(repo, "drive-dedupe", "showA", "Show A", 11);
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct",
      connectedStorageId: "drive-dedupe",
      title: {
        id: "title_other",
        tmdbId: 99,
        type: "tv",
        title: "Other",
        originalTitle: "Other",
        year: 2020,
        aliases: [],
      },
      season: {
        id: "title_other_s1",
        mediaTitleId: "title_other",
        seasonNumber: 1,
        status: "active",
        qualityPreference: "1080p",
        storageDirectoryId: "somewhere-else",
        totalEpisodes: 1,
        latestAiredEpisode: 1,
        latestAiredSource: "metadata",
      },
      workflowRun: {
        id: "recovery-already",
        kind: "staging_recovery",
        status: "queued",
        trackedSeasonId: "title_other_s1",
        startedAt: "2026-09-27T02:00:00.000Z",
        finishedAt: null,
        auditEvents: [
          {
            type: "staging_recovery_queued",
            message: "already queued",
            data: { stagingDirectoryId: "stg-a", showDirectoryId: "showA", seasonNumbers: [1] },
          },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    await sweepOrphanStagingDirs({
      repository: repo,
      drives: [drive({ storageId: "drive-dedupe", executor: disk.executor })],
      now: "2026-09-28T03:00:00.000Z",
    });

    const recoveries = await recoveriesOf(repo, "drive-dedupe");
    expect(recoveries.map((run) => run.workflowRun.id)).toEqual(["recovery-already"]);
    expect(disk.removed).toEqual([]);
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
  });

  it("queues at most 5 recovery runs per drive per sweep", async () => {
    const repo = new InMemoryWorkflowRepository();
    const dirs: Array<{ id: string; name: string; parentId: string }> = [{ id: "tv", name: "TV", parentId: "root" }];
    const files: Array<{ dirId: string; path: string; providerFileId: string; sizeBytes: number }> = [];
    for (let n = 1; n <= 11; n += 1) {
      const showId = `show-${n}`;
      const stgId = `stg-${n}`;
      dirs.push({ id: showId, name: `S${String(n).padStart(2, "0")}`, parentId: "tv" });
      dirs.push({ id: stgId, name: `staging-run-${n}`, parentId: showId });
      files.push({ dirId: stgId, path: "a.mkv", providerFileId: `f-${n}`, sizeBytes: 1024 * 1024 });
    }
    const disk = memoryDrive({ dirs, files });
    for (let n = 1; n <= 6; n += 1) {
      await saveTracked(repo, "drive-many", `show-${n}`, `Show ${n}`, n);
    }
    await sweepOrphanStagingDirs({
      repository: repo,
      drives: [drive({ storageId: "drive-many", executor: disk.executor })],
      now: NOW,
    });
    const queued = await recoveriesOf(repo, "drive-many");
    expect(queued).toHaveLength(5);
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
    expect(disk.dirs.some((dir) => dir.id === "stg-6")).toBe(true);
  });

  it("spaces pan123 calls by 1500ms and does not space other brands", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const clock = {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    };
    function timed(label: string) {
      const times: number[] = [];
      return {
        times,
        executor: {
          async listChildDirectories(parentId: string) {
            times.push(now);
            if (parentId === "tv") return [{ id: "show", name: label }];
            if (parentId === "show") return [{ id: "stg", name: "staging-old" }];
            return [];
          },
          async listTree() {
            times.push(now);
            return [];
          },
          async listSubdirectories() {
            times.push(now);
            return [];
          },
          async removeDirectory(id: string) {
            times.push(now);
            return { removed: id.length > 0 };
          },
        },
      };
    }
    const pan123 = timed("123");
    const pan115 = timed("115");
    const repo = new InMemoryWorkflowRepository();
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      clock,
      drives: [
        drive({ storageId: "d123", provider: "pan123", executor: pan123.executor }),
        drive({ storageId: "d115", provider: "pan115", executor: pan115.executor }),
      ],
    });
    // category, show, listTree, listSubdirectories, removeDirectory — four gaps.
    // An empty file walk still lists subdirectories, to see whether the depth limit hid a file.
    expect(pan123.times.slice(1).map((time, index) => time - pan123.times[index]!)).toEqual([1500, 1500, 1500, 1500]);
    expect(pan115.times.every((time) => time === pan115.times[0])).toBe(true);
    expect(sleeps).toEqual([1500, 1500, 1500, 1500]);
  });

  it("resumes a cut-short walk at the show that threw, and clears the cursor after a full walk", async () => {
    const repo = new InMemoryWorkflowRepository();
    let failShowB = true;
    const visited: string[] = [];
    const executor = {
      async listChildDirectories(parentId: string) {
        if (parentId === "tv") {
          return [
            { id: "showA", name: "A" },
            { id: "showB", name: "B" },
            { id: "showC", name: "C" },
          ];
        }
        visited.push(parentId);
        if (parentId === "showB" && failShowB) {
          throw new Error("budget exhausted");
        }
        return [];
      },
      async listTree() {
        return [];
      },
      async removeDirectory() {
        return { removed: true };
      },
    };
    const target = drive({ storageId: "drive-resume", executor });
    await sweepOrphanStagingDirs({ repository: repo, drives: [target], now: NOW });
    expect(visited).toEqual(["showA", "showB"]);
    expect(await repo.getAccountSetting("acct", "staging_janitor_cursor:drive-resume")).toBe("showB");

    failShowB = false;
    await sweepOrphanStagingDirs({ repository: repo, drives: [target], now: "2026-09-28T03:00:00.000Z" });
    expect(visited).toEqual(["showA", "showB", "showB", "showC"]);
    expect(await repo.getAccountSetting("acct", "staging_janitor_cursor:drive-resume")).toBe("");
  });

  it("stops before the next show when an update hold starts, and resumes there next time", async () => {
    const repo = new InMemoryWorkflowRepository();
    const visited: string[] = [];
    const executor = {
      async listChildDirectories(parentId: string) {
        if (parentId === "tv") {
          return [
            { id: "showA", name: "A" },
            { id: "showB", name: "B" },
          ];
        }
        visited.push(parentId);
        return [];
      },
      async listTree() {
        return [];
      },
      async removeDirectory() {
        return { removed: true };
      },
    };
    const first = drive({ storageId: "drive-held", executor });
    const second = drive({ storageId: "drive-after", executor });
    const logs: string[] = [];
    const result = await sweepOrphanStagingDirs({
      repository: repo,
      drives: [first, second],
      now: NOW,
      log: (line) => logs.push(line),
      // The hold is taken while showA is being looked at.
      mayStartRun: () => !visited.includes("showA"),
    });
    expect(result).toEqual({ held: true });
    expect(visited).toEqual(["showA"]);
    expect(await repo.getAccountSetting("acct", "staging_janitor_cursor:drive-held")).toBe("showB");
    expect(logs.some((line) => line.includes("an update is about to replace this process"))).toBe(true);

    const again = await sweepOrphanStagingDirs({ repository: repo, drives: [first], now: NOW, mayStartRun: () => true });
    expect(again).toEqual({ held: false });
    expect(visited).toEqual(["showA", "showB"]);
    expect(await repo.getAccountSetting("acct", "staging_janitor_cursor:drive-held")).toBe("");
  });

  it("retries a 100011 inside one listTree, then finishes the walk", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const clock = {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    };
    let trees = 0;
    const executor = {
      async listChildDirectories(parentId: string) {
        if (parentId === "tv") return [{ id: "show", name: "Show" }];
        if (parentId === "show") return [{ id: "stg", name: "staging-old" }];
        return [];
      },
      async listTree() {
        trees += 1;
        if (trees === 1) {
          throw new Error("PAN123_FAILED(/file/list/new): code=100011 请勿频繁操作");
        }
        return [];
      },
      async listSubdirectories() {
        return [];
      },
      async removeDirectory() {
        return { removed: true };
      },
    };
    const repo = new InMemoryWorkflowRepository();
    const logs: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      clock,
      log: (line) => logs.push(line),
      drives: [drive({ storageId: "d-retry", provider: "pan115", executor })],
    });
    expect(trees).toBe(2);
    expect(sleeps).toContain(30000);
    expect(logs.some((line) => /d-retry: removed 1 empty, queued 0 recovery/.test(line))).toBe(true);
  });

  it("propagates a 100011 after three retries and saves the resume cursor", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const clock = {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    };
    let trees = 0;
    const executor = {
      async listChildDirectories(parentId: string) {
        if (parentId === "tv") return [{ id: "show", name: "Show" }];
        if (parentId === "show") return [{ id: "stg", name: "staging-old" }];
        return [];
      },
      async listTree() {
        trees += 1;
        throw new Error("PAN123_FAILED(/file/list/new): code=100011 请勿频繁操作");
      },
      async removeDirectory() {
        return { removed: true };
      },
    };
    const repo = new InMemoryWorkflowRepository();
    const logs: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      clock,
      log: (line) => logs.push(line),
      drives: [drive({ storageId: "d-limit", provider: "pan115", executor })],
    });
    expect(trees).toBe(4);
    expect(sleeps).toEqual([30000, 60000, 120000]);
    expect(await repo.getAccountSetting("acct", "staging_janitor_cursor:d-limit")).toBe("show");
    expect(logs.some((line) => /d-limit: failed: .*100011/.test(line))).toBe(true);
  });

  it("logs an empty orphan whose removeDirectory returned removed:false", async () => {
    const repo = new InMemoryWorkflowRepository();
    const logs: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [
        drive({
          storageId: "drive-stuck",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Show" }];
              if (parentId === "show") return [{ id: "stg", name: "staging-old" }];
              return [];
            },
            async listTree() {
              return [];
            },
            async listSubdirectories() {
              return [];
            },
            async removeDirectory() {
              return { removed: false };
            },
          },
        }),
      ],
    });
    expect(logs).toContain(
      "[patrol] staging janitor drive-stuck: removed 0 empty (1 could not be removed), queued 0 recovery",
    );
  });

  it("removes a wrapper-only orphan (one empty subdirectory, no files) and does not notify", async () => {
    const removed: string[] = [];
    const repo = new InMemoryWorkflowRepository();
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [
        drive({
          storageId: "drive-deep",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Deep Show" }];
              if (parentId === "show") return [{ id: "stg-deep", name: "staging-run-deep" }];
              if (parentId === "stg-deep") return [{ id: "nested", name: "pack" }];
              return [];
            },
            async listTree() {
              return [];
            },
            async listSubdirectories() {
              return [{ id: "nested", path: "pack" }];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual(["stg-deep"]);
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
  });

  it("asks listTree for maxDepth 10", async () => {
    const depths: Array<number | undefined> = [];
    const repo = new InMemoryWorkflowRepository();
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [
        drive({
          storageId: "drive-depth",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Deep Show" }];
              if (parentId === "show") return [{ id: "stg-deep", name: "staging-run-deep" }];
              return [{ id: "nested", name: "pack" }];
            },
            async listTree(input: { directoryId: string; maxDepth?: number }) {
              depths.push(input.maxDepth);
              if ((input.maxDepth ?? 0) >= 10) {
                return [{ path: "pack/a.mkv", providerFileId: "f1", sizeBytes: 2 * 1024 * 1024 }];
              }
              return [];
            },
            async removeDirectory() {
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(depths).toEqual([10]);
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
  });

  it("removes a staging dir that has no files and no subdirectories", async () => {
    const removed: string[] = [];
    const repo = new InMemoryWorkflowRepository();
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [
        drive({
          storageId: "drive-bare",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Bare Show" }];
              if (parentId === "show") return [{ id: "stg-bare", name: "staging-run-bare" }];
              return [];
            },
            async listTree() {
              return [];
            },
            async listSubdirectories() {
              return [];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual(["stg-bare"]);
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
  });

  it("leaves a recently finished run's staging alone and removes one that settled over an hour ago", async () => {
    const repo = new InMemoryWorkflowRepository();
    await saveRun(repo, {
      id: "run-recent",
      status: "failed",
      startedAt: "2026-09-27T02:40:00.000Z",
      finishedAt: "2026-09-27T02:50:00.000Z",
    });
    await saveRun(repo, {
      id: "run-old",
      status: "failed",
      startedAt: "2026-09-27T00:30:00.000Z",
      finishedAt: "2026-09-27T01:00:00.000Z",
    });
    const disk = memoryDrive({
      dirs: [
        { id: "tv", name: "TV", parentId: "root" },
        { id: "show", name: "Show", parentId: "tv" },
        { id: "stg-recent", name: "staging-run-recent", parentId: "show" },
        { id: "stg-old", name: "staging-run-old", parentId: "show" },
        { id: "stg-missing", name: "staging-run-missing", parentId: "show" },
      ],
    });
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [drive({ storageId: "drive-settle", executor: disk.executor })],
    });
    expect(disk.removed.sort()).toEqual(["stg-missing", "stg-old"]);
    expect(disk.dirs.some((dir) => dir.id === "stg-recent")).toBe(true);
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
  });

  it("does not remove a staging dir whose run becomes active before the delete", async () => {
    const inner = new InMemoryWorkflowRepository();
    await saveRun(inner, {
      id: "run-flip",
      status: "failed",
      startedAt: "2026-09-27T00:30:00.000Z",
      finishedAt: "2026-09-27T01:00:00.000Z",
    });
    let reads = 0;
    const repo = {
      getWorkflowRunSnapshot: async (id: string, scope?: string) => {
        const snapshot = await inner.getWorkflowRunSnapshot(id, scope);
        if (id !== "run-flip" || !snapshot) return snapshot;
        reads += 1;
        if (reads < 2) return snapshot;
        return { ...snapshot, workflowRun: { ...snapshot.workflowRun, status: "running" as const } };
      },
      getAccountSetting: (accountId: string, key: string) => inner.getAccountSetting(accountId, key),
      setAccountSetting: (accountId: string, key: string, value: string) =>
        inner.setAccountSetting(accountId, key, value),
      saveWorkflowRunSnapshot: (input: Parameters<InMemoryWorkflowRepository["saveWorkflowRunSnapshot"]>[0]) =>
        inner.saveWorkflowRunSnapshot(input),
      listTrackedSeasonStates: (scope?: Parameters<InMemoryWorkflowRepository["listTrackedSeasonStates"]>[0]) =>
        inner.listTrackedSeasonStates(scope),
      listActiveWorkflowRuns: (scope?: Parameters<InMemoryWorkflowRepository["listActiveWorkflowRuns"]>[0]) =>
        inner.listActiveWorkflowRuns(scope),
      findActiveStagingRecovery: (input: Parameters<InMemoryWorkflowRepository["findActiveStagingRecovery"]>[0]) =>
        inner.findActiveStagingRecovery(input),
      reserveWorkflowRun: (input: Parameters<InMemoryWorkflowRepository["reserveWorkflowRun"]>[0]) =>
        inner.reserveWorkflowRun(input),
    };
    const removed: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [
        drive({
          storageId: "drive-flip",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Show" }];
              if (parentId === "show") return [{ id: "stg-flip", name: "staging-run-flip" }];
              return [];
            },
            async listTree() {
              return [];
            },
            async listSubdirectories() {
              return [];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual([]);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("does not remove a staging dir whose run becomes active during the subdirectory listing", async () => {
    const inner = new InMemoryWorkflowRepository();
    await saveRun(inner, {
      id: "run-late",
      status: "failed",
      startedAt: "2026-09-27T00:30:00.000Z",
      finishedAt: "2026-09-27T01:00:00.000Z",
    });
    // The run is requeued while the janitor walks the subdirectories: every read
    // after that walk sees it running again.
    let flipped = false;
    const repo = {
      getWorkflowRunSnapshot: async (id: string, scope?: string) => {
        const snapshot = await inner.getWorkflowRunSnapshot(id, scope);
        if (id !== "run-late" || !snapshot || !flipped) return snapshot;
        return { ...snapshot, workflowRun: { ...snapshot.workflowRun, status: "running" as const } };
      },
      getAccountSetting: (accountId: string, key: string) => inner.getAccountSetting(accountId, key),
      setAccountSetting: (accountId: string, key: string, value: string) =>
        inner.setAccountSetting(accountId, key, value),
      saveWorkflowRunSnapshot: (input: Parameters<InMemoryWorkflowRepository["saveWorkflowRunSnapshot"]>[0]) =>
        inner.saveWorkflowRunSnapshot(input),
      listTrackedSeasonStates: (scope?: Parameters<InMemoryWorkflowRepository["listTrackedSeasonStates"]>[0]) =>
        inner.listTrackedSeasonStates(scope),
      listActiveWorkflowRuns: (scope?: Parameters<InMemoryWorkflowRepository["listActiveWorkflowRuns"]>[0]) =>
        inner.listActiveWorkflowRuns(scope),
      findActiveStagingRecovery: (input: Parameters<InMemoryWorkflowRepository["findActiveStagingRecovery"]>[0]) =>
        inner.findActiveStagingRecovery(input),
      reserveWorkflowRun: (input: Parameters<InMemoryWorkflowRepository["reserveWorkflowRun"]>[0]) =>
        inner.reserveWorkflowRun(input),
    };
    const removed: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [
        drive({
          storageId: "drive-late",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Show" }];
              if (parentId === "show") return [{ id: "stg-late", name: "staging-run-late" }];
              return [];
            },
            async listTree() {
              return [];
            },
            async listSubdirectories() {
              flipped = true;
              return [];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(flipped).toBe(true);
    expect(removed).toEqual([]);
  });

  it("does not queue a non-empty leftover whose run becomes active during the listing", async () => {
    const inner = new InMemoryWorkflowRepository();
    await saveRun(inner, {
      id: "run-report",
      status: "failed",
      startedAt: "2026-09-27T00:30:00.000Z",
      finishedAt: "2026-09-27T01:00:00.000Z",
    });
    let reads = 0;
    const repo = {
      getWorkflowRunSnapshot: async (id: string, scope?: string) => {
        const snapshot = await inner.getWorkflowRunSnapshot(id, scope);
        if (id !== "run-report" || !snapshot) return snapshot;
        reads += 1;
        if (reads < 2) return snapshot;
        return { ...snapshot, workflowRun: { ...snapshot.workflowRun, status: "running" as const } };
      },
      getAccountSetting: (accountId: string, key: string) => inner.getAccountSetting(accountId, key),
      setAccountSetting: (accountId: string, key: string, value: string) =>
        inner.setAccountSetting(accountId, key, value),
      saveWorkflowRunSnapshot: (input: Parameters<InMemoryWorkflowRepository["saveWorkflowRunSnapshot"]>[0]) =>
        inner.saveWorkflowRunSnapshot(input),
      listTrackedSeasonStates: (scope?: Parameters<InMemoryWorkflowRepository["listTrackedSeasonStates"]>[0]) =>
        inner.listTrackedSeasonStates(scope),
      listActiveWorkflowRuns: (scope?: Parameters<InMemoryWorkflowRepository["listActiveWorkflowRuns"]>[0]) =>
        inner.listActiveWorkflowRuns(scope),
      findActiveStagingRecovery: (input: Parameters<InMemoryWorkflowRepository["findActiveStagingRecovery"]>[0]) =>
        inner.findActiveStagingRecovery(input),
      reserveWorkflowRun: (input: Parameters<InMemoryWorkflowRepository["reserveWorkflowRun"]>[0]) =>
        inner.reserveWorkflowRun(input),
    };
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [
        drive({
          storageId: "drive-report",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Show" }];
              if (parentId === "show") return [{ id: "stg-report", name: "staging-run-report" }];
              return [];
            },
            async listTree() {
              return [{ path: "a.mkv", providerFileId: "f1", sizeBytes: 1024 * 1024 }];
            },
            async listSubdirectories() {
              return [];
            },
            async removeDirectory() {
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(await inner.listNotifications({ accountId: "acct" })).toEqual([]);
    expect(await recoveriesOf(inner, "drive-report")).toEqual([]);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("does not remove an orphan whose only file sits below the listing depth, and does not queue it", async () => {
    const removed: string[] = [];
    const repo = new InMemoryWorkflowRepository();
    const logs: string[] = [];
    const deepPath = Array.from({ length: 10 }, (_, index) => `L${index + 1}`).join("/");
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [
        drive({
          storageId: "drive-unseen",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Show" }];
              if (parentId === "show") return [{ id: "stg-deep", name: "staging-old" }];
              return [];
            },
            // The file is inside the tenth directory. listTree stops before opening it.
            async listTree() {
              return [];
            },
            async listSubdirectories() {
              return [{ id: "bottom", path: deepPath }];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual([]);
    expect(await recoveriesOf(repo, "drive-unseen")).toEqual([]);
    expect(logs.some((line) => /drive-unseen: removed 0 empty, queued 0 recovery, skipped 1 deep/.test(line))).toBe(true);
  });

  it("still removes an orphan that holds only empty wrapper folders", async () => {
    const removed: string[] = [];
    const repo = new InMemoryWorkflowRepository();
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [
        drive({
          storageId: "drive-wrappers",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Show" }];
              if (parentId === "show") return [{ id: "stg-wrap", name: "staging-old" }];
              return [];
            },
            async listTree() {
              return [];
            },
            async listSubdirectories() {
              return [
                { id: "wrap", path: "双轨" },
                { id: "inner", path: "双轨/inner" },
              ];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual(["stg-wrap"]);
  });

  it("does not queue a leftover that has a visible file and another file below the depth limit", async () => {
    const repo = new InMemoryWorkflowRepository();
    await saveTracked(repo, "drive-mixed", "show", "Show", 42);
    const removed: string[] = [];
    const logs: string[] = [];
    const deepPath = Array.from({ length: 10 }, (_, index) => `L${index + 1}`).join("/");
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [
        drive({
          storageId: "drive-mixed",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Show" }];
              if (parentId === "show") return [{ id: "stg-mixed", name: "staging-old" }];
              return [];
            },
            async listTree() {
              return [{ path: "Show.S01E01.mkv", providerFileId: "seen", sizeBytes: 1024 * 1024 }];
            },
            async listSubdirectories() {
              return [
                { id: "wrap", path: "双轨" },
                { id: "bottom", path: deepPath },
              ];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual([]);
    expect(await recoveriesOf(repo, "drive-mixed")).toEqual([]);
    expect(logs.some((line) => /drive-mixed: removed 0 empty, queued 0 recovery, skipped 1 deep/.test(line))).toBe(true);
  });

  it("still queues a recovery when the depth-limited walk sees a file", async () => {
    const repo = new InMemoryWorkflowRepository();
    await saveTracked(repo, "drive-seen", "show", "Show", 41);
    const removed: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [
        drive({
          storageId: "drive-seen",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Show" }];
              if (parentId === "show") return [{ id: "stg-file", name: "staging-old" }];
              return [];
            },
            async listTree() {
              return [{ path: "Show.S01E01.mkv", providerFileId: "f1", sizeBytes: 1024 * 1024 }];
            },
            async listSubdirectories() {
              return [{ id: "wrap", path: "双轨" }];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual([]);
    const queued = await recoveriesOf(repo, "drive-seen");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.workflowRun.auditEvents.some((event) => event.data?.["stagingDirectoryId"] === "stg-file")).toBe(true);
  });

  it("removes a settled non-empty leftover under an untracked {tmdb-N} show and leaves the show", async () => {
    const repo = new InMemoryWorkflowRepository();
    const disk = memoryDrive({
      dirs: [
        { id: "tv", name: "TV", parentId: "root" },
        { id: "show", name: "Gone Show (2020) {tmdb-77}", parentId: "tv" },
        { id: "season", name: "Season 01", parentId: "show" },
        { id: "stg", name: "staging-run-gone", parentId: "show" },
      ],
      files: [{ dirId: "stg", path: "a.mkv", providerFileId: "a", sizeBytes: 2 * 1024 * 1024 }],
    });
    const logs: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [drive({ storageId: "drive-untracked", executor: disk.executor })],
    });
    expect(disk.removed).toEqual(["stg"]);
    expect(disk.dirs.map((dir) => dir.id).sort()).toEqual(["season", "show", "tv"]);
    expect(await recoveriesOf(repo, "drive-untracked")).toEqual([]);
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
    expect(
      logs.some((line) => /drive-untracked: removed 0 empty, queued 0 recovery, removed 1 untracked/.test(line)),
    ).toBe(true);
  });

  it("does not remove a {tmdb-N} leftover when that id is tracked but the folder does not match", async () => {
    const repo = new InMemoryWorkflowRepository();
    await saveTracked(repo, "drive-mismatch", "other-show", "Real Show", 42);
    const disk = memoryDrive({
      dirs: [
        { id: "tv", name: "TV", parentId: "root" },
        { id: "show", name: "Wrong Name (1999) {tmdb-42}", parentId: "tv" },
        { id: "season", name: "Season 01", parentId: "show" },
        { id: "stg", name: "staging-run-old", parentId: "show" },
      ],
      files: [{ dirId: "stg", path: "a.mkv", providerFileId: "a", sizeBytes: 1024 * 1024 }],
    });
    const logs: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [drive({ storageId: "drive-mismatch", executor: disk.executor })],
    });
    expect(disk.removed).toEqual([]);
    expect(disk.dirs.some((dir) => dir.id === "stg")).toBe(true);
    expect(await recoveriesOf(repo, "drive-mismatch")).toEqual([]);
    expect(
      logs.some((line) => /drive-mismatch: removed 0 empty, queued 0 recovery, skipped 1 unmatched/.test(line)),
    ).toBe(true);
  });

  it("leaves a legacy show name with no {tmdb-N} and no match, and counts it as skipped", async () => {
    const repo = new InMemoryWorkflowRepository();
    const disk = memoryDrive({
      dirs: [
        { id: "tv", name: "TV", parentId: "root" },
        { id: "show", name: "Legacy Show (2020)", parentId: "tv" },
        { id: "stg", name: "staging-run-legacy", parentId: "show" },
      ],
      files: [{ dirId: "stg", path: "a.mkv", providerFileId: "a", sizeBytes: 1024 * 1024 }],
    });
    const logs: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [drive({ storageId: "drive-legacy", executor: disk.executor })],
    });
    expect(disk.removed).toEqual([]);
    expect(disk.dirs.some((dir) => dir.id === "stg")).toBe(true);
    expect(await recoveriesOf(repo, "drive-legacy")).toEqual([]);
    expect(
      logs.some((line) => /drive-legacy: removed 0 empty, queued 0 recovery, skipped 1 unmatched/.test(line)),
    ).toBe(true);
  });

  it("does not remove an untracked {tmdb-N} leftover that has a subdirectory at the depth limit", async () => {
    const repo = new InMemoryWorkflowRepository();
    const removed: string[] = [];
    const logs: string[] = [];
    const deepPath = Array.from({ length: 10 }, (_, index) => `L${index + 1}`).join("/");
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [
        drive({
          storageId: "drive-untracked-deep",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Gone Show (2020) {tmdb-77}" }];
              if (parentId === "show") return [{ id: "stg-deep", name: "staging-run-deep" }];
              return [];
            },
            async listTree() {
              return [{ path: "a.mkv", providerFileId: "seen", sizeBytes: 1024 * 1024 }];
            },
            async listSubdirectories() {
              return [{ id: "bottom", path: deepPath }];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual([]);
    expect(await recoveriesOf(repo, "drive-untracked-deep")).toEqual([]);
    expect(
      logs.some((line) => /drive-untracked-deep: removed 0 empty, queued 0 recovery, skipped 1 deep/.test(line)),
    ).toBe(true);
  });

  it("does not remove a {tmdb-N} leftover when that id is still tracked as anime", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct",
      connectedStorageId: "drive-anime-id",
      title: {
        id: "title_anime",
        tmdbId: 77,
        type: "anime",
        title: "Anime Show",
        originalTitle: "Anime Show",
        year: 2024,
        aliases: [],
      },
      season: {
        id: "title_anime_s1",
        mediaTitleId: "title_anime",
        seasonNumber: 1,
        status: "active",
        qualityPreference: "1080p",
        storageDirectoryId: "anime-show",
        totalEpisodes: 1,
        latestAiredEpisode: 1,
        latestAiredSource: "metadata",
      },
      workflowRun: {
        id: "done-anime",
        kind: "type3_monitor",
        status: "succeeded",
        trackedSeasonId: "title_anime_s1",
        startedAt: "2026-09-26T00:00:00.000Z",
        finishedAt: "2026-09-26T01:00:00.000Z",
        auditEvents: [],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const disk = memoryDrive({
      dirs: [
        { id: "tv", name: "TV", parentId: "root" },
        { id: "show", name: "Gone Show (2020) {tmdb-77}", parentId: "tv" },
        { id: "stg", name: "staging-run-anime-id", parentId: "show" },
      ],
      files: [{ dirId: "stg", path: "a.mkv", providerFileId: "a", sizeBytes: 1024 * 1024 }],
    });
    const logs: string[] = [];
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [drive({ storageId: "drive-anime-id", executor: disk.executor })],
    });
    expect(disk.removed).toEqual([]);
    expect(await recoveriesOf(repo, "drive-anime-id")).toEqual([]);
    expect(
      logs.some((line) => /drive-anime-id: removed 0 empty, queued 0 recovery, skipped 1 unmatched/.test(line)),
    ).toBe(true);
  });

  it("does not touch a drive whose executor cannot list and remove", async () => {
    const repo = new InMemoryWorkflowRepository();
    let listed = false;
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [
        drive({
          storageId: "drive-partial",
          executor: {
            async listChildDirectories() {
              listed = true;
              return [];
            },
          },
        }),
      ],
    });
    expect(listed).toBe(false);
  });

  it("calls executor methods with this when listing a settled leftover", async () => {
    class BoundExecutor {
      readonly calls: string[] = [];
      async listChildDirectories(parentId: string) {
        this.calls.push("listChildDirectories");
        if (parentId === "tv") return [{ id: "show", name: "Show" }];
        if (parentId === "show") return [{ id: "stg-bound", name: "staging-old" }];
        return [];
      }
      async listTree() {
        this.calls.push("listTree");
        return [{ path: "Show.S01E01.mkv", providerFileId: "f1", sizeBytes: 1024 * 1024 }];
      }
      async listSubdirectories() {
        this.calls.push("listSubdirectories");
        return [];
      }
      async removeDirectory(id: string) {
        this.calls.push(`removeDirectory:${id}`);
        return { removed: true };
      }
    }
    const repo = new InMemoryWorkflowRepository();
    await saveTracked(repo, "drive-bound", "show", "Show", 41);
    const executor = new BoundExecutor();
    await sweepOrphanStagingDirs({
      repository: repo,
      now: NOW,
      drives: [drive({ storageId: "drive-bound", executor })],
    });
    expect(executor.calls).toContain("listSubdirectories");
    const queued = await recoveriesOf(repo, "drive-bound");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.workflowRun.auditEvents.some((event) => event.data?.["stagingDirectoryId"] === "stg-bound")).toBe(true);
  });

  it("does not delete an untracked leftover when the title becomes tracked during the walk", async () => {
    const inner = new InMemoryWorkflowRepository();
    let reads = 0;
    const repository = {
      getWorkflowRunSnapshot: (id: string, accountId?: string) => inner.getWorkflowRunSnapshot(id, accountId),
      getAccountSetting: (accountId: string, key: string) => inner.getAccountSetting(accountId, key),
      setAccountSetting: (accountId: string, key: string, value: string) => inner.setAccountSetting(accountId, key, value),
      listActiveWorkflowRuns: (scope?: Parameters<InMemoryWorkflowRepository["listActiveWorkflowRuns"]>[0]) =>
        inner.listActiveWorkflowRuns(scope),
      findActiveStagingRecovery: (input: Parameters<InMemoryWorkflowRepository["findActiveStagingRecovery"]>[0]) =>
        inner.findActiveStagingRecovery(input),
      reserveWorkflowRun: (input: Parameters<InMemoryWorkflowRepository["reserveWorkflowRun"]>[0]) =>
        inner.reserveWorkflowRun(input),
      listTrackedSeasonStates: async () => {
        reads += 1;
        if (reads === 1) return [];
        return [
          {
            accountId: "acct",
            connectedStorageId: "drive-late",
            title: {
              id: "title_late",
              tmdbId: 77,
              type: "tv" as const,
              title: "Gone Show",
              originalTitle: "Gone Show",
              year: 2020,
              aliases: [],
            },
            season: {
              id: "title_late_s1",
              mediaTitleId: "title_late",
              seasonNumber: 1,
              status: "active" as const,
              qualityPreference: "1080p" as const,
              storageDirectoryId: "tracked-elsewhere",
              totalEpisodes: 1,
              latestAiredEpisode: 1,
              latestAiredSource: "metadata" as const,
            },
            episodes: [],
          },
        ];
      },
    };
    const removed: string[] = [];
    const logs: string[] = [];
    await sweepOrphanStagingDirs({
      repository,
      now: NOW,
      log: (line) => logs.push(line),
      drives: [
        drive({
          storageId: "drive-late",
          executor: {
            async listChildDirectories(parentId: string) {
              if (parentId === "tv") return [{ id: "show", name: "Gone Show (2020) {tmdb-77}" }];
              if (parentId === "show") return [{ id: "stg-late", name: "staging-run-late" }];
              return [];
            },
            async listTree() {
              return [{ path: "a.mkv", providerFileId: "a", sizeBytes: 1024 * 1024 }];
            },
            async listSubdirectories() {
              return [];
            },
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).not.toContain("stg-late");
    expect(await recoveriesOf(inner, "drive-late")).toEqual([]);
    expect(logs.some((line) => /drive-late: removed 0 empty, queued 0 recovery, skipped 1 unmatched/.test(line))).toBe(true);
  });

  it("skips a show that throws on two sweeps in a row so the rest of the drive is reached", async () => {
    const repo = new InMemoryWorkflowRepository();
    const removed: string[] = [];
    const executor = {
      async listChildDirectories(parentId: string) {
        if (parentId === "tv") {
          return [
            { id: "showA", name: "A" },
            { id: "showB", name: "B" },
            { id: "showC", name: "C" },
          ];
        }
        if (parentId === "showB") throw new Error("PAN115_LIST_TOO_LARGE");
        if (parentId === "showA") return [{ id: "stg-a", name: "staging-old-a" }];
        if (parentId === "showC") return [{ id: "stg-c", name: "staging-old-c" }];
        return [];
      },
      async listTree() {
        return [];
      },
      async listSubdirectories() {
        return [];
      },
      async removeDirectory(id: string) {
        removed.push(id);
        return { removed: true };
      },
    };
    const target = drive({ storageId: "drive-stall", executor });
    await sweepOrphanStagingDirs({ repository: repo, drives: [target], now: NOW });
    expect(removed).toEqual(["stg-a"]);
    expect(await repo.getAccountSetting("acct", "staging_janitor_cursor:drive-stall")).toBe("showB");

    await sweepOrphanStagingDirs({ repository: repo, drives: [target], now: NOW });
    expect(removed).toEqual(["stg-a"]);
    expect(await repo.getAccountSetting("acct", "staging_janitor_cursor:drive-stall")).toBe("showC");

    await sweepOrphanStagingDirs({ repository: repo, drives: [target], now: NOW });
    expect(removed).toEqual(["stg-a", "stg-c"]);
  });

  it("processes a show that threw once, then continues to the shows after it", async () => {
    const repo = new InMemoryWorkflowRepository();
    const removed: string[] = [];
    let failShowB = true;
    const executor = {
      async listChildDirectories(parentId: string) {
        if (parentId === "tv") {
          return [
            { id: "showA", name: "A" },
            { id: "showB", name: "B" },
            { id: "showC", name: "C" },
          ];
        }
        if (parentId === "showB" && failShowB) throw new Error("budget exhausted");
        if (parentId === "showA") return [{ id: "stg-a", name: "staging-old-a" }];
        if (parentId === "showB") return [{ id: "stg-b", name: "staging-old-b" }];
        if (parentId === "showC") return [{ id: "stg-c", name: "staging-old-c" }];
        return [];
      },
      async listTree() {
        return [];
      },
      async listSubdirectories() {
        return [];
      },
      async removeDirectory(id: string) {
        removed.push(id);
        return { removed: true };
      },
    };
    const target = drive({ storageId: "drive-once", executor });
    await sweepOrphanStagingDirs({ repository: repo, drives: [target], now: NOW });
    expect(removed).toEqual(["stg-a"]);
    failShowB = false;
    await sweepOrphanStagingDirs({ repository: repo, drives: [target], now: NOW });
    expect(removed).toEqual(["stg-a", "stg-b", "stg-c"]);
    expect(await repo.getAccountSetting("acct", "staging_janitor_cursor:drive-once")).toBe("");
  });
});
