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

  it("a second schedule replaces the first", () => {
    let first = 0;
    let second = 0;
    scheduleRefreshNudges(() => {
      first += 1;
    }, { intervalMs: 200, durationMs: 5_000 });
    vi.advanceTimersByTime(200);
    expect(first).toBe(1);
    scheduleRefreshNudges(() => {
      second += 1;
    }, { intervalMs: 200, durationMs: 600 });
    vi.advanceTimersByTime(600);
    expect(first).toBe(1);
    expect(second).toBe(3);
    vi.advanceTimersByTime(5_000);
    expect(first).toBe(1);
    expect(second).toBe(3);
  });
});
