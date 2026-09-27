"use client";

import { useState, type ReactNode } from "react";

/**
 * A season row's disclosure on the detail page. A season holding 待换 episodes starts
 * open, so the red cells show without a click. After that the row is the user's: every
 * toggle is kept in state, so a re-render (a refresh that clears the last 待换 while a
 * run is in flight, or 不换了 updating the shared context) renders what the user chose
 * instead of snapping it back.
 */
export function SeasonDetails({ initiallyOpen, children }: { initiallyOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details className="hub-season-details" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      {children}
    </details>
  );
}
