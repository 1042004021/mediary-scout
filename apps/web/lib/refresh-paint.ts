/** True when `requestUrl` is an App Router RSC fetch for the page the user is on.
 *  Other prefetches (sidebar links) must not count — painting on those would
 *  re-render on every hover prefetch. */
export function isCurrentPageRsc(pagePathname: string, requestUrl: string): boolean {
  try {
    const parsed = new URL(requestUrl, "http://local");
    return parsed.pathname === pagePathname && parsed.searchParams.has("_rsc");
  } catch {
    return false;
  }
}
