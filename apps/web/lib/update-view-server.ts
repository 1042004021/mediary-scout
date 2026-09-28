import { readBuildCommit } from "./deployment-update-server";
import { fetchCommitRelation, fetchReleaseFeed } from "./release-feed-server";
import { buildUpdateView, type UpdateView } from "./update-state";
import { getUpdaterStatus } from "./updater-client";

/** Shared by the 「更新」 tab, 「立即更新」, the daily auto-update and the settings badge.
 *  The badge polls every 8 s per open tab, so it passes `{ updaterStatus: false }` to skip the updater call. */
export async function loadUpdateView(options: { updaterStatus?: boolean } = {}): Promise<UpdateView> {
  const [currentCommit, feed, updater] = await Promise.all([
    readBuildCommit(),
    fetchReleaseFeed(),
    options.updaterStatus === false ? Promise.resolve(null) : getUpdaterStatus(),
  ]);
  const newest = feed[0];
  const tagged = feed.some((release) => release.commit === currentCommit);
  const relation =
    newest && currentCommit && !tagged ? await fetchCommitRelation(newest.commit, currentCommit) : null;
  return buildUpdateView({ currentCommit, feed, updater, relation });
}
