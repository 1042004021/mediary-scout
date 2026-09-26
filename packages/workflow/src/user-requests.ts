/**
 * User messages to the agent — "this one is wrong, find another".
 *
 * A user who got a bad resource (blue-tinted picture, a knock-off film with the same
 * name) writes one sentence on the title page. The next patrol (or "现在处理") runs a
 * replace_request for that work: the agent reads the message, rejects the current
 * source, finds a DIFFERENT one and lands it beside the old file (never deletes it).
 * Episodes it could not replace stay "待换" and every later patrol keeps looking.
 * Design: docs/superpowers/specs/2026-09-26-user-message-replace-design.md.
 */

export type UserMessageStatus = "pending" | "processing" | "done" | "withdrawn";

export interface UserMessageScope {
  accountId: string;
  /** connected_storage_id; "" when the work has no bound drive. */
  drive: string;
  /** Media title id, e.g. tmdb_tv_283428 / tmdb_movie_238. */
  titleKey: string;
}

export interface ReplacementResult {
  episode: string;
  outcome: "replaced" | "not_found";
  label?: string;
  sizeBytes?: number;
  note: string;
}

export interface UserMessageReply {
  results: ReplacementResult[];
  /** Paths (relative to the library dir) of the files the user may now delete. */
  oldFiles: string[];
  runId: string;
}

export interface UserMessage extends UserMessageScope {
  id: string;
  body: string;
  episodeTags: string[];
  status: UserMessageStatus;
  urgent: boolean;
  runId: string | null;
  reply: UserMessageReply | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}

export interface PendingReplacement extends UserMessageScope {
  episode: string;
  messageId: string;
  requestedAt: string;
}

export interface RejectedResource {
  id: string;
  accountId: string;
  titleKey: string;
  episode: string;
  linkKey: string | null;
  label: string;
  sizeBytes: number | null;
  reason: string;
  messageId: string | null;
  createdAt: string;
}

export interface EpisodeSource extends UserMessageScope {
  episode: string;
  linkKey: string | null;
  label: string;
  sizeBytes: number | null;
  runId: string;
  recordedAt: string;
}

/** Persistence port, implemented by all three repositories. Every state transition
 *  that can race (edit vs claim, claim vs claim) is atomic in the store. */
export interface UserRequestStore {
  createUserMessage(input: UserMessageScope & { body: string; episodeTags: string[]; now: string }): Promise<UserMessage>;
  /** Newest first; withdrawn excluded. */
  listUserMessages(scope: UserMessageScope): Promise<UserMessage[]>;
  /** Only while pending. Returns the updated row, or null when it is no longer pending. */
  editUserMessage(input: { accountId: string; id: string; body: string; episodeTags: string[]; now: string }): Promise<UserMessage | null>;
  /** Only while pending. Returns whether it was withdrawn. */
  withdrawUserMessage(input: { accountId: string; id: string; now: string }): Promise<boolean>;
  /** Mark this work's pending messages urgent ("现在处理"). Returns how many. */
  markUserMessagesUrgent(input: UserMessageScope & { now: string }): Promise<number>;
  /** Atomically move every pending message of the work to processing under runId. */
  claimUserMessages(input: UserMessageScope & { runId: string; now: string }): Promise<UserMessage[]>;
  /** processing(runId) → done with the reply. */
  finishUserMessages(input: { runId: string; reply: UserMessageReply; now: string }): Promise<void>;
  /** processing(runId) → pending + urgent (the run died; retry when the queue is free). */
  releaseUserMessages(input: { runId: string; now: string }): Promise<void>;
  /** Works (any account) with a pending message; `urgentOnly` for the idle-queue scan. */
  listWorksWithPendingMessages(input: { urgentOnly: boolean }): Promise<UserMessageScope[]>;

  listPendingReplacements(scope: UserMessageScope): Promise<PendingReplacement[]>;
  /** Every (work) that has at least one pending replacement. */
  listWorksWithPendingReplacements(): Promise<UserMessageScope[]>;
  addPendingReplacements(input: UserMessageScope & { episodes: string[]; messageId: string; now: string }): Promise<void>;
  removePendingReplacements(input: UserMessageScope & { episodes: string[] }): Promise<number>;

  addRejectedResources(input: { accountId: string; titleKey: string; items: Array<Omit<RejectedResource, "id" | "accountId" | "titleKey" | "createdAt">>; now: string }): Promise<void>;
  listRejectedResources(input: { accountId: string; titleKey: string }): Promise<RejectedResource[]>;

  upsertEpisodeSource(input: EpisodeSource): Promise<void>;
  listEpisodeSources(scope: UserMessageScope): Promise<EpisodeSource[]>;
}

export const USER_MESSAGE_LIMITS = {
  bodyMax: 500,
  tagsMax: 200,
} as const;

const EPISODE_TAG = /^(?:S\d{2}E\d{2,4}|MOVIE)$/;

/** Null = valid; otherwise a 中文 message for the UI. */
export function validateUserMessageInput(input: { body: string; episodeTags: string[] }): string | null {
  if (typeof input.body !== "string" || input.body.trim() === "") return "留言不能是空的";
  if (input.body.length > USER_MESSAGE_LIMITS.bodyMax) return `留言最多 ${USER_MESSAGE_LIMITS.bodyMax} 字`;
  if (!Array.isArray(input.episodeTags) || input.episodeTags.length > USER_MESSAGE_LIMITS.tagsMax) return "集数标签不对";
  if (input.episodeTags.some((tag) => typeof tag !== "string" || !EPISODE_TAG.test(tag))) return "集数标签不对";
  return null;
}

/** "" when the work has no bound drive (the column is NOT NULL). */
export function userMessageDrive(connectedStorageId: string | null | undefined): string {
  return connectedStorageId ?? "";
}

const RELEASE_NOISE =
  /\b(?:2160p|1080p|720p|480p|4k|uhd|hdr10?\+?|dv|dovi|web-?dl|webrip|bluray|blu-ray|bdrip|remux|hevc|avc|x26[45]|h\.?26[45]|aac|ddp?5\.1|atmos|flac|10bit|8bit|mkv|mp4|ts)\b/gi;

/** Title normalization for the fingerprint: bracket groups, sizes, release words and
 *  punctuation removed, lowercased. Deliberately aggressive — it only ever combines
 *  with an exact-ish size match, never decides alone. */
export function normalizeResourceLabel(label: string): string {
  return label
    .replace(/[【\[(（][^】\])）]*[】\])）]/g, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:gb?|mb?|tb?)\b/gi, " ")
    .replace(/\.[a-z0-9]{2,4}$/i, " ")
    .replace(RELEASE_NOISE, " ")
    .replace(/[\s._\-·:：,，、。!！?？'"]+/g, "")
    .toLowerCase();
}

/** A size PanSou-style titles often carry ("[2.2G]", "850MB"). Null when absent. */
export function parseSizeFromTitle(title: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(T|G|M)(?:i?B)?\b/i.exec(title);
  if (!match) return null;
  const unit = match[2]!.toUpperCase();
  const factor = unit === "T" ? 1024 ** 4 : unit === "G" ? 1024 ** 3 : 1024 ** 2;
  return Math.round(Number(match[1]) * factor);
}

/** The "same file, different link" rule: the candidate title must carry a size within
 *  2% of the rejected file AND normalize to the same label. Anything short of that is
 *  left for the agent, which sees the rejected list verbatim. */
export function resourceFingerprintMatches(
  candidateTitle: string,
  rejected: { label: string; sizeBytes: number | null },
): boolean {
  if (rejected.sizeBytes === null || rejected.sizeBytes <= 0) return false;
  const size = parseSizeFromTitle(candidateTitle);
  if (size === null) return false;
  if (Math.abs(size - rejected.sizeBytes) / rejected.sizeBytes > 0.02) return false;
  const a = normalizeResourceLabel(candidateTitle);
  return a !== "" && a === normalizeResourceLabel(rejected.label);
}

/** The flat row both SQL engines store for user_messages. */
export interface UserMessageRow {
  id: string;
  account_id: string;
  drive: string;
  title_key: string;
  body: string;
  episode_tags: string;
  status: string;
  urgent: boolean | number;
  run_id: string | null;
  reply: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
}

const USER_MESSAGE_STATUSES: readonly UserMessageStatus[] = ["pending", "processing", "done", "withdrawn"];

export function userMessageFromRow(row: UserMessageRow): UserMessage {
  // Fail loud on an unknown status: defaulting to "pending" would silently make a
  // message editable/claimable again.
  const status = USER_MESSAGE_STATUSES.find((s) => s === row.status);
  if (!status) throw new Error(`user message ${String(row.id)} has unknown status ${JSON.stringify(row.status)}`);
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    drive: String(row.drive ?? ""),
    titleKey: String(row.title_key),
    body: String(row.body),
    episodeTags: parseJsonArray(row.episode_tags),
    status,
    urgent: row.urgent === true || row.urgent === 1,
    runId: row.run_id ?? null,
    reply: parseReply(row.reply),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    processedAt: row.processed_at ?? null,
  };
}

/** Oldest first, id as the tie-break — the claim order every engine returns
 *  (RETURNING has no ORDER BY, so the SQL engines sort in code too). */
export function compareUserMessagesCreated(a: UserMessage, b: UserMessage): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Row shape of pending_replacements in both SQL engines. */
export interface PendingReplacementRow {
  account_id: string;
  drive: string;
  title_key: string;
  episode: string;
  message_id: string;
  requested_at: string;
}

export function pendingReplacementFromRow(row: PendingReplacementRow): PendingReplacement {
  return {
    accountId: String(row.account_id),
    drive: String(row.drive ?? ""),
    titleKey: String(row.title_key),
    episode: String(row.episode),
    messageId: String(row.message_id),
    requestedAt: String(row.requested_at),
  };
}

/** Row shape of rejected_resources. size_bytes is bigint in Postgres (pg returns
 *  it as a string) and integer in SQLite. */
export interface RejectedResourceRow {
  id: string;
  account_id: string;
  title_key: string;
  episode: string;
  link_key: string | null;
  label: string;
  size_bytes: string | number | null;
  reason: string;
  message_id: string | null;
  created_at: string;
}

export function rejectedResourceFromRow(row: RejectedResourceRow): RejectedResource {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    titleKey: String(row.title_key),
    episode: String(row.episode),
    linkKey: row.link_key ?? null,
    label: String(row.label),
    sizeBytes: sizeFromColumn(row.size_bytes),
    reason: String(row.reason),
    messageId: row.message_id ?? null,
    createdAt: String(row.created_at),
  };
}

/** Row shape of episode_sources (size_bytes as for rejected_resources). */
export interface EpisodeSourceRow {
  account_id: string;
  drive: string;
  title_key: string;
  episode: string;
  link_key: string | null;
  label: string;
  size_bytes: string | number | null;
  run_id: string;
  recorded_at: string;
}

export function episodeSourceFromRow(row: EpisodeSourceRow): EpisodeSource {
  return {
    accountId: String(row.account_id),
    drive: String(row.drive ?? ""),
    titleKey: String(row.title_key),
    episode: String(row.episode),
    linkKey: row.link_key ?? null,
    label: String(row.label),
    sizeBytes: sizeFromColumn(row.size_bytes),
    runId: String(row.run_id),
    recordedAt: String(row.recorded_at),
  };
}

function sizeFromColumn(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseReply(text: string | null | undefined): UserMessageReply | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as UserMessageReply;
  } catch {
    return null;
  }
}

function parseJsonArray(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
