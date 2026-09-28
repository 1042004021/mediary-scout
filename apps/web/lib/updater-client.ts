import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type UpdaterPhase =
  | "idle"
  | "waiting"
  | "backing_up"
  | "building"
  | "switching"
  | "verifying"
  | "done"
  | "rolled_back"
  | "failed";

export interface UpdaterStatus {
  phase: UpdaterPhase;
  targetTag: string | null;
  fromCommit: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** One human sentence for the UI. */
  message: string;
  /** Last ~40 lines of the update log, shown behind 「查看详情」. */
  logTail: string;
  /** HEAD of the deploy folder, sent with every status. The version source for
   *  instances built without GIT_SHA — the documented `docker compose up -d` path. */
  repoCommit?: string | null;
}

const DEFAULT_STATE_DIR = "/updater-state";

interface ClientOptions {
  stateDir?: string;
  fetchImpl?: typeof fetch;
}

function updaterUrl(): string {
  return process.env.MEDIA_TRACK_UPDATER_URL ?? "http://updater:8787";
}

async function readToken(stateDir: string): Promise<string | null> {
  try {
    return (await readFile(join(stateDir, "token"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function sameToken(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function isUpdaterStatus(value: unknown): value is UpdaterStatus {
  return Boolean(value) && typeof value === "object" && typeof (value as { phase?: unknown }).phase === "string";
}

/** Null = no updater (old compose file, desktop, or it did not answer). */
export async function getUpdaterStatus(options: ClientOptions = {}): Promise<UpdaterStatus | null> {
  const token = await readToken(options.stateDir ?? DEFAULT_STATE_DIR);
  if (!token) return null;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${updaterUrl()}/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isUpdaterStatus(body) ? body : null;
  } catch {
    return null;
  }
}

export async function requestUpdate(
  tag: string,
  options: ClientOptions = {},
): Promise<{ ok: true } | { ok: false; reason: "no_updater" | "busy" | "bad_tag" | "unreachable" }> {
  const token = await readToken(options.stateDir ?? DEFAULT_STATE_DIR);
  if (!token) return { ok: false, reason: "no_updater" };
  try {
    const response = await (options.fetchImpl ?? fetch)(`${updaterUrl()}/update`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tag }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 202) return { ok: true };
    if (response.status === 409) return { ok: false, reason: "busy" };
    if (response.status === 400) return { ok: false, reason: "bad_tag" };
    return { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

let repoCommitCache: { at: number; commit: string | null } | null = null;

export function invalidateRepoCommitCache(): void {
  repoCommitCache = null;
}

/** The deploy folder's HEAD as the updater reports it, cached 30 s (the badge polls every
 *  8 s; a missing updater costs one timed-out call per 30 s, not per poll). */
export async function getCachedRepoCommit(options: ClientOptions = {}): Promise<string | null> {
  if (repoCommitCache && Date.now() - repoCommitCache.at < 30_000) return repoCommitCache.commit;
  const status = await getUpdaterStatus(options);
  const reported = status?.repoCommit;
  const commit = typeof reported === "string" && /^[0-9a-f]{40}$/.test(reported) ? reported : null;
  repoCommitCache = { at: Date.now(), commit };
  return commit;
}

/** The updater calls /api/update/busy with the same token; verify it here. */
export async function isUpdaterToken(header: string | null, options: ClientOptions = {}): Promise<boolean> {
  const token = await readToken(options.stateDir ?? DEFAULT_STATE_DIR);
  if (!token || !header?.startsWith("Bearer ")) return false;
  return sameToken(header.slice("Bearer ".length), token);
}
