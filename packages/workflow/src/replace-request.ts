import type { LanguageModel } from "ai";
import type { TrackedSeasonState, WorkflowRepository } from "./repository.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { JevJudge } from "./jev-judge.js";
import type { RunAcquisitionV2Request, RunAcquisitionV2Result } from "./acquisition-v2/orchestrator.js";
import {
  userMessageDrive,
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
  const all = await repository.listAllTrackedSeasonStates();
  return all
    .filter(
      (s) => s.accountId === work.accountId && userMessageDrive(s.connectedStorageId) === work.drive && s.title.id === work.titleKey,
    )
    .sort((a, b) => a.season.seasonNumber - b.season.seasonNumber);
}

export async function queueReplaceRequest(input: {
  repository: WorkflowRepository;
  work: UserMessageScope;
  now?: () => string;
  createWorkflowRunId?: () => string;
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
      auditEvents: [{ type: "replace_request_queued", message: `Queued replace request ${workflowRunId}` }],
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

/** Idle-queue scan: every work with an urgent pending message and no active run. */
export async function enqueueUrgentReplaceRequests(input: {
  repository: WorkflowRepository;
  now?: () => string;
}): Promise<number> {
  let n = 0;
  for (const work of await input.repository.listWorksWithPendingMessages({ urgentOnly: true })) {
    // A run that failed for good released its messages as urgent. Re-queueing it on
    // every idle tick would retry a broken setup (dead LLM key, missing library dir)
    // every few seconds, each with a failure push. After such a failure only a user
    // action (现在处理, a new or edited message) brings it back here; the patrol
    // still retries it on its own schedule.
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
  const scope = { accountId: work.accountId, connectedStorageId: work.drive === "" ? null : work.drive };
  const notifications = await repository.listNotifications({ ...scope, since: lastTouch, limit: 500 });
  for (const notification of notifications) {
    // handleWorkflowRunFailure stamps the failure notification with the run's kind.
    if (notification.kind !== "replace_request") continue;
    const run = await repository.getWorkflowRunSnapshot(notification.workflowRunId, scope);
    if (run?.title.id === work.titleKey && run.workflowRun.status === "failed") return true;
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
  try {
    messages = await repository.claimUserMessages({ ...work, runId, now: now() });
    const pendingRows = await repository.listPendingReplacements(work);
    const pending = pendingRows.map((p) => p.episode);
    const states = await workStates(repository, work);
    if (!states.some((s) => s.season.id === claimed.season.id)) {
      throw new Error(`REPLACE_REQUEST_NOT_TRACKED: ${work.titleKey} is no longer tracked on this drive`);
    }
    const lockState = states.find((s) => s.season.id === claimed.season.id)!;

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

    const movie = claimed.title.type === "movie";
    const requested = [...new Set([...messages.flatMap((m) => m.episodeTags), ...pending])];
    const requestedEpisodes = movie && requested.length === 0 ? ["MOVIE"] : requested;
    const rejected = await repository.listRejectedResources({ accountId: work.accountId, titleKey: work.titleKey });
    const sources = await repository.listEpisodeSources(work);
    const userRequest: UserRequest = {
      requestedEpisodes,
      prompt: {
        messages: messages.map((m) => ({ body: m.body, episodeTags: m.episodeTags, createdAt: m.createdAt })),
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
      now,
    };

    let replacement: RunAcquisitionV2Result["replacement"];
    let workflowStatus: WorkflowStatus;
    if (movie) {
      const result = await runMovieAcquisitionV2AndPersist({
        ...common,
        title: claimed.title,
        categoryParentId: requireCategoryParent(deps.moviesParentDirectoryId ?? input.moviesParentDirectoryId),
      });
      replacement = result.replacement;
      workflowStatus = result.status;
    } else {
      const result = await runReplaceRequestV2AndPersist({
        ...common,
        title: claimed.title,
        categoryParentId: requireCategoryParent(
          storageParentForTitle(claimed.title, deps.storageParentDirectoryId, deps.animeStorageParentDirectoryId),
        ),
        seasons: states.map((s) => ({ season: s.season, episodes: s.episodes })),
        lockSeasonNumber: lockState.season.seasonNumber,
        lockAuditEvents: claimed.workflowRun.auditEvents,
      });
      replacement = result.replacement;
      workflowStatus = result.status;
    }

    // Bookkeeping: 待换 records, episode sources, and the reply on the messages.
    const results = replacement?.results ?? [];
    const replaced = results.filter((r) => r.outcome === "replaced");
    const notFound = results.filter((r) => r.outcome === "not_found").map((r) => r.episode);
    if (replaced.length > 0) {
      await repository.removePendingReplacements({ ...work, episodes: replaced.map((r) => r.episode) });
    }
    for (const r of replaced) {
      await repository.upsertEpisodeSource({
        ...work,
        episode: r.episode,
        linkKey: r.linkKey ?? null,
        label: r.label ?? "",
        sizeBytes: null,
        runId,
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
    if (messages.length > 0) {
      const reply: UserMessageReply = {
        results: results.map((r): ReplacementResult => ({
          episode: r.episode,
          outcome: r.outcome,
          // Only a replaced episode names a resource.
          ...(r.outcome === "replaced" && r.label !== undefined ? { label: r.label } : {}),
          note: r.note,
        })),
        oldFiles: replacement?.oldFiles ?? [],
        runId,
        ...(replacement?.rejectedPersistFailed ? { rejectedNotSaved: true } : {}),
      };
      await repository.finishUserMessages({ runId, reply, now: now() });
    }
    return { status: "ran", workflowRunId: runId, workflowStatus };
  } catch (error) {
    // Messages go back to pending (urgent) for a retry; the library stays as it was.
    try {
      await repository.releaseUserMessages({ runId, now: now() });
    } catch (releaseError) {
      console.error(`[user-message] run ${runId} could not release its messages: ${String(releaseError)}`);
    }
    const lockState = (await workStates(repository, work).catch(() => [])).find((s) => s.season.id === claimed.season.id);
    const handled = await handleWorkflowRunFailure({
      // The failure record keeps the lock season's CURRENT episodes, not the queue-time copy.
      claimed: lockState ? { ...claimed, season: lockState.season, episodes: lockState.episodes } : claimed,
      error,
      repository,
      now,
      ...(input.onAuthErrorFreeze === undefined ? {} : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }
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
