import { compareReleaseTags, parseReleaseNotes, parseReleaseTag, type ReleaseNote } from "./release-version";
import { normalizeCommit } from "./deployment-update";

const REPO = "fancydirty/mediary-scout";
const TAGS_URL = `https://api.github.com/repos/${REPO}/tags?per_page=30`;
const OK_TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
/** Notes fetched for the newest N releases only (the tab shows 3, "更早" expands to 10). */
const NOTES_LIMIT = 10;

export interface ReleaseEntry {
  tag: string;
  date: string;
  commit: string;
  notes: ReleaseNote[];
}

let cache: { at: number; ttl: number; feed: ReleaseEntry[] } | null = null;
const relationCache = new Map<string, { at: number; relation: CommitRelation | null }>();

export function invalidateReleaseFeedCache(): void {
  cache = null;
  relationCache.clear();
}

/** Where `head` stands relative to `base` on GitHub. */
export type CommitRelation = "ahead" | "behind" | "identical" | "diverged";
const RELATIONS = new Set<CommitRelation>(["ahead", "behind", "identical", "diverged"]);

/** Null = unknown (offline, rate-limited, unknown commit). Callers must treat unknown as "don't offer an update". */
export async function fetchCommitRelation(
  base: string,
  head: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CommitRelation | null> {
  const key = `${base}...${head}`;
  const hit = relationCache.get(key);
  if (hit && Date.now() - hit.at < (hit.relation ? OK_TTL_MS : FAIL_TTL_MS)) return hit.relation;
  let relation: CommitRelation | null = null;
  try {
    const raw = await getText(fetchImpl, `https://api.github.com/repos/${REPO}/compare/${key}`);
    const status = raw ? (JSON.parse(raw) as { status?: unknown }).status : null;
    relation = typeof status === "string" && RELATIONS.has(status as CommitRelation) ? (status as CommitRelation) : null;
  } catch {
    relation = null;
  }
  relationCache.set(key, { at: Date.now(), relation });
  return relation;
}

async function getText(
  fetchImpl: typeof fetch,
  url: string,
  accept = "application/vnd.github+json",
): Promise<string | null> {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "mediary-scout-update-check", accept },
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  return response.ok ? await response.text() : null;
}

/** Newest first. Failure-tolerant: an offline instance gets [] (and does not retry for 5 minutes). */
export async function fetchReleaseFeed(fetchImpl: typeof fetch = fetch): Promise<ReleaseEntry[]> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.feed;
  let feed: ReleaseEntry[] = [];
  let ttl = FAIL_TTL_MS;
  try {
    const raw = await getText(fetchImpl, TAGS_URL);
    const list = raw ? (JSON.parse(raw) as Array<{ name?: unknown; commit?: { sha?: unknown } }>) : [];
    const releases = list
      .map((item) => {
        const parsed = typeof item.name === "string" ? parseReleaseTag(item.name) : null;
        const commit = normalizeCommit(typeof item.commit?.sha === "string" ? item.commit.sha : null);
        return parsed && commit ? { tag: parsed.tag, date: parsed.date, commit } : null;
      })
      .filter((item): item is { tag: string; date: string; commit: string } => item !== null)
      .sort((a, b) => compareReleaseTags(b.tag, a.tag));
    feed = await Promise.all(
      releases.map(async (release, index) => {
        if (index >= NOTES_LIMIT) return { ...release, notes: [] };
        const md = await getText(
          fetchImpl,
          `https://api.github.com/repos/${REPO}/contents/release-notes/${release.tag}.md?ref=${release.tag}`,
          "application/vnd.github.raw",
        ).catch(() => null);
        return { ...release, notes: md ? parseReleaseNotes(md) : [] };
      }),
    );
    if (raw) ttl = OK_TTL_MS;
  } catch {
    feed = [];
  }
  cache = { at: Date.now(), ttl, feed };
  return feed;
}
