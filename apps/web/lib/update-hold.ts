/**
 * The update hold: taken by the updater right before it swaps the web container, so
 * nothing new starts executing while it waits for running tasks to end. Queued runs
 * stay queued and run on the new version. The hold dies with this process (the swap
 * replaces it) and expires on its own if the updater never comes back.
 *
 * Kept on globalThis: Next bundles route handlers and the instrumentation worker
 * separately, so plain module state would not be shared between them.
 */
export const UPDATE_HOLD_MAX_MS = 40 * 60 * 1000;

interface HoldState {
  startedAt: number;
  until: number;
}

const KEY = Symbol.for("mediary-scout.update-hold");

function slot(): { hold: HoldState | null } {
  const store = globalThis as typeof globalThis & { [KEY]?: { hold: HoldState | null } };
  store[KEY] ??= { hold: null };
  return store[KEY];
}

/** Take or refresh the hold. A refresh keeps the original start time. */
export function setUpdateHold(now: number, ms: number = UPDATE_HOLD_MAX_MS): void {
  const current = slot().hold;
  const until = now + Math.min(Math.max(ms, 0), UPDATE_HOLD_MAX_MS);
  const startedAt = current && current.until > now ? current.startedAt : now;
  slot().hold = { startedAt, until };
}

export function clearUpdateHold(): void {
  slot().hold = null;
}

export function isUpdateHoldActive(now: number): boolean {
  const hold = slot().hold;
  return Boolean(hold && hold.until > now);
}

/** When the active hold was taken, or null when there is none. */
export function updateHoldStartedAt(now: number): number | null {
  const hold = slot().hold;
  return hold && hold.until > now ? hold.startedAt : null;
}
