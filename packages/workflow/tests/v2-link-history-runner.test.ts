import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  runMovieAcquisitionV2AndPersist,
  runReplaceRequestV2AndPersist,
  runSeriesInitializationV2AndPersist,
  runType2InitializationV2AndPersist,
  runType3MonitoringV2AndPersist,
} from "../src/runner-v2.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { createEpisodeStates, type MediaTitle, type ResourceSnapshot, type TrackedSeason } from "../src/domain.js";
import type { ResourceProvider } from "../src/ports.js";
import type { LinkHistoryRow } from "../src/user-requests.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

const NOW = "2026-09-27T04:25:00.000Z";
const SINCE = new Date(Date.parse(NOW) - 30 * 24 * 60 * 60 * 1000).toISOString();

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: `snap_${keyword}`,
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: NOW,
    }),
  };
}

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

const tvTitle = {
  id: "tmdb_tv_100",
  tmdbId: 100,
  type: "tv",
  title: "示例剧",
  year: 2024,
  aliases: ["Example Show"],
} as unknown as MediaTitle;

const movieTitle = {
  id: "tmdb_movie_27205",
  tmdbId: 27205,
  type: "movie",
  title: "盗梦空间",
  year: 2010,
  aliases: ["Inception"],
} as unknown as MediaTitle;

function trackedSeason(): TrackedSeason {
  return {
    id: "tmdb_tv_100_s1",
    mediaTitleId: "tmdb_tv_100",
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "",
    totalEpisodes: 3,
    latestAiredEpisode: 3,
    latestAiredSource: "metadata",
  };
}

class HistorySpy extends InMemoryWorkflowRepository {
  readonly calls: Array<{ accountId: string; drive: string; titleKey: string; since: string; excludeRunId?: string }> = [];
  fail = false;
  override async listLinkHistory(input: {
    accountId: string;
    drive: string;
    titleKey: string;
    since: string;
    excludeRunId?: string;
  }): Promise<LinkHistoryRow[]> {
    this.calls.push(input);
    if (this.fail) throw new Error("link history down");
    return [];
  }
}

const owner = { accountId: "acct_a", connectedStorageId: "cs_1", now: () => NOW };

describe("runner-v2 link history lookup", () => {
  it("passes since = now − 30 days and excludeRunId = the current run for every run kind", async () => {
    const repository = new HistorySpy();
    const storage = () => new FakeStorageExecutor();
    const common = {
      ...owner,
      repository,
      resourceProvider: emptyProvider(),
      storage: storage(),
      model: searchThenReportModel(),
      categoryParentId: "tv_root",
    };

    await runType2InitializationV2AndPersist({
      ...common,
      title: tvTitle,
      season: trackedSeason(),
      workflowRun: { id: "run-type2", startedAt: NOW, finishedAt: null },
    });
    await runType3MonitoringV2AndPersist({
      ...common,
      storage: storage(),
      model: searchThenReportModel(),
      title: tvTitle,
      season: { ...trackedSeason(), id: "tmdb_tv_100_s1b" },
      episodes: createEpisodeStates({ trackedSeasonId: "tmdb_tv_100_s1b", seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 }),
      workflowRun: { id: "run-type3", startedAt: NOW, finishedAt: null },
    });
    await runSeriesInitializationV2AndPersist({
      ...common,
      storage: storage(),
      model: searchThenReportModel(),
      title: tvTitle,
      seasons: [{ seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 }],
      workflowRun: { id: "run-series", startedAt: NOW, finishedAt: null },
      seasonQualityRecord: "4K",
    });
    await runMovieAcquisitionV2AndPersist({
      ...common,
      storage: storage(),
      model: searchThenReportModel(),
      title: movieTitle,
      categoryParentId: "movies_root",
      workflowRun: { id: "run-movie", startedAt: NOW, finishedAt: null },
    });
    await runReplaceRequestV2AndPersist({
      ...common,
      storage: storage(),
      model: searchThenReportModel(),
      title: tvTitle,
      seasons: [{
        season: { ...trackedSeason(), id: "tmdb_tv_100_s1c" },
        episodes: createEpisodeStates({ trackedSeasonId: "tmdb_tv_100_s1c", seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 }),
      }],
      workflowRun: { id: "run-replace", startedAt: NOW, finishedAt: null },
      lockSeasonNumber: 1,
      lockAuditEvents: [],
      userRequest: {
        requestedEpisodes: ["S01E01"],
        prompt: { messages: [{ body: "换一版", episodeTags: ["S01E01"], createdAt: NOW }], rejected: [], pending: [] },
        rejectedStore: { list: async () => [], add: async () => undefined },
      },
    });

    expect(repository.calls).toEqual([
      { accountId: "acct_a", drive: "cs_1", titleKey: "tmdb_tv_100", since: SINCE, excludeRunId: "run-type2" },
      { accountId: "acct_a", drive: "cs_1", titleKey: "tmdb_tv_100", since: SINCE, excludeRunId: "run-type3" },
      { accountId: "acct_a", drive: "cs_1", titleKey: "tmdb_tv_100", since: SINCE, excludeRunId: "run-series" },
      { accountId: "acct_a", drive: "cs_1", titleKey: "tmdb_movie_27205", since: SINCE, excludeRunId: "run-movie" },
      { accountId: "acct_a", drive: "cs_1", titleKey: "tmdb_tv_100", since: SINCE, excludeRunId: "run-replace" },
    ]);
  });

  it("a throwing repository read yields [] and the run proceeds", async () => {
    const repository = new HistorySpy();
    repository.fail = true;
    const errors: string[] = [];
    const errorSpy = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const result = await runType2InitializationV2AndPersist({
        ...owner,
        title: tvTitle,
        season: trackedSeason(),
        categoryParentId: "tv_root",
        resourceProvider: emptyProvider(),
        storage: new FakeStorageExecutor(),
        model: searchThenReportModel(),
        repository,
        workflowRun: { id: "run-down", startedAt: NOW, finishedAt: null },
      });
      expect(result.status).toBe("no_coverage");
      expect(repository.calls).toHaveLength(1);
      expect(repository.calls[0]).toMatchObject({ since: SINCE, excludeRunId: "run-down" });
      expect(errors.some((line) => line.includes("link history"))).toBe(true);
    } finally {
      console.error = errorSpy;
    }
  });
});
