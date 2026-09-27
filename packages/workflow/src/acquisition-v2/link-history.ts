import { resourceLinkKey } from "./resource-link.js";
import { readTransferFate, type LinkHistoryRow } from "../user-requests.js";

/**
 * Shown wherever a prompt explains `· 发布 YYYY-MM-DD`. States where the files
 * went, and the usual reason, without turning the note into a block.
 */
export const LINK_HISTORY_PROMPT =
  "The 「近 30 天转过…」 note is this work's own transfer history of that same link (any title). 「文件每次都被丢掉」 means none of the files those transfers landed ended up in the library — usually because they were episodes the library already had, so transferring it again needs a concrete reason (e.g. a post date after those transfers, or a size/version that differs from what you have).";

/** resourceLinkKey → the one-line note. A row whose url has no key, or that landed nothing, is skipped. */
export function linkHistoryByKey(rows: readonly LinkHistoryRow[]): Map<string, string> {
  const groups = new Map<string, LinkHistoryRow[]>();
  for (const row of rows) {
    if (typeof row.materializedCount !== "number" || !Number.isFinite(row.materializedCount) || row.materializedCount <= 0) continue;
    if (typeof row.url !== "string" || row.url === "") continue;
    const key = resourceLinkKey(row.url);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const notes = new Map<string, string>();
  for (const [key, group] of groups) notes.set(key, formatLinkHistory(group));
  return notes;
}

export function linkHistoryNoteForUrl(notes: ReadonlyMap<string, string>, url: string): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  const key = resourceLinkKey(url);
  return key ? notes.get(key) : undefined;
}

function formatLinkHistory(rows: readonly LinkHistoryRow[]): string {
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.startedAt.localeCompare(b.row.startedAt) || a.index - b.index)
    .map((item) => item.row);
  const latest = ordered[ordered.length - 1]!;
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(latest.startedAt);
  const head = day ? `近 30 天转过 ${ordered.length} 次（最近 ${day[2]}-${day[3]}）` : `近 30 天转过 ${ordered.length} 次`;
  const phrase = fatePhrase(ordered);
  return phrase ? `${head}，${phrase}` : head;
}

/** `rows` are oldest-first. The last parsed fate is the most recent one recorded. */
function fatePhrase(rows: readonly LinkHistoryRow[]): string | undefined {
  const recorded = rows.flatMap((row) => {
    const fate = readTransferFate(row.fate);
    return fate ? [fate] : [];
  });
  if (recorded.length === 0) return undefined;
  const allDiscarded = recorded.every((fate) => fate.kept === 0);
  if (allDiscarded && recorded.length === rows.length) return "文件每次都被丢掉";
  if (allDiscarded) return `有记录的 ${recorded.length} 次文件都被丢掉`;
  const latest = recorded[recorded.length - 1]!;
  if (latest.kept > 0) return `最近一次留下 ${latest.kept} 个文件`;
  return undefined;
}
