import { describe, expect, it } from "vitest";
import {
  Pan115ApiGuard,
  Pan115RiskControlError,
  PAN115_TRANSFER_RESERVE_CALLS,
  Storage115Executor,
  createBootstrapPan115CookieStorageExecutor,
  createProtectedStorage115Executor,
  budgetSoftThreshold,
  BUDGET_SOFT_HEADROOM,
  type Pan115StorageApi,
} from "../src/index.js";

/** Spend `n` listing calls (never transfer-class). */
async function spendListings(guard: Pan115ApiGuard, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await guard.run("listItems", async () => []);
  }
}

const HARNESS_RESERVE = 5;

describe("Pan115ApiGuard harness reserve (清理额度 agent 花不掉)", () => {
  it("refuses normal calls once callCount reaches hard − harnessReserve, and does not count the refusal", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 10, harnessReserveCalls: 3 });
    expect(guard.callBudget()).toBe(7);
    await spendListings(guard, 7);
    await expect(guard.run("listItems", async () => [])).rejects.toThrow(Pan115RiskControlError);
    await expect(guard.run("moveItems", async () => ({ ok: true, message: "" }))).rejects.toThrow(
      /API call budget exhausted before moveItems; maxCallsPerOperation=7/,
    );
    expect(guard.callsSpent()).toBe(7);
  });

  it("calls inside the harness scope may use the reserve up to the hard limit", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 10, harnessReserveCalls: 3 });
    await spendListings(guard, 7);
    const scoped = (guard as { withCleanupBudget?: <T>(fn: () => Promise<T>) => Promise<T> }).withCleanupBudget;
    expect(scoped).toEqual(expect.any(Function));
    await scoped!.call(guard, async () => {
      await guard.run("getDirectoryInfo", async () => null);
      await guard.run("deleteItems", async () => ({ ok: true, message: "" }));
      await guard.run("listItems", async () => []);
    });
    expect(guard.callsSpent()).toBe(10);
    await expect(
      scoped!.call(guard, () => guard.run("listItems", async () => [])),
    ).rejects.toThrow(/maxCallsPerOperation=10/);
    expect(guard.callsSpent()).toBe(10);
  });

  it("keeps the transfer reserve: transfers still stop at hard − transferReserve, listings continue to the agent wall", async () => {
    const guard = new Pan115ApiGuard({
      maxCallsPerOperation: 10,
      transferReserveCalls: 4,
      harnessReserveCalls: 2,
    });
    expect(guard.transferCallBudget()).toBe(6);
    expect(guard.callBudget()).toBe(8);
    await spendListings(guard, 6);
    await expect(guard.run("receiveShare", async () => ({ ok: true, message: "" }))).rejects.toThrow(
      /transfer budget exhausted before receiveShare/,
    );
    await expect(guard.run("addOfflineTask", async () => ({ ok: true, message: "" }))).rejects.toThrow(
      Pan115RiskControlError,
    );
    expect(guard.callsSpent()).toBe(6);
    await guard.run("moveItems", async () => ({ ok: true, message: "" }));
    await guard.run("deleteItems", async () => ({ ok: true, message: "" }));
    expect(guard.callsSpent()).toBe(8);
    await expect(guard.run("listItems", async () => [])).rejects.toThrow(/maxCallsPerOperation=8/);
  });

  it("a zero harness reserve is the old hard cap (listings run up to it)", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 3 });
    expect(guard.callBudget()).toBe(3);
    await spendListings(guard, 3);
    await expect(guard.run("listItems", async () => [])).rejects.toThrow(/maxCallsPerOperation=3/);
  });
});

describe("115 factories wire the harness reserve into the agent-facing budget", () => {
  it("createProtectedStorage115Executor: agent wall is hard − 5, transfer stop stays hard − transfer reserve, soft warning tracks the agent wall", () => {
    const executor = createProtectedStorage115Executor({
      api: {} as Pan115StorageApi,
      env: {
        MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
        MEDIA_TRACK_115_MIN_DELAY_MS: "1",
      },
    });
    expect(executor.apiCallBudget()).toBe(300 - HARNESS_RESERVE);
    expect(executor.apiTransferCallBudget()).toBe(300 - PAN115_TRANSFER_RESERVE_CALLS);
    expect(budgetSoftThreshold(executor.apiCallBudget())).toBe(300 - HARNESS_RESERVE - BUDGET_SOFT_HEADROOM);
    expect(budgetSoftThreshold(executor.apiCallBudget())).toBeLessThan(executor.apiTransferCallBudget());
  });

  it("createBootstrapPan115CookieStorageExecutor carries the same agent wall (kept in sync)", () => {
    const executor = createBootstrapPan115CookieStorageExecutor({ cookie: "UID=1_abc" });
    expect(executor.apiCallBudget()).toBe(300 - HARNESS_RESERVE);
    expect(executor.apiTransferCallBudget()).toBe(300 - PAN115_TRANSFER_RESERVE_CALLS);
  });

  it("Storage115Executor.withCleanupBudget spends the reserve the agent was refused", async () => {
    const calls: string[] = [];
    const api = {
      async listItems() {
        calls.push("list");
        return [];
      },
      async getDirectoryInfo() {
        calls.push("info");
        return { state: true, path: [{ cid: "root", name: "root" }, { cid: "stg", name: "staging" }] };
      },
      async deleteItems() {
        calls.push("delete");
        return { ok: true, message: "" };
      },
      async createFolder() {
        return "id";
      },
      async receiveShare() {
        return { ok: true, message: "" };
      },
      async addOfflineTask() {
        return { ok: true, message: "" };
      },
      async removeOfflineTask() {
        return { ok: true, message: "" };
      },
      async listOfflineTasks() {
        return [];
      },
      async moveItems() {
        return { ok: true, message: "" };
      },
      async renameFile() {
        return { ok: true, message: "" };
      },
    } satisfies Pan115StorageApi;
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 5, harnessReserveCalls: 3, minDelayMs: 0 });
    const executor = new Storage115Executor({
      api,
      apiGuard: guard,
      writeScopeDirectoryIds: ["root"],
    });
    expect(executor.apiCallBudget()).toBe(2);
    await guard.run("listItems", async () => []);
    await guard.run("listItems", async () => []);
    await expect(executor.listChildDirectories("show")).rejects.toThrow(/maxCallsPerOperation=2/);

    const removed = await executor.withCleanupBudget(() => executor.removeDirectory("stg"));
    const children = await executor.withCleanupBudget(() => executor.listChildDirectories("show"));
    expect(removed).toEqual({ removed: true });
    expect(children).toEqual([]);
    // The two listings that filled the agent wall went through guard.run's own
    // callback, not this api — the reserve is what paid for info + delete + the
    // read-back listing.
    expect(guard.callsSpent()).toBe(5);
    expect(calls).toEqual(["info", "delete", "list"]);
  });
});
