import { describe, expect, it } from "vitest";
import {
  decideUpdateNotice,
  parseLatestRelease,
  shouldCheckForUpdate,
  UPDATE_CHECK_INTERVAL_MS,
} from "../src/update-check.js";

const PAGE = "https://github.com/fancydirty/mediary-scout/releases/tag/v2026.10.02";

describe("parseLatestRelease", () => {
  it("reads a date release and links its release page on GitHub", () => {
    expect(parseLatestRelease({ tag_name: "v2026.10.02", html_url: "https://elsewhere.example/x" })).toEqual({
      tag: "v2026.10.02",
      version: "2026.1002.0",
      pageUrl: PAGE,
    });
  });

  it("ignores anything that is not a date release", () => {
    for (const body of [{ tag_name: "v1.4.1" }, { tag_name: 42 }, {}, null, "v2026.10.02"]) {
      expect(parseLatestRelease(body)).toBeNull();
    }
  });
});

describe("decideUpdateNotice", () => {
  const latest = { tag: "v2026.10.02", version: "2026.1002.0", pageUrl: PAGE };

  it("offers a newer release, and notifies once per release", () => {
    expect(decideUpdateNotice({ latest, currentVersion: "2026.928.0", notifiedTag: null })).toEqual({
      offer: latest,
      notify: true,
    });
    expect(decideUpdateNotice({ latest, currentVersion: "2026.928.0", notifiedTag: "v2026.10.02" })).toEqual({
      offer: latest,
      notify: false,
    });
    expect(decideUpdateNotice({ latest, currentVersion: "2026.928.0", notifiedTag: "v2026.09.30" }).notify).toBe(true);
  });

  it("never offers the running release or an older one", () => {
    const none = { offer: null, notify: false };
    expect(decideUpdateNotice({ latest, currentVersion: "2026.1002.0", notifiedTag: null })).toEqual(none);
    expect(decideUpdateNotice({ latest, currentVersion: "2026.1015.0", notifiedTag: null })).toEqual(none);
    expect(decideUpdateNotice({ latest: null, currentVersion: "2026.928.0", notifiedTag: null })).toEqual(none);
  });

  it("offers the first date release to a 1.x install", () => {
    expect(decideUpdateNotice({ latest, currentVersion: "1.4.1", notifiedTag: null }).offer).toBe(latest);
  });
});

describe("shouldCheckForUpdate", () => {
  const start = Date.UTC(2026, 9, 1);

  it("checks when it never has, then once a day of wall-clock time has passed", () => {
    expect(shouldCheckForUpdate({ now: start, lastCheckedAt: null })).toBe(true);
    expect(shouldCheckForUpdate({ now: start + UPDATE_CHECK_INTERVAL_MS - 1, lastCheckedAt: start })).toBe(false);
    expect(shouldCheckForUpdate({ now: start + UPDATE_CHECK_INTERVAL_MS, lastCheckedAt: start })).toBe(true);
  });

  it("checks again when the clock went backwards", () => {
    expect(shouldCheckForUpdate({ now: start - 1000, lastCheckedAt: start })).toBe(true);
  });
});
