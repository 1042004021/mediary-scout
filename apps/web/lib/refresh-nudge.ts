/** One active nudge schedule. A new schedule cancels the previous one. */
let activeCancel: (() => void) | null = null;

type TimerId = ReturnType<typeof setTimeout>;

/**
 * Call `bump` every `intervalMs` (default 200) until `durationMs` (default
 * 5000) has elapsed, including a bump on the deadline when it lands on an
 * interval. Returns a cancel function. Starting another schedule cancels this
 * one first.
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
  activeCancel?.();
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
    if (activeCancel === cancel) activeCancel = null;
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
  activeCancel = cancel;
  return cancel;
}
