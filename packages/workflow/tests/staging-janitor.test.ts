import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository, sweepOrphanStagingDirs, type StagingJanitorDrive } from "../src/index.js";
import type { WorkflowRun } from "../src/domain.js";

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
    async listTree(input: { directoryId: string }) {
      const dirIds = new Set<string>();
      const stack = [input.directoryId];
      while (stack.length > 0) {
        const current = stack.pop()!;
        dirIds.add(current);
        for (const dir of dirs) {
          if (dir.parentId === current) stack.push(dir.id);
        }
      }
      return files
        .filter((file) => dirIds.has(file.dirId))
        .map((file) => ({ path: file.path, providerFileId: file.providerFileId, sizeBytes: file.sizeBytes }));
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
  it("removes empty orphans, keeps and reports a non-empty orphan once, and leaves an active run plus non-staging dirs alone", async () => {
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

    const notes = (await repo.listNotifications({ accountId: "acct" })).filter(
      (note) => note.kind === "staging_leftover",
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.title).toBe("网盘暂存目录残留（1 个）");
    expect(notes[0]?.body).toContain("Show A / staging-run-full：2 个文件，3 MB");
    expect(notes[0]?.body).toContain("这些文件不在季目录里，请到网盘手动处理。");

    const tracked = await repo.listTrackedSeasonStates("acct");
    expect(tracked.some((state) => state.title.id.startsWith("staging-janitor"))).toBe(false);
    expect(tracked.some((state) => state.title.id === "title_show")).toBe(true);
    expect(logs.some((line) => /drive-good: removed 2 empty, reported 1 non-empty/.test(line))).toBe(true);

    await sweepOrphanStagingDirs({ repository: repo, drives: [good], now: NOW, log: () => undefined });
    const again = (await repo.listNotifications({ accountId: "acct" })).filter(
      (note) => note.kind === "staging_leftover",
    );
    expect(again).toHaveLength(1);
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
    expect(logs.some((line) => /drive-next: removed 1 empty, reported 0 non-empty/.test(line))).toBe(true);
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

  it("reports every newly found non-empty orphan of one drive in a single notification", async () => {
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
    const good = drive({ storageId: "drive-batch", executor: disk.executor });
    await sweepOrphanStagingDirs({ repository: repo, drives: [good], now: "2026-09-27T03:00:00.000Z" });
    const first = (await repo.listNotifications({ accountId: "acct" })).filter((note) => note.kind === "staging_leftover");
    expect(first).toHaveLength(1);
    expect(first[0]?.title).toBe("网盘暂存目录残留（2 个）");
    expect(first[0]?.body).toContain("Show A / staging-run-a：1 个文件，2 MB");
    expect(first[0]?.body).toContain("Show B / staging-run-b：1 个文件，1 MB");
    expect(first[0]?.id).toContain("2026-09-27T03:00:00.000Z");

    disk.dirs.push({ id: "showC", name: "Show C", parentId: "tv" }, { id: "stg-c", name: "staging-run-c", parentId: "showC" });
    disk.files.push({ dirId: "stg-c", path: "c.mkv", providerFileId: "c", sizeBytes: 1024 * 1024 });
    await sweepOrphanStagingDirs({ repository: repo, drives: [good], now: "2026-09-28T03:00:00.000Z" });
    const all = (await repo.listNotifications({ accountId: "acct" })).filter((note) => note.kind === "staging_leftover");
    expect(all).toHaveLength(2);
    const second = all.find((note) => note.id.includes("2026-09-28"));
    expect(second?.title).toBe("网盘暂存目录残留（1 个）");
    expect(second?.body).toContain("Show C / staging-run-c");
    expect(second?.body).not.toContain("Show A");
    expect(second?.body).not.toContain("Show B");
  });

  it("folds more than ten directories into one notice with a total line", async () => {
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
    await sweepOrphanStagingDirs({
      repository: repo,
      drives: [drive({ storageId: "drive-many", executor: disk.executor })],
      now: NOW,
    });
    const [note] = (await repo.listNotifications({ accountId: "acct" })).filter((item) => item.kind === "staging_leftover");
    expect(note?.title).toBe("网盘暂存目录残留（11 个）");
    expect(note?.body).toContain("S01 / staging-run-1：1 个文件，1 MB");
    expect(note?.body).toContain("S10 / staging-run-10：1 个文件，1 MB");
    expect(note?.body).not.toContain("S11 /");
    expect(note?.body).toContain("…等共 11 个目录，合计 11 MB");
    expect(note?.body).toContain("这些文件不在季目录里，请到网盘手动处理。");
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
    // category, show, listTree, subdirectory check, removeDirectory — four gaps.
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
    expect(sleeps).toContain(3000);
    expect(logs.some((line) => /d-retry: removed 1 empty, reported 0 non-empty/.test(line))).toBe(true);
  });

  it("propagates a 100011 after two retries and saves the resume cursor", async () => {
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
    expect(trees).toBe(3);
    expect(sleeps).toEqual([3000, 6000]);
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
            async removeDirectory() {
              return { removed: false };
            },
          },
        }),
      ],
    });
    expect(logs).toContain(
      "[patrol] staging janitor drive-stuck: removed 0 empty (1 could not be removed), reported 0 non-empty",
    );
  });

  it("does not delete a staging dir whose files are below listTree depth, and reports it", async () => {
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
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual([]);
    const notes = (await repo.listNotifications({ accountId: "acct" })).filter(
      (note) => note.kind === "staging_leftover",
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain("Deep Show / staging-run-deep：0 个文件");
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
            async removeDirectory(id: string) {
              removed.push(id);
              return { removed: true };
            },
          },
        }),
      ],
    });
    expect(removed).toEqual(["stg-bare"]);
    const notes = (await repo.listNotifications({ accountId: "acct" })).filter(
      (note) => note.kind === "staging_leftover",
    );
    expect(notes).toHaveLength(0);
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
});
