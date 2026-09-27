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
    expect(bumps).toBe(5);
    vi.advanceTimersByTime(2_000);
    expect(bumps).toBe(5);
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
    expect(second).toBe(5);
    vi.advanceTimersByTime(2_000);
    expect(second).toBe(5);
  });
});
