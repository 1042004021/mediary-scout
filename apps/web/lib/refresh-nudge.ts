type TimerId = ReturnType<typeof setTimeout>;

/**
 * Call `bump` every `intervalMs` (default 200) until `durationMs` (default
 * 5000) of wall-clock time has passed. A tick that fires before the deadline
 * still bumps; one that fires on or after it stops. Returns a cancel function.
 * Each call is its own schedule: cancelling one does not stop another.
 */
export function scheduleRefreshNudges(
  bump: () => void,
  opts?: {
    intervalMs?: number;
    durationMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => TimerId;
    clearTimer?: (id: TimerId) => void;
  },
): () => void {
  const intervalMs = opts?.intervalMs ?? 200;
  const durationMs = opts?.durationMs ?? 5_000;
  const now = opts?.now ?? Date.now;
  const setTimer = opts?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts?.clearTimer ?? ((id) => clearTimeout(id));
  const start = now();
  let timer: TimerId | null = null;
  let stopped = false;
  const cancel = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const tick = () => {
    timer = null;
    if (stopped) return;
    if (now() - start >= durationMs) {
      cancel();
      return;
    }
    bump();
    if (stopped) return;
    timer = setTimer(tick, intervalMs);
  };
  timer = setTimer(tick, intervalMs);
  return cancel;
}
