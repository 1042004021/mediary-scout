import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  InMemoryWorkflowRepository,
  movieAnchorSeason,
  pickWorkspaceStorageId,
  queueReplaceRequest,
  type MediaTitle,
  type TrackedSeason,
} from "@media-track/workflow";
import { loadMessageThread, nextPatrolLabel, resolveMessageWork, swapBadgeLabel } from "./user-message-server";

const NOW = "2026-09-27T08:00:00.000Z";

const show: MediaTitle = { id: "tmdb_tv_42", tmdbId: 42, type: "tv", title: "Show", originalTitle: "Show", year: 2026, aliases: [] };
const film: MediaTitle = { id: "tmdb_movie_42", tmdbId: 42, type: "movie", title: "Film", originalTitle: "Film", year: 2026, aliases: [] };

function season(titleId: string, seasonNumber: number): TrackedSeason {
  return {
    id: `${titleId}_s${seasonNumber}`,
    mediaTitleId: titleId,
    seasonNumber,
    status: "completed",
    qualityPreference: "4K",
    storageDirectoryId: `dir_s${seasonNumber}`,
    totalEpisodes: 2,
    latestAiredEpisode: 2,
    latestAiredSource: "metadata",
  };
}

/** A finished acquisition that left `s` tracked (all episodes obtained) on `drive`
 *  (undefined = an unbound season, stored with a null drive). */
async function track(repo: InMemoryWorkflowRepository, input: { accountId?: string; drive?: string; title: MediaTitle; s: TrackedSeason }) {
  await repo.saveWorkflowRunSnapshot({
    accountId: input.accountId ?? "acct_1",
    ...(input.drive === undefined ? {} : { connectedStorageId: input.drive }),
    title: input.title,
    season: input.s,
    workflowRun: {
      id: `seed_${input.s.id}_${input.drive ?? "unbound"}`,
      kind: input.title.type === "movie" ? "movie_init" : "type2_init",
      status: "succeeded",
      trackedSeasonId: input.s.id,
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:00:00.000Z",
      auditEvents: [],
    },
    episodes: createEpisodeStates({
      trackedSeasonId: input.s.id,
      seasonNumber: input.s.seasonNumber,
      totalEpisodes: input.s.totalEpisodes,
      latestAiredEpisode: input.s.latestAiredEpisode,
    }).map((e) => ({ ...e, obtained: true })),
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

describe("resolveMessageWork — the work the engine will look for", () => {
  it("a message posted from the primary drive (page storageId undefined) is keyed by the real drive id and is queueable", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: show, s: season(show.id, 1) });
    // What getActiveWorkspaceScope(undefined) resolves on the show page: the primary drive's id.
    const storageId: string | undefined = undefined;
    const scope = { accountId: "acct_1", connectedStorageId: pickWorkspaceStorageId([{ id: "cs_primary", createdAt: NOW }], storageId) };
    expect(scope.connectedStorageId).toBe("cs_primary");

    const work = await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: "tv" });

    expect(work).toEqual({ accountId: "acct_1", drive: "cs_primary", titleKey: "tmdb_tv_42" });
    await repo.createUserMessage({ ...work!, body: "13、24 集发蓝", episodeTags: ["S01E01"], now: NOW });
    expect((await queueReplaceRequest({ repository: repo, work: work! })).status).toBe("queued");
    // The key the UI plan first used (storageId ?? "") is one the engine never finds.
    expect((await queueReplaceRequest({ repository: repo, work: { ...work!, drive: storageId ?? "" } })).status).toBe("not_tracked");
  });

  it("an unbound season (no drive) resolves to drive \"\" and queues", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { title: show, s: season(show.id, 1) });
    // An account with no drive yet: the workspace scope is account-wide.
    const scope = { accountId: "acct_1", connectedStorageId: pickWorkspaceStorageId([], undefined) };

    const work = await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: "tv" });

    expect(work).toEqual({ accountId: "acct_1", drive: "", titleKey: "tmdb_tv_42" });
    await repo.createUserMessage({ ...work!, body: "换一个", episodeTags: [], now: NOW });
    expect((await queueReplaceRequest({ repository: repo, work: work! })).status).toBe("queued");
  });

  it("a non-primary drive keys by that drive; all of the title's seasons share one work", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_quark", title: show, s: season(show.id, 1) });
    await track(repo, { drive: "cs_quark", title: show, s: season(show.id, 2) });

    const work = await resolveMessageWork({ repo, scope: { accountId: "acct_1", connectedStorageId: "cs_quark" }, tmdbId: 42, mediaType: "tv" });

    expect(work).toEqual({ accountId: "acct_1", drive: "cs_quark", titleKey: "tmdb_tv_42" });
  });

  it("null when the title is not tracked on this drive, or only under another account", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_other", title: show, s: season(show.id, 1) });
    await track(repo, { accountId: "acct_2", drive: "cs_primary", title: show, s: season(show.id, 1) });

    expect(await resolveMessageWork({ repo, scope: { accountId: "acct_1", connectedStorageId: "cs_primary" }, tmdbId: 42, mediaType: "tv" })).toBeNull();
  });

  it("movie and tv ids are separate namespaces", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: film, s: movieAnchorSeason({ titleId: film.id, qualityPreference: "4K", storageDirectoryId: "dir_movie" }) });
    const scope = { accountId: "acct_1", connectedStorageId: "cs_primary" };

    expect(await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: "movie" })).toEqual({
      accountId: "acct_1",
      drive: "cs_primary",
      titleKey: "tmdb_movie_42",
    });
    expect(await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: "tv" })).toBeNull();
  });

  it("refuses a forged mediaType or tmdbId (server actions get whatever the client sent)", async () => {
    const repo = new InMemoryWorkflowRepository();
    await track(repo, { drive: "cs_primary", title: show, s: season(show.id, 1) });
    const scope = { accountId: "acct_1", connectedStorageId: "cs_primary" };
    const forged = "tv_42_x" as unknown as "tv";

    expect(await resolveMessageWork({ repo, scope, tmdbId: 42, mediaType: forged })).toBeNull();
    expect(await resolveMessageWork({ repo, scope, tmdbId: -42, mediaType: "tv" })).toBeNull();
    expect(await resolveMessageWork({ repo, scope, tmdbId: 4.2, mediaType: "tv" })).toBeNull();
  });
});

describe("loadMessageThread", () => {
  const work = { accountId: "acct_1", drive: "cs_primary", titleKey: "tmdb_tv_42" };

  it("lists the work's messages newest first without withdrawn ones, with only what the card shows", async () => {
    const repo = new InMemoryWorkflowRepository();
    const first = await repo.createUserMessage({ ...work, body: "第一条", episodeTags: ["S01E13"], now: "2026-09-27T01:00:00.000Z" });
    const gone = await repo.createUserMessage({ ...work, body: "撤回的", episodeTags: [], now: "2026-09-27T02:00:00.000Z" });
    const latest = await repo.createUserMessage({ ...work, body: "第二条", episodeTags: [], now: "2026-09-27T03:00:00.000Z" });
    await repo.withdrawUserMessage({ accountId: work.accountId, id: gone.id, now: NOW });
    // Another work's message stays out.
    await repo.createUserMessage({ ...work, titleKey: "tmdb_tv_7", body: "别的剧", episodeTags: [], now: NOW });

    const view = await loadMessageThread(repo, work);

    expect(view.messages).toEqual([
      { id: latest.id, body: "第二条", episodeTags: [], status: "pending", urgent: false, createdAt: "2026-09-27T03:00:00.000Z", reply: null },
      { id: first.id, body: "第一条", episodeTags: ["S01E13"], status: "pending", urgent: false, createdAt: "2026-09-27T01:00:00.000Z", reply: null },
    ]);
    expect(view.busy).toBe(false);
  });

  it("待换 episodes come back sorted; busy while a run holds a message", async () => {
    const repo = new InMemoryWorkflowRepository();
    const m = await repo.createUserMessage({ ...work, body: "换 24、3", episodeTags: [], now: NOW });
    await repo.addPendingReplacements({ ...work, episodes: ["S01E24", "S01E03"], messageId: m.id, now: NOW });
    await repo.claimUserMessages({ ...work, runId: "run_1", now: NOW });

    const view = await loadMessageThread(repo, work);

    expect(view.pendingReplacements).toEqual(["S01E03", "S01E24"]);
    expect(view.busy).toBe(true);
    expect(view.messages[0]).toMatchObject({ status: "processing" });
  });
});

describe("nextPatrolLabel", () => {
  it("names today's next patrol, else tomorrow's first (明早 before noon)", () => {
    expect(nextPatrolLabel(["06:00", "21:00"], "14:02")).toBe("今天 21:00");
    expect(nextPatrolLabel(["06:00"], "14:02")).toBe("明早 06:00");
    expect(nextPatrolLabel(["06:00"], "05:00")).toBe("今天 06:00");
    expect(nextPatrolLabel(["23:30"], "23:40")).toBe("明天 23:30");
  });
});

describe("swapBadgeLabel — the 待换 badge beside the title", () => {
  it("counts a show's 待换 episodes; none → no badge", () => {
    expect(swapBadgeLabel("tv", [])).toBeNull();
    expect(swapBadgeLabel("tv", ["S01E24"])).toBe("1 集待换");
    expect(swapBadgeLabel("tv", ["S01E03", "S02E01"])).toBe("2 集待换");
  });

  it("a film says 待换资源 only while the film itself is 待换", () => {
    expect(swapBadgeLabel("movie", ["MOVIE"])).toBe("待换资源");
    expect(swapBadgeLabel("movie", [])).toBeNull();
  });
});
