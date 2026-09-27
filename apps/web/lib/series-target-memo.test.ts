import { describe, expect, it } from "vitest";
import { createTtlMemo } from "./series-target-memo";

describe("createTtlMemo", () => {
  it("reuses a successful load until the success TTL", async () => {
    let now = 1_000;
    let loads = 0;
    const get = createTtlMemo<{ id: number }>({
      now: () => now,
      successTtlMs: 50,
      failureTtlMs: 10,
      load: async (key) => {
        loads += 1;
        return { id: key };
      },
    });
    expect(await get(7)).toEqual({ id: 7 });
    expect(await get(7)).toEqual({ id: 7 });
    expect(loads).toBe(1);
    now += 50;
    expect(await get(7)).toEqual({ id: 7 });
    expect(loads).toBe(2);
  });

  it("does not call the loader again while a miss is fresh", async () => {
    let now = 1_000;
    let loads = 0;
    const get = createTtlMemo<string>({
      now: () => now,
      successTtlMs: 50,
      failureTtlMs: 10,
      load: async () => {
        loads += 1;
        return null;
      },
    });
    expect(await get(9)).toBeNull();
    expect(await get(9)).toBeNull();
    expect(loads).toBe(1);
    now += 10;
    expect(await get(9)).toBeNull();
    expect(loads).toBe(2);
  });

  it("returns the last success when a refetch fails, and does not retry during the miss TTL", async () => {
    let now = 1_000;
    let mode: "ok" | "null" | "throw" = "ok";
    let loads = 0;
    const get = createTtlMemo<{ id: number }>({
      now: () => now,
      successTtlMs: 50,
      failureTtlMs: 10,
      load: async (key) => {
        loads += 1;
        if (mode === "throw") throw new Error("tmdb down");
        if (mode === "null") return null;
        return { id: key };
      },
    });
    expect(await get(4)).toEqual({ id: 4 });
    now += 50;
    mode = "throw";
    expect(await get(4)).toEqual({ id: 4 });
    expect(loads).toBe(2);
    expect(await get(4)).toEqual({ id: 4 });
    expect(loads).toBe(2);
    now += 10;
    mode = "null";
    expect(await get(4)).toEqual({ id: 4 });
    expect(loads).toBe(3);
  });

  it("returns null when a failing load has no prior success", async () => {
    let loads = 0;
    const get = createTtlMemo<string>({
      successTtlMs: 50,
      failureTtlMs: 10_000,
      load: async () => {
        loads += 1;
        throw new Error("tmdb down");
      },
    });
    await expect(get(1)).resolves.toBeNull();
    await expect(get(1)).resolves.toBeNull();
    expect(loads).toBe(1);
  });

  it("shares one load across concurrent callers", async () => {
    let loads = 0;
    let release: () => void = () => undefined;
    const get = createTtlMemo<{ ok: true; key: number }>({
      successTtlMs: 50,
      failureTtlMs: 10,
      load: (key) => {
        loads += 1;
        return new Promise<void>((resolve) => {
          release = () => resolve();
        }).then(() => ({ ok: true as const, key }));
      },
    });
    const first = get(3);
    const second = get(3);
    expect(loads).toBe(1);
    release();
    await expect(first).resolves.toEqual({ ok: true, key: 3 });
    await expect(second).resolves.toEqual({ ok: true, key: 3 });
    expect(loads).toBe(1);
  });
});
