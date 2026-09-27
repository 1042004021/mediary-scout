import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  createEpisodeStates,
  enqueueUrgentReplaceRequests,
  FakeStorageExecutor,
  formatDailyDigestPushText,
  InMemoryWorkflowRepository,
  movieAnchorSeason,
  queueReplaceRequest,
  runQueuedReplaceRequest,
  scheduledDigestItems,
  type MediaTitle,
  type ResourceCandidate,
  type ResourceProvider,
  type TrackedSeason,
  type VerifiedFile,
  type WorkflowRepository,
} from "../src/index.js";

const NOW = "2026-09-26T08:00:00.000Z";
const fixedNow = () => NOW;
const DRIVE = "cs_drive_1";
const NEW_TITLE = "[NewGroup] Show 01 [1.9G]";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;
const tool = (name: string, input: unknown, i: number) => ({
  content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
  usage: USAGE,
  warnings: [],
});
const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: "stop" as const },
  usage: USAGE,
  warnings: [],
});
/** A model response the provider's content filter cut off. */
const contentFiltered = () => ({
  content: [],
  finishReason: { unified: "content-filter" as const, raw: "content_filter" },
  usage: USAGE,
  warnings: [],
});

function throwingModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("agent model unavailable");
    },
  });
}

/** The JSON output of the most recent tool result named `toolName` in a model prompt. */
function lastToolOutput(prompt: unknown, toolName: string): any {
  const messages = prompt as Array<{ role: string; content: unknown }>;
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type: string; toolName?: string; output?: { value?: unknown } }>) {
      if (part.type === "tool-result" && part.toolName === toolName) return part.output?.value;
    }
  }
  return undefined;
}

/** Any "Show…" search returns one new release with a stable id. */
function provider(): ResourceProvider {
  return {
    search: async ({ keyword }) => {
      const snapshotId = `snap_${keyword}`;
      const candidates: ResourceCandidate[] = keyword.startsWith("Show")
        ? [
            {
              id: "cand_new",
              snapshotId,
              index: 0,
              title: NEW_TITLE,
              type: "magnet",
              source: "pansou",
              providerPayload: { url: `magnet:?xt=urn:btih:${"b".repeat(40)}` },
            },
          ]
        : [];
      return { id: snapshotId, provider: "pansou", keyword, candidates, createdAt: NOW };
    },
  };
}

function trackedFixture() {
  const title: MediaTitle = {
    id: "tmdb_tv_42",
    tmdbId: 42,
    type: "tv",
    title: "Show",
    originalTitle: "Show",
    year: 2026,
    aliases: [],
  };
  const season: TrackedSeason = {
    id: "tmdb_tv_42_s1",
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "completed",
    qualityPreference: "4K",
    storageDirectoryId: "dir_s1",
    totalEpisodes: 2,
    latestAiredEpisode: 2,
    latestAiredSource: "metadata",
  };
  return { title, season };
}

function verifiedFile(directoryId: string, id: string, code: string): VerifiedFile {
  return {
    id,
    storageDirectoryId: directoryId,
    name: `Show.${code}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: id,
  };
}

/** A tracked season on DRIVE whose listed episodes are all obtained. */
async function seedTrackedSeason(input: {
  repository: InMemoryWorkflowRepository;
  title: MediaTitle;
  season: TrackedSeason;
  obtainedCodes: string[];
}) {
  const episodes = createEpisodeStates({
    trackedSeasonId: input.season.id,
    seasonNumber: input.season.seasonNumber,
    totalEpisodes: input.season.totalEpisodes,
    latestAiredEpisode: input.season.latestAiredEpisode,
  }).map((episode) => ({ ...episode, obtained: input.obtainedCodes.includes(episode.episodeCode) }));
  await input.repository.saveWorkflowRunSnapshot({
    accountId: "acct_1",
    connectedStorageId: DRIVE,
    title: input.title,
    season: input.season,
    workflowRun: {
      id: `seed_${input.season.id}`,
      kind: "type2_init",
      status: "succeeded",
      trackedSeasonId: input.season.id,
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:00:00.000Z",
      auditEvents: [],
    },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

/** The canonical `Title (Year)/Season NN` tree the V2 workflow verify-or-creates, with the old files. */
async function seedV2Season(storage: FakeStorageExecutor, title: MediaTitle, season: TrackedSeason, presentCodes: string[]) {
  const showDir = await storage.createDirectory({ name: `${title.title} (${title.year})`, parentId: "library_root" });
  const seasonDir = await storage.createDirectory({
    name: `Season ${String(season.seasonNumber).padStart(2, "0")}`,
    parentId: showDir,
  });
  storage.seedDirectoryFiles(
    seasonDir,
    presentCodes.map((code) => verifiedFile(seasonDir, `present_${code}`, code)),
  );
  return seasonDir;
}

function storageWithNewRelease() {
  return new FakeStorageExecutor({
    transferOutcomes: {
      cand_new: {
        status: "succeeded",
        providerMessage: "ok",
        files: [{ id: "new01", storageDirectoryId: "staging", name: "[NewGroup] Show 01.mkv", sizeBytes: 2_000_000_000, episodeCode: "S01E01", providerFileId: "new01" }],
      },
    },
  });
}

const WORK = { accountId: "acct_1", drive: DRIVE, titleKey: "tmdb_tv_42" };

async function trackedShow() {
  const repository = new InMemoryWorkflowRepository();
  const { title, season } = trackedFixture();
  await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01", "S01E02"] });
  return { repository, title, season };
}

function baseRun(repository: InMemoryWorkflowRepository, storage: FakeStorageExecutor, model: MockLanguageModelV3) {
  return {
    repository,
    resourceProvider: provider(),
    storage,
    model,
    storageParentDirectoryId: "library_root",
    moviesParentDirectoryId: "movies_root",
    agentMemory: false,
    now: fixedNow,
  };
}

describe("queueReplaceRequest", () => {
  it("queues one replace_request per work; a second one is already_running", async () => {
    const { repository, season } = await trackedShow();

    const first = await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_1" });
    expect(first).toEqual({ status: "queued", workflowRunId: "run_rr_1" });
    const again = await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_2" });
    expect(again).toEqual({ status: "already_running", workflowRunId: "run_rr_1" });

    const active = await repository.listActiveWorkflowRuns({ accountId: "acct_1", connectedStorageId: DRIVE });
    expect(active.map((run) => [run.workflowRun.id, run.workflowRun.kind, run.workflowRun.status])).toEqual([
      ["run_rr_1", "replace_request", "queued"],
    ]);
    // The reservation kept the library's episode bucket.
    const state = await repository.getTrackedSeasonState(season.id, { accountId: "acct_1", connectedStorageId: DRIVE });
    expect(state?.episodes.every((episode) => episode.obtained)).toBe(true);
  });

  it("an unbound work (no drive) is queued and its message processed, not not_tracked", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    const episodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: season.latestAiredEpisode,
    }).map((episode) => ({ ...episode, obtained: true }));
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_1",
      title,
      season,
      workflowRun: {
        id: "seed_unbound",
        kind: "type2_init",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: "2026-09-01T00:00:00.000Z",
        finishedAt: "2026-09-01T00:00:00.000Z",
        auditEvents: [],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const unbound = { ...WORK, drive: "" };
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...unbound, body: "1 集发蓝", episodeTags: ["S01E01"], now: NOW });

    const queued = await queueReplaceRequest({ repository, work: unbound, now: fixedNow, createWorkflowRunId: () => "run_rr_unbound" });
    expect(queued).toEqual({ status: "queued", workflowRunId: "run_rr_unbound" });
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        i += 1;
        if (i === 1) return tool("reportReplacement", { results: [{ episode: "S01E01", outcome: "not_found", note: "没找到" }] }, i);
        return text("done");
      },
    });
    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_unbound", workflowStatus: "succeeded" });
    const [message] = await repository.listUserMessages(unbound);
    expect(message).toMatchObject({ status: "done", runId: "run_rr_unbound" });
    expect((await repository.listPendingReplacements(unbound)).map((p) => p.episode)).toEqual(["S01E01"]);
  });

  it("a work that is not tracked on that drive is not queued", async () => {
    const { repository } = await trackedShow();
    const result = await queueReplaceRequest({ repository, work: { ...WORK, drive: "other_drive" }, now: fixedNow });
    expect(result).toEqual({ status: "not_tracked", workflowRunId: null });
  });

  /** The repository, except that `race` runs once right after the first
   *  listTrackedSeasonStates read — the caller still holds the states read before it. */
  function raceAfterFirstStatesRead(repository: InMemoryWorkflowRepository, race: () => Promise<unknown>): WorkflowRepository {
    let raced = false;
    return new Proxy(repository, {
      get(target, prop, receiver) {
        if (prop === "listTrackedSeasonStates") {
          return async (...args: Parameters<WorkflowRepository["listTrackedSeasonStates"]>) => {
            const states = await target.listTrackedSeasonStates(...args);
            if (!raced) {
              raced = true;
              await race();
            }
            return states;
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("the work untracked between reading its seasons and reserving: not_tracked, and nothing tracks it again", async () => {
    const { repository } = await trackedShow();
    const scope = { accountId: "acct_1", connectedStorageId: DRIVE };
    let untracked: unknown;
    const racing = raceAfterFirstStatesRead(repository, async () => {
      untracked = await repository.untrackTitle(42, scope, "tv");
    });

    const result = await queueReplaceRequest({ repository: racing, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_gone_mid" });

    expect(untracked).toEqual({ status: "untracked", removedSeasons: 1 });
    expect(result).toEqual({ status: "not_tracked", workflowRunId: null });
    expect(await repository.listTrackedSeasonStates(scope)).toEqual([]);
    expect(await repository.listActiveWorkflowRuns(scope)).toEqual([]);
  });

  it("only the lock season untracked between reading and reserving: queued on the lowest season still tracked, the untracked one stays gone", async () => {
    const { repository, title, season } = await trackedShow();
    const season2: TrackedSeason = { ...season, id: "tmdb_tv_42_s2", seasonNumber: 2, storageDirectoryId: "dir_s2" };
    await seedTrackedSeason({ repository, title, season: season2, obtainedCodes: ["S02E01", "S02E02"] });
    const scope = { accountId: "acct_1", connectedStorageId: DRIVE };
    const racing = raceAfterFirstStatesRead(repository, () => repository.untrackTitle(42, scope, "tv", 1));

    const result = await queueReplaceRequest({ repository: racing, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_s2" });

    expect(result).toEqual({ status: "queued", workflowRunId: "run_rr_s2" });
    expect((await repository.listTrackedSeasonStates(scope)).map((s) => s.season.seasonNumber)).toEqual([2]);
    const active = await repository.listActiveWorkflowRuns(scope);
    expect(active.map((run) => [run.workflowRun.id, run.workflowRun.kind, run.workflowRun.trackedSeasonId])).toEqual([
      ["run_rr_s2", "replace_request", season2.id],
    ]);
  });

  it("a run of the lock season that saved between reading the seasons and reserving keeps what it landed: the reservation writes only the run", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01"] });
    const scope = { accountId: "acct_1", connectedStorageId: DRIVE };
    // A patrol run of S01, still running when the seasons were read, lands E02 and saves.
    const racing = raceAfterFirstStatesRead(repository, async () => {
      const state = (await repository.getTrackedSeasonState(season.id, scope))!;
      await repository.saveWorkflowRunSnapshot({
        accountId: "acct_1",
        connectedStorageId: DRIVE,
        title,
        season: state.season,
        workflowRun: {
          id: "run_patrol_landed",
          kind: "type3_monitor",
          status: "succeeded",
          trackedSeasonId: season.id,
          startedAt: "2026-09-25T00:00:00.000Z",
          finishedAt: "2026-09-25T00:10:00.000Z",
          auditEvents: [],
        },
        episodes: state.episodes.map((episode) => ({ ...episode, obtained: true })),
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
    });

    const result = await queueReplaceRequest({ repository: racing, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_after_landing" });

    expect(result).toEqual({ status: "queued", workflowRunId: "run_rr_after_landing" });
    const state = await repository.getTrackedSeasonState(season.id, scope);
    expect(state?.episodes.map((e) => [e.episodeCode, e.obtained])).toEqual([["S01E01", true], ["S01E02", true]]);
  });
});

describe("runQueuedReplaceRequest", () => {
  it("idle when nothing is queued", async () => {
    const repository = new InMemoryWorkflowRepository();
    const result = await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), throwingModel()));
    expect(result).toEqual({ status: "idle" });
  });

  it("claims the messages, replaces one episode, keeps the other pending, and replies per episode", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = storageWithNewRelease();
    const seasonDir = await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    const message = await repository.createUserMessage({ ...WORK, body: "1、2 集发蓝", episodeTags: ["S01E01", "S01E02"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr" });

    let system = "";
    let statusDuringRun = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) {
          system = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
          statusDuringRun = (await repository.listUserMessages(WORK))[0]!.status;
          return tool("inspectTargetDir", { season: 1 }, i);
        }
        if (i === 2) return tool("rejectCurrentSource", { episodes: ["S01E01"], fileIds: ["present_S01E01"], reason: "发蓝" }, i);
        // Every requested episode must be rejected before anything transfers.
        if (i === 3) return tool("rejectCurrentSource", { episodes: ["S01E02"], fileIds: ["present_S01E02"], reason: "发蓝" }, i);
        if (i === 4) return tool("searchResources", { keyword: "Show 01" }, i);
        if (i === 5) {
          const search = lastToolOutput(options.prompt, "searchResources");
          const alias = (search.snapshot.candidates as Array<{ id: string; title: string }>).find((c) => c.title === NEW_TITLE)!.id;
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: alias }, i);
        }
        if (i === 6) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["new01"] }] }, i);
        if (i === 7) return tool("markObtained", { codes: ["S01E01"] }, i);
        if (i === 8) {
          const search = lastToolOutput(options.prompt, "searchResources");
          const alias = (search.snapshot.candidates as Array<{ id: string; title: string }>)[0]!.id;
          return tool(
            "reportReplacement",
            { results: [{ episode: "S01E01", outcome: "replaced", candidateId: alias, fileIds: ["new01"], note: "新版" }, { episode: "S01E02", outcome: "not_found", note: "没找到别的版本" }] },
            i,
          );
        }
        if (i === 9) return tool("finish", {}, i);
        return text("done");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr" });
    // The message reached the agent, and was processing while it ran.
    expect(system).toContain("1、2 集发蓝");
    expect(statusDuringRun).toBe("processing");

    const [done] = await repository.listUserMessages(WORK);
    expect(done).toMatchObject({ id: message.id, status: "done", runId: "run_rr" });
    // The size is the new file's real size (from the target dir), not the "[1.9G]" in its title.
    expect(done!.reply).toEqual({
      results: [
        { episode: "S01E01", outcome: "replaced", label: NEW_TITLE, sizeBytes: 2_000_000_000, note: "新版" },
        { episode: "S01E02", outcome: "not_found", note: "没找到别的版本" },
      ],
      oldFiles: ["Season 01/Show.S01E01.mkv", "Season 01/Show.S01E02.mkv"],
      runId: "run_rr",
    });

    expect((await repository.listPendingReplacements(WORK)).map((p) => [p.episode, p.messageId])).toEqual([["S01E02", message.id]]);
    const sources = await repository.listEpisodeSources(WORK);
    expect(sources).toEqual([
      expect.objectContaining({ episode: "S01E01", label: NEW_TITLE, linkKey: `magnet:${"b".repeat(40)}`, runId: "run_rr", sizeBytes: 2_000_000_000 }),
    ]);
    const rejected = await repository.listRejectedResources({ accountId: "acct_1", titleKey: "tmdb_tv_42" });
    expect(rejected).toHaveLength(2);
    expect(rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ episode: "S01E01", label: "Show.S01E01.mkv", messageId: message.id }),
      expect.objectContaining({ episode: "S01E02", label: "Show.S01E02.mkv", messageId: message.id }),
    ]));

    // The library is intact: both episodes obtained, old and new files side by side.
    const state = await repository.getTrackedSeasonState(season.id, { accountId: "acct_1", connectedStorageId: DRIVE });
    expect(state?.episodes.map((e) => [e.episodeCode, e.obtained])).toEqual([["S01E01", true], ["S01E02", true]]);
    expect((await storage.listTree({ directoryId: seasonDir })).map((f) => f.providerFileId).sort()).toEqual(
      ["new01", "present_S01E01", "present_S01E02"],
    );

    // The lock run itself is terminal, keeps its kind, and carries the replace notification.
    const run = await repository.getWorkflowRunSnapshot("run_rr", { accountId: "acct_1", connectedStorageId: DRIVE });
    expect(run?.workflowRun).toMatchObject({ kind: "replace_request", status: "succeeded" });
    expect(run?.workflowRun.finishedAt).toBe(NOW);
    expect(run?.workflowRun.auditEvents.map((e) => e.type)).toEqual(expect.arrayContaining(["replace_request_queued", "workflow_claimed"]));
    expect(run?.notifications).toHaveLength(1);
    const notification = run!.notifications[0]!;
    expect(notification).toMatchObject({ kind: "replacement_done", trigger: "user", workflowRunId: "run_rr" });
    expect(notification.report).toMatchObject({ status: "replaced" });
    expect(notification.report?.lines[0]).toBe("换好 1 集（E01），1 集还在找（E02）");
    // No landed size: old + new files would double-count.
    expect(notification.report?.fileCount).toBeUndefined();
    expect(notification.body).not.toMatch(/入库|获取完成/);
    expect(await repository.listActiveWorkflowRuns({ accountId: "acct_1", connectedStorageId: DRIVE })).toEqual([]);
  });

  it("an episode replaced from a season pack replies with its own file's size, not the pack size in the title", async () => {
    const { repository, title, season } = await trackedShow();
    const PACK_TITLE = "[NewGroup] Show S01 全集 1080p [20.5G]";
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        cand_pack: {
          status: "succeeded",
          providerMessage: "ok",
          files: [
            { id: "pack01", storageDirectoryId: "staging", name: "[NewGroup] Show 01.mkv", sizeBytes: 1_300_000_000, episodeCode: "S01E01", providerFileId: "pack01" },
            { id: "pack02", storageDirectoryId: "staging", name: "[NewGroup] Show 02.mkv", sizeBytes: 1_400_000_000, episodeCode: "S01E02", providerFileId: "pack02" },
          ],
        },
      },
    });
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    const packProvider: ResourceProvider = {
      search: async ({ keyword }) => ({
        id: `snap_${keyword}`,
        provider: "pansou",
        keyword,
        candidates: [
          { id: "cand_pack", snapshotId: `snap_${keyword}`, index: 0, title: PACK_TITLE, type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"d".repeat(40)}` } },
        ],
        createdAt: NOW,
      }),
    };
    await repository.createUserMessage({ ...WORK, body: "第 1 集发蓝", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_pack" });
    let alias = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: ["S01E01"], fileIds: ["present_S01E01"], reason: "发蓝" }, i);
        if (i === 2) return tool("searchResources", { keyword: "Show S01" }, i);
        if (i === 3) {
          const search = lastToolOutput(options.prompt, "searchResources");
          alias = search.snapshot.candidates[0].id;
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: alias }, i);
        }
        if (i === 4) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["pack01"] }] }, i);
        if (i === 5) return tool("markObtained", { codes: ["S01E01"] }, i);
        if (i === 6) return tool("reportReplacement", { results: [{ episode: "S01E01", outcome: "replaced", candidateId: alias, fileIds: ["pack01"], note: "整季包里的第 1 集" }] }, i);
        if (i === 7) return tool("finish", {}, i);
        return text("done");
      },
    });

    await runQueuedReplaceRequest({ ...baseRun(repository, storage, model), resourceProvider: packProvider });

    const [done] = await repository.listUserMessages(WORK);
    expect(done?.reply?.results).toEqual([
      { episode: "S01E01", outcome: "replaced", label: PACK_TITLE, sizeBytes: 1_300_000_000, note: "整季包里的第 1 集" },
    ]);
    expect(await repository.listEpisodeSources(WORK)).toEqual([expect.objectContaining({ episode: "S01E01", sizeBytes: 1_300_000_000 })]);
  });

  it("covers every tracked season: the lock season record carries the evidence, the other season a bare _sN record", async () => {
    const { repository, title, season } = await trackedShow();
    const season2: TrackedSeason = { ...season, id: "tmdb_tv_42_s2", seasonNumber: 2, storageDirectoryId: "dir_s2" };
    await seedTrackedSeason({ repository, title, season: season2, obtainedCodes: ["S02E01", "S02E02"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "第二季第一集没字幕", episodeTags: ["S02E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_ms" });

    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        i += 1;
        if (i === 1) return tool("reportReplacement", { results: [{ episode: "S02E01", outcome: "not_found", note: "没有带字幕的" }] }, i);
        return text("done");
      },
    });

    await runQueuedReplaceRequest(baseRun(repository, storage, model));

    const scope = { accountId: "acct_1", connectedStorageId: DRIVE };
    const lock = await repository.getWorkflowRunSnapshot("run_rr_ms", scope);
    expect(lock?.season.seasonNumber).toBe(1);
    expect(lock?.notifications.map((n) => n.kind)).toEqual(["replacement_done"]);
    const s2 = await repository.getWorkflowRunSnapshot("run_rr_ms_s2", scope);
    expect(s2?.workflowRun).toMatchObject({ kind: "replace_request", status: "succeeded" });
    expect(s2?.notifications).toEqual([]);
    for (const id of [season.id, season2.id]) {
      const state = await repository.getTrackedSeasonState(id, scope);
      expect(state?.episodes.every((e) => e.obtained)).toBe(true);
    }
    expect((await repository.listPendingReplacements(WORK)).map((p) => p.episode)).toEqual(["S02E01"]);
  });

  it("a failing model releases the messages to the patrol (not urgent: a final failure) and leaves the library untouched", async () => {
    const { repository, season } = await trackedShow();
    await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_fail" });
    const storage = new FakeStorageExecutor();

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, throwingModel()));

    expect(result).toMatchObject({ status: "failed", workflowRunId: "run_rr_fail" });
    const [message] = await repository.listUserMessages(WORK);
    expect(message).toMatchObject({ status: "pending", urgent: false, runId: null });
    const run = await repository.getWorkflowRunSnapshot("run_rr_fail", { accountId: "acct_1", connectedStorageId: DRIVE });
    expect(run?.workflowRun.status).toBe("failed");
    // A failed replace keeps the lock season's episodes (a failed type2 init would clear them).
    const state = await repository.getTrackedSeasonState(season.id, { accountId: "acct_1", connectedStorageId: DRIVE });
    expect(state?.episodes.map((e) => [e.episodeCode, e.obtained])).toEqual([["S01E01", true], ["S01E02", true]]);
    expect(await repository.listPendingReplacements(WORK)).toEqual([]);
  });

  it("a patrol-queued replace whose acquisition throws saves the failure notification with trigger 'scheduled'; a user-queued one stays 'user'", async () => {
    for (const origin of ["patrol", "user"] as const) {
      const { repository } = await trackedShow();
      await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
      const runId = `run_rr_fail_${origin}`;
      await queueReplaceRequest({ repository, work: WORK, now: fixedNow, origin, createWorkflowRunId: () => runId });

      const result = await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), throwingModel()));

      expect(result).toMatchObject({ status: "failed", workflowRunId: runId });
      const run = await repository.getWorkflowRunSnapshot(runId, { accountId: "acct_1", connectedStorageId: DRIVE });
      expect(run?.notifications).toHaveLength(1);
      // Patrol failures join the daily digest (trigger "scheduled"); user failures are pushed individually ("user").
      expect(run?.notifications[0]?.trigger).toBe(origin === "patrol" ? "scheduled" : "user");
    }
  });

  it("with no message and no pending episode the claimed run just succeeds", async () => {
    const { repository } = await trackedShow();
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_empty" });

    const result = await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), throwingModel()));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_empty", workflowStatus: "succeeded" });
    const run = await repository.getWorkflowRunSnapshot("run_rr_empty", { accountId: "acct_1", connectedStorageId: DRIVE });
    expect(run?.workflowRun.status).toBe("succeeded");
    expect(run?.episodes.every((e) => e.obtained)).toBe(true);
  });

  it("a pending replacement alone (no message) is queued and run with the pending episodes as the request", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E02"], messageId: "msg_old", now: NOW });

    const queued = await enqueueUrgentReplaceRequests({ repository, now: fixedNow });
    expect(queued).toBe(0); // the idle scan is for urgent messages only; the patrol queues this one
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_pending" });

    let system = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) {
          system = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
          return tool("reportReplacement", { results: [{ episode: "S01E02", outcome: "not_found", note: "还是没有" }] }, i);
        }
        return text("done");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_pending" });
    expect(system).toContain("Still waiting for a replacement from earlier requests: S01E02");
    // Still pending, still attributed to the original message.
    expect((await repository.listPendingReplacements(WORK)).map((p) => [p.episode, p.messageId])).toEqual([["S01E02", "msg_old"]]);
    const run = await repository.getWorkflowRunSnapshot("run_rr_pending", { accountId: "acct_1", connectedStorageId: DRIVE });
    expect(run?.notifications[0]?.report?.status).toBe("no_coverage");
    expect(run?.notifications[0]?.report?.lines[0]).toContain("还没找到可以换的版本");
  });

  it("a movie replace run keeps the film obtained, records the source, and says so in a replacement_done notification", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title: MediaTitle = { id: "tmdb_movie_27205", tmdbId: 27205, type: "movie", title: "Film", originalTitle: "Film", year: 2010, aliases: [] };
    const season = movieAnchorSeason({ titleId: title.id, qualityPreference: "4K", storageDirectoryId: "dir_movie" });
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_1",
      connectedStorageId: DRIVE,
      title,
      season,
      workflowRun: { id: "seed_movie", kind: "movie_init", status: "succeeded", trackedSeasonId: season.id, startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.000Z", auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }).map((e) => ({ ...e, obtained: true })),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const work = { accountId: "acct_1", drive: DRIVE, titleKey: title.id };
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        cand_film: {
          status: "succeeded",
          providerMessage: "ok",
          files: [{ id: "newfilm", storageDirectoryId: "x", name: "Film.2010.Real.mkv", sizeBytes: 9_000_000_000, episodeCode: null, providerFileId: "newfilm" }],
        },
      },
    });
    const movieDir = await storage.createDirectory({ name: "Film (2010) {tmdb-27205}", parentId: "movies_root" });
    storage.seedDirectoryFiles(movieDir, [
      { id: "oldfilm", storageDirectoryId: movieDir, name: "Film.2010.KnockOff.mkv", sizeBytes: 4_000_000_000, episodeCode: null, providerFileId: "oldfilm" },
    ]);
    const filmProvider: ResourceProvider = {
      search: async ({ keyword }) => ({
        id: `snap_${keyword}`,
        provider: "pansou",
        keyword,
        candidates: [
          { id: "cand_film", snapshotId: `snap_${keyword}`, index: 0, title: "Film 2010 Real [8.4G]", type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"c".repeat(40)}` } },
        ],
        createdAt: NOW,
      }),
    };
    await repository.createUserMessage({ ...work, body: "这是假片", episodeTags: [], now: NOW });
    await queueReplaceRequest({ repository, work, now: fixedNow, createWorkflowRunId: () => "run_rr_movie" });

    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: [], fileIds: ["oldfilm"], reason: "假片" }, i);
        if (i === 2) return tool("searchResources", { keyword: "Film" }, i);
        if (i === 3) {
          const search = lastToolOutput(options.prompt, "searchResources");
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: search.snapshot.candidates[0].id }, i);
        }
        if (i === 4) return tool("markObtained", { codes: ["MOVIE"] }, i);
        if (i === 5) {
          const search = lastToolOutput(options.prompt, "searchResources");
          return tool("reportReplacement", { results: [{ episode: "MOVIE", outcome: "replaced", candidateId: search.snapshot.candidates[0].id, fileIds: ["newfilm"], note: "正版" }] }, i);
        }
        return text("done");
      },
    });

    const result = await runQueuedReplaceRequest({ ...baseRun(repository, storage, model), resourceProvider: filmProvider });

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_movie" });
    const run = await repository.getWorkflowRunSnapshot("run_rr_movie", { accountId: "acct_1", connectedStorageId: DRIVE });
    expect(run?.workflowRun).toMatchObject({ kind: "replace_request", status: "succeeded" });
    expect(run?.episodes[0]?.obtained).toBe(true);
    expect(run?.notifications[0]).toMatchObject({ kind: "replacement_done", trigger: "user" });
    expect(run?.notifications[0]?.report).toMatchObject({ status: "replaced", lines: expect.arrayContaining(["已换成新版本"]) });
    expect(run?.notifications[0]?.report?.totalBytes).toBeUndefined();
    const [message] = await repository.listUserMessages(work);
    expect(message?.status).toBe("done");
    // The new film's real size, not the "[8.4G]" in the candidate title.
    const filmSize = 9_000_000_000;
    expect(message?.reply?.results).toEqual([{ episode: "MOVIE", outcome: "replaced", label: "Film 2010 Real [8.4G]", sizeBytes: filmSize, note: "正版" }]);
    expect(await repository.listEpisodeSources(work)).toEqual([
      expect.objectContaining({ episode: "MOVIE", label: "Film 2010 Real [8.4G]", sizeBytes: filmSize }),
    ]);
    expect(await repository.listPendingReplacements(work)).toEqual([]);
  });

  it("a movie replace run cut off by the content filter before any transfer fails loud like TV: no reply, no 还没找到 push, no 待换", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title: MediaTitle = { id: "tmdb_movie_7", tmdbId: 7, type: "movie", title: "Film", originalTitle: "Film", year: 2020, aliases: [] };
    const season = movieAnchorSeason({ titleId: title.id, qualityPreference: "4K", storageDirectoryId: "dir_movie" });
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_1",
      connectedStorageId: DRIVE,
      title,
      season,
      workflowRun: { id: "seed_movie7", kind: "movie_init", status: "succeeded", trackedSeasonId: season.id, startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.000Z", auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }).map((e) => ({ ...e, obtained: true })),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const work = { accountId: "acct_1", drive: DRIVE, titleKey: title.id };
    const storage = new FakeStorageExecutor();
    // The film the user calls fake: it sits in the movie dir, which is also the run's staging.
    const movieDir = await storage.createDirectory({ name: "Film (2020) {tmdb-7}", parentId: "movies_root" });
    storage.seedDirectoryFiles(movieDir, [
      { id: "old_film", storageDirectoryId: movieDir, name: "Film.2020.mkv", sizeBytes: 5_000_000_000, episodeCode: null, providerFileId: "old_film" },
    ]);
    await repository.createUserMessage({ ...work, body: "这是假片", episodeTags: [], now: NOW });
    await queueReplaceRequest({ repository, work, now: fixedNow, createWorkflowRunId: () => "run_rr_movie_cf" });
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return calls === 1 ? contentFiltered() : text("恢复轮：没有新文件");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "failed", workflowRunId: "run_rr_movie_cf" });
    // No finish-only recovery turn: the old film is not something it could finish.
    expect(calls).toBe(1);
    const [message] = await repository.listUserMessages(work);
    expect(message).toMatchObject({ status: "pending", runId: null });
    expect(message?.reply).toBeFalsy();
    expect(await repository.listPendingReplacements(work)).toEqual([]);
    const run = await repository.getWorkflowRunSnapshot("run_rr_movie_cf", { accountId: "acct_1", connectedStorageId: DRIVE });
    expect(run?.workflowRun.status).toBe("failed");
    expect(run?.notifications.map((n) => n.report?.status)).toEqual(["failed"]);
    expect(JSON.stringify(run?.notifications)).not.toContain("还没找到");
    expect(run?.episodes[0]?.obtained).toBe(true);
  });

  it("a rejected list that could not be saved is flagged in the reply", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_nosave" });
    repository.addRejectedResources = async () => {
      throw new Error("db down");
    };
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: ["S01E01"], fileIds: ["present_S01E01"], reason: "发蓝" }, i);
        return text("done");
      },
    });

    await runQueuedReplaceRequest(baseRun(repository, storage, model));

    const [message] = await repository.listUserMessages(WORK);
    expect(message?.status).toBe("done");
    expect(message?.reply).toMatchObject({ rejectedNotSaved: true, results: [{ episode: "S01E01", outcome: "not_found" }] });
  });

  it("a TV message without tags whose episodes the agent never identifies: done with an unidentified reply, nothing kept 待换", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    const message = await repository.createUserMessage({ ...WORK, body: "画面有点发蓝", episodeTags: [], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_untagged" });
    let finishOutput: any;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("finish", {}, i);
        if (i === 2) finishOutput = lastToolOutput(options.prompt, "finish");
        return text("看不出是哪几集");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_untagged" });
    // The agent was told to work out the episodes first; it gave up instead.
    expect(String(finishOutput?.error)).toMatch(/^SANDBOX_NO_EPISODE_IDENTIFIED/);
    const [done] = await repository.listUserMessages(WORK);
    expect(done).toMatchObject({ id: message.id, status: "done", runId: "run_rr_untagged" });
    expect(done!.reply).toEqual({ results: [], oldFiles: [], runId: "run_rr_untagged", unidentified: true });
    expect(await repository.listPendingReplacements(WORK)).toEqual([]);
  });

  it("an untagged message beside a 待换 episode: re-checking only the 待换 one leaves the message unidentified, the 待换 result kept", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E02"], messageId: "msg_old", now: NOW });
    const message = await repository.createUserMessage({ ...WORK, body: "有一集字幕对不上", episodeTags: [], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_untagged_pending" });
    let finishOutput: any;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        // Only the older 待换 episode is looked at; nothing is read from the new words.
        if (i === 1) return tool("reportReplacement", { results: [{ episode: "S01E02", outcome: "not_found", note: "还是没有" }] }, i);
        if (i === 2) return tool("finish", {}, i);
        if (i === 3) finishOutput = lastToolOutput(options.prompt, "finish");
        return text("看不出新留言说的是哪一集");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_untagged_pending" });
    // The 待换 episode does not stand in for the new message's episodes.
    expect(String(finishOutput?.error)).toMatch(/^SANDBOX_NO_EPISODE_IDENTIFIED/);
    const [done] = await repository.listUserMessages(WORK);
    expect(done).toMatchObject({ id: message.id, status: "done", runId: "run_rr_untagged_pending" });
    expect(done!.reply).toEqual({
      results: [{ episode: "S01E02", outcome: "not_found", note: "还是没有" }],
      oldFiles: [],
      runId: "run_rr_untagged_pending",
      unidentified: true,
    });
    // The 待换 episode stays pending, still on the message that asked for it.
    expect((await repository.listPendingReplacements(WORK)).map((p) => [p.episode, p.messageId])).toEqual([["S01E02", "msg_old"]]);
  });

  it("a new file moved in and deleted again before the report is no replacement: no episode source, the episode stays 待换", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = storageWithNewRelease();
    const seasonDir = await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    const message = await repository.createUserMessage({ ...WORK, body: "1 集发蓝", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_deleted_new" });
    let reportOutput: any;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: ["S01E01"], fileIds: ["present_S01E01"], reason: "发蓝" }, i);
        if (i === 2) return tool("searchResources", { keyword: "Show 01" }, i);
        if (i === 3) {
          const search = lastToolOutput(options.prompt, "searchResources");
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: search.snapshot.candidates[0].id }, i);
        }
        if (i === 4) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["new01"] }] }, i);
        // The new file is deleted again before the report.
        if (i === 5) return tool("deleteFiles", { directory: "season", season: 1, fileIds: ["new01"] }, i);
        if (i === 6) return tool("markObtained", { codes: ["S01E01"] }, i);
        if (i === 7) {
          const search = lastToolOutput(options.prompt, "searchResources");
          return tool("reportReplacement", { results: [{ episode: "S01E01", outcome: "replaced", candidateId: search.snapshot.candidates[0].id, fileIds: ["new01"], note: "新版" }] }, i);
        }
        if (i === 8) reportOutput = lastToolOutput(options.prompt, "reportReplacement");
        return text("done");
      },
    });

    await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(reportOutput?.notInTarget).toEqual([{ episode: "S01E01", reason: expect.stringContaining("not in the target directory now: new01") }]);
    expect((await storage.listTree({ directoryId: seasonDir })).map((f) => f.providerFileId)).not.toContain("new01");
    expect(await repository.listEpisodeSources(WORK)).toEqual([]);
    expect((await repository.listPendingReplacements(WORK)).map((p) => [p.episode, p.messageId])).toEqual([["S01E01", message.id]]);
    const [done] = await repository.listUserMessages(WORK);
    expect(done?.reply?.results).toEqual([{ episode: "S01E01", outcome: "not_found", note: expect.stringContaining("不算完成替换") }]);
  });
});

/** A model that only reports the given episodes not_found, capturing the user prompt. */
function reportingModel(episodes: string[], seen: { prompt?: string } = {}) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      i += 1;
      if (i === 1) {
        seen.prompt = JSON.stringify(options.prompt.filter((m) => m.role === "user"));
        return tool("reportReplacement", { results: episodes.map((episode) => ({ episode, outcome: "not_found", note: "没找到" })) }, i);
      }
      return text("done");
    },
  });
}

describe("runQueuedReplaceRequest — scope, metadata and bookkeeping", () => {
  const SCOPE = { accountId: "acct_1", connectedStorageId: DRIVE };

  it("syncs TMDB before running: a 待换 work (skipped by the patrol) still learns of a newly aired episode", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E01"], messageId: "msg_old", now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_sync" });
    const synced: Array<{ tmdbId: number; seasonNumber: number }> = [];
    const seen: { prompt?: string } = {};

    await runQueuedReplaceRequest({
      ...baseRun(repository, storage, reportingModel(["S01E01"], seen)),
      syncSeasonMetadata: async (q) => {
        synced.push(q);
        return { latestAiredEpisode: 3, totalEpisodes: 3 };
      },
    });

    expect(synced).toEqual([{ tmdbId: 42, seasonNumber: 1 }]);
    expect(seen.prompt).toContain("S01E03");
    const state = await repository.getTrackedSeasonState(season.id, SCOPE);
    expect(state?.season).toMatchObject({ totalEpisodes: 3, latestAiredEpisode: 3 });
    expect(state?.episodes.map((e) => [e.episodeCode, e.obtained])).toEqual([["S01E01", true], ["S01E02", true], ["S01E03", false]]);
  });

  it("a failing metadata sync is best-effort: the run goes ahead on the stored counts", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E01"], messageId: "msg_old", now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_sync_fail" });

    const result = await runQueuedReplaceRequest({
      ...baseRun(repository, storage, reportingModel(["S01E01"])),
      syncSeasonMetadata: async () => {
        throw new Error("tmdb down");
      },
    });

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_sync_fail" });
  });

  for (const failing of ["listRejectedResources", "listEpisodeSources"] as const) {
    it(`a failing ${failing} read does not fail the replace run (enrichment fails open)`, async () => {
      const { repository, title, season } = await trackedShow();
      const storage = new FakeStorageExecutor();
      await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
      const message = await repository.createUserMessage({ ...WORK, body: "1 发蓝", episodeTags: ["S01E01"], now: NOW });
      await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => `run_rr_${failing}` });
      repository[failing] = async () => {
        throw new Error(`relation for ${failing} does not exist`);
      };
      const seen: { prompt?: string } = {};

      const result = await runQueuedReplaceRequest(baseRun(repository, storage, reportingModel(["S01E01"], seen)));

      expect(result).toMatchObject({ status: "ran", workflowRunId: `run_rr_${failing}` });
      // The agent really ran as a replace run …
      expect(seen.prompt).toContain("call reportReplacement for every requested episode");
      // … and the message finished instead of going back as urgent.
      expect((await repository.listUserMessages(WORK))[0]).toMatchObject({ id: message.id, status: "done", runId: `run_rr_${failing}` });
    });
  }

  it("drops requested and 待换 episodes outside the tracked seasons and deletes those stale 待换 rows", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    // S03 is not tracked on this drive (an old tag, or a season untracked since).
    const message = await repository.createUserMessage({ ...WORK, body: "1 和第三季 5 发蓝", episodeTags: ["S01E01", "S03E05"], now: NOW });
    await repository.addPendingReplacements({ ...WORK, episodes: ["S03E07", "MOVIE"], messageId: "msg_old", now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_scope" });
    const seen: { prompt?: string } = {};
    let system = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) {
          system = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
          seen.prompt = "x";
          return tool("reportReplacement", { results: [{ episode: "S01E01", outcome: "not_found", note: "没找到" }] }, i);
        }
        return text("done");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowStatus: "succeeded" });
    expect(system).not.toContain("S03E07");
    expect(await repository.listPendingReplacements(WORK)).toEqual([
      expect.objectContaining({ episode: "S01E01", messageId: message.id }),
    ]);
    const [done] = await repository.listUserMessages(WORK);
    expect(done?.reply?.results.map((r) => r.episode)).toEqual(["S01E01"]);
  });

  it("a season cannot be untracked while the work's replace run is running, so the run cannot bring it back when it saves", async () => {
    const { repository, title, season } = await trackedShow();
    const season2: TrackedSeason = { ...season, id: "tmdb_tv_42_s2", seasonNumber: 2, storageDirectoryId: "dir_s2" };
    await seedTrackedSeason({ repository, title, season: season2, obtainedCodes: ["S02E01", "S02E02"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "第一季第一集发蓝", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_untrack" });
    let untrackMidRun: unknown;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        i += 1;
        if (i === 1) {
          // The user clicks 「取消第 2 季追踪」 while the run (recorded on season 1) works.
          untrackMidRun = await repository.untrackTitle(42, SCOPE, "tv", 2);
          return tool("reportReplacement", { results: [{ episode: "S01E01", outcome: "not_found", note: "没找到" }] }, i);
        }
        return text("done");
      },
    });

    await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(untrackMidRun).toEqual({ status: "in_flight", removedSeasons: 0 });
    expect((await repository.listTrackedSeasonStates(SCOPE)).map((s) => s.season.seasonNumber)).toEqual([1, 2]);
    // Afterwards it goes through, and stays gone.
    expect(await repository.untrackTitle(42, SCOPE, "tv", 2)).toEqual({ status: "untracked", removedSeasons: 1 });
    expect((await repository.listTrackedSeasonStates(SCOPE)).map((s) => s.season.seasonNumber)).toEqual([1]);
  });

  it("only out-of-scope 待换 rows and no message: the rows are deleted and the run ends empty", async () => {
    const { repository } = await trackedShow();
    await repository.addPendingReplacements({ ...WORK, episodes: ["S05E01"], messageId: "msg_old", now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_stale" });

    const result = await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), throwingModel()));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_stale", workflowStatus: "succeeded" });
    expect(await repository.listPendingReplacements(WORK)).toEqual([]);
    expect(await repository.listWorksWithPendingReplacements()).toEqual([]);
  });

  it("a bookkeeping write that fails twice sends the messages back to the patrol, never finishing them without their 待换 rows", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = storageWithNewRelease();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "1 集发蓝", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_book" });
    let calls = 0;
    repository.addPendingReplacements = async () => {
      calls += 1;
      throw new Error("db hiccup");
    };

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, reportingModel(["S01E01"])));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_book" });
    expect(calls).toBe(2);
    const run = await repository.getWorkflowRunSnapshot("run_rr_book", SCOPE);
    expect(run?.workflowRun.status).not.toBe("failed");
    const [message] = await repository.listUserMessages(WORK);
    expect(message).toMatchObject({ status: "pending", urgent: false });
    expect(message?.reply).toBeFalsy();
  });

  it("pending-only run: a source write that fails twice leaves the 待换 row in place (the request is not lost)", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = storageWithNewRelease();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E01"], messageId: "msg_old", now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_pend_book" });
    let calls = 0;
    repository.upsertEpisodeSource = async () => {
      calls += 1;
      throw new Error("db hiccup");
    };
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: ["S01E01"], fileIds: ["present_S01E01"], reason: "发蓝" }, i);
        if (i === 2) return tool("searchResources", { keyword: "Show 01" }, i);
        if (i === 3) {
          const search = lastToolOutput(options.prompt, "searchResources");
          const alias = (search.snapshot.candidates as Array<{ id: string; title: string }>).find((c) => c.title === NEW_TITLE)!.id;
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: alias }, i);
        }
        if (i === 4) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["new01"] }] }, i);
        if (i === 5) return tool("markObtained", { codes: ["S01E01"] }, i);
        if (i === 6) {
          const search = lastToolOutput(options.prompt, "searchResources");
          const alias = (search.snapshot.candidates as Array<{ id: string; title: string }>)[0]!.id;
          return tool("reportReplacement", { results: [{ episode: "S01E01", outcome: "replaced", candidateId: alias, fileIds: ["new01"], note: "新版" }] }, i);
        }
        if (i === 7) return tool("finish", {}, i);
        return text("done");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_pend_book" });
    expect(calls).toBe(2);
    expect((await repository.listPendingReplacements(WORK)).map((p) => [p.episode, p.messageId])).toEqual([["S01E01", "msg_old"]]);
  });

  it("a bookkeeping write that fails once is retried and the messages finish", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = storageWithNewRelease();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "1 集发蓝", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_book1" });
    const add = repository.addPendingReplacements.bind(repository);
    let calls = 0;
    repository.addPendingReplacements = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("db hiccup");
      return add(input);
    };

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, reportingModel(["S01E01"])));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_book1" });
    expect(calls).toBe(2);
    expect((await repository.listUserMessages(WORK))[0]).toMatchObject({ status: "done", runId: "run_rr_book1" });
    expect(await repository.listPendingReplacements(WORK)).toEqual([expect.objectContaining({ episode: "S01E01" })]);
  });

  it("a reply write that fails once is retried, so the message still gets its reply", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "1 集发蓝", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_retry" });
    const finish = repository.finishUserMessages.bind(repository);
    let calls = 0;
    repository.finishUserMessages = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
      return finish(input);
    };

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, reportingModel(["S01E01"])));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_retry" });
    expect(calls).toBe(2);
    expect((await repository.listUserMessages(WORK))[0]).toMatchObject({ status: "done", runId: "run_rr_retry" });
  });

  it("a reply write that keeps failing gives up after one retry without failing the run", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "1 集发蓝", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_giveup" });
    let calls = 0;
    repository.finishUserMessages = async () => {
      calls += 1;
      throw new Error("db down");
    };

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, reportingModel(["S01E01"])));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_giveup" });
    expect(calls).toBe(2);
    expect((await repository.getWorkflowRunSnapshot("run_rr_giveup", SCOPE))?.workflowRun.status).not.toBe("failed");
  });

  it("a work no longer tracked fails without writing its queue-time episodes back", async () => {
    const { repository } = await trackedShow();
    await repository.createUserMessage({ ...WORK, body: "换", episodeTags: [], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_gone" });
    repository.listTrackedSeasonStates = async () => [];
    repository.listAllTrackedSeasonStates = async () => [];

    const result = await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), throwingModel()));

    expect(result).toMatchObject({ status: "failed", workflowRunId: "run_rr_gone" });
    expect((await repository.getWorkflowRunSnapshot("run_rr_gone", SCOPE))?.episodes).toEqual([]);
  });

  it("the movie replace prompt says the film is already in the library only when it was obtained before the run", async () => {
    for (const obtained of [true, false]) {
      const repository = new InMemoryWorkflowRepository();
      const title: MediaTitle = { id: `tmdb_movie_${obtained ? 31 : 32}`, tmdbId: obtained ? 31 : 32, type: "movie", title: "Film", originalTitle: "Film", year: 2010, aliases: [] };
      const season = movieAnchorSeason({ titleId: title.id, qualityPreference: "4K", storageDirectoryId: "dir_movie" });
      await repository.saveWorkflowRunSnapshot({
        accountId: "acct_1",
        connectedStorageId: DRIVE,
        title,
        season,
        workflowRun: { id: `seed_${title.id}`, kind: "movie_init", status: obtained ? "succeeded" : "no_coverage", trackedSeasonId: season.id, startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.000Z", auditEvents: [] },
        episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }).map((e) => ({ ...e, obtained })),
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      const work = { accountId: "acct_1", drive: DRIVE, titleKey: title.id };
      await repository.createUserMessage({ ...work, body: "找个正版", episodeTags: [], now: NOW });
      await queueReplaceRequest({ repository, work, now: fixedNow, createWorkflowRunId: () => `run_rr_${title.id}` });
      const seen: { prompt?: string } = {};

      await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), reportingModel(["MOVIE"], seen)));

      if (obtained) expect(seen.prompt).toContain("The film is already in the library");
      else expect(seen.prompt).not.toContain("already in the library");
      expect(seen.prompt).toContain("this run is for the USER REQUESTS in your instructions");
    }
  });

  it("a movie that was never obtained stays unobtained when the replace run lands nothing", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title: MediaTitle = { id: "tmdb_movie_5", tmdbId: 5, type: "movie", title: "Film", originalTitle: "Film", year: 2010, aliases: [] };
    const season = movieAnchorSeason({ titleId: title.id, qualityPreference: "4K", storageDirectoryId: "dir_movie" });
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_1",
      connectedStorageId: DRIVE,
      title,
      season,
      workflowRun: { id: "seed_movie5", kind: "movie_init", status: "no_coverage", trackedSeasonId: season.id, startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.000Z", auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const work = { accountId: "acct_1", drive: DRIVE, titleKey: title.id };
    await repository.createUserMessage({ ...work, body: "找个正版", episodeTags: [], now: NOW });
    await queueReplaceRequest({ repository, work, now: fixedNow, createWorkflowRunId: () => "run_rr_movie5" });

    await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), reportingModel(["MOVIE"])));

    const run = await repository.getWorkflowRunSnapshot("run_rr_movie5", SCOPE);
    expect(run?.episodes[0]?.obtained).toBe(false);
    // A film's message always means the film: never "unidentified", though nothing was rejected.
    const [message] = await repository.listUserMessages(work);
    expect(message?.reply?.results).toEqual([{ episode: "MOVIE", outcome: "not_found", note: "没找到" }]);
    expect(message?.reply).not.toHaveProperty("unidentified");
  });
});

describe("runQueuedReplaceRequest — 不换了 while the run works", () => {
  const CODES = Array.from({ length: 24 }, (_, i) => `S01E${String(i + 1).padStart(2, "0")}`);

  /** A 24-episode season, every episode obtained, its files in the library. */
  async function longShow() {
    const repository = new InMemoryWorkflowRepository();
    const { title, season: base } = trackedFixture();
    const season: TrackedSeason = { ...base, totalEpisodes: 24, latestAiredEpisode: 24 };
    await seedTrackedSeason({ repository, title, season, obtainedCodes: CODES });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, CODES);
    return { repository, storage };
  }

  /** The user's 不换了: the episodes' 待换 rows are deleted. */
  const dropPending = (repository: InMemoryWorkflowRepository, episodes: string[]) =>
    repository.removePendingReplacements({ ...WORK, episodes });

  it("a 待换-only episode the user dropped mid-run stays dropped when the run does not find it; a tagged episode not found stays 待换", async () => {
    const { repository, storage } = await longShow();
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E24"], messageId: "msg_old", now: NOW });
    const message = await repository.createUserMessage({ ...WORK, body: "13 集发蓝", episodeTags: ["S01E13"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_dropped" });
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        i += 1;
        if (i === 1) {
          await dropPending(repository, ["S01E24"]);
          return tool(
            "reportReplacement",
            { results: [{ episode: "S01E13", outcome: "not_found", note: "没找到" }, { episode: "S01E24", outcome: "not_found", note: "还是没有" }] },
            i,
          );
        }
        return text("done");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_dropped", workflowStatus: "succeeded" });
    expect((await repository.listPendingReplacements(WORK)).map((p) => [p.episode, p.messageId])).toEqual([["S01E13", message.id]]);
    // The reply still says what the run found for each episode.
    const [done] = await repository.listUserMessages(WORK);
    expect(done?.reply?.results.map((r) => [r.episode, r.outcome])).toEqual([["S01E13", "not_found"], ["S01E24", "not_found"]]);
  });

  it("a dropped 待换 episode whose copy the agent rejects afresh this run is written back; re-rejecting the copy already on the list is no new request", async () => {
    const { repository, storage } = await longShow();
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E20", "S01E24"], messageId: "msg_old", now: NOW });
    // E24's current copy was rejected by the run that left it 待换; E20's never was.
    await repository.addRejectedResources({
      accountId: "acct_1",
      titleKey: "tmdb_tv_42",
      now: NOW,
      items: [{ episode: "S01E24", linkKey: null, label: "Show.S01E24.mkv", sizeBytes: 1_000_000_000, reason: "发蓝", messageId: "msg_old" }],
    });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_rejected" });
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: ["S01E24"], fileIds: ["present_S01E24"], reason: "发蓝" }, i);
        if (i === 2) return tool("rejectCurrentSource", { episodes: ["S01E20"], fileIds: ["present_S01E20"], reason: "口型对不上" }, i);
        if (i === 3) {
          await dropPending(repository, ["S01E20", "S01E24"]);
          return tool(
            "reportReplacement",
            { results: [{ episode: "S01E20", outcome: "not_found", note: "没找到" }, { episode: "S01E24", outcome: "not_found", note: "还是没有" }] },
            i,
          );
        }
        return text("done");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_rejected", workflowStatus: "succeeded" });
    // Only E20 got a new rejection this run (E24's copy was already on the list).
    expect((await repository.listRejectedResources({ accountId: "acct_1", titleKey: "tmdb_tv_42" })).map((r) => r.episode).sort()).toEqual(["S01E20", "S01E24"]);
    expect((await repository.listPendingReplacements(WORK)).map((p) => [p.episode, p.messageId])).toEqual([["S01E20", "msg_old"]]);
  });

  it("a film's new message asks for the film again: dropped mid-run and not found, it is 待换 again", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title: MediaTitle = { id: "tmdb_movie_55", tmdbId: 55, type: "movie", title: "Film", originalTitle: "Film", year: 2010, aliases: [] };
    const season = movieAnchorSeason({ titleId: title.id, qualityPreference: "4K", storageDirectoryId: "dir_movie" });
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_1",
      connectedStorageId: DRIVE,
      title,
      season,
      workflowRun: { id: "seed_movie55", kind: "movie_init", status: "no_coverage", trackedSeasonId: season.id, startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.000Z", auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const work = { accountId: "acct_1", drive: DRIVE, titleKey: title.id };
    await repository.addPendingReplacements({ ...work, episodes: ["MOVIE"], messageId: "msg_old", now: NOW });
    // A film's message means the film, with or without a tag (this one has none).
    await repository.createUserMessage({ ...work, body: "还是假片", episodeTags: [], now: NOW });
    await queueReplaceRequest({ repository, work, now: fixedNow, createWorkflowRunId: () => "run_rr_movie55" });
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        i += 1;
        if (i === 1) {
          await repository.removePendingReplacements({ ...work, episodes: ["MOVIE"] });
          return tool("reportReplacement", { results: [{ episode: "MOVIE", outcome: "not_found", note: "没找到" }] }, i);
        }
        return text("done");
      },
    });

    await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), model));

    expect((await repository.listPendingReplacements(work)).map((p) => [p.episode, p.messageId])).toEqual([["MOVIE", "msg_old"]]);
  });
});

describe("replace_request notifications — patrol vs user", () => {
  const SCOPE = { accountId: "acct_1", connectedStorageId: DRIVE };

  it("a patrol-queued run with a message reports into the scheduled digest", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_p1", origin: "patrol" });

    await runQueuedReplaceRequest(baseRun(repository, storage, reportingModel(["S01E01"])));

    const run = await repository.getWorkflowRunSnapshot("run_rr_p1", SCOPE);
    expect(run?.notifications.map((n) => [n.kind, n.trigger])).toEqual([["replacement_done", "scheduled"]]);
  });

  it("a patrol-queued run for 待换 episodes only that replaced nothing is routine (no push of its own)", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E02"], messageId: "msg_old", now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_p2", origin: "patrol" });

    await runQueuedReplaceRequest(baseRun(repository, storage, reportingModel(["S01E02"])));

    const run = await repository.getWorkflowRunSnapshot("run_rr_p2", SCOPE);
    expect(run?.notifications.map((n) => [n.kind, n.trigger])).toEqual([["already_current", "scheduled"]]);
  });

  it("a patrol-queued 待换-only run where a newly aired gap lands is not routine: it names the new episode in the digest and activity", async () => {
    const { repository, title, season } = await trackedShow();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        cand_new: {
          status: "succeeded",
          providerMessage: "ok",
          files: [{ id: "new03", storageDirectoryId: "staging", name: "[NewGroup] Show 03.mkv", sizeBytes: 2_000_000_000, episodeCode: "S01E03", providerFileId: "new03" }],
        },
      },
    });
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E01"], messageId: "msg_old", now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_grow", origin: "patrol" });
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("searchResources", { keyword: "Show 03" }, i);
        if (i === 2) {
          const search = lastToolOutput(options.prompt, "searchResources");
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: search.snapshot.candidates[0].id }, i);
        }
        if (i === 3) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["new03"] }] }, i);
        if (i === 4) return tool("markObtained", { codes: ["S01E03"] }, i);
        if (i === 5) return tool("reportReplacement", { results: [{ episode: "S01E01", outcome: "not_found", note: "没找到" }] }, i);
        if (i === 6) return tool("finish", {}, i);
        return text("done");
      },
    });

    await runQueuedReplaceRequest({
      ...baseRun(repository, storage, model),
      syncSeasonMetadata: async () => ({ latestAiredEpisode: 3, totalEpisodes: 3 }),
    });

    const state = await repository.getTrackedSeasonState(season.id, SCOPE);
    expect(state?.episodes.find((e) => e.episodeCode === "S01E03")?.obtained).toBe(true);
    const run = await repository.getWorkflowRunSnapshot("run_rr_grow", SCOPE);
    const [notification] = run!.notifications;
    expect(notification).toMatchObject({ kind: "replacement_done", trigger: "scheduled" });
    expect(notification!.report).toMatchObject({ newlyObtained: ["S01E03"] });
    expect(notification!.report!.status).not.toBe("no_coverage");
    expect(notification!.report!.lines[0]).toContain("新增 E03");
    // Not folded away: the digest lists it as a change (and, being no already_current,
    // the activity page and the notification feed show it too).
    expect(formatDailyDigestPushText(scheduledDigestItems(run!.notifications, { skipIfOnlyRoutine: true }))).toContain("新增 S01E03");
  });

  it("a movie queued by the patrol for its 待换 film, nothing replaced: routine too", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title: MediaTitle = { id: "tmdb_movie_6", tmdbId: 6, type: "movie", title: "Film", originalTitle: "Film", year: 2010, aliases: [] };
    const season = movieAnchorSeason({ titleId: title.id, qualityPreference: "4K", storageDirectoryId: "dir_movie" });
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_1",
      connectedStorageId: DRIVE,
      title,
      season,
      workflowRun: { id: "seed_movie6", kind: "movie_init", status: "succeeded", trackedSeasonId: season.id, startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.000Z", auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }).map((e) => ({ ...e, obtained: true })),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const work = { accountId: "acct_1", drive: DRIVE, titleKey: title.id };
    await repository.addPendingReplacements({ ...work, episodes: ["MOVIE"], messageId: "msg_old", now: NOW });
    await queueReplaceRequest({ repository, work, now: fixedNow, createWorkflowRunId: () => "run_rr_m6", origin: "patrol" });

    await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), reportingModel(["MOVIE"])));

    const run = await repository.getWorkflowRunSnapshot("run_rr_m6", SCOPE);
    expect(run?.notifications.map((n) => [n.kind, n.trigger])).toEqual([["already_current", "scheduled"]]);
  });
});

describe("replace_request crash recovery", () => {
  const SCOPE = { accountId: "acct_1", connectedStorageId: DRIVE };

  /** A replace run that claimed its message and then lost its worker (still running). */
  async function crashedRun(runId: string) {
    const { repository, title, season } = await trackedShow();
    const message = await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => runId });
    await repository.claimNextQueuedWorkflowRun({ kind: "replace_request", now: NOW });
    await repository.claimUserMessages({ ...WORK, runId, now: NOW });
    return { repository, title, season, message };
  }

  it("a run requeued after a crash re-claims its own processing messages and finishes them", async () => {
    const { repository, title, season, message } = await crashedRun("run_rr_crash");
    expect(await repository.requeueRunningWorkflowRuns(NOW)).toBe(1);
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    let system = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) {
          system = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
          return tool("reportReplacement", { results: [{ episode: "S01E01", outcome: "not_found", note: "没找到" }] }, i);
        }
        return text("done");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, storage, model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_crash" });
    expect(system).toContain("换第 1 集");
    expect((await repository.listUserMessages(WORK))[0]).toMatchObject({ id: message.id, status: "done", runId: "run_rr_crash" });
  });

  it("an orphaned replace run past the recovery cap is failed and its messages go back to pending (not urgent: the patrol retries)", async () => {
    const { repository } = await crashedRun("run_rr_poison");
    const stored = await repository.getWorkflowRunSnapshot("run_rr_poison", SCOPE);
    await repository.saveWorkflowRunSnapshot({ ...stored!, workflowRun: { ...stored!.workflowRun, orphanRequeueCount: 5 } });

    expect(await repository.requeueRunningWorkflowRuns(NOW)).toBe(0);

    expect((await repository.getWorkflowRunSnapshot("run_rr_poison", SCOPE))?.workflowRun.status).toBe("failed");
    expect((await repository.listUserMessages(WORK))[0]).toMatchObject({ status: "pending", urgent: false, runId: null });
    expect(await enqueueUrgentReplaceRequests({ repository, now: fixedNow })).toBe(0);
  });

  it("the idle scan hands messages stranded in processing by a run that is gone back to the patrol (pending, not urgent)", async () => {
    const { repository } = await trackedShow();
    await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    // Claimed by a run that never got saved (or was pruned/cancelled out from under it).
    await repository.claimUserMessages({ ...WORK, runId: "run_vanished", now: NOW });

    expect(await enqueueUrgentReplaceRequests({ repository, now: () => "2026-09-26T08:30:00.000Z" })).toBe(0);

    expect((await repository.listUserMessages(WORK))[0]).toMatchObject({ status: "pending", urgent: false, runId: null });
    expect(await repository.listActiveWorkflowRuns(SCOPE)).toEqual([]);
    // The next patrol queues it (every pending message counts there).
    expect(await repository.listWorksWithPendingMessages({ urgentOnly: false })).toEqual([WORK]);
  });
});

describe("enqueueUrgentReplaceRequests", () => {
  it("queues works with an urgent pending message and no active run; skips busy works and non-urgent messages", async () => {
    const repository = new InMemoryWorkflowRepository();
    const busy = { ...trackedFixture(), title: { ...trackedFixture().title, id: "tmdb_tv_7", tmdbId: 7, title: "Busy" } };
    busy.season = { ...busy.season, id: "tmdb_tv_7_s1", mediaTitleId: "tmdb_tv_7" };
    const calm = { ...trackedFixture(), title: { ...trackedFixture().title, id: "tmdb_tv_8", tmdbId: 8, title: "Calm" } };
    calm.season = { ...calm.season, id: "tmdb_tv_8_s1", mediaTitleId: "tmdb_tv_8" };
    const quiet = { ...trackedFixture(), title: { ...trackedFixture().title, id: "tmdb_tv_9", tmdbId: 9, title: "Quiet" } };
    quiet.season = { ...quiet.season, id: "tmdb_tv_9_s1", mediaTitleId: "tmdb_tv_9" };
    for (const show of [busy, calm, quiet]) {
      await seedTrackedSeason({ repository, title: show.title, season: show.season, obtainedCodes: ["S01E01", "S01E02"] });
    }
    // Busy has a patrol running right now.
    await repository.reserveWorkflowRun({
      accountId: "acct_1",
      connectedStorageId: DRIVE,
      title: busy.title,
      season: busy.season,
      workflowRun: { id: "run_patrol", kind: "type3_monitor", status: "running", trackedSeasonId: busy.season.id, startedAt: NOW, finishedAt: null, auditEvents: [] },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const busyWork = { ...WORK, titleKey: "tmdb_tv_7" };
    const calmWork = { ...WORK, titleKey: "tmdb_tv_8" };
    const quietWork = { ...WORK, titleKey: "tmdb_tv_9" };
    for (const work of [busyWork, calmWork]) {
      await repository.createUserMessage({ ...work, body: "换", episodeTags: [], now: NOW });
      await repository.markUserMessagesUrgent({ ...work, now: NOW });
    }
    await repository.createUserMessage({ ...quietWork, body: "不急", episodeTags: [], now: NOW });

    expect(await enqueueUrgentReplaceRequests({ repository, now: fixedNow })).toBe(1);

    const replaceRuns = (await repository.listActiveWorkflowRuns({ accountId: "acct_1", connectedStorageId: DRIVE })).filter(
      (run) => run.workflowRun.kind === "replace_request",
    );
    expect(replaceRuns.map((run) => run.title.id)).toEqual(["tmdb_tv_8"]);
  });

  it("a failure of the same title on ANOTHER drive does not hold back an unbound work's urgent message", async () => {
    const { repository, title, season } = await trackedShow();
    // The same show, also tracked with no bound drive.
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_1",
      title,
      season,
      workflowRun: { id: "seed_unbound", kind: "type2_init", status: "succeeded", trackedSeasonId: season.id, startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:00:00.000Z", auditEvents: [] },
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 }).map((e) => ({ ...e, obtained: true })),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    // The user asks on the unbound copy…
    const unbound = { ...WORK, drive: "" };
    await repository.createUserMessage({ ...unbound, body: "也换", episodeTags: [], now: "2026-09-26T07:59:00.000Z" });
    await repository.markUserMessagesUrgent({ ...unbound, now: "2026-09-26T07:59:00.000Z" });
    // …and afterwards a replace run of the same title on DRIVE fails for good.
    await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_bound_fail" });
    await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), throwingModel()));
    expect((await repository.getWorkflowRunSnapshot("run_rr_bound_fail", { accountId: "acct_1", connectedStorageId: DRIVE }))?.workflowRun.status).toBe("failed");

    await enqueueUrgentReplaceRequests({ repository, now: () => "2026-09-26T08:00:05.000Z" });

    const active = await repository.listActiveWorkflowRuns({ accountId: "acct_1", connectedStorageId: null });
    expect(active.filter((r) => r.connectedStorageId === null).map((r) => r.workflowRun.kind)).toEqual(["replace_request"]);
  });

  it("after a replace run failed for good, the idle scan waits for the user (现在处理) instead of retrying every tick", async () => {
    const { repository } = await trackedShow();
    await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_f1" });
    await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), throwingModel()));
    expect((await repository.listUserMessages(WORK))[0]).toMatchObject({ status: "pending", urgent: false });

    expect(await enqueueUrgentReplaceRequests({ repository, now: () => "2026-09-26T08:00:05.000Z" })).toBe(0);
    // The user presses 现在处理 again.
    await repository.markUserMessagesUrgent({ ...WORK, now: "2026-09-26T08:30:00.000Z" });
    expect(await enqueueUrgentReplaceRequests({ repository, now: () => "2026-09-26T08:30:01.000Z" })).toBe(1);
  });
});

describe("replace_request failure — who retries, and how the failure is labelled", () => {
  const SCOPE = { accountId: "acct_1", connectedStorageId: DRIVE };

  it("a final failure hands the messages to the patrol: the run's own and one written during the run lose their urgency, and the idle scan leaves them alone", async () => {
    const { repository } = await trackedShow();
    await repository.createUserMessage({ ...WORK, body: "A: 换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await repository.markUserMessagesUrgent({ ...WORK, now: NOW }); // 现在处理
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_final" });
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        // Written while the run holds A, so it is urgent ("right after this one").
        await repository.createUserMessage({ ...WORK, body: "B: 还有第 2 集", episodeTags: ["S01E02"], now: "2026-09-26T08:00:01.000Z" });
        throw new Error("401 Unauthorized: invalid api key");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), model));

    expect(result).toMatchObject({ status: "failed", workflowRunId: "run_rr_final" });
    expect((await repository.listUserMessages(WORK)).map((m) => [m.body, m.status, m.urgent])).toEqual([
      ["B: 还有第 2 集", "pending", false],
      ["A: 换第 1 集", "pending", false],
    ]);
    let queued = 0;
    for (let t = 1; t <= 5; t++) {
      queued += await enqueueUrgentReplaceRequests({ repository, now: () => new Date(Date.parse(NOW) + t * 3000).toISOString() });
    }
    expect(queued).toBe(0);
    expect(await repository.listActiveWorkflowRuns(SCOPE)).toEqual([]);
  });

  it("a transient failure re-queues the run and keeps its messages urgent for it; the idle scan does not queue a second run", async () => {
    const { repository } = await trackedShow();
    await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_transient" });
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("fetch failed: ECONNRESET");
      },
    });

    const result = await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), model));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_rr_transient", workflowStatus: "queued" });
    expect((await repository.listUserMessages(WORK))[0]).toMatchObject({ status: "pending", urgent: true, runId: null });
    expect(await enqueueUrgentReplaceRequests({ repository, now: () => "2026-09-26T08:00:03.000Z" })).toBe(0);
    expect((await repository.listActiveWorkflowRuns(SCOPE)).map((r) => [r.workflowRun.id, r.workflowRun.status])).toEqual([
      ["run_rr_transient", "queued"],
    ]);
  });

  it("when even saving the failure fails, the messages still go back to pending — not urgent", async () => {
    const { repository } = await trackedShow();
    await repository.createUserMessage({ ...WORK, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await repository.markUserMessagesUrgent({ ...WORK, now: NOW });
    await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => "run_rr_savefail" });
    repository.saveWorkflowRunSnapshot = async () => {
      throw new Error("db down");
    };

    await expect(runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), throwingModel()))).rejects.toThrow("db down");

    expect((await repository.listUserMessages(WORK))[0]).toMatchObject({ status: "pending", urgent: false, runId: null });
  });

  it("a replace run's failure and retry notices are title-level: an S02 request is never labelled with the lock season", async () => {
    const cases = [
      { runId: "run_rr_f2", error: "agent model unavailable", status: "failed" },
      { runId: "run_rr_r2", error: "fetch failed: ECONNRESET", status: "retrying" },
    ] as const;
    for (const { runId, error, status } of cases) {
      const { repository, title, season } = await trackedShow();
      const season2: TrackedSeason = { ...season, id: "tmdb_tv_42_s2", seasonNumber: 2, storageDirectoryId: "dir_s2" };
      await seedTrackedSeason({ repository, title, season: season2, obtainedCodes: ["S02E01", "S02E02"] });
      await repository.createUserMessage({ ...WORK, body: "第二季第一集没字幕", episodeTags: ["S02E01"], now: NOW });
      await queueReplaceRequest({ repository, work: WORK, now: fixedNow, createWorkflowRunId: () => runId });
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error(error);
        },
      });

      await runQueuedReplaceRequest(baseRun(repository, new FakeStorageExecutor(), model));

      const run = await repository.getWorkflowRunSnapshot(runId, SCOPE);
      expect(run?.notifications.map((n) => n.report?.status)).toEqual([status]);
      expect(run?.notifications[0]?.report?.seasonLabel).toBeNull();
      expect(run?.notifications[0]?.body).not.toMatch(/第 \d+ 季/);
    }
  });

  it("an urgent message of a work no longer tracked on its drive goes to the patrol after one idle scan, not re-scanned every tick", async () => {
    const { repository } = await trackedShow();
    // Nothing of this work is tracked on that drive (its last season was untracked).
    const gone = { ...WORK, drive: "cs_gone" };
    await repository.createUserMessage({ ...gone, body: "换第 1 集", episodeTags: ["S01E01"], now: NOW });
    await repository.markUserMessagesUrgent({ ...gone, now: NOW });

    expect(await enqueueUrgentReplaceRequests({ repository, now: () => "2026-09-26T08:00:03.000Z" })).toBe(0);

    expect((await repository.listUserMessages(gone))[0]).toMatchObject({ status: "pending", urgent: false });
    expect(await repository.listWorksWithPendingMessages({ urgentOnly: true })).toEqual([]);
  });
});
