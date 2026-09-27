"use client";

import { useState, type ReactNode } from "react";

/**
 * A season row's disclosure on the detail page. A season holding 待换 episodes starts
 * open, so the red cells show without a click. Open-ness is read once: after that the
 * row is the user's — a refresh that clears the last 待换 (the page refreshes itself
 * while a run is in flight) must not snap it shut under them.
 */
export function SeasonDetails({ initiallyOpen, children }: { initiallyOpen: boolean; children: ReactNode }) {
  const [open] = useState(initiallyOpen);
  return (
    <details className="hub-season-details" open={open}>
      {children}
    </details>
  );
}
