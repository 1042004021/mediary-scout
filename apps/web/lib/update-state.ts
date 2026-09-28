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

/**
 * available — a newer release exists (see `available`).
 * latest    — compared, nothing newer: running the newest release, or a build ahead of it.
 * unknown   — could not compare: no stamped commit, or GitHub could not place the build.
 * offline   — no release list (GitHub unreachable, or nothing released yet).
 */
export type UpdateStatus = "available" | "latest" | "unknown" | "offline";

export interface UpdateView {
  current: { label: string; tag: string | null };
  /** The newest release strictly newer than what is running, or null. Never a downgrade. */
  available: ReleaseEntry | null;
  status: UpdateStatus;
  releases: Array<ReleaseEntry & { isCurrent: boolean }>;
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
  const status: UpdateStatus = !newest
    ? "offline"
    : available
      ? "available"
      : currentRelease || input.relation === "ahead" || input.relation === "identical"
        ? "latest"
        : "unknown";
  return {
    current: currentRelease
      ? { label: currentRelease.tag, tag: currentRelease.tag }
      : !short
        ? // Built without GIT_SHA (plain `docker compose up -d --build`): no stamped commit.
          { label: "未知版本", tag: null }
        : !newest
          ? // No release list: it may be a release or a dev build; say only what we know.
            { label: short, tag: null }
          : input.relation === "ahead"
            ? { label: `${short} · 比 ${newest.tag} 新的开发版本`, tag: null }
            : { label: `${short} · 开发版本`, tag: null },
    available,
    status,
    releases: input.feed.map((release) => ({ ...release, isCurrent: release.tag === currentRelease?.tag })),
    updater: input.updater,
  };
}
