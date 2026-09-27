/** In-process memo for a per-title TMDB read.
 *  A hit (including "TMDB has no such title") is reused until its TTL so a
 *  refresh of a page that already asked does not wait on the network again.
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
  return (key: number) => {
    const hit = stored.get(key);
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.value);
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = options
      .load(key)
      .then((value) => {
        stored.set(key, {
          value,
          expiresAt: now() + (value === null ? options.failureTtlMs : options.successTtlMs),
        });
        inflight.delete(key);
        return value;
      })
      .catch((error: unknown) => {
        inflight.delete(key);
        throw error;
      });
    inflight.set(key, promise);
    return promise;
  };
}
