import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleRefreshNudges } from "./refresh-nudge";

describe("scheduleRefreshNudges", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bumps on each interval until the duration has passed, then stops", () => {
    let bumps = 0;
    scheduleRefreshNudges(() => {
      bumps += 1;
    }, { intervalMs: 200, durationMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    // Ticks at 200, 400, 600 and 800. The tick at 1000 is on the deadline and does not bump.
    expect(bumps).toBe(4);
    vi.advanceTimersByTime(2_000);
    expect(bumps).toBe(4);
  });

  it("cancel stops further bumps", () => {
    let bumps = 0;
    const cancel = scheduleRefreshNudges(() => {
      bumps += 1;
    }, { intervalMs: 200, durationMs: 5_000 });
    vi.advanceTimersByTime(200);
    expect(bumps).toBe(1);
    cancel();
    vi.advanceTimersByTime(5_000);
    expect(bumps).toBe(1);
  });

  it("two schedules run independently — cancelling one does not stop the other", () => {
    let first = 0;
    let second = 0;
    const cancelFirst = scheduleRefreshNudges(() => {
      first += 1;
    }, { intervalMs: 200, durationMs: 1_000 });
    scheduleRefreshNudges(() => {
      second += 1;
    }, { intervalMs: 200, durationMs: 1_000 });
    vi.advanceTimersByTime(200);
    expect(first).toBe(1);
    expect(second).toBe(1);
    cancelFirst();
    vi.advanceTimersByTime(800);
    expect(first).toBe(1);
    expect(second).toBe(4);
    vi.advanceTimersByTime(2_000);
    expect(second).toBe(4);
  });

  it("stops after the wall-clock duration when each tick is delayed", () => {
    let bumps = 0;
    scheduleRefreshNudges(() => {
      bumps += 1;
    }, {
      intervalMs: 200,
      durationMs: 5_000,
      now: () => Date.now(),
      setTimer: (fn) => setTimeout(fn, 1_000),
    });
    vi.advanceTimersByTime(6_000);
    expect(bumps).toBeGreaterThan(0);
    expect(bumps).toBeLessThanOrEqual(5);
    const settled = bumps;
    vi.advanceTimersByTime(10_000);
    expect(bumps).toBe(settled);
  });
});
