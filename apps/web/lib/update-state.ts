import type { CommitRelation, ReleaseEntry } from "./release-feed-server";
import { compareReleaseTags } from "./release-version";
import type { UpdaterPhase, UpdaterStatus } from "./updater-client";

/** Phases during which an update is in progress (the tab polls; the scheduler must not start another). */
export const ACTIVE_UPDATER_PHASES: ReadonlySet<UpdaterPhase> = new Set<UpdaterPhase>([
  "waiting",
  "backing_up",
  "building",
  "switching",
  "verifying",
]);

export interface UpdateView {
  current: { label: string; tag: string | null };
  /** The newest release strictly newer than what is running, or null. Never a downgrade. */
  available: ReleaseEntry | null;
  releases: Array<ReleaseEntry & { isCurrent: boolean }>;
  feedUnavailable: boolean;
  updater: UpdaterStatus | null;
}

export function buildUpdateView(input: {
  currentCommit: string | null;
  feed: ReleaseEntry[];
  updater: UpdaterStatus | null;
  /** Where the running commit stands relative to the newest release (only used when it is untagged). */
  relation: CommitRelation | null;
}): UpdateView {
  const currentRelease = input.feed.find((release) => release.commit === input.currentCommit) ?? null;
  const newest = input.feed[0] ?? null;
  const short = input.currentCommit?.slice(0, 8) ?? null;
  let available: ReleaseEntry | null = null;
  if (newest && currentRelease) {
    available = compareReleaseTags(newest.tag, currentRelease.tag) > 0 ? newest : null;
  } else if (newest && input.relation === "behind") {
    available = newest;
  }
  return {
    current: currentRelease
      ? { label: currentRelease.tag, tag: currentRelease.tag }
      : !short
        ? // Built without GIT_SHA (plain `docker compose up -d --build`): no stamped commit.
          { label: "未知版本", tag: null }
        : newest && input.relation === "ahead"
          ? { label: `${short} · 比 ${newest.tag} 新的开发版本`, tag: null }
          : { label: `${short} · 开发版本`, tag: null },
    available,
    releases: input.feed.map((release) => ({ ...release, isCurrent: release.tag === currentRelease?.tag })),
    feedUnavailable: input.feed.length === 0,
    updater: input.updater,
  };
}
