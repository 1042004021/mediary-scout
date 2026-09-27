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
  return { executor, removed, dirs };
}

function drive(partial: Partial<StagingJanitorDrive> & Pick<StagingJanitorDrive, "storageId" | "executor">): StagingJanitorDrive {
  return {
    accountId: "acct",
    status: "active",
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
    expect(notes[0]?.title).toContain("Show A");
    expect(notes[0]?.body).toContain("staging-run-full");
    expect(notes[0]?.body).toContain("2");
    expect(notes[0]?.body).toContain("3 MB");

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
