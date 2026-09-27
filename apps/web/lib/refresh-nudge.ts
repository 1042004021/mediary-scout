type TimerId = ReturnType<typeof setTimeout>;

/**
 * Call `bump` every `intervalMs` (default 200) until `durationMs` (default
 * 5000) has elapsed, including a bump on the deadline when it lands on an
 * interval. Returns a cancel function. Each call is its own schedule: cancelling
 * one does not stop another.
 */
export function scheduleRefreshNudges(
  bump: () => void,
  opts?: {
    intervalMs?: number;
    durationMs?: number;
    setTimer?: (fn: () => void, ms: number) => TimerId;
    clearTimer?: (id: TimerId) => void;
  },
): () => void {
  const intervalMs = opts?.intervalMs ?? 200;
  const durationMs = opts?.durationMs ?? 5_000;
  const setTimer = opts?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts?.clearTimer ?? ((id) => clearTimeout(id));
  let elapsed = 0;
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
    elapsed += intervalMs;
    if (elapsed > durationMs) {
      cancel();
      return;
    }
    bump();
    if (stopped || elapsed >= durationMs) {
      cancel();
      return;
    }
    timer = setTimer(tick, intervalMs);
  };
  timer = setTimer(tick, intervalMs);
  return cancel;
}
