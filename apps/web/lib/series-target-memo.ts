/** In-process memo for a per-title TMDB read.
 *  A fresh hit is reused so a refresh does not wait on the network again.
 *  A failed load (null or throw) returns the last successful value for that
 *  key when one exists, and waits out `failureTtlMs` before trying again.
 *  With no prior success, the failure itself is remembered for that TTL.
 *  Concurrent callers share one in-flight load. */
export function createTtlMemo<T>(options: {
  now?: () => number;
  successTtlMs: number;
  failureTtlMs: number;
  load: (key: number) => Promise<T | null>;
}): (key: number) => Promise<T | null> {
  const stored = new Map<number, { value: T | null; expiresAt: number }>();
  const inflight = new Map<number, Promise<T | null>>();
  const now = () => options.now?.() ?? Date.now();
  const remember = (key: number, value: T | null): T | null => {
    const previous = stored.get(key)?.value ?? null;
    if (value === null && previous !== null) {
      stored.set(key, { value: previous, expiresAt: now() + options.failureTtlMs });
      return previous;
    }
    stored.set(key, {
      value,
      expiresAt: now() + (value === null ? options.failureTtlMs : options.successTtlMs),
    });
    return value;
  };
  return (key: number) => {
    const hit = stored.get(key);
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.value);
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = options
      .load(key)
      .then(
        (value) => remember(key, value),
        () => remember(key, null),
      )
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  };
}
