import { afterEach, describe, expect, it } from "vitest";
import {
  UPDATE_HOLD_MAX_MS,
  clearUpdateHold,
  isUpdateHoldActive,
  setUpdateHold,
  updateHoldStartedAt,
} from "./update-hold";

afterEach(() => clearUpdateHold());

describe("update hold", () => {
  it("is off until taken, and off again once released", () => {
    expect(isUpdateHoldActive(1_000)).toBe(false);
    setUpdateHold(1_000, 60_000);
    expect(isUpdateHoldActive(1_000)).toBe(true);
    expect(updateHoldStartedAt(1_000)).toBe(1_000);
    clearUpdateHold();
    expect(isUpdateHoldActive(1_000)).toBe(false);
    expect(updateHoldStartedAt(1_000)).toBeNull();
  });

  it("expires on its own", () => {
    setUpdateHold(1_000, 60_000);
    expect(isUpdateHoldActive(60_999)).toBe(true);
    expect(isUpdateHoldActive(61_000)).toBe(false);
    expect(updateHoldStartedAt(61_000)).toBeNull();
  });

  it("caps the length at 40 minutes", () => {
    setUpdateHold(0, 10 * UPDATE_HOLD_MAX_MS);
    expect(isUpdateHoldActive(UPDATE_HOLD_MAX_MS - 1)).toBe(true);
    expect(isUpdateHoldActive(UPDATE_HOLD_MAX_MS)).toBe(false);
  });

  it("keeps the first start time when refreshed, and starts over after it expired", () => {
    setUpdateHold(1_000, 60_000);
    setUpdateHold(30_000, 60_000);
    expect(updateHoldStartedAt(30_000)).toBe(1_000);
    expect(isUpdateHoldActive(80_000)).toBe(true);
    setUpdateHold(200_000, 60_000);
    expect(updateHoldStartedAt(200_000)).toBe(200_000);
  });

  it("is shared through globalThis, so separately bundled modules see the same hold", async () => {
    setUpdateHold(5_000, 60_000);
    const store = globalThis as unknown as Record<symbol, { hold: unknown } | undefined>;
    expect(store[Symbol.for("mediary-scout.update-hold")]?.hold).toEqual({ startedAt: 5_000, until: 65_000 });
  });
});
