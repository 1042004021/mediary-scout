import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  refresh: vi.fn(),
  schedules: 0,
}));

vi.mock("react", () => ({
  useState: () => [0, () => undefined] as const,
  useRef: (init: unknown) => ({ current: init }),
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (fn: () => void | (() => void)) => {
    const cleanup = fn();
    if (typeof cleanup === "function") h.cleanups.push(cleanup);
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));

vi.mock("./refresh-nudge", () => ({
  scheduleRefreshNudges: () => {
    h.schedules += 1;
    return () => undefined;
  },
}));

import { useRouter } from "./use-router";

describe("useRouter", () => {
  afterEach(() => {
    h.cleanups.length = 0;
    h.refresh.mockClear();
    h.schedules = 0;
  });

  it("refreshes after unmount without starting another nudge schedule", () => {
    const router = useRouter();
    router.refresh();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.schedules).toBe(1);

    for (const cleanup of h.cleanups) cleanup();

    router.refresh();
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.schedules).toBe(1);
  });
});
