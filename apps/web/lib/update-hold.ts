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

interface Slot {
  hold: HoldState | null;
  /** Work in this process that must finish before a swap: a worker tick (claiming and
   *  reserving runs) or a patrol (reservations, staging cleanup). */
  inFlight: number;
}

const KEY = Symbol.for("mediary-scout.update-hold");

function slot(): Slot {
  const store = globalThis as typeof globalThis & { [KEY]?: Slot };
  store[KEY] ??= { hold: null, inFlight: 0 };
  store[KEY].inFlight ??= 0;
  return store[KEY];
}

/** Count `work` as in flight until it settles. /api/update/busy reports busy meanwhile,
 *  so a swap never lands between a "may I start?" check and the database write it
 *  guards, or in the middle of a staging cleanup. */
export async function whileInFlight<T>(work: () => Promise<T>): Promise<T> {
  slot().inFlight += 1;
  try {
    return await work();
  } finally {
    slot().inFlight -= 1;
  }
}

export function inFlightCount(): number {
  return slot().inFlight;
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
