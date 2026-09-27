import { describe, expect, it } from "vitest";
import { createKeepUndo, type KeepToast, type KeepUndoDeps } from "./keep-undo";
import type { PendingRow } from "./user-message-state";

const E24: PendingRow = { episode: "S01E24", messageId: "msg_a", requestedAt: "2026-09-27T06:31:00.000Z" };
const E13: PendingRow = { episode: "S01E13", messageId: "msg_b", requestedAt: "2026-09-26T06:31:00.000Z" };

/** A deferred promise the test settles by hand: the server action's answer. */
function answer() {
  let settle!: (message: string | null) => void;
  const promise = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** Lets every settled promise run its callbacks. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The card around the module: what the page draws, the toast, the error line, the
 *  calls to the two actions, and a clock the test moves by hand. */
function harness() {
  const kept = new Set<string>();
  const log: string[] = [];
  let toast: KeepToast | null = null;
  let error: string | null = null;
  let refreshes = 0;
  const commits: Array<{ episodes: string[]; settle: (message: string | null) => void }> = [];
  const restores: Array<{ rows: PendingRow[]; settle: (message: string | null) => void }> = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  let nextTimer = 1;
  const deps: KeepUndoDeps = {
    commit: (episodes) => {
      const a = answer();
      commits.push({ episodes, settle: a.settle });
      log.push(`commit ${episodes.join(",")}`);
      return a.promise;
    },
    restore: (rows) => {
      const a = answer();
      restores.push({ rows, settle: a.settle });
      log.push(`restore ${rows.map((r) => r.episode).join(",")}`);
      return a.promise;
    },
    hide: (episodes) => episodes.forEach((e) => kept.add(e)),
    show: (episodes) => episodes.forEach((e) => kept.delete(e)),
    toast: (t) => {
      toast = t;
    },
    error: (message) => {
      error = message;
    },
    refresh: () => {
      refreshes += 1;
    },
    undoMs: 6000,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return {
    keeper: createKeepUndo(deps),
    kept,
    log,
    commits,
    restores,
    advance,
    get toast() {
      return toast;
    },
    get error() {
      return error;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

describe("不换了 and its 撤销 (C10: save at once, undo restores)", () => {
  it("不换了 saves at once — not after the undo window — and shows the undo toast", () => {
    const h = harness();

    expect(h.keeper.keep({ rows: [E24], text: "E24 不换了，恢复成已获取", busy: false })).toBe(true);

    // Sent right away: leaving the page inside the window can no longer lose it.
    expect(h.log).toEqual(["commit S01E24"]);
    expect([...h.kept]).toEqual(["S01E24"]);
    expect(h.toast).toMatchObject({ episodes: ["S01E24"], text: "E24 不换了，恢复成已获取" });
    expect(h.error).toBeNull();
  });

  it("撤销 puts the 待换 rows back as they were, and the page draws them 待换 again", async () => {
    const h = harness();
    h.keeper.keep({ rows: [E24, E13], text: "t", busy: false });
    h.commits[0]!.settle(null);
    await flush();

    const undone = h.keeper.undo();
    expect(h.toast).toBeNull();
    await flush();
    // Same message, same time: the rows are not re-requested now.
    expect(h.restores.map((r) => r.rows)).toEqual([[E24, E13]]);
    // Still drawn kept until the server has them back.
    expect([...h.kept].sort()).toEqual(["S01E13", "S01E24"]);

    h.restores[0]!.settle(null);
    await undone;
    expect([...h.kept]).toEqual([]);
    expect(h.refreshes).toBe(1);
    expect(h.error).toBeNull();
  });

  it("a keep that fails to save draws the episodes 待换 again, closes the toast and says why", async () => {
    const h = harness();
    h.keeper.keep({ rows: [E24], text: "t", busy: false });

    h.commits[0]!.settle("「不换了」没保存上，再点一次试试");
    await flush();

    expect([...h.kept]).toEqual([]);
    expect(h.toast).toBeNull();
    expect(h.error).toBe("「不换了」没保存上，再点一次试试");
    // Nothing was saved, so nothing is left to undo.
    await h.keeper.undo();
    expect(h.restores).toHaveLength(0);
  });

  it("an undo that fails says so and leaves the episodes kept, as the server has them", async () => {
    const h = harness();
    h.keeper.keep({ rows: [E24], text: "t", busy: false });
    h.commits[0]!.settle(null);
    await flush();

    const undone = h.keeper.undo();
    await flush();
    h.restores[0]!.settle("撤销没成功，先按不换了算。还想换就再留一条");
    await undone;

    expect(h.error).toBe("撤销没成功，先按不换了算。还想换就再留一条");
    expect([...h.kept]).toEqual(["S01E24"]);
    // The server's own render takes over from here.
    expect(h.refreshes).toBe(1);
    h.keeper.viewChanged();
    expect([...h.kept]).toEqual([]);
  });

  it("is refused while a replace run of the work is processing: its bookkeeping would put the episode back", () => {
    const h = harness();

    expect(h.keeper.keep({ rows: [E24], text: "t", busy: true })).toBe(false);

    expect(h.log).toEqual([]);
    expect([...h.kept]).toEqual([]);
    expect(h.toast).toBeNull();
  });

  it("撤销 waits for a save still in flight before putting the rows back (the delete must not land last)", async () => {
    const h = harness();
    h.keeper.keep({ rows: [E24], text: "t", busy: false });

    const undone = h.keeper.undo();
    await flush();
    expect(h.restores).toHaveLength(0);

    h.commits[0]!.settle(null);
    await flush();
    expect(h.log).toEqual(["commit S01E24", "restore S01E24"]);
    h.restores[0]!.settle(null);
    await undone;
    expect([...h.kept]).toEqual([]);
  });

  it("after six seconds the toast closes, the page refreshes, and the next fresh render takes over", async () => {
    const h = harness();
    h.keeper.keep({ rows: [E24], text: "t", busy: false });
    h.commits[0]!.settle(null);
    await flush();
    // No refresh while 撤销 is still possible: the page already draws the keep.
    expect(h.refreshes).toBe(0);

    h.advance(5999);
    expect(h.toast).not.toBeNull();
    h.advance(1);
    expect(h.toast).toBeNull();
    expect(h.refreshes).toBe(1);
    expect([...h.kept]).toEqual(["S01E24"]);

    h.keeper.viewChanged();
    expect([...h.kept]).toEqual([]);
    await h.keeper.undo();
    expect(h.restores).toHaveLength(0);
  });

  it("a fresh render inside the undo window leaves the page drawing the keep", async () => {
    const h = harness();
    h.keeper.keep({ rows: [E24], text: "t", busy: false });
    h.commits[0]!.settle(null);
    await flush();

    h.keeper.viewChanged();

    expect([...h.kept]).toEqual(["S01E24"]);
    expect(h.toast).not.toBeNull();
  });

  it("a save slower than the undo window hands over once it lands", async () => {
    const h = harness();
    h.keeper.keep({ rows: [E24], text: "t", busy: false });
    h.advance(6000);
    expect(h.toast).toBeNull();
    expect(h.refreshes).toBe(0);

    h.commits[0]!.settle(null);
    await flush();
    expect(h.refreshes).toBe(1);
    h.keeper.viewChanged();
    expect([...h.kept]).toEqual([]);
  });

  it("a second 不换了 ends the first one's undo window; the first stays saved", async () => {
    const h = harness();
    h.keeper.keep({ rows: [E24], text: "first", busy: false });
    h.commits[0]!.settle(null);
    await flush();

    h.keeper.keep({ rows: [E13], text: "second", busy: false });

    expect(h.toast).toMatchObject({ text: "second", episodes: ["S01E13"] });
    expect(h.log).toEqual(["commit S01E24", "commit S01E13"]);
    // The first keep is past undoing: the next fresh render takes it over; the second
    // is still drawn kept while its own window is open.
    h.keeper.viewChanged();
    expect([...h.kept]).toEqual(["S01E13"]);
    // 撤销 now undoes the second one only.
    h.commits[1]!.settle(null);
    const undone = h.keeper.undo();
    await flush();
    expect(h.restores.map((r) => r.rows)).toEqual([[E13]]);
    h.restores[0]!.settle(null);
    await undone;
  });

  it("撤销 while a save that fails is in flight ends quietly: the episode is 待换, as asked", async () => {
    const h = harness();
    h.keeper.keep({ rows: [E24], text: "t", busy: false });

    const undone = h.keeper.undo();
    h.commits[0]!.settle("「不换了」没保存上，再点一次试试");
    await undone;

    expect([...h.kept]).toEqual([]);
    expect(h.restores).toHaveLength(0);
    expect(h.error).toBeNull();
  });

  it("nothing to keep, nothing sent", () => {
    const h = harness();
    expect(h.keeper.keep({ rows: [], text: "t", busy: false })).toBe(false);
    expect(h.log).toEqual([]);
  });
});
