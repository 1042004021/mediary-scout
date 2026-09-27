import { describe, expect, it } from "vitest";
import { isCurrentPageRsc } from "./refresh-paint";

describe("isCurrentPageRsc", () => {
  it("matches only this page's refresh/RSC request", () => {
    expect(isCurrentPageRsc("/show/1396", "http://127.0.0.1:4011/show/1396?from=library&_rsc=abc")).toBe(true);
    expect(isCurrentPageRsc("/show/1396", "/show/1396?from=library&_rsc=abc")).toBe(true);
    expect(isCurrentPageRsc("/show/1396", "/settings?_rsc=abc")).toBe(false);
    expect(isCurrentPageRsc("/show/1396", "/show/1396?from=library")).toBe(false);
    expect(isCurrentPageRsc("/show/1396", "/api/activity?since=1")).toBe(false);
  });
});
