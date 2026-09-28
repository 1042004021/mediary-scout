import { appVersionFromTag, isNewerAppVersion } from "./release-version.js";

export const RELEASES_LATEST_URL = "https://api.github.com/repos/fancydirty/mediary-scout/releases/latest";
/** Wall-clock time between successful checks. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LatestRelease {
  tag: string;
  version: string;
  /** The release on GitHub: what changed, and both installers. */
  pageUrl: string;
}

/** GitHub's releases/latest body → the release, or null when it is not a date release (v1.4.1).
 *  The page URL is built from the checked tag, never taken from the response. */
export function parseLatestRelease(body: unknown): LatestRelease | null {
  if (!body || typeof body !== "object") return null;
  const tag = (body as { tag_name?: unknown }).tag_name;
  if (typeof tag !== "string") return null;
  const version = appVersionFromTag(tag);
  if (!version) return null;
  return { tag, version, pageUrl: `https://github.com/fancydirty/mediary-scout/releases/tag/${tag}` };
}

/** Offer only a newer release, and notify once per release. */
export function decideUpdateNotice(input: {
  latest: LatestRelease | null;
  currentVersion: string;
  notifiedTag: string | null;
}): { offer: LatestRelease | null; notify: boolean } {
  const offer = input.latest && isNewerAppVersion(input.latest.version, input.currentVersion) ? input.latest : null;
  return { offer, notify: offer !== null && offer.tag !== input.notifiedTag };
}

/** Due when never checked, a day has passed, or the clock went backwards. */
export function shouldCheckForUpdate(input: { now: number; lastCheckedAt: number | null }): boolean {
  if (input.lastCheckedAt === null) return true;
  return input.now < input.lastCheckedAt || input.now - input.lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}
