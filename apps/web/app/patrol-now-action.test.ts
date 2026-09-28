import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const runScheduledType3 = vi.fn();
vi.mock("../lib/workflow-runtime", () => ({
  runScheduledType3: (...args: unknown[]) => runScheduledType3(...args),
}));

import { runPatrolNowAction } from "./actions";

const prevDemo = process.env.MEDIA_TRACK_DEMO_MODE;
afterEach(() => {
  vi.clearAllMocks();
  if (prevDemo === undefined) delete process.env.MEDIA_TRACK_DEMO_MODE;
  else process.env.MEDIA_TRACK_DEMO_MODE = prevDemo;
});

describe("runPatrolNowAction", () => {
  it("says so plainly when an update is holding new runs", async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    runScheduledType3.mockResolvedValue({ skipped: "update_in_progress", outcomes: [] });
    expect(await runPatrolNowAction()).toEqual({ success: false, message: "正在更新，更新完成后再巡检。" });
    expect(runScheduledType3).toHaveBeenCalledWith({ force: true });
  });

  it("reports how many items it checked otherwise", async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    runScheduledType3.mockResolvedValue({ outcomes: [{}, {}] });
    expect(await runPatrolNowAction()).toEqual({ success: true, checked: 2 });
  });
});
