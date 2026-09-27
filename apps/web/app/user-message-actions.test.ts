import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEpisodeStates,
  InMemoryWorkflowRepository,
  isRegisteredStorageProvider,
  movieAnchorSeason,
  pickWorkspaceStorageId,
  queueReplaceRequest,
  type MediaTitle,
  type TrackedSeason,
} from "@media-track/workflow";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const NOW = "2026-09-27T08:00:00.000Z";
const show: MediaTitle = { id: "tmdb_tv_42", tmdbId: 42, type: "tv", title: "Show", originalTitle: "Show", year: 2026, aliases: [] };
const s1: TrackedSeason = {
  id: "tmdb_tv_42_s1",
  mediaTitleId: show.id,
  seasonNumber: 1,
  status: "completed",
  qualityPreference: "4K",
  storageDirectoryId: "dir_s1",
  totalEpisodes: 2,
  latestAiredEpisode: 2,
  latestAiredSource: "metadata",
};

/** A finished acquisition that left the show tracked on `drive` for `accountId`. */
async function track(repo: InMemoryWorkflowRepository, accountId: string, drive: string) {
  await repo.saveWorkflowRunSnapshot({
    accountId,
    connectedStorageId: drive,
    title: show,
    season: s1,
    workflowRun: {
      id: `seed_${accountId}_${drive}`,
      kind: "type2_init",
      status: "succeeded",
      trackedSeasonId: s1.id,
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:00:00.000Z",
      auditEvents: [],
    },
    episodes: createEpisodeStates({ trackedSeasonId: s1.id, seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 }).map((e) => ({
      ...e,
      obtained: true,
    })),
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

/** The message actions of the work detail page. They write shared state, so they use
 *  the memory actions' guards; every work-level one files the message where the engine
 *  will look for it. */
describe("user message actions", () => {
  let repo: InMemoryWorkflowRepository;
  let actions: typeof import("./actions");
  let accountId = "acct_default";
  let llmError: string | null = null;

  beforeEach(async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    repo = new InMemoryWorkflowRepository();
    accountId = "acct_default";
    llmError = null;
    // The account's primary drive (earliest created), where the page has no storageId.
    await repo.upsertConnectedStorage({ id: "cs_primary", accountId: "acct_default", provider: "pan115", providerUid: "1001", payload: {}, createdAt: "2026-09-01T00:00:00.000Z" });
    await repo.upsertConnectedStorage({ id: "cs_quark", accountId: "acct_default", provider: "quark", providerUid: "2002", payload: {}, createdAt: "2026-09-02T00:00:00.000Z" });
    vi.resetModules();
    vi.doMock("../lib/workflow-runtime", async () => {
      const actual = await vi.importActual<typeof import("../lib/workflow-runtime")>("../lib/workflow-runtime");
      return {
        ...actual,
        getWorkflowRepository: () => repo,
        getCurrentAccountId: async () => accountId,
        requireAuthenticatedAccountId: async () => {
          if (accountId === actual.UNAUTHENTICATED_ACCOUNT_ID) throw new actual.UnauthenticatedAccountError();
          return accountId;
        },
        // The real resolution (registered drives → primary when storageId is undefined), over this repo.
        getActiveWorkspaceScope: async (storageId?: string) => ({
          accountId,
          connectedStorageId: pickWorkspaceStorageId(
            (await repo.listConnectedStorages(accountId)).filter((s) => isRegisteredStorageProvider(s.provider)),
            storageId,
          ),
        }),
        acquireLlmPreflightError: async () => llmError,
      };
    });
    actions = await import("./actions");
  }, 30_000);

  const onPrimary = { tmdbId: 42, mediaType: "tv" as const, storageId: undefined };
  const primaryWork = { accountId: "acct_default", drive: "cs_primary", titleKey: "tmdb_tv_42" };

  it("a message left on the primary drive is filed under that drive's id, and 现在处理 queues it", async () => {
    await track(repo, "acct_default", "cs_primary");

    expect(await actions.postUserMessageAction({ ...onPrimary, body: "  13 集发蓝\n", episodeTags: ["S01E01"] })).toEqual({ success: true });
    const [message] = await repo.listUserMessages(primaryWork);
    expect(message).toMatchObject({ body: "13 集发蓝", episodeTags: ["S01E01"], status: "pending", urgent: false });

    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: true, status: "queued" });
    expect((await repo.listUserMessages(primaryWork))[0]?.urgent).toBe(true);
    const active = await repo.listActiveWorkflowRuns({ accountId: "acct_default", connectedStorageId: "cs_primary" });
    expect(active.map((r) => [r.workflowRun.kind, r.title.id])).toEqual([["replace_request", "tmdb_tv_42"]]);
  });

  it("a non-primary drive files under its own id", async () => {
    await track(repo, "acct_default", "cs_quark");

    expect(await actions.postUserMessageAction({ ...onPrimary, storageId: "cs_quark", body: "换一个", episodeTags: [] })).toEqual({ success: true });
    expect(await repo.listUserMessages({ ...primaryWork, drive: "cs_quark" })).toHaveLength(1);
  });

  it("a title this account does not track on the drive is refused, and nothing is written", async () => {
    await track(repo, "acct_2", "cs_other");
    const notTracked = { success: false, message: "这部作品没有在这块网盘上追踪" };

    expect(await actions.postUserMessageAction({ ...onPrimary, body: "换", episodeTags: [] })).toEqual(notTracked);
    expect(await actions.processMessagesNowAction(onPrimary)).toEqual(notTracked);
    expect(await actions.keepEpisodesAsIsAction({ ...onPrimary, episodes: ["S01E01"] })).toEqual(notTracked);
    expect(
      await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: [{ episode: "S01E01", messageId: "msg_1", requestedAt: NOW }] }),
    ).toEqual(notTracked);
    expect(await repo.listUserMessages(primaryWork)).toHaveLength(0);
    expect(await repo.listPendingReplacements(primaryWork)).toHaveLength(0);
    expect(await repo.listWorksWithPendingMessages({ urgentOnly: false })).toEqual([]);
  });

  it("another account's message cannot be edited or withdrawn", async () => {
    const theirs = await repo.createUserMessage({ accountId: "acct_2", drive: "cs_other", titleKey: "tmdb_tv_42", body: "原话", episodeTags: [], now: NOW });

    expect(await actions.editUserMessageAction({ id: theirs.id, body: "改掉", episodeTags: [] })).toMatchObject({ success: false });
    expect(await actions.withdrawUserMessageAction({ id: theirs.id })).toMatchObject({ success: false });
    expect(await repo.listUserMessages({ accountId: "acct_2", drive: "cs_other", titleKey: "tmdb_tv_42" })).toMatchObject([
      { body: "原话", status: "pending" },
    ]);
  });

  it("a pending message can be edited and withdrawn; once a run holds it, both say the agent has started", async () => {
    await track(repo, "acct_default", "cs_primary");
    const kept = await repo.createUserMessage({ ...primaryWork, body: "第 1 集发蓝", episodeTags: [], now: NOW });
    const dropped = await repo.createUserMessage({ ...primaryWork, body: "第 2 集也换", episodeTags: [], now: NOW });

    expect(await actions.editUserMessageAction({ id: kept.id, body: "第 1 集发蓝，换一个", episodeTags: ["S01E01"] })).toEqual({ success: true });
    expect(await actions.withdrawUserMessageAction({ id: dropped.id })).toEqual({ success: true });
    expect(await repo.listUserMessages(primaryWork)).toMatchObject([{ id: kept.id, body: "第 1 集发蓝，换一个", episodeTags: ["S01E01"] }]);

    await repo.claimUserMessages({ ...primaryWork, runId: "run_1", now: NOW });
    const started = { success: false, message: "agent 已经开始处理这条留言了" };
    expect(await actions.editUserMessageAction({ id: kept.id, body: "算了", episodeTags: [] })).toEqual(started);
    expect(await actions.withdrawUserMessageAction({ id: kept.id })).toEqual(started);
    expect((await repo.listUserMessages(primaryWork))[0]).toMatchObject({ body: "第 1 集发蓝，换一个", status: "processing" });
  });

  it("an empty body or a malformed episode tag is refused with the validator's message", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "原话", episodeTags: [], now: NOW });

    expect(await actions.postUserMessageAction({ ...onPrimary, body: "   ", episodeTags: [] })).toEqual({ success: false, message: "留言不能是空的" });
    expect(await actions.postUserMessageAction({ ...onPrimary, body: "换", episodeTags: ["E13"] })).toEqual({ success: false, message: "集数标签不对" });
    expect(await actions.editUserMessageAction({ id: m.id, body: "", episodeTags: [] })).toEqual({ success: false, message: "留言不能是空的" });
    expect(await repo.listUserMessages(primaryWork)).toMatchObject([{ body: "原话" }]);
  });

  it("the input is checked before any lookup: a bad message gets the validator's answer even on an untracked title", async () => {
    // Nothing is tracked, so any lookup would answer 「没有在这块网盘上追踪」 first.
    expect(await actions.postUserMessageAction({ ...onPrimary, body: "  ", episodeTags: [] })).toEqual({ success: false, message: "留言不能是空的" });
    expect(await actions.postUserMessageAction({ ...onPrimary, body: "换", episodeTags: ["S1E1"] })).toEqual({ success: false, message: "集数标签不对" });
  });

  it("the 500-character limit counts the body that is stored, without the surrounding blanks", async () => {
    await track(repo, "acct_default", "cs_primary");
    const full = "蓝".repeat(500);

    expect(await actions.postUserMessageAction({ ...onPrimary, body: `\n  ${full}  \n`, episodeTags: [] })).toEqual({ success: true });
    const [stored] = await repo.listUserMessages(primaryWork);
    expect(stored?.body).toBe(full);
    expect(await actions.editUserMessageAction({ id: stored!.id, body: ` ${full} `, episodeTags: [] })).toEqual({ success: true });
    expect(await actions.postUserMessageAction({ ...onPrimary, body: `${full}蓝`, episodeTags: [] })).toEqual({ success: false, message: "留言最多 500 字" });
    expect(await actions.editUserMessageAction({ id: stored!.id, body: `${full}蓝`, episodeTags: [] })).toEqual({ success: false, message: "留言最多 500 字" });
  });

  it("现在处理 while a run already holds the work: the message is urgent and runs right after", async () => {
    await track(repo, "acct_default", "cs_primary");
    await repo.createUserMessage({ ...primaryWork, body: "第一条", episodeTags: [], now: NOW });
    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: true, status: "queued" });
    await repo.claimUserMessages({ ...primaryWork, runId: "run_1", now: NOW });
    // Left while the first one is being processed.
    await repo.createUserMessage({ ...primaryWork, body: "还有第 2 集", episodeTags: [], now: NOW });

    // The card says 「排队中 · 这次处理完接着处理」, not 「马上处理」.
    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: true, status: "already_running" });
    expect(await repo.listWorksWithPendingMessages({ urgentOnly: true })).toEqual([primaryWork]);
  });

  it("现在处理 queues nothing when no message is waiting any more", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "换", episodeTags: [], now: NOW });
    await repo.withdrawUserMessage({ accountId: "acct_default", id: m.id, now: NOW });

    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: true, status: "nothing_waiting" });
    expect(await repo.listActiveWorkflowRuns({ accountId: "acct_default", connectedStorageId: "cs_primary" })).toEqual([]);
  });

  it("现在处理 says so when the AI model is not set up, before marking or queueing anything", async () => {
    await track(repo, "acct_default", "cs_primary");
    await repo.createUserMessage({ ...primaryWork, body: "换", episodeTags: [], now: NOW });
    llmError = "还没配置 AI 模型";

    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: false, message: "还没配置 AI 模型" });
    expect((await repo.listUserMessages(primaryWork))[0]?.urgent).toBe(false);
    expect(await repo.listActiveWorkflowRuns({ accountId: "acct_default", connectedStorageId: "cs_primary" })).toEqual([]);
  });

  it("现在处理 on a drive whose login died asks for a re-bind, before marking or queueing anything", async () => {
    await track(repo, "acct_default", "cs_primary");
    await repo.createUserMessage({ ...primaryWork, body: "换", episodeTags: [], now: NOW });
    await repo.setConnectedStorageStatus("cs_primary", "frozen", "cookie expired", NOW);

    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: false, message: "这块网盘登录已失效，重新绑定后再处理" });
    expect((await repo.listUserMessages(primaryWork))[0]?.urgent).toBe(false);
    expect(await repo.listActiveWorkflowRuns({ accountId: "acct_default", connectedStorageId: "cs_primary" })).toEqual([]);
  });

  it("不换了 drops only the named 待换 episodes", async () => {
    await track(repo, "acct_default", "cs_primary");
    await repo.addPendingReplacements({ ...primaryWork, episodes: ["S01E01", "S01E02"], messageId: "msg_1", now: NOW });

    expect(await actions.keepEpisodesAsIsAction({ ...onPrimary, episodes: ["S01E02"] })).toEqual({ success: true });
    expect((await repo.listPendingReplacements(primaryWork)).map((p) => p.episode)).toEqual(["S01E01"]);
  });

  // The card disables 不换了 while a replace run of the work is processing (its end-of-run
  // bookkeeping would put the episode back as 待换), but only as of the page's last render:
  // the server checks again when the button is pressed.
  const keepBusy = { success: false, message: "处理中，完了再操作" };

  it("不换了 is refused once the replace run the page saw queued has started and holds the messages", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "第 1 集也换", episodeTags: ["S01E01"], now: NOW });
    await repo.addPendingReplacements({ ...primaryWork, episodes: ["S01E02"], messageId: m.id, now: NOW });
    const queued = await queueReplaceRequest({ repository: repo, work: primaryWork });
    // The worker starts it after the page rendered: the card still shows 不换了 enabled.
    await repo.claimNextQueuedWorkflowRun({ kind: "replace_request", now: NOW });
    await repo.claimUserMessages({ ...primaryWork, runId: queued.workflowRunId!, now: NOW });

    expect(await actions.keepEpisodesAsIsAction({ ...onPrimary, episodes: ["S01E02"] })).toEqual(keepBusy);
    expect((await repo.listPendingReplacements(primaryWork)).map((p) => p.episode)).toEqual(["S01E02"]);
  });

  it("不换了 is refused while a replace run of the work is running without any message (the patrol's, for 待换 only)", async () => {
    await track(repo, "acct_default", "cs_primary");
    await repo.addPendingReplacements({ ...primaryWork, episodes: ["S01E02"], messageId: "msg_1", now: NOW });
    await queueReplaceRequest({ repository: repo, work: primaryWork, origin: "patrol" });
    await repo.claimNextQueuedWorkflowRun({ kind: "replace_request", now: NOW });

    expect(await actions.keepEpisodesAsIsAction({ ...onPrimary, episodes: ["S01E02"] })).toEqual(keepBusy);
    expect((await repo.listPendingReplacements(primaryWork)).map((p) => p.episode)).toEqual(["S01E02"]);
  });

  it("不换了 is refused while one of the work's messages is still processing, as the card shows it", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "第 2 集发蓝", episodeTags: ["S01E02"], now: NOW });
    await repo.addPendingReplacements({ ...primaryWork, episodes: ["S01E02"], messageId: m.id, now: NOW });
    // Held by a run that is no longer listed (it died; the orphan scan has not released it yet).
    await repo.claimUserMessages({ ...primaryWork, runId: "run_gone", now: NOW });

    expect(await actions.keepEpisodesAsIsAction({ ...onPrimary, episodes: ["S01E02"] })).toEqual(keepBusy);
    expect((await repo.listPendingReplacements(primaryWork)).map((p) => p.episode)).toEqual(["S01E02"]);
  });

  it("不换了 goes through while the replace run is only queued (it re-reads the 待换 rows when it starts) or another kind of run holds the title", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "第 1 集也换", episodeTags: ["S01E01"], now: NOW });
    await repo.addPendingReplacements({ ...primaryWork, episodes: ["S01E01", "S01E02"], messageId: m.id, now: NOW });
    await queueReplaceRequest({ repository: repo, work: primaryWork });

    expect(await actions.keepEpisodesAsIsAction({ ...onPrimary, episodes: ["S01E02"] })).toEqual({ success: true });
    expect((await repo.listPendingReplacements(primaryWork)).map((p) => p.episode)).toEqual(["S01E01"]);

    // An acquisition of another season running on the title: not a replace run.
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      connectedStorageId: "cs_primary",
      title: show,
      season: { ...s1, id: "tmdb_tv_42_s2", seasonNumber: 2 },
      workflowRun: { id: "run_s2", kind: "type2_init", status: "running", trackedSeasonId: "tmdb_tv_42_s2", startedAt: NOW, finishedAt: null, auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: "tmdb_tv_42_s2", seasonNumber: 2, totalEpisodes: 2, latestAiredEpisode: 2 }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    expect(await actions.keepEpisodesAsIsAction({ ...onPrimary, episodes: ["S01E01"] })).toEqual({ success: true });
    expect(await repo.listPendingReplacements(primaryWork)).toEqual([]);
  });

  it("撤销 after 不换了 puts the 待换 rows back as they were: same message, same time", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m1 = await repo.createUserMessage({ ...primaryWork, body: "第 1 集发蓝", episodeTags: ["S01E01"], now: "2026-09-25T00:00:00.000Z" });
    const m2 = await repo.createUserMessage({ ...primaryWork, body: "第 2 集也是", episodeTags: ["S01E02"], now: "2026-09-26T00:00:00.000Z" });
    await repo.addPendingReplacements({ ...primaryWork, episodes: ["S01E01"], messageId: m1.id, now: "2026-09-25T01:00:00.000Z" });
    await repo.addPendingReplacements({ ...primaryWork, episodes: ["S01E02"], messageId: m2.id, now: "2026-09-26T02:00:00.000Z" });
    const before = await repo.listPendingReplacements(primaryWork);
    const rows = before.map(({ episode, messageId, requestedAt }) => ({ episode, messageId, requestedAt }));
    expect(await actions.keepEpisodesAsIsAction({ ...onPrimary, episodes: ["S01E01", "S01E02"] })).toEqual({ success: true });
    expect(await repo.listPendingReplacements(primaryWork)).toEqual([]);

    expect(await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: rows })).toEqual({ success: true });

    expect(await repo.listPendingReplacements(primaryWork)).toEqual(before);
  });

  it("撤销 leaves a row that is somehow still there as it was", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m1 = await repo.createUserMessage({ ...primaryWork, body: "第 1 集发蓝", episodeTags: [], now: NOW });
    const m2 = await repo.createUserMessage({ ...primaryWork, body: "第 1 集还是蓝", episodeTags: [], now: NOW });
    await repo.addPendingReplacements({ ...primaryWork, episodes: ["S01E01"], messageId: m1.id, now: NOW });

    // Already 待换 (a refresh raced the undo): left as it was.
    expect(
      await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: [{ episode: "S01E01", messageId: m2.id, requestedAt: "2026-01-01T00:00:00.000Z" }] }),
    ).toEqual({ success: true });
    expect(await repo.listPendingReplacements(primaryWork)).toMatchObject([{ episode: "S01E01", messageId: m1.id, requestedAt: NOW }]);
  });

  it("a film's 撤销 puts back its MOVIE row", async () => {
    const film: MediaTitle = { id: "tmdb_movie_42", tmdbId: 42, type: "movie", title: "Film", originalTitle: "Film", year: 2026, aliases: [] };
    const anchor = movieAnchorSeason({ titleId: film.id, qualityPreference: "4K", storageDirectoryId: "dir_film" });
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      connectedStorageId: "cs_primary",
      title: film,
      season: anchor,
      workflowRun: { id: "seed_film", kind: "movie_init", status: "succeeded", trackedSeasonId: anchor.id, startedAt: NOW, finishedAt: NOW, auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: anchor.id, seasonNumber: anchor.seasonNumber, totalEpisodes: 1, latestAiredEpisode: 1 }).map((e) => ({ ...e, obtained: true })),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const filmWork = { ...primaryWork, titleKey: film.id };
    const onFilm = { ...onPrimary, mediaType: "movie" as const };
    const m = await repo.createUserMessage({ ...filmWork, body: "这部是假片", episodeTags: [], now: NOW });
    await repo.addPendingReplacements({ ...filmWork, episodes: ["MOVIE"], messageId: m.id, now: NOW });
    expect(await actions.keepEpisodesAsIsAction({ ...onFilm, episodes: ["MOVIE"] })).toEqual({ success: true });

    expect(await actions.restoreEpisodesToPendingAction({ ...onFilm, episodes: [{ episode: "MOVIE", messageId: m.id, requestedAt: NOW }] })).toEqual({
      success: true,
    });
    expect(await repo.listPendingReplacements(filmWork)).toMatchObject([{ episode: "MOVIE", messageId: m.id, requestedAt: NOW }]);
  });

  it("撤销's rows are checked before any lookup: a malformed one is refused and nothing is written", async () => {
    await track(repo, "acct_default", "cs_primary");
    const ok = { episode: "S01E01", messageId: "msg_1", requestedAt: NOW };
    const refused = { success: false, message: "集数不对" };
    const bad: unknown[] = [
      [],
      "S01E01",
      [{ ...ok, episode: "E13" }],
      [{ ...ok, episode: "S1E01" }],
      [{ ...ok, episode: "MOVIE" }],
      [{ ...ok, messageId: "" }],
      [{ ...ok, messageId: "x".repeat(200) }],
      [{ ...ok, requestedAt: "昨天" }],
      // Not an ISO time as the store writes it (a date alone; the year-275760 extended form).
      [{ ...ok, requestedAt: "2026-09-27" }],
      [{ ...ok, requestedAt: "+275760-09-13T00:00:00.000Z" }],
      [{ episode: "S01E01" }],
      [null],
      Array.from({ length: 201 }, (_, i) => ({ ...ok, episode: `S01E${String(i + 1).padStart(3, "0")}` })),
    ];

    for (const episodes of bad) {
      expect(await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: episodes as never })).toEqual(refused);
    }
    // A film only has its MOVIE row.
    expect(await actions.restoreEpisodesToPendingAction({ ...onPrimary, mediaType: "movie", episodes: [ok] })).toEqual(refused);
    expect(await repo.listPendingReplacements(primaryWork)).toEqual([]);
  });

  // 撤销 is a client call like any other: the rows it sends back must be ones this work's
  // own 待换 could have held — else it could file any episode under any message, any time.
  const mismatch = { success: false, message: "要恢复的集对不上这部作品" };

  it("撤销 only puts back rows filed under one of this work's messages", async () => {
    await track(repo, "acct_default", "cs_primary");
    const theirs = await repo.createUserMessage({ accountId: "acct_2", drive: "cs_other", titleKey: "tmdb_tv_42", body: "别人的", episodeTags: [], now: NOW });
    const otherWork = await repo.createUserMessage({ ...primaryWork, titleKey: "tmdb_tv_7", body: "别的剧", episodeTags: [], now: NOW });
    const withdrawn = await repo.createUserMessage({ ...primaryWork, body: "撤回了", episodeTags: [], now: NOW });
    await repo.withdrawUserMessage({ accountId: "acct_default", id: withdrawn.id, now: NOW });

    for (const messageId of [theirs.id, otherWork.id, withdrawn.id, "msg_made_up"]) {
      expect(await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: [{ episode: "S01E01", messageId, requestedAt: NOW }] })).toEqual(mismatch);
    }
    expect(await repo.listPendingReplacements(primaryWork)).toEqual([]);
  });

  it("撤销 only puts back episodes of a season tracked here", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "换", episodeTags: [], now: NOW });

    for (const episode of ["S02E01", "S99E9999", "S00E01"]) {
      expect(await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: [{ episode, messageId: m.id, requestedAt: NOW }] })).toEqual(mismatch);
    }
    expect(await repo.listPendingReplacements(primaryWork)).toEqual([]);
  });

  it("撤销 refuses a time later than now, beyond a few minutes of clock skew", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "换", episodeTags: [], now: NOW });
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

    expect(await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: [{ episode: "S01E01", messageId: m.id, requestedAt: later(10) }] })).toEqual(mismatch);
    expect(await repo.listPendingReplacements(primaryWork)).toEqual([]);

    // The server's clock and the one that wrote the row may differ a little.
    const skewed = later(2);
    expect(await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: [{ episode: "S01E01", messageId: m.id, requestedAt: skewed }] })).toEqual({
      success: true,
    });
    expect(await repo.listPendingReplacements(primaryWork)).toMatchObject([{ episode: "S01E01", messageId: m.id, requestedAt: skewed }]);
  });

  it("one row that does not fit refuses the whole call: the others are not written either", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "换", episodeTags: [], now: NOW });

    expect(
      await actions.restoreEpisodesToPendingAction({
        ...onPrimary,
        episodes: [
          { episode: "S01E01", messageId: m.id, requestedAt: NOW },
          { episode: "S02E01", messageId: m.id, requestedAt: NOW },
        ],
      }),
    ).toEqual(mismatch);
    expect(await repo.listPendingReplacements(primaryWork)).toEqual([]);
  });

  it("撤销 takes every episode code the engine writes: SxxEyy with two or more digits in each part", async () => {
    await track(repo, "acct_default", "cs_primary");
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      connectedStorageId: "cs_primary",
      title: show,
      season: { ...s1, id: "tmdb_tv_42_s100", seasonNumber: 100 },
      workflowRun: { id: "seed_s100", kind: "type2_init", status: "succeeded", trackedSeasonId: "tmdb_tv_42_s100", startedAt: NOW, finishedAt: NOW, auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: "tmdb_tv_42_s100", seasonNumber: 100, totalEpisodes: 2, latestAiredEpisode: 2 }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const m = await repo.createUserMessage({ ...primaryWork, body: "换", episodeTags: [], now: NOW });
    const rows = ["S01E100", "S01E12345", "S100E01"].map((episode) => ({ episode, messageId: m.id, requestedAt: NOW }));

    expect(await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: rows })).toEqual({ success: true });
    expect((await repo.listPendingReplacements(primaryWork)).map((p) => p.episode).sort()).toEqual(["S01E100", "S01E12345", "S100E01"]);
  });

  it("the unauthenticated sentinel is refused by every action and nothing is written", async () => {
    const { UNAUTHENTICATED_ACCOUNT_ID } = await vi.importActual<typeof import("../lib/workflow-runtime")>("../lib/workflow-runtime");
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "原话", episodeTags: [], now: NOW });
    await repo.addPendingReplacements({ ...primaryWork, episodes: ["S01E01"], messageId: m.id, now: NOW });
    accountId = UNAUTHENTICATED_ACCOUNT_ID;

    expect(await actions.postUserMessageAction({ ...onPrimary, body: "换", episodeTags: [] })).toMatchObject({ success: false });
    expect(await actions.editUserMessageAction({ id: m.id, body: "改", episodeTags: [] })).toMatchObject({ success: false });
    expect(await actions.withdrawUserMessageAction({ id: m.id })).toMatchObject({ success: false });
    expect(await actions.processMessagesNowAction(onPrimary)).toMatchObject({ success: false });
    expect(await actions.keepEpisodesAsIsAction({ ...onPrimary, episodes: ["S01E01"] })).toMatchObject({ success: false });
    expect(
      await actions.restoreEpisodesToPendingAction({ ...onPrimary, episodes: [{ episode: "S01E02", messageId: m.id, requestedAt: NOW }] }),
    ).toMatchObject({ success: false });

    expect(await repo.listUserMessages(primaryWork)).toMatchObject([{ body: "原话", status: "pending", urgent: false }]);
    expect(await repo.listPendingReplacements(primaryWork)).toMatchObject([{ episode: "S01E01" }]);
    expect(await repo.listWorksWithPendingMessages({ urgentOnly: false })).toEqual([primaryWork]);
  });
});
