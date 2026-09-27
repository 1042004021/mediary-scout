/**
 * 「不换了」 and its 撤销 on the detail page's message card, kept apart from React so the
 * sequence is unit-tested with a hand-moved clock and hand-settled actions.
 *
 * The keep is saved AT ONCE; for six seconds 撤销 puts the 待换 rows back exactly as
 * they were (same message, same time). An earlier version waited out the undo window
 * before saving and sent a waiting keep when the page went away — but that send ran
 * after an in-app navigation, posted to the new route, and was lost (review C10-C1).
 *
 * While a keep is on screen the page draws its episodes kept (the 待换 cell, the badge,
 * the reply row) through hide/show; once the undo window is over, the next fresh server
 * render takes over. No refresh is asked for while 撤销 is still possible: the page
 * already shows the keep, and a refresh landing after a quick 撤销 would flash it back.
 * Design: docs/superpowers/specs/2026-09-26-user-message-replace-design.md §6.
 */
import type { PendingRow } from "./user-message-state";

export interface KeepToast {
  id: number;
  episodes: string[];
  text: string;
}

export interface KeepUndoDeps {
  /** Saves the keep (keepEpisodesAsIsAction): null when saved, else the card's error line. */
  commit(episodes: string[]): Promise<string | null>;
  /** Puts the rows back (restoreEpisodesToPendingAction): null when done, else the card's error line. */
  restore(rows: PendingRow[]): Promise<string | null>;
  /** Draw these episodes kept on the page / as the server's render has them again. */
  hide(episodes: string[]): void;
  show(episodes: string[]): void;
  toast(toast: KeepToast | null): void;
  error(message: string | null): void;
  /** Ask for a fresh server render (router.refresh). */
  refresh(): void;
  undoMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface KeepUndo {
  /** 「不换了」 on these rows. False (nothing happens) when there is nothing to keep, or a
   *  replace run of the work is processing (`busy`): its end-of-run bookkeeping would put
   *  the episode back as 待换 and silently undo the choice. */
  keep(input: { rows: PendingRow[]; text: string; busy: boolean }): boolean;
  /** 撤销 on the toast. */
  undo(): Promise<void>;
  /** A fresh server render arrived. */
  viewChanged(): void;
}

interface Keep {
  id: number;
  rows: PendingRow[];
  episodes: string[];
  open: boolean;
  timer: unknown;
  undone: boolean;
  /** null while the save is in flight. */
  saved: boolean | null;
  /** The save's answer: null when saved, else the error line. */
  answer: Promise<string | null>;
}

/** The card's error line when the keep was not saved (the episodes are 待换 again). */
export const KEEP_SAVE_FAILED = "「不换了」没保存上，再点一次试试";
/** The card's error line when 撤销 did not go through (the episodes stay kept). */
export const KEEP_UNDO_FAILED = "撤销没成功，先按不换了算。还想换就再留一条";

export function createKeepUndo(deps: KeepUndoDeps): KeepUndo {
  let seq = 0;
  /** The keep whose undo window is open (its toast is on screen). */
  let current: Keep | null = null;
  /** Episodes saved as kept and past undoing: the next fresh render draws them. */
  let handOver: string[] = [];

  const settle = (k: Keep) => {
    handOver = [...handOver, ...k.episodes];
    deps.refresh();
  };

  const closeWindow = (k: Keep) => {
    if (!k.open) return;
    k.open = false;
    deps.clearTimer(k.timer);
    if (current === k) {
      current = null;
      deps.toast(null);
    }
    if (k.saved === true && !k.undone) settle(k);
  };

  return {
    keep({ rows, text, busy }) {
      if (busy || rows.length === 0) return false;
      // One undo at a time: a second 不换了 ends the first one's window (it stays saved).
      if (current) closeWindow(current);
      const episodes = rows.map((r) => r.episode);
      const k: Keep = {
        id: ++seq,
        rows,
        episodes,
        open: true,
        timer: null,
        undone: false,
        saved: null,
        answer: deps.commit(episodes).catch(() => KEEP_SAVE_FAILED),
      };
      current = k;
      deps.error(null);
      deps.hide(episodes);
      deps.toast({ id: k.id, episodes, text });
      k.timer = deps.setTimer(() => closeWindow(k), deps.undoMs);
      void k.answer.then((message) => {
        k.saved = message === null;
        if (message !== null) {
          // Still 待换 on the server: draw it so again; there is nothing left to undo.
          // After 撤销 that is just what was asked for, so no error then.
          closeWindow(k);
          deps.show(episodes);
          if (!k.undone) deps.error(message);
          return;
        }
        // Saved after the window closed (a slow save): hand over now.
        if (!k.open && !k.undone) settle(k);
      });
      return true;
    },

    async undo() {
      const k = current;
      if (!k || !k.open) return;
      k.undone = true;
      closeWindow(k);
      // Never put the rows back before the delete has landed.
      if ((await k.answer) !== null) return;
      const message = await deps.restore(k.rows).catch(() => KEEP_UNDO_FAILED);
      if (message === null) {
        deps.show(k.episodes);
        deps.refresh();
        return;
      }
      // The server still has them kept: say so, and let its render take over.
      deps.error(message);
      settle(k);
    },

    viewChanged() {
      if (handOver.length === 0) return;
      const episodes = handOver;
      handOver = [];
      deps.show(episodes);
    },
  };
}
