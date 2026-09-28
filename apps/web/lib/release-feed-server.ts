import { compareReleaseTags, parseReleaseNotes, parseReleaseTag, type ReleaseNote } from "./release-version";
import { normalizeCommit } from "./deployment-update";

const REPO = "fancydirty/mediary-scout";
/** Every `v…` tag in one response (the tags list API pages at 30, which would lose the
 *  running release once 30 newer ones exist). Old semver tags come back too and are
 *  dropped by parseReleaseTag. Release tags must be lightweight: an annotated tag's
 *  ref points at a tag object, not a commit. */
const TAGS_URL = `https://api.github.com/repos/${REPO}/git/matching-refs/tags/v`;
const OK_TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
/** Notes fetched for the newest N releases only (the tab shows 3, "更早" expands to 10). */
const NOTES_LIMIT = 10;
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Installers are only trusted from this repo's own release downloads. */
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

export interface ReleaseEntry {
  tag: string;
  date: string;
  commit: string;
  notes: ReleaseNote[];
}

/** The newest Release published on GitHub with installers: what desktop users can download. */
export interface DesktopRelease {
  tag: string;
  pageUrl: string;
  dmgUrl: string | null;
  exeUrl: string | null;
}

let cache: { at: number; ttl: number; feed: ReleaseEntry[] } | null = null;
let desktopCache: { at: number; ttl: number; release: DesktopRelease | null } | null = null;
const relationCache = new Map<string, { at: number; relation: CommitRelation | null }>();

export function invalidateReleaseFeedCache(): void {
  cache = null;
  desktopCache = null;
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
    const list = raw ? (JSON.parse(raw) as Array<{ ref?: unknown; object?: { sha?: unknown; type?: unknown } }>) : [];
    const releases = list
      .map((item) => {
        const name = typeof item.ref === "string" ? item.ref.replace(/^refs\/tags\//, "") : "";
        const parsed = parseReleaseTag(name);
        const commit =
          item.object?.type === "commit" && typeof item.object.sha === "string" ? normalizeCommit(item.object.sha) : null;
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

/** Null when GitHub is unreachable or the latest release is not a date release (e.g. v1.4.1).
 *  Cached like the feed: an hour after success, five minutes after a failure. */
export async function fetchLatestDesktopRelease(fetchImpl: typeof fetch = fetch): Promise<DesktopRelease | null> {
  if (desktopCache && Date.now() - desktopCache.at < desktopCache.ttl) return desktopCache.release;
  let release: DesktopRelease | null = null;
  let ttl = FAIL_TTL_MS;
  try {
    const raw = await getText(fetchImpl, LATEST_RELEASE_URL);
    if (raw) {
      release = desktopReleaseFrom(JSON.parse(raw));
      ttl = OK_TTL_MS;
    }
  } catch {
    release = null;
  }
  desktopCache = { at: Date.now(), ttl, release };
  return release;
}

function desktopReleaseFrom(body: unknown): DesktopRelease | null {
  const data = (body ?? {}) as { tag_name?: unknown; assets?: unknown };
  if (typeof data.tag_name !== "string" || !parseReleaseTag(data.tag_name)) return null;
  const assets = Array.isArray(data.assets)
    ? (data.assets as Array<{ name?: unknown; browser_download_url?: unknown } | null>)
    : [];
  const installer = (extension: string): string | null => {
    for (const asset of assets) {
      const url = asset?.browser_download_url;
      if (typeof asset?.name === "string" && asset.name.endsWith(extension) && typeof url === "string" && url.startsWith(DOWNLOAD_PREFIX)) {
        return url;
      }
    }
    return null;
  };
  return {
    tag: data.tag_name,
    pageUrl: `https://github.com/${REPO}/releases/tag/${data.tag_name}`,
    dmgUrl: installer(".dmg"),
    exeUrl: installer(".exe"),
  };
}
