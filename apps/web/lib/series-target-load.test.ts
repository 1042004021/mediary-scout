import { afterEach, describe, expect, it, vi } from "vitest";

// tmdb-cache (imported by title-hub) marks itself server-only; plain Node has no such package.
// @ts-expect-error Vitest's runtime supports virtual mocks, but its v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });
import type { PreparedSeriesTarget } from "@media-track/workflow";
import type { DurableJsonCache } from "./tmdb-cache";
import { createTtlMemo } from "./series-target-memo";
import { loadSeriesTargetWithCache } from "./title-hub";

const target = { title: { title: "Ok" }, seasons: [], keyword: "Ok" } as unknown as PreparedSeriesTarget;

describe("loadSeriesTargetWithCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the TMDB value and the memo keeps it as a success when the durable write throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let now = 1_000;
    let loads = 0;
    const durable: DurableJsonCache = {
      getJson: async () => null,
      setJson: async () => {
        throw new Error("postgres down");
      },
    };
    const get = createTtlMemo<PreparedSeriesTarget>({
      now: () => now,
      successTtlMs: 50,
      failureTtlMs: 10,
      load: (id) =>
        loadSeriesTargetWithCache(id, durable, async () => {
          loads += 1;
          return target;
        }),
    });

    expect(await get(4)).toEqual(target);
    expect(loads).toBe(1);
    expect(console.error).toHaveBeenCalled();
    now += 10;
    expect(await get(4)).toEqual(target);
    expect(loads).toBe(1);
    now += 40;
    expect(await get(4)).toEqual(target);
    expect(loads).toBe(2);
  });
});
