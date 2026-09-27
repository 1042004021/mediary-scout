/**
 * Server-side logic behind a work's message card on the detail page: which work a
 * message belongs to, the thread the card shows, and when the next patrol comes. Kept
 * apart from the server actions so it can be unit-tested against a plain repository.
 * Design: docs/superpowers/specs/2026-09-26-user-message-replace-design.md.
 */
import {
  userMessageDrive,
  type PersistedWorkflowRunSnapshot,
  type UserMessageScope,
  type UserRequestStore,
  type WorkflowRepository,
  type WorkflowScope,
} from "@media-track/workflow";
import type { PendingRow, ThreadMessage } from "./user-message-state";

// The badge label is shared with the client card (which must not import this module).
export { swapBadgeLabel } from "./user-message-state";

/**
 * The work a message is filed under — the one the engine looks up: the page's own
 * workspace scope, and the drive key taken from the title's tracked seasons there
 * (userMessageDrive of their connected storage, "" when unbound). The page and every
 * message action resolve it this way. On the primary drive the page has no storageId,
 * yet its seasons carry the real drive id: a message filed under "" instead would never
 * be found by the engine, never processed. Null when the title is not tracked here.
 */
export async function resolveMessageWork(input: {
  repo: Pick<WorkflowRepository, "listTrackedSeasonStates">;
  scope: WorkflowScope;
  tmdbId: number;
  mediaType: "movie" | "tv";
}): Promise<UserMessageScope | null> {
  // Server actions receive whatever the client sent — the type alone guarantees nothing.
  if (input.mediaType !== "movie" && input.mediaType !== "tv") return null;
  if (!Number.isInteger(input.tmdbId) || input.tmdbId <= 0) return null;
  const titleKey = input.mediaType === "movie" ? `tmdb_movie_${input.tmdbId}` : `tmdb_tv_${input.tmdbId}`;
  const states = (await input.repo.listTrackedSeasonStates(input.scope)).filter((s) => s.title.id === titleKey);
  const first = states[0];
  if (!first) return null;
  return { accountId: input.scope.accountId, drive: userMessageDrive(first.connectedStorageId), titleKey };
}

export interface MessageThreadView {
  /** Newest first; withdrawn ones are gone. */
  messages: ThreadMessage[];
  /** Episode codes still 待换 (sorted); "MOVIE" for a film. */
  pendingReplacements: string[];
  /** The same 待换 rows with the message that asked and when (same order): what 撤销
   *  after 「不换了」 puts back. */
  pendingRows: PendingRow[];
  /** A run holds one of the messages right now. */
  busy: boolean;
}

export async function loadMessageThread(
  repo: Pick<UserRequestStore, "listUserMessages" | "listPendingReplacements">,
  work: UserMessageScope,
): Promise<MessageThreadView> {
  const [messages, pending] = await Promise.all([repo.listUserMessages(work), repo.listPendingReplacements(work)]);
  const pendingRows = pending
    .map(({ episode, messageId, requestedAt }) => ({ episode, messageId, requestedAt }))
    .sort((a, b) => (a.episode < b.episode ? -1 : a.episode > b.episode ? 1 : 0));
  return {
    messages: messages.map(({ id, body, episodeTags, status, urgent, createdAt, processedAt, reply }) => ({
      id,
      body,
      episodeTags,
      status,
      urgent,
      createdAt,
      processedAt,
      reply,
    })),
    pendingReplacements: pendingRows.map((p) => p.episode),
    pendingRows,
    busy: holdsMessage(messages),
  };
}

/** A run holds one of these messages right now. */
function holdsMessage(messages: ReadonlyArray<{ status: string }>): boolean {
  return messages.some((m) => m.status === "processing");
}

/** What the work's active run means for its messages. */
export interface MessageRunView {
  /** A replace run of this work is running now. */
  running: boolean;
  /** Its live line (progress.activity), for the ticker; null before the first one. */
  activity: string | null;
  /** An urgent message waits for the run in flight: a replace run already running (it
   *  took what was pending when it started) or any other kind of run on the title (the
   *  title lock). A replace run that is only queued is not one — it takes every pending
   *  message along when it starts. */
  waitsForRun: boolean;
}

/** `runs`: active runs of the page's scope (listActiveWorkflowRuns). */
export function messageRunView(
  runs: ReadonlyArray<Pick<PersistedWorkflowRunSnapshot, "title" | "connectedStorageId" | "workflowRun">>,
  work: UserMessageScope,
): MessageRunView {
  const mine = runs.filter((r) => r.title.id === work.titleKey && userMessageDrive(r.connectedStorageId) === work.drive);
  const replaceRunning = mine.find((r) => r.workflowRun.kind === "replace_request" && r.workflowRun.status === "running");
  return {
    running: replaceRunning !== undefined,
    activity: replaceRunning?.workflowRun.progress?.activity.trim() || null,
    waitsForRun: mine.some((r) => r.workflowRun.kind !== "replace_request" || r.workflowRun.status === "running"),
  };
}

/**
 * Whether 「不换了」 must wait, read when it is pressed: the card's keepBusy (a run holds one
 * of the work's messages, or a replace run of the work is running) worked out the same way
 * from fresh data. That run's end-of-run bookkeeping would put the episode back as 待换 and
 * silently undo the choice. The card's gate is only as fresh as its page: a run that started
 * after the page rendered would slip through it.
 */
export async function keepMustWait(input: {
  repo: Pick<WorkflowRepository, "listUserMessages" | "listActiveWorkflowRuns">;
  /** The page's workspace scope, as for readTitleMessages. */
  scope: WorkflowScope;
  work: UserMessageScope;
}): Promise<boolean> {
  const [messages, runs] = await Promise.all([input.repo.listUserMessages(input.work), input.repo.listActiveWorkflowRuns(input.scope)]);
  return holdsMessage(messages) || messageRunView(runs, input.work).running;
}

// The 待换 rows 撤销 sends back (restoreEpisodesToPendingAction). The page handed them to the
// card, but the call comes from the client like any other: unchecked, it could file any
// episode under any message at any time.
/** The episode codes the engine writes for a show (replace-request.ts episodeScope): SxxEyy
 *  with two or more digits in each part. A film's one row is "MOVIE". */
const SHOW_EPISODE_CODE = /^S(\d{2,})E\d{2,}$/;
const MESSAGE_ID = /^msg_[\w-]{1,80}$/;
/** A time as the store writes it (toISOString), or with an offset instead of Z. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The rows as they will be written back, or null when any is malformed or not this kind
 *  of work's episode. Checked before any lookup. */
export function parsePendingRows(input: unknown, mediaType: "movie" | "tv", max: number): PendingRow[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > max) return null;
  const rows: PendingRow[] = [];
  for (const row of input as unknown[]) {
    if (typeof row !== "object" || row === null) return null;
    const { episode, messageId, requestedAt } = row as Record<string, unknown>;
    if (typeof episode !== "string" || !(mediaType === "movie" ? episode === "MOVIE" : SHOW_EPISODE_CODE.test(episode))) return null;
    if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) return null;
    if (typeof requestedAt !== "string" || !ISO_TIME.test(requestedAt) || !Number.isFinite(Date.parse(requestedAt))) return null;
    rows.push({ episode, messageId, requestedAt: new Date(requestedAt).toISOString() });
  }
  return rows;
}

/** Whether every row could be one of this work's own 待换 rows: filed under one of its
 *  messages, for an episode it has (a show: a season tracked here, on this drive — the
 *  engine's rule), at a time not later than now. */
export async function pendingRowsFitWork(input: {
  repo: Pick<WorkflowRepository, "listUserMessages" | "listTrackedSeasonStates">;
  /** The page's workspace scope, as for resolveMessageWork. */
  scope: WorkflowScope;
  work: UserMessageScope;
  mediaType: "movie" | "tv";
  rows: readonly PendingRow[];
  now: Date;
}): Promise<boolean> {
  const { work } = input;
  const [messages, states] = await Promise.all([input.repo.listUserMessages(work), input.repo.listTrackedSeasonStates(input.scope)]);
  const messageIds = new Set(messages.map((m) => m.id));
  // The episodes that exist in this work's seasons tracked on this drive — a season number
  // alone would let a forged code (S01E9999 in a two-episode season) through.
  const episodes = new Set(
    states
      .filter((s) => s.title.id === work.titleKey && userMessageDrive(s.connectedStorageId) === work.drive)
      .flatMap((s) => s.episodes.map((e) => e.episodeCode)),
  );
  // The rows come back from this same server (web and worker share its clock), written
  // in the past — a time later than now is forged.
  const latest = input.now.getTime();
  const isEpisode = (episode: string) => (input.mediaType === "movie" ? episode === "MOVIE" : episodes.has(episode));
  return input.rows.every((row) => messageIds.has(row.messageId) && isEpisode(row.episode) && Date.parse(row.requestedAt) <= latest);
}

export interface TitleMessages {
  thread: MessageThreadView;
  run: MessageRunView;
  /** The daily patrol times (Beijing "HH:MM"), for 「等巡检 · 明早 06:00」. */
  sweepTimes: string[];
}

/**
 * The detail page's message decorations — the 待换 badge and cells, and the message
 * card — for the work on the page's drive; null when the title is not tracked there.
 * They are decorations: a failed read logs one short line and leaves them out, it
 * never takes the whole detail page down.
 */
export async function readTitleMessages(input: {
  repo: Pick<WorkflowRepository, "listTrackedSeasonStates" | "listUserMessages" | "listPendingReplacements" | "listActiveWorkflowRuns">;
  /** The page's workspace scope — a lookup of its own, so its failure is caught too. */
  scope: () => Promise<WorkflowScope>;
  tmdbId: number;
  mediaType: "movie" | "tv";
  /** The patrol times setting (getDailySweepTimes). */
  sweepTimes: () => Promise<string[]>;
  log?: (line: string) => void;
}): Promise<TitleMessages | null> {
  try {
    const scope = await input.scope();
    const work = await resolveMessageWork({ repo: input.repo, scope, tmdbId: input.tmdbId, mediaType: input.mediaType });
    if (!work) return null;
    const [thread, runs, sweepTimes] = await Promise.all([
      loadMessageThread(input.repo, work),
      input.repo.listActiveWorkflowRuns(scope),
      input.sweepTimes(),
    ]);
    return { thread, run: messageRunView(runs, work), sweepTimes };
  } catch (error) {
    (input.log ?? console.error)(
      `[user-message] tmdb ${input.mediaType} ${input.tmdbId}: messages read failed, page shown without the 待换 badge/cells and the message card: ${shortError(error)}`,
    );
    return null;
  }
}

/** A log-sized error message (a DB error can carry a whole query). */
function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

/** When a message left now gets read: the next patrol time (Beijing "HH:MM") today,
 *  else tomorrow's first — 「明早」 when that is before noon. */
export function nextPatrolLabel(times: string[], hhmm: string): string {
  const sorted = [...times].sort();
  const today = sorted.find((t) => t > hhmm);
  if (today) return `今天 ${today}`;
  const first = sorted[0] ?? "06:00";
  return first < "12:00" ? `明早 ${first}` : `明天 ${first}`;
}
