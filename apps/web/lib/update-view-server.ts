import { readBuildCommit } from "./deployment-update-server";
import { fetchCommitRelation, fetchLatestDesktopRelease, fetchReleaseFeed } from "./release-feed-server";
import { buildUpdateView, desktopDownload, desktopFeed, type UpdateView } from "./update-state";
import { getUpdaterStatus } from "./updater-client";
import { resolveIsDesktop } from "./workflow-runtime";

/** Shared by the 「更新」 tab, 「立即更新」, the daily auto-update and the settings badge.
 *  The badge polls every 8 s per open tab, so it passes `{ updaterStatus: false }` to skip the updater call.
 *  On desktop only a release published with installers counts: a tag whose build is still
 *  running, or failed, is never offered. */
export async function loadUpdateView(options: { updaterStatus?: boolean } = {}): Promise<UpdateView> {
  const desktop = resolveIsDesktop();
  const [currentCommit, releases, updater, published] = await Promise.all([
    readBuildCommit(),
    fetchReleaseFeed(),
    options.updaterStatus === false ? Promise.resolve(null) : getUpdaterStatus(),
    desktop ? fetchLatestDesktopRelease() : Promise.resolve(null),
  ]);
  const feed = desktop ? desktopFeed(releases, published?.tag ?? null) : releases;
  const newest = feed[0];
  const tagged = feed.some((release) => release.commit === currentCommit);
  const relation =
    newest && currentCommit && !tagged ? await fetchCommitRelation(newest.commit, currentCommit) : null;
  const view = buildUpdateView({ currentCommit, feed, updater, relation });
  return published && view.available ? { ...view, download: desktopDownload(published, process.platform) } : view;
}
