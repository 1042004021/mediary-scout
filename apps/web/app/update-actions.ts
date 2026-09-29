"use server";

import { isDemoMode } from "../lib/demo-mode";
import { invalidateReleaseFeedCache } from "../lib/release-feed-server";
import { resolveCurrentIsOwner } from "../lib/settings-attention-server";
import { loadUpdateView } from "../lib/update-view-server";
import { requestUpdate } from "../lib/updater-client";

const REASON_TEXT = {
  no_updater: "一键更新需要先完成一次手动升级（见下方命令）。",
  busy: "已经在更新了。",
  needs_recovery: "上次更新回退没成功，请先在部署目录运行 ./scripts/deploy.sh 恢复，再更新。",
  bad_tag: "这个版本不是可更新的新版本，刷新页面再试。",
  unreachable: "连不上更新助手，稍后再试。",
} as const;

export async function startUpdateAction(
  tag: string,
): Promise<{
  ok: boolean;
  message: string;
  reason?: "no_updater" | "busy" | "needs_recovery" | "bad_tag" | "unreachable" | "denied" | "stale";
}> {
  if (isDemoMode() || !(await resolveCurrentIsOwner()))
    return { ok: false, message: "没有权限。", reason: "denied" };
  // Only the release the view itself offers — never an arbitrary string from the client,
  // and never an older tag (that would be a downgrade).
  const offered = (await loadUpdateView()).available?.tag;
  if (!offered || offered !== tag) return { ok: false, message: REASON_TEXT.bad_tag, reason: "stale" };
  const result = await requestUpdate(offered);
  return result.ok
    ? { ok: true, message: "已开始更新。" }
    : { ok: false, message: REASON_TEXT[result.reason], reason: result.reason };
}

let lastManualCheck = 0;

/** 「检查更新」: drop the cached release list so the next render asks GitHub again.
 *  At most once a minute: a refill costs up to 11 GitHub calls, and anonymous calls
 *  are limited to 60 an hour per IP. */
export async function checkForUpdatesAction(): Promise<void> {
  if (isDemoMode() || !(await resolveCurrentIsOwner())) return;
  if (Date.now() - lastManualCheck < 60_000) return;
  lastManualCheck = Date.now();
  invalidateReleaseFeedCache();
}
