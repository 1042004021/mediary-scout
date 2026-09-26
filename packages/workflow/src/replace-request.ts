import type { LanguageModel } from "ai";
import type { TrackedSeasonState, WorkflowRepository } from "./repository.js";
import type { AuditEvent, EpisodeState, TrackedSeason } from "./domain.js";
import { syncSeasonAgainstMetadata } from "./season-sync.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { JevJudge } from "./jev-judge.js";
import type { RunAcquisitionV2Request, RunAcquisitionV2Result } from "./acquisition-v2/orchestrator.js";
import {
  parseSizeFromTitle,
  userMessageDrive,
  type EpisodeSource,
  type ReplacementResult,
  type UserMessage,
  type UserMessageReply,
  type UserMessageScope,
} from "./user-requests.js";
import type { WorkflowStatus } from "./domain.js";
import { runMovieAcquisitionV2AndPersist, runReplaceRequestV2AndPersist } from "./runner-v2.js";
import {
  handleWorkflowRunFailure,
  requireCategoryParent,
  resolveWorkerDeps,
  storageParentForTitle,
  type AccountWorkerContext,
  type QueuedType2WorkerResult,
  type ResolveAccountWorkerContext,
  type SeasonMetadataSync,
} from "./worker.js";

/**
 * The replace_request run: a user left a message on a work ("13、24 集发蓝", "这是假片")
 * or an earlier request left episodes 待换. One run covers every tracked season of the
 * work on one drive (the message is about the whole work), holds a title-level lock,
 * and is queued by the patrol (Task 11), by "现在处理", or by the idle-queue scan for
 * urgent messages. Design: docs/superpowers/specs/2026-09-26-user-message-replace-design.md.
 */

/** The tracked states of ONE work on ONE drive (all seasons, or the movie anchor). */
async function workStates(repository: WorkflowRepository, work: UserMessageScope): Promise<TrackedSeasonState[]> {
  // A null storage scope is account-wide, so the exact-drive filter stays.
  const states = await repository.listTrackedSeasonStates({
    accountId: work.accountId,
    connectedStorageId: work.drive === "" ? null : work.drive,
  });
  return states
    .filter((s) => userMessageDrive(s.connectedStorageId) === work.drive && s.title.id === work.titleKey)
    .sort((a, b) => a.season.seasonNumber - b.season.seasonNumber);
}

/** Who queued a replace run: the patrol (its report joins the daily digest) or the
 *  user (现在处理 / the idle scan for urgent messages — pushed on its own). */
export type ReplaceRequestOrigin = "patrol" | "user";

export async function queueReplaceRequest(input: {
  repository: WorkflowRepository;
  work: UserMessageScope;
  now?: () => string;
  createWorkflowRunId?: () => string;
  /** Default "user". Recorded on the queued audit event. */
  origin?: ReplaceRequestOrigin;
}): Promise<{ status: "queued" | "already_running" | "not_tracked"; workflowRunId: string | null }> {
  const now = input.now ?? (() => new Date().toISOString());
  const states = await workStates(input.repository, input.work);
  // The lowest season is the lock: the run is reserved on it, title-level exclusive.
  const lock = states[0];
  if (!lock) return { status: "not_tracked", workflowRunId: null };
  const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
  const queuedAt = now();
  const reservation = await input.repository.reserveWorkflowRun({
    accountId: lock.accountId,
    ...(lock.connectedStorageId != null ? { connectedStorageId: lock.connectedStorageId } : {}),
    title: lock.title,
    season: lock.season,
    workflowRun: {
      id: workflowRunId,
      kind: "replace_request",
      status: "queued",
      trackedSeasonId: lock.season.id,
      startedAt: queuedAt,
      finishedAt: null,
      auditEvents: [
        {
          type: "replace_request_queued",
          message: `Queued replace request ${workflowRunId}`,
          data: { origin: input.origin ?? "user" },
        },
      ],
    },
    // A reservation replaces the season's episode bucket wholesale: hand it back unchanged.
    episodes: lock.episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    blockIfTitleHasActiveRun: true,
  });
  if (reservation.status === "already_active") {
    return { status: "already_running", workflowRunId: reservation.snapshot.workflowRun.id };
  }
  if (reservation.status !== "reserved") return { status: "already_running", workflowRunId: null };
  return { status: "queued", workflowRunId };
}

/** How long a finished run may still hold its messages: the post-run bookkeeping
 *  (finishUserMessages) takes seconds, so anything older died before finishing. */
const ORPHANED_MESSAGE_GRACE_MS = 10 * 60 * 1000;

/** Idle-queue scan: every work with an urgent pending message and no active run. */
export async function enqueueUrgentReplaceRequests(input: {
  repository: WorkflowRepository;
  now?: () => string;
}): Promise<number> {
  const nowIso = (input.now ?? (() => new Date().toISOString()))();
  // A worker that died between claiming messages and finishing them leaves them in
  // processing with no live run: hand them back first so the scan below sees them.
  await input.repository.releaseOrphanedUserMessages({
    now: nowIso,
    finishedBefore: new Date(Date.parse(nowIso) - ORPHANED_MESSAGE_GRACE_MS).toISOString(),
  });
  let n = 0;
  for (const work of await input.repository.listWorksWithPendingMessages({ urgentOnly: true })) {
    // A run that failed for good released its messages as urgent. Re-queueing it on
    // every idle tick would retry a broken setup (dead LLM key, missing library dir)
    // every few seconds, each with a failure push. After such a failure only 现在处理
    // or editing one of its messages (both touch an urgent message) brings it back
    // here — a new message is not urgent. The patrol still retries it on its own schedule.
    if (await failedSinceLastTouch(input.repository, work)) continue;
    const result = await queueReplaceRequest({ repository: input.repository, work, ...(input.now ? { now: input.now } : {}) });
    if (result.status === "queued") n += 1;
  }
  return n;
}

async function failedSinceLastTouch(repository: WorkflowRepository, work: UserMessageScope): Promise<boolean> {
  const urgent = (await repository.listUserMessages(work)).filter((m) => m.status === "pending" && m.urgent);
  const lastTouch = urgent.map((m) => m.updatedAt).sort().at(-1);
  if (lastTouch === undefined) return false;
  // A null storage scope is account-wide: the run's own drive must match exactly, or a
  // failure of the same title on another drive would hold back the unbound work.
  const scope = { accountId: work.accountId, connectedStorageId: work.drive === "" ? null : work.drive };
  const notifications = await repository.listNotifications({ ...scope, since: lastTouch, limit: 500 });
  for (const notification of notifications) {
    // handleWorkflowRunFailure stamps the failure notification with the run's kind.
    if (notification.kind !== "replace_request") continue;
    const run = await repository.getWorkflowRunSnapshot(notification.workflowRunId, scope);
    if (!run || userMessageDrive(run.connectedStorageId) !== work.drive) continue;
    if (run.title.id === work.titleKey && run.workflowRun.status === "failed") return true;
  }
  return false;
}

type UserRequest = NonNullable<RunAcquisitionV2Request["userRequest"]>;

export async function runQueuedReplaceRequest(
  input: AccountWorkerContext & {
    repository: WorkflowRepository;
    resourceProvider: ResourceProvider;
    storage: StorageExecutor;
    model: LanguageModel;
    storageParentDirectoryId: string;
    moviesParentDirectoryId: string;
    /** TMDB refresh of aired/total counts. A work with 待换 episodes is skipped by
     *  the patrol, where the sync normally happens — so this run does it instead. */
    syncSeasonMetadata?: SeasonMetadataSync;
    now?: () => string;
    resolveAccountContext?: ResolveAccountWorkerContext;
    onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  },
): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const repository = input.repository;
  const claimed = await repository.claimNextQueuedWorkflowRun({ kind: "replace_request", now: now() });
  if (!claimed) return { status: "idle" };
  const runId = claimed.workflowRun.id;
  const work: UserMessageScope = {
    accountId: claimed.accountId,
    drive: userMessageDrive(claimed.connectedStorageId),
    titleKey: claimed.title.id,
  };

  let messages: UserMessage[] = [];
  let pendingRows: Awaited<ReturnType<WorkflowRepository["listPendingReplacements"]>> = [];
  let sources: EpisodeSource[] = [];
  let replacement: RunAcquisitionV2Result["replacement"];
  let workflowStatus: WorkflowStatus;
  try {
    messages = await repository.claimUserMessages({ ...work, runId, now: now() });
    const states = await workStates(repository, work);
    if (!states.some((s) => s.season.id === claimed.season.id)) {
      throw new Error(`REPLACE_REQUEST_NOT_TRACKED: ${work.titleKey} is no longer tracked on this drive`);
    }
    const lockState = states.find((s) => s.season.id === claimed.season.id)!;
    const movie = claimed.title.type === "movie";

    // Only episodes of the seasons tracked here can be replaced (movie: the film). An
    // old tag or a 待换 row of a season untracked since would only be refused by the
    // sandbox; the stale 待换 rows are dropped for good.
    const inScope = episodeScope(movie, states);
    const allPending = await repository.listPendingReplacements(work);
    pendingRows = allPending.filter((p) => inScope(p.episode));
    const stale = allPending.filter((p) => !inScope(p.episode)).map((p) => p.episode);
    if (stale.length > 0) await repository.removePendingReplacements({ ...work, episodes: stale });
    const pending = pendingRows.map((p) => p.episode);

    if (messages.length === 0 && pending.length === 0) {
      // Everything was withdrawn (or already replaced) before the run started.
      await repository.saveWorkflowRunSnapshot({
        accountId: claimed.accountId,
        connectedStorageId: claimed.connectedStorageId,
        title: claimed.title,
        season: lockState.season,
        workflowRun: {
          ...claimed.workflowRun,
          status: "succeeded",
          finishedAt: now(),
          auditEvents: [...claimed.workflowRun.auditEvents, { type: "replace_request_empty", message: "No message or pending episode left" }],
        },
        episodes: lockState.episodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      return { status: "ran", workflowRunId: runId, workflowStatus: "succeeded" };
    }

    const requested = [...new Set([...messages.flatMap((m) => m.episodeTags), ...pending])].filter(inScope);
    const requestedEpisodes = movie && requested.length === 0 ? ["MOVIE"] : requested;
    const rejected = await repository.listRejectedResources({ accountId: work.accountId, titleKey: work.titleKey });
    sources = await repository.listEpisodeSources(work);
    const userRequest: UserRequest = {
      requestedEpisodes,
      prompt: {
        messages: messages.map((m) => ({ body: m.body, episodeTags: m.episodeTags.filter(inScope), createdAt: m.createdAt })),
        rejected: rejected.map((r) => ({ episode: r.episode, label: r.label, sizeBytes: r.sizeBytes, reason: r.reason })),
        pending,
      },
      rejectedStore: {
        list: async () =>
          (await repository.listRejectedResources({ accountId: work.accountId, titleKey: work.titleKey })).map((r) => ({
            episode: r.episode,
            linkKey: r.linkKey,
            label: r.label,
            sizeBytes: r.sizeBytes,
          })),
        // An episode replaced once before has a known link: reject it by link too, not only name+size.
        add: (rows) =>
          repository.addRejectedResources({
            accountId: work.accountId,
            titleKey: work.titleKey,
            now: now(),
            items: rows.map((r) => ({
              ...r,
              linkKey: r.linkKey ?? sources.find((s) => s.episode === r.episode)?.linkKey ?? null,
              messageId: messageFor(messages, r.episode)?.id ?? null,
            })),
          }),
      },
    };

    // A patrol-queued run reports into the daily digest; a 待换 re-check with no new
    // message that replaced nothing is routine (see stampReplaceNotification).
    const notice = {
      trigger: queuedBy(claimed.workflowRun.auditEvents) === "patrol" ? ("scheduled" as const) : ("user" as const),
      routineIfNothingReplaced: messages.length === 0,
    };
    const deps = await resolveWorkerDeps(input.resolveAccountContext, claimed.accountId, claimed.connectedStorageId, input);
    const common = {
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository,
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      ...optionalDeps(deps),
      workflowRun: { id: runId, startedAt: claimed.workflowRun.startedAt, finishedAt: null },
      userRequest,
      notice,
      now,
    };

    if (movie) {
      const result = await runMovieAcquisitionV2AndPersist({
        ...common,
        title: claimed.title,
        categoryParentId: requireCategoryParent(deps.moviesParentDirectoryId ?? input.moviesParentDirectoryId),
        // The film stays obtained only if it was: the old file is still there.
        priorObtained: lockState.episodes.some((e) => e.obtained),
      });
      replacement = result.replacement;
      workflowStatus = result.status;
    } else {
      const seasons = await syncedSeasons(states, claimed.title.tmdbId, input.syncSeasonMetadata);
      const result = await runReplaceRequestV2AndPersist({
        ...common,
        title: claimed.title,
        categoryParentId: requireCategoryParent(
          storageParentForTitle(claimed.title, deps.storageParentDirectoryId, deps.animeStorageParentDirectoryId),
        ),
        seasons,
        lockSeasonNumber: lockState.season.seasonNumber,
        lockAuditEvents: claimed.workflowRun.auditEvents,
      });
      replacement = result.replacement;
      workflowStatus = result.status;
    }
  } catch (error) {
    // Messages go back to pending (urgent) for a retry; the library stays as it was.
    try {
      await repository.releaseUserMessages({ runId, now: now() });
    } catch (releaseError) {
      console.error(`[user-message] run ${runId} could not release its messages: ${String(releaseError)}`);
    }
    // The failure record keeps the lock season's CURRENT episodes, not the queue-time
    // copy; none at all when the work is no longer tracked here. Only when the read
    // itself fails does the queue-time copy stand in (never wipe a real library).
    const current = await workStates(repository, work).then(
      (states) => states.find((s) => s.season.id === claimed.season.id) ?? null,
      () => undefined,
    );
    const handled = await handleWorkflowRunFailure({
      claimed:
        current === undefined
          ? claimed
          : current === null
            ? { ...claimed, episodes: [] }
            : { ...claimed, season: current.season, episodes: current.episodes },
      error,
      repository,
      now,
      ...(input.onAuthErrorFreeze === undefined ? {} : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }

  // The run itself succeeded and is saved. What follows is bookkeeping: a failure
  // here is logged, never turned into a failed run, and the messages still get
  // their reply (a message left in processing is released by the idle scan).
  const results = (replacement?.results ?? []).map((r) => ({ ...r, sizeBytes: r.label ? parseSizeFromTitle(r.label) : null }));
  try {
    await recordReplacementOutcome({ repository, work, runId, results, messages, pendingRows, now });
  } catch (error) {
    console.error(`[user-message] run ${runId} bookkeeping failed (the run itself succeeded): ${String(error)}`);
  }
  if (messages.length > 0) {
    const reply: UserMessageReply = {
      results: results.map((r): ReplacementResult => ({
        episode: r.episode,
        outcome: r.outcome,
        // Only a replaced episode names a resource.
        ...(r.outcome === "replaced" && r.label !== undefined ? { label: r.label } : {}),
        ...(r.outcome === "replaced" && r.sizeBytes !== null ? { sizeBytes: r.sizeBytes } : {}),
        note: r.note,
      })),
      oldFiles: replacement?.oldFiles ?? [],
      runId,
      ...(replacement?.rejectedPersistFailed ? { rejectedNotSaved: true } : {}),
    };
    // One retry: a message left in processing is only released by the idle scan after
    // the grace period, and then re-run from scratch — a transient hiccup should not cost that.
    try {
      await repository.finishUserMessages({ runId, reply, now: now() });
    } catch (firstError) {
      try {
        await repository.finishUserMessages({ runId, reply, now: now() });
      } catch (error) {
        console.error(`[user-message] run ${runId} could not write the reply (retried once): ${String(firstError)} / ${String(error)}`);
      }
    }
  }
  return { status: "ran", workflowRunId: runId, workflowStatus };
}

/** 待换 records and episode sources after a replace run. */
async function recordReplacementOutcome(input: {
  repository: WorkflowRepository;
  work: UserMessageScope;
  runId: string;
  results: Array<{ episode: string; outcome: "replaced" | "not_found"; label?: string; linkKey?: string | null; sizeBytes: number | null }>;
  messages: UserMessage[];
  pendingRows: Array<{ episode: string; messageId: string }>;
  now: () => string;
}): Promise<void> {
  const { repository, work, messages, pendingRows, now } = input;
  const replaced = input.results.filter((r) => r.outcome === "replaced");
  const notFound = input.results.filter((r) => r.outcome === "not_found").map((r) => r.episode);
  if (replaced.length > 0) {
    await repository.removePendingReplacements({ ...work, episodes: replaced.map((r) => r.episode) });
  }
  for (const r of replaced) {
    await repository.upsertEpisodeSource({
      ...work,
      episode: r.episode,
      linkKey: r.linkKey ?? null,
      label: r.label ?? "",
      sizeBytes: r.sizeBytes,
      runId: input.runId,
      recordedAt: now(),
    });
  }
  // Keep a still-pending episode on the message that first asked for it.
  const byMessage = new Map<string, string[]>();
  for (const episode of notFound) {
    const messageId =
      pendingRows.find((p) => p.episode === episode)?.messageId ?? messageFor(messages, episode)?.id ?? pendingRows[0]?.messageId;
    if (messageId === undefined) continue;
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), episode]);
  }
  for (const [messageId, episodes] of byMessage) {
    await repository.addPendingReplacements({ ...work, episodes, messageId, now: now() });
  }
}

/** Whether an episode code belongs to this work on this drive: "MOVIE" for a film,
 *  SxxEyy of a tracked season for a show. */
function episodeScope(movie: boolean, states: TrackedSeasonState[]): (episode: string) => boolean {
  if (movie) return (episode) => episode === "MOVIE";
  const seasons = new Set(states.map((s) => s.season.seasonNumber));
  return (episode) => {
    const m = /^S(\d{2,})E\d{2,}$/.exec(episode);
    return m !== null && seasons.has(Number(m[1]));
  };
}

/** Every season refreshed against TMDB (best-effort per season, as in the patrol). */
async function syncedSeasons(
  states: TrackedSeasonState[],
  tmdbId: number,
  sync: SeasonMetadataSync | undefined,
): Promise<Array<{ season: TrackedSeason; episodes: EpisodeState[] }>> {
  const out: Array<{ season: TrackedSeason; episodes: EpisodeState[] }> = [];
  for (const state of states) {
    let entry = { season: state.season, episodes: state.episodes };
    if (sync) {
      try {
        const meta = await sync({ tmdbId, seasonNumber: state.season.seasonNumber });
        if (meta) {
          const synced = syncSeasonAgainstMetadata({ ...entry, latestAiredEpisode: meta.latestAiredEpisode, totalEpisodes: meta.totalEpisodes });
          entry = { season: synced.season, episodes: synced.episodes };
        }
      } catch {
        // Metadata sync is best-effort; fall back to stored counts.
      }
    }
    out.push(entry);
  }
  return out;
}

/** Who queued the run (the queued audit event's origin); "user" when unknown. */
function queuedBy(events: AuditEvent[]): ReplaceRequestOrigin {
  const origin = events.find((e) => e.type === "replace_request_queued")?.data?.["origin"];
  return origin === "patrol" ? "patrol" : "user";
}

/** The message that named this episode, else the oldest one claimed. */
function messageFor(messages: UserMessage[], episode: string): UserMessage | undefined {
  return messages.find((m) => m.episodeTags.includes(episode)) ?? messages[0];
}

/** The per-account options the runners take, present only when resolved. */
function optionalDeps(deps: Awaited<ReturnType<typeof resolveWorkerDeps>>): {
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageProvider?: string;
  assrtToken?: string;
  jevJudge?: JevJudge;
  agentMemory?: boolean;
} {
  return {
    ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
    ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
    ...(deps.storageProvider === undefined ? {} : { storageProvider: deps.storageProvider }),
    ...(deps.assrtToken === undefined ? {} : { assrtToken: deps.assrtToken }),
    ...(deps.jevJudge === undefined ? {} : { jevJudge: deps.jevJudge }),
    ...(deps.agentMemory === undefined ? {} : { agentMemory: deps.agentMemory }),
  };
}
