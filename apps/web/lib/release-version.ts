/** Release tags are `vYYYY.MM.DD` (first release that day) or `vYYYY.MM.DD.N` (N ≥ 2).
 *  Only author-verified commits get a tag; instances auto-update to these and nothing else. */
export interface ReleaseTag {
  tag: string;
  /** YYYY-MM-DD */
  date: string;
  /** 0 for the day's first release, N for `.N`. */
  seq: number;
}

const TAG_RE = /^v(20\d{2})\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(?:\.([2-9]|[1-9]\d+))?$/;

export function parseReleaseTag(value: string): ReleaseTag | null {
  const match = TAG_RE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // The pattern allows 31 for every month; a date that rolls over (02.31 → 03.03) does not exist.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return { tag: value, date: `${match[1]}-${match[2]}-${match[3]}`, seq: match[4] ? Number(match[4]) : 0 };
}

export function compareReleaseTags(a: string, b: string): number {
  const left = parseReleaseTag(a);
  const right = parseReleaseTag(b);
  if (!left || !right) return a.localeCompare(b);
  return left.date.localeCompare(right.date) || left.seq - right.seq;
}

export type ReleaseNoteKind = "add" | "improve" | "fix";

export interface ReleaseNote {
  kind: ReleaseNoteKind;
  text: string;
}

const NOTE_KINDS: Record<string, ReleaseNoteKind> = { 新增: "add", 改进: "improve", 修复: "fix" };
const NOTE_RE = /^[-*]\s+(新增|改进|修复)\s+(.+?)\s*$/;

/** One bullet per note: `- 修复 <text>`. Anything else in the file is ignored. */
export function parseReleaseNotes(markdown: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = NOTE_RE.exec(line.trim());
    if (match) notes.push({ kind: NOTE_KINDS[match[1]!]!, text: match[2]! });
  }
  return notes;
}
