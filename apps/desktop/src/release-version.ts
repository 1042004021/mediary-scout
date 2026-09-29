/** Release tags: vYYYY.MM.DD, or vYYYY.MM.DD.N (N ≥ 2) for a later release the same day.
 *  Same rule as apps/web/lib/release-version.ts; tests/release-version.test.ts keeps the two in step. */
const TAG_RE = /^v(20\d{2})\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(?:\.([2-9]|[1-9]\d+))?$/;

/** The app version a release tag ships as: v2026.09.28 → 2026.928.0, v2026.09.28.2 → 2026.928.2.
 *  Valid semver (no leading zeros), ordered like the tags, and above every 1.x release. Null for
 *  anything that is not a release tag, including dates that do not exist. */
export function appVersionFromTag(tag: string): string | null {
  const match = TAG_RE.exec(tag);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // The pattern allows 31 for every month; a date that rolls over (02.31 → 03.03) does not exist.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return `${year}.${month * 100 + day}.${match[4] ? Number(match[4]) : 0}`;
}

/** True when `candidate` (x.y.z) is newer than `current`. Unparseable input is never newer. */
export function isNewerAppVersion(candidate: string, current: string): boolean {
  const next = parseAppVersion(candidate);
  const running = parseAppVersion(current);
  if (!next || !running) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== running[index]) return next[index]! > running[index]!;
  }
  return false;
}

function parseAppVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
