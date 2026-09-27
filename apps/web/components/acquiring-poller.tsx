"use client";

import { useEffect } from "react";
import { useRouter } from "../lib/use-router";

/**
 * The "获取中 / disabled" state is owned by the SERVER (a queued/running
 * workflow run), not by client state — so it survives reloads and a closed
 * browser. This poller is the client's way of learning, without a manual
 * refresh, WHEN the server says the run has finished: while an acquisition is
 * in flight it re-fetches the server view on an interval, and the moment the
 * server stops reporting an active run the parent stops rendering this poller
 * (its effect cleanup clears the timer) and the buttons/placeholder release.
 *
 * Mount it ONLY when the server reports work in flight.
 */
export function AcquiringPoller({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
