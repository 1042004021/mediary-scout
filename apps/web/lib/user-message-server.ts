/**
 * Server-side logic behind a work's message card on the detail page: which work a
 * message belongs to, the thread the card shows, and when the next patrol comes. Kept
 * apart from the server actions so it can be unit-tested against a plain repository.
 * Design: docs/superpowers/specs/2026-09-26-user-message-replace-design.md.
 */
import {
  userMessageDrive,
  type UserMessage,
  type UserMessageScope,
  type UserRequestStore,
  type WorkflowRepository,
  type WorkflowScope,
} from "@media-track/workflow";

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
  messages: Array<Pick<UserMessage, "id" | "body" | "episodeTags" | "status" | "urgent" | "createdAt" | "reply">>;
  /** Episode codes still 待换 (sorted); "MOVIE" for a film. */
  pendingReplacements: string[];
  /** A run holds one of the messages right now. */
  busy: boolean;
}

export async function loadMessageThread(
  repo: Pick<UserRequestStore, "listUserMessages" | "listPendingReplacements">,
  work: UserMessageScope,
): Promise<MessageThreadView> {
  const [messages, pending] = await Promise.all([repo.listUserMessages(work), repo.listPendingReplacements(work)]);
  return {
    messages: messages.map(({ id, body, episodeTags, status, urgent, createdAt, reply }) => ({
      id,
      body,
      episodeTags,
      status,
      urgent,
      createdAt,
      reply,
    })),
    pendingReplacements: pending.map((p) => p.episode).sort(),
    busy: messages.some((m) => m.status === "processing"),
  };
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

/** The badge beside the title while something is 待换: how many episodes of a show, or
 *  「待换资源」 for a film. Null when nothing is. */
export function swapBadgeLabel(mediaType: "movie" | "tv", pendingReplacements: readonly string[]): string | null {
  if (mediaType === "movie") return pendingReplacements.includes("MOVIE") ? "待换资源" : null;
  return pendingReplacements.length > 0 ? `${pendingReplacements.length} 集待换` : null;
}
