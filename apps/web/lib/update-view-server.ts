import { readBuildCommit } from "./deployment-update-server";
import { fetchCommitRelation, fetchLatestDesktopRelease, fetchReleaseFeed } from "./release-feed-server";
import { buildUpdateView, desktopDownload, desktopFeed, desktopView, type UpdateView } from "./update-state";
import { getCachedRepoCommit, getUpdaterStatus } from "./updater-client";
import { resolveIsDesktop } from "./workflow-runtime";

/** Shared by the 「更新」 tab, 「立即更新」, the daily auto-update and the settings badge.
 *  The badge polls every 8 s per open tab, so it passes `{ updaterStatus: false }` to skip the updater call.
 *  On desktop only a release published with installers counts: a tag whose build is still
 *  running, or failed, is never offered. If the published release cannot be read, the
 *  changelog stays and nothing is offered. Desktop never talks to the updater. */
export async function loadUpdateView(options: { updaterStatus?: boolean } = {}): Promise<UpdateView> {
  const desktop = resolveIsDesktop();
  const [buildCommit, releases, updater, published] = await Promise.all([
    readBuildCommit(),
    fetchReleaseFeed(),
    desktop || options.updaterStatus === false ? Promise.resolve(null) : getUpdaterStatus(),
    desktop ? fetchLatestDesktopRelease() : Promise.resolve(null),
  ]);
  // No stamped commit (built without GIT_SHA): the deploy folder's HEAD is the next best
  // answer. It comes from the updater, so skip it when the caller asked not to call the
  // updater (the badge poll). Desktop installs from GitHub and never calls the updater.
  const reported = typeof updater?.repoCommit === "string" && /^[0-9a-f]{40}$/.test(updater.repoCommit) ? updater.repoCommit : null;
  const currentCommit =
    buildCommit ?? reported ?? (desktop || options.updaterStatus === false ? null : await getCachedRepoCommit());
  const feed = desktop && published ? desktopFeed(releases, published.tag) : releases;
  const newest = feed[0];
  const tagged = feed.some((release) => release.commit === currentCommit);
  const relation =
    newest && currentCommit && !tagged ? await fetchCommitRelation(newest.commit, currentCommit) : null;
  const view = buildUpdateView({ currentCommit, feed, updater, relation });
  if (!desktop) return view;
  const settled = desktopView(view, published);
  return published && settled.available ? { ...settled, download: desktopDownload(published, process.platform) } : settled;
}
