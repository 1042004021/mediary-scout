import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  createEpisodeStates,
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  queueMovieAcquisition,
  queueReplaceRequest,
  queueSeriesInitialization,
  queueTrackingInitialization,
  reconcileVerifiedFiles,
  runScheduledType3Monitoring,
  type MediaTitle,
  type TrackedSeason,
} from "../src/index.js";

const NOW = "2026-09-28T04:00:00.000Z";
const fixedNow = () => NOW;

function showTitle(): MediaTitle {
  return {
    id: "title_show",
    tmdbId: 11,
    type: "tv",
    title: "Show",
    originalTitle: "Show",
    year: 2024,
    aliases: [],
  };
}

function movieTitle(): MediaTitle {
  return {
    id: "title_film",
    tmdbId: 12,
    type: "movie",
    title: "Film",
    originalTitle: "Film",
    year: 2024,
    aliases: [],
  };
}

/** A queued leftover recovery on this title. Its season is not the one the user action reserves. */
async function queueLeftoverRecovery(repo: InMemoryWorkflowRepository, title: MediaTitle): Promise<void> {
  const seasonId = `${title.id}_recovery_hold`;
  await repo.saveWorkflowRunSnapshot({
    title,
    season: {
      id: seasonId,
      mediaTitleId: title.id,
      seasonNumber: 9,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "show-dir",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    },
    workflowRun: {
      id: `recovery-${title.id}`,
      kind: "staging_recovery",
      status: "queued",
      trackedSeasonId: seasonId,
      startedAt: "2026-09-28T01:00:00.000Z",
      finishedAt: null,
      auditEvents: [
        {
          type: "staging_recovery_queued",
          message: "queued",
          data: { stagingDirectoryId: `stg-${title.id}`, showDirectoryId: "show-dir", seasonNumbers: [1] },
        },
      ],
    },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

function throwingModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("agent model unavailable");
    },
  });
}

describe("a queued staging_recovery does not pin the title", () => {
  it("lets a user queue a season, a series, and a movie", async () => {
    const repo = new InMemoryWorkflowRepository();
    const show = showTitle();
    const film = movieTitle();
    await queueLeftoverRecovery(repo, show);
    await queueLeftoverRecovery(repo, film);

    const season: TrackedSeason = {
      id: "title_show_s1",
      mediaTitleId: show.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "",
      totalEpisodes: 2,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    expect(
      (await queueTrackingInitialization({
        title: show,
        season,
        keyword: "Show",
        repository: repo,
        createWorkflowRunId: () => "run_type2",
        now: fixedNow,
      })).status,
    ).toBe("queued");
    const series: MediaTitle = { ...show, id: "title_series_held", title: "Series" };
    await queueLeftoverRecovery(repo, series);
    expect(
      (await queueSeriesInitialization({
        title: series,
        seasons: [{ seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 1 }],
        keyword: "Series",
        repository: repo,
        createWorkflowRunId: () => "run_series_held",
        now: fixedNow,
      })).status,
    ).toBe("queued");
    expect(
      (await queueMovieAcquisition({
        title: film,
        keyword: "Film",
        repository: repo,
        createWorkflowRunId: () => "run_movie",
        now: fixedNow,
      })).status,
    ).toBe("queued");
  });

  it("lets a replace request queue while the recovery is still queued", async () => {
    const repo = new InMemoryWorkflowRepository();
    const title = showTitle();
    const season: TrackedSeason = {
      id: "title_show_s1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "dir_s1",
      totalEpisodes: 2,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    };
    const episodes = reconcileVerifiedFiles({
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: 1,
        totalEpisodes: 2,
        latestAiredEpisode: 2,
      }),
      files: [],
    });
    await repo.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: {
        id: "seed_show",
        kind: "type3_monitor",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: "2026-09-27T00:00:00.000Z",
        finishedAt: "2026-09-27T01:00:00.000Z",
        auditEvents: [],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await queueLeftoverRecovery(repo, title);

    const result = await queueReplaceRequest({
      repository: repo,
      work: { accountId: "acct_default", drive: "", titleKey: title.id },
      now: fixedNow,
      createWorkflowRunId: () => "run_replace",
    });
    expect(result.status).toBe("queued");
  });

  it("does not patrol a show or an unobtained movie that has a queued recovery", async () => {
    const repo = new InMemoryWorkflowRepository();
    const title = showTitle();
    const season: TrackedSeason = {
      id: "title_show_s1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 2,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    };
    const episodes = reconcileVerifiedFiles({
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: 1,
        totalEpisodes: 2,
        latestAiredEpisode: 2,
      }),
      files: ["S01E01", "S01E02"].map((code, index) => ({
        id: `seed_${index}`,
        storageDirectoryId: season.storageDirectoryId,
        name: `Show.${code}.mkv`,
        sizeBytes: 1_000_000_000,
        episodeCode: code,
        providerFileId: `provider_${index}`,
      })),
    });
    await repo.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: {
        id: "seed_show",
        kind: "type2_init",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: "2026-09-27T00:00:00.000Z",
        finishedAt: "2026-09-27T01:00:00.000Z",
        auditEvents: [],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await repo.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: {
        id: "recovery-show",
        kind: "staging_recovery",
        status: "queued",
        trackedSeasonId: season.id,
        startedAt: "2026-09-28T02:00:00.000Z",
        finishedAt: null,
        auditEvents: [
          {
            type: "staging_recovery_queued",
            message: "queued",
            data: { stagingDirectoryId: "stg-show", showDirectoryId: "show-dir", seasonNumbers: [1] },
          },
        ],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const film = movieTitle();
    const anchor: TrackedSeason = {
      id: "title_film_movie",
      mediaTitleId: film.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    await repo.saveWorkflowRunSnapshot({
      title: film,
      season: anchor,
      workflowRun: {
        id: "seed_film",
        kind: "movie_init",
        status: "succeeded",
        trackedSeasonId: anchor.id,
        startedAt: "2026-09-27T00:00:00.000Z",
        finishedAt: "2026-09-27T01:00:00.000Z",
        auditEvents: [],
      },
      episodes: createEpisodeStates({
        trackedSeasonId: anchor.id,
        seasonNumber: 1,
        totalEpisodes: 1,
        latestAiredEpisode: 1,
      }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const filmEpisodes = createEpisodeStates({
      trackedSeasonId: anchor.id,
      seasonNumber: 1,
      totalEpisodes: 1,
      latestAiredEpisode: 1,
    });
    await repo.saveWorkflowRunSnapshot({
      title: film,
      season: anchor,
      workflowRun: {
        id: "recovery-film",
        kind: "staging_recovery",
        status: "queued",
        trackedSeasonId: anchor.id,
        startedAt: "2026-09-28T02:00:00.000Z",
        finishedAt: null,
        auditEvents: [
          {
            type: "staging_recovery_queued",
            message: "queued",
            data: { stagingDirectoryId: "stg-film", showDirectoryId: "film-dir", seasonNumbers: [1] },
          },
        ],
      },
      episodes: filmEpisodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const storage = new FakeStorageExecutor();
    const showDir = await storage.createDirectory({ name: `${title.title} (${title.year})`, parentId: "library_root" });
    const seasonDir = await storage.createDirectory({ name: "Season 01", parentId: showDir });
    storage.seedDirectoryFiles(
      seasonDir,
      ["S01E01", "S01E02"].map((code, index) => ({
        id: `present_${index}`,
        storageDirectoryId: seasonDir,
        name: `Show.${code}.mkv`,
        sizeBytes: 1_000_000_000,
        episodeCode: code,
        providerFileId: `present_${index}`,
      })),
    );

    const outcomes = await runScheduledType3Monitoring({
      repository: repo,
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage,
      model: throwingModel(),
      storageParentDirectoryId: "library_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      createWorkflowRunId: (() => {
        let n = 0;
        return () => `run_patrol_${(n += 1)}`;
      })(),
    });

    expect(outcomes.filter((outcome) => outcome.trackedSeasonId === season.id || outcome.trackedSeasonId === anchor.id)).toEqual([]);
    expect(await repo.getWorkflowRunSnapshot("run_patrol_1")).toBeNull();
    expect(await repo.getWorkflowRunSnapshot("run_patrol_2")).toBeNull();
    expect((await repo.listActiveWorkflowRuns()).map((run) => run.workflowRun.id).sort()).toEqual([
      "recovery-film",
      "recovery-show",
    ]);
  });

  it("a queued user run still blocks another acquire of that title", async () => {
    const repo = new InMemoryWorkflowRepository();
    const show = showTitle();
    const season: TrackedSeason = {
      id: "title_show_s2",
      mediaTitleId: show.id,
      seasonNumber: 2,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    expect(
      (await queueTrackingInitialization({
        title: show,
        season,
        keyword: "Show",
        repository: repo,
        createWorkflowRunId: () => "run_first",
        now: fixedNow,
      })).status,
    ).toBe("queued");
    expect(
      (await queueTrackingInitialization({
        title: show,
        season: { ...season, id: "title_show_s3", seasonNumber: 3 },
        keyword: "Show",
        repository: repo,
        createWorkflowRunId: () => "run_second",
        now: fixedNow,
      })).status,
    ).toBe("already_running");
  });
});
