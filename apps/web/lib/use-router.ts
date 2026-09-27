"use client";

import { useRouter as useNextRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { scheduleRefreshNudges } from "./refresh-nudge";

/**
 * Workaround for facebook/react#35821: `useDeferredValue` gets stuck on a stale
 * value when the update suspends (`use()` + Suspense). Next's layout router
 * does exactly that — `useDeferredValue(cacheNode.rsc, …)` — so `router.refresh()`
 * can write the new RSC and then never paint it. facebook/react#36134
 * (c0d218f, 2026-03-24) fixes it. Next 16.2.9 bundles React
 * 19.3.0-canary-3f0b9e61-20260317, which is before that fix. The fix is in
 * Next 16.3.x, but 16.3.5 has an open report that `router.refresh()` silently
 * no-ops on streamed pages in production (vercel/next.js#99027).
 *
 * Delete this wrapper once we run a Next release whose bundled React includes
 * react#36134 and whose router.refresh works on streamed pages.
 * A later React state update retries the stuck deferred render (a rAF does
 * not). After `refresh()`, nudge the calling component for a few seconds.
 *
 * Next's router is one object (`window.next.router` is that same object), so
 * the wrap is installed on it. A direct `router.refresh()` — including the
 * harness — nudges every mounted caller of this hook.
 */
type AppRouter = ReturnType<typeof useNextRouter>;

const bumps = new Set<() => void>();
let realRefresh: (() => void) | null = null;
let nudgeCancel: (() => void) | null = null;

function restartNudges() {
  nudgeCancel?.();
  if (bumps.size === 0) {
    nudgeCancel = null;
    return;
  }
  nudgeCancel = scheduleRefreshNudges(() => {
    for (const bump of [...bumps]) bump();
  });
}

function callRealRefresh(router: AppRouter) {
  if (realRefresh) {
    realRefresh();
    return;
  }
  router.refresh();
}

function ensureWrapped(router: AppRouter) {
  if (realRefresh) return;
  const original = router.refresh.bind(router);
  realRefresh = original;
  router.refresh = () => {
    original();
    restartNudges();
  };
}

function restoreRefresh(router: AppRouter) {
  nudgeCancel?.();
  nudgeCancel = null;
  if (realRefresh) {
    router.refresh = realRefresh;
    realRefresh = null;
  }
}

export function useRouter(): AppRouter {
  const router = useNextRouter();
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    bumps.add(bump);
    ensureWrapped(router);
    return () => {
      bumps.delete(bump);
      if (bumps.size === 0) restoreRefresh(router);
    };
  }, [router]);
  return useMemo(
    () => ({
      ...router,
      refresh() {
        callRealRefresh(router);
        restartNudges();
      },
    }),
    [router],
  );
}
