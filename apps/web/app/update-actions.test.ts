import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("../lib/settings-attention-server", () => ({ resolveCurrentIsOwner: vi.fn(async () => true) }));
vi.mock("../lib/update-view-server", () => ({ loadUpdateView: vi.fn() }));
vi.mock("../lib/updater-client", () => ({ requestUpdate: vi.fn() }));
vi.mock("../lib/release-feed-server", () => ({ invalidateReleaseFeedCache: vi.fn() }));

import { isDemoMode } from "../lib/demo-mode";
import { invalidateReleaseFeedCache } from "../lib/release-feed-server";
import { resolveCurrentIsOwner } from "../lib/settings-attention-server";
import { loadUpdateView } from "../lib/update-view-server";
import { requestUpdate } from "../lib/updater-client";
import { checkForUpdatesAction, startUpdateAction } from "./update-actions";

describe("startUpdateAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
  });

  it("forwards only the tag the current view offers", async () => {
    vi.mocked(loadUpdateView).mockResolvedValue({ available: { tag: "v2026.10.02" } } as never);
    vi.mocked(requestUpdate).mockResolvedValue({ ok: true });
    expect(await startUpdateAction("v2026.09.28")).toEqual({
      ok: false,
      message: "这个版本不是可更新的新版本，刷新页面再试。",
      reason: "stale",
    });
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(await startUpdateAction("v2026.10.02")).toEqual({ ok: true, message: "已开始更新。" });
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    expect(requestUpdate).toHaveBeenCalledWith("v2026.10.02");
  });

  it("marks the demo and non-owner refusals as denied", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    expect(await startUpdateAction("v2026.10.02")).toEqual({
      ok: false,
      message: "没有权限。",
      reason: "denied",
    });
    expect(loadUpdateView).not.toHaveBeenCalled();
    expect(resolveCurrentIsOwner).not.toHaveBeenCalled();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(false);
    expect(await startUpdateAction("v2026.10.02")).toEqual({
      ok: false,
      message: "没有权限。",
      reason: "denied",
    });
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("passes the updater's own reason through with its text", async () => {
    vi.mocked(loadUpdateView).mockResolvedValue({ available: { tag: "v2026.10.02" } } as never);
    for (const [reason, message] of [
      ["busy", "已经在更新了。"],
      ["no_updater", "一键更新需要先完成一次手动升级（见下方命令）。"],
      ["needs_recovery", "上次更新回退没成功，请先在部署目录运行 ./scripts/deploy.sh 恢复，再更新。"],
      ["bad_tag", "这个版本不是可更新的新版本，刷新页面再试。"],
      ["unreachable", "连不上更新助手，稍后再试。"],
    ] as const) {
      vi.mocked(requestUpdate).mockResolvedValue({ ok: false, reason });
      expect(await startUpdateAction("v2026.10.02")).toEqual({ ok: false, message, reason });
    }
  });
});

describe("checkForUpdatesAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
  });

  it("drops the cached release list at most once a minute", async () => {
    const now = vi.spyOn(Date, "now");
    let clock = 1_700_000_000_000;
    now.mockImplementation(() => clock);
    await checkForUpdatesAction();
    await checkForUpdatesAction();
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await checkForUpdatesAction();
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(2);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(false);
    clock += 61_000;
    await checkForUpdatesAction();
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
});
