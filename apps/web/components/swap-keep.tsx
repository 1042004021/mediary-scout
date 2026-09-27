"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { swapBadgeLabel } from "../lib/user-message-state";

/**
 * 「不换了」 is deferred — six seconds to undo, the way deleting a note works — yet the
 * page must look kept at once: the red 待换 cell back to its own state, the badge gone.
 * The season grid and the badge are server-rendered, so the episodes waiting on a 不换了
 * are shared through this context: the message card adds and removes them, the two
 * small client pieces below read them. Design: docs/superpowers/specs/2026-09-26-user-message-replace-design.md §6.
 */
interface SwapKeepState {
  /** Episodes whose 不换了 is waiting out the undo window, or sent and not yet reflected
   *  by a fresh server render. */
  kept: ReadonlySet<string>;
  add: (episodes: readonly string[]) => void;
  remove: (episodes: readonly string[]) => void;
}

const SwapKeepContext = createContext<SwapKeepState | null>(null);

function useKeptEpisodes(): SwapKeepState {
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const add = useCallback((episodes: readonly string[]) => {
    setKept((prev) => new Set([...prev, ...episodes]));
  }, []);
  const remove = useCallback((episodes: readonly string[]) => {
    setKept((prev) => (episodes.some((e) => prev.has(e)) ? new Set([...prev].filter((e) => !episodes.includes(e))) : prev));
  }, []);
  return useMemo(() => ({ kept, add, remove }), [kept, add, remove]);
}

/** Wraps one work's detail page. Key it by the work: nothing kept on one title may
 *  carry to the next (the App Router reuses components across /show pages). */
export function SwapKeepProvider({ children }: { children: ReactNode }) {
  return <SwapKeepContext.Provider value={useKeptEpisodes()}>{children}</SwapKeepContext.Provider>;
}

/** The page's shared state, for the message card that changes it; a component-local
 *  one when rendered outside the provider (the card still works on its own). */
export function useSwapKeep(): SwapKeepState {
  const local = useKeptEpisodes();
  return useContext(SwapKeepContext) ?? local;
}

const NONE: ReadonlySet<string> = new Set();

/** Read-only: the episodes a 不换了 is waiting on (none outside the provider). */
function useKept(): ReadonlySet<string> {
  return useContext(SwapKeepContext)?.kept ?? NONE;
}

/** 「N 集待换」/「待换资源」 beside the title, less the episodes a 不换了 is waiting on. */
export function SwapBadgeLive({ mediaType, pending }: { mediaType: "movie" | "tv"; pending: readonly string[] }) {
  const kept = useKept();
  const label = swapBadgeLabel(mediaType, kept.size > 0 ? pending.filter((e) => !kept.has(e)) : pending);
  return label ? <span className="hub-badge tone-red">{label}</span> : null;
}

/** A 待换 cell of the season grid. While a 不换了 on it is waiting it is drawn in its
 *  own state again (the file was never touched, so that state is what it is). */
export function SwapEpisodeCell({ code, stateClass, stateLabel }: { code: string; stateClass: string; stateLabel: string }) {
  const kept = useKept();
  const swapping = !kept.has(code);
  return (
    <div className={`episode-cell ${stateClass}${swapping ? " swap" : ""}`} title={swapping ? "你要求换 · 巡检会继续找" : undefined}>
      <strong>{code.replace(/^S\d+/, "")}</strong>
      <span>{swapping ? "待换" : stateLabel}</span>
    </div>
  );
}
