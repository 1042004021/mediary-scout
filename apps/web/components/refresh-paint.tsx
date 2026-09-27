"use client";

import { useEffect, useState } from "react";
import { isCurrentPageRsc } from "../lib/refresh-paint";

/** router.refresh() writes the new RSC into the segment cache, then Next paints
 *  it from a deferred render (layout-router `useDeferredValue`). On a quiet
 *  title page that follow-up render often never runs until the next unrelated
 *  setState — the 活动 badge's 5s poll — so the new UI sits ready for ~4s.
 *  Painting when this page's own RSC body has arrived commits it immediately. */
export function RefreshPaint() {
  const [, bump] = useState(0);
  useEffect(() => {
    const orig = window.fetch.bind(window);
    let scheduled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const paint = () => {
      if (scheduled) return;
      scheduled = true;
      // After the flight client has applied the body (same task + a follow-up
      // turn). One bump is enough once the cache promise is fulfilled.
      timer = setTimeout(() => {
        scheduled = false;
        bump((n) => n + 1);
      }, 0);
    };
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const pending = orig(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!isCurrentPageRsc(location.pathname, url)) return pending;
      return pending.then((response) => {
        try {
          void response.clone().arrayBuffer().then(paint, paint);
        } catch {
          paint();
        }
        return response;
      });
    };
    return () => {
      window.fetch = orig;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return null;
}
