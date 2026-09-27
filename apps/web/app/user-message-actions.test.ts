import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEpisodeStates,
  InMemoryWorkflowRepository,
  isRegisteredStorageProvider,
  pickWorkspaceStorageId,
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

    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: true, queued: true });
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
    expect(await repo.listUserMessages(primaryWork)).toHaveLength(0);
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

  it("现在处理 while a run already holds the work: the message is urgent and runs right after", async () => {
    await track(repo, "acct_default", "cs_primary");
    await repo.createUserMessage({ ...primaryWork, body: "第一条", episodeTags: [], now: NOW });
    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: true, queued: true });
    await repo.claimUserMessages({ ...primaryWork, runId: "run_1", now: NOW });
    // Left while the first one is being processed.
    await repo.createUserMessage({ ...primaryWork, body: "还有第 2 集", episodeTags: [], now: NOW });

    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: true, queued: false });
    expect(await repo.listWorksWithPendingMessages({ urgentOnly: true })).toEqual([primaryWork]);
  });

  it("现在处理 queues nothing when no message is waiting any more", async () => {
    await track(repo, "acct_default", "cs_primary");
    const m = await repo.createUserMessage({ ...primaryWork, body: "换", episodeTags: [], now: NOW });
    await repo.withdrawUserMessage({ accountId: "acct_default", id: m.id, now: NOW });

    expect(await actions.processMessagesNowAction(onPrimary)).toEqual({ success: true, queued: false });
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

    expect(await repo.listUserMessages(primaryWork)).toMatchObject([{ body: "原话", status: "pending", urgent: false }]);
    expect(await repo.listPendingReplacements(primaryWork)).toHaveLength(1);
    expect(await repo.listWorksWithPendingMessages({ urgentOnly: false })).toEqual([primaryWork]);
  });
});
