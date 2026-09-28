import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import {
  createEpisodeStates,
  InMemoryWorkflowRepository,
  runQueuedStagingRecovery,
  type StorageExecutor,
} from "../src/index.js";
import { Storage115Simulator, type SimTreeFile } from "../src/acquisition-v2/storage-115-simulator.js";
import type { ResourceSnapshot } from "../src/domain.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

const FORBIDDEN = [
  "searchResources",
  "transferCandidate",
  "transferUntilLanded",
  "viewSubtitleSnapshot",
  "transferSubtitle",
  "writeMemory",
];

interface NamedFile {
  id: string;
  path: string;
  isVideo?: boolean;
  isSubtitle?: boolean;
}

function isNamedFile(value: unknown): value is NamedFile {
  return Boolean(value && typeof value === "object" && typeof (value as NamedFile).id === "string" && typeof (value as NamedFile).path === "string");
}

function toolValues(prompt: unknown, toolName: string): unknown[] {
  const values: unknown[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record["type"] === "tool-result" && record["toolName"] === toolName) {
      const output = record["output"];
      if (output && typeof output === "object" && "value" in output) values.push((output as { value: unknown }).value);
      else values.push(output ?? record["result"]);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(prompt);
  return values;
}

function asFiles(value: unknown): NamedFile[] {
  return Array.isArray(value) ? value.filter(isNamedFile) : [];
}

/** Move the staging videos the season does not already have, plus their subtitles. */
function fileIdsToMove(prompt: unknown): string[] {
  const staging = asFiles(toolValues(prompt, "inspectStaging").at(-1));
  const season = asFiles(toolValues(prompt, "inspectTargetDir").at(-1));
  const seasonVideos = new Set(season.filter((file) => file.isVideo).map((file) => file.path.split("/").pop()));
  const videos = staging.filter((file) => file.isVideo && !seasonVideos.has(file.path.split("/").pop()));
  const stems = new Set(videos.map((file) => (file.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "")));
  const subtitles = staging.filter((file) => {
    if (!file.isSubtitle) return false;
    const stem = (file.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
    return stems.has(stem);
  });
  return [...videos, ...subtitles].map((file) => file.id);
}

function recoveryModel(offered: Set<string>, failMove: boolean, sawPrompt: { value: boolean }) {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      for (const tool of options.tools ?? []) {
        if (tool.type === "function") offered.add(tool.name);
      }
      step += 1;
      const text = JSON.stringify(options.prompt);
      if (text.includes("left over from an earlier run")) sawPrompt.value = true;
      const call = (name: string, input: unknown) => ({
        content: [{ type: "tool-call" as const, toolCallId: `c${step}`, toolName: name, input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
        usage: USAGE,
        warnings: [],
      });
      if (text.includes("MOVE_NOT_DONE") || text.includes("move failed")) return call("finish", {});
      if (step === 1) return call("inspectStaging", {});
      if (step === 2) return call("inspectTargetDir", { season: 1 });
      if (step === 3) {
        const fileIds = fileIdsToMove(options.prompt);
        if (fileIds.length === 0) throw new Error(`recovery model saw no file to move: ${text.slice(0, 1500)}`);
        return call("moveToSeason", { moves: [{ season: 1, fileIds }] });
      }
      if (!failMove && step === 4) return call("markObtained", { codes: ["S01E05"] });
      if (!failMove && step === 5) return call("discardStaging", {});
      return call("finish", {});
    },
  });
}

function asExecutor(sim: Storage115Simulator, failMove: boolean): { executor: StorageExecutor; created: string[] } {
  const created: string[] = [];
  let moves = 0;
  const executor = {
    async createDirectory(input: { name: string; parentId: string }) {
      created.push(input.name);
      return sim.createDirectory(input);
    },
    async listChildDirectories(parentId: string) {
      const subs = await sim.listSubdirectories({ directoryId: parentId });
      return subs.filter((entry) => !entry.path.includes("/")).map((entry) => ({ id: entry.id, name: entry.path }));
    },
    async listTree(input: { directoryId: string }) {
      const files = await sim.listTree({ directoryId: input.directoryId });
      return files.map((file) => ({ path: file.path, providerFileId: file.id, sizeBytes: file.sizeBytes }));
    },
    async listSubdirectories(input: { directoryId: string }) {
      return sim.listSubdirectories(input);
    },
    async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }) {
      moves += 1;
      if (failMove && moves === 1) throw new Error("PAN115_RATE_LIMIT: move failed");
      return sim.moveFiles(input);
    },
    async deleteFiles(input: { directoryId: string; fileIds: string[] }) {
      return sim.deleteFiles(input);
    },
    async removeDirectory(directoryId: string) {
      try {
        await sim.removeDirectory({ directoryId });
        return { removed: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("NOT_FOUND")) return { removed: true };
        throw error;
      }
    },
    async renameFile() {
      throw new Error("rename is not part of this recovery");
    },
  };
  return { executor: executor as unknown as StorageExecutor, created };
}

async function stage(failMove: boolean) {
  const sim = new Storage115Simulator({
    packs: {
      have: { files: [{ path: "Show.S01E01.mkv", sizeBytes: 1000 }] },
      left: {
        files: [
          { path: "Show.S01E01.mkv", sizeBytes: 1000 },
          { path: "Show.S01E05.mkv", sizeBytes: 5000 },
          { path: "Show.S01E05.ass", sizeBytes: 20 },
        ],
      },
    },
  });
  const showId = await sim.createDirectory({ name: "Show (2024) {tmdb-7}", parentId: "root" });
  const seasonId = await sim.createDirectory({ name: "Season 01", parentId: showId });
  const stagingId = await sim.createDirectory({ name: "staging-old", parentId: showId });
  await sim.transferCandidate({ candidateId: "have", intoDirectoryId: seasonId });
  await sim.transferCandidate({ candidateId: "left", intoDirectoryId: stagingId });
  const seasonBefore = await sim.listTree({ directoryId: seasonId });
  const stagingBefore = await sim.listTree({ directoryId: stagingId });
  const { executor, created } = asExecutor(sim, failMove);
  const repo = new InMemoryWorkflowRepository();
  const title = {
    id: "title_7",
    tmdbId: 7,
    type: "tv" as const,
    title: "Show",
    originalTitle: "Show",
    year: 2024,
    aliases: [] as string[],
  };
  const season = {
    id: "title_7_s1",
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active" as const,
    qualityPreference: "1080p",
    storageDirectoryId: seasonId,
    totalEpisodes: 5,
    latestAiredEpisode: 5,
    latestAiredSource: "metadata" as const,
  };
  const episodes = createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: 1,
    totalEpisodes: 5,
    latestAiredEpisode: 5,
  }).map((episode) => (episode.episodeCode === "S01E01" ? { ...episode, obtained: true } : episode));
  await repo.saveWorkflowRunSnapshot({
    accountId: "acct",
    connectedStorageId: "drive",
    title,
    season,
    workflowRun: {
      id: "done",
      kind: "type3_monitor",
      status: "succeeded",
      trackedSeasonId: season.id,
      startedAt: "2026-09-26T00:00:00.000Z",
      finishedAt: "2026-09-26T01:00:00.000Z",
      auditEvents: [],
    },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
  await repo.reserveWorkflowRun({
    accountId: "acct",
    connectedStorageId: "drive",
    title,
    season,
    workflowRun: {
      id: "recovery-1",
      kind: "staging_recovery",
      status: "queued",
      trackedSeasonId: season.id,
      startedAt: "2026-09-28T03:00:00.000Z",
      finishedAt: null,
      auditEvents: [
        {
          type: "staging_recovery_queued",
          message: "queued",
          data: { stagingDirectoryId: stagingId, showDirectoryId: showId, seasonNumbers: [1] },
        },
      ],
    },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    keepCurrentEpisodes: true,
    requireTrackedSeason: true,
    blockIfTitleHasActiveRun: true,
  });
  let searches = 0;
  const resourceProvider = {
    async search(): Promise<ResourceSnapshot> {
      searches += 1;
      return { id: "snap", provider: "pansou", keyword: "Show", candidates: [], createdAt: "2026-09-28T03:00:00.000Z" };
    },
  };
  return { sim, repo, executor, created, seasonId, stagingId, seasonBefore, stagingBefore, searches: () => searches, resourceProvider };
}

describe("staging_recovery", () => {
  it("moves the episode the season lacks, discards the duplicate with staging, and does not notify", async () => {
    const staged = await stage(false);
    const offered = new Set<string>();
    const sawPrompt = { value: false };
    const result = await runQueuedStagingRecovery({
      repository: staged.repo,
      resourceProvider: staged.resourceProvider,
      storage: staged.executor,
      model: recoveryModel(offered, false, sawPrompt),
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(result.status).toBe("ran");
    expect(staged.searches()).toBe(0);
    expect(staged.created.some((name) => name.startsWith("staging"))).toBe(false);
    for (const name of FORBIDDEN) expect(offered.has(name)).toBe(false);
    expect(offered.has("inspectStaging")).toBe(true);
    expect(offered.has("moveToSeason")).toBe(true);
    expect(offered.has("discardStaging")).toBe(true);
    expect(sawPrompt.value).toBe(true);

    const saved = await staged.repo.getWorkflowRunSnapshot("recovery-1", { accountId: "acct", connectedStorageId: "drive" });
    expect(saved?.notifications).toEqual([]);
    expect(await staged.repo.listNotifications({ accountId: "acct" })).toEqual([]);
    expect(saved?.episodes.find((episode) => episode.episodeCode === "S01E05")?.obtained).toBe(true);
    expect(saved?.episodes.find((episode) => episode.episodeCode === "S01E01")?.obtained).toBe(true);
    const seasonAfter = await staged.sim.listTree({ directoryId: staged.seasonId });
    const seasonIds = seasonAfter.map((file) => file.id);
    for (const file of staged.seasonBefore) expect(seasonIds).toContain(file.id);
    const moved = staged.stagingBefore.find((file) => file.path.endsWith("S01E05.mkv"))!;
    const subtitle = staged.stagingBefore.find((file) => file.path.endsWith("S01E05.ass"))!;
    const duplicate = staged.stagingBefore.find((file) => file.path.endsWith("S01E01.mkv"))!;
    expect(seasonIds).toContain(moved.id);
    expect(seasonIds).toContain(subtitle.id);
    expect(seasonIds).not.toContain(duplicate.id);
    await expect(staged.sim.listTree({ directoryId: staged.stagingId })).rejects.toThrow(/NOT_FOUND/);
  });

  it("keeps the staging dir when the move fails and does not mark the episode obtained", async () => {
    const staged = await stage(true);
    const offered = new Set<string>();
    const result = await runQueuedStagingRecovery({
      repository: staged.repo,
      resourceProvider: staged.resourceProvider,
      storage: staged.executor,
      model: recoveryModel(offered, true, { value: false }),
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(result.status).toBe("ran");
    const saved = await staged.repo.getWorkflowRunSnapshot("recovery-1", { accountId: "acct", connectedStorageId: "drive" });
    expect(saved?.notifications).toEqual([]);
    expect(saved?.episodes.find((episode) => episode.episodeCode === "S01E05")?.obtained).toBe(false);
    expect(saved?.workflowRun.auditEvents.some((event) => event.type === "staging_kept_unmoved_files")).toBe(true);
    const seasonAfter = await staged.sim.listTree({ directoryId: staged.seasonId });
    expect(seasonAfter.map((file) => file.id).sort()).toEqual(staged.seasonBefore.map((file: SimTreeFile) => file.id).sort());
    const still = await staged.sim.listTree({ directoryId: staged.stagingId });
    expect(still.map((file) => file.id).sort()).toEqual(staged.stagingBefore.map((file) => file.id).sort());
    for (const name of FORBIDDEN) expect(offered.has(name)).toBe(false);
  });
});
