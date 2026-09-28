import { describe, expect, it } from "vitest";
import { linkTarget } from "../src/external-links.js";

const ORIGIN = "http://127.0.0.1:53123";

describe("linkTarget", () => {
  it("keeps the app's own pages in the app", () => {
    expect(linkTarget("http://127.0.0.1:53123/settings?tab=update", ORIGIN)).toBe("app");
    expect(linkTarget("http://127.0.0.1:53123/", ORIGIN)).toBe("app");
  });

  it("sends http and https links elsewhere to the system browser", () => {
    expect(linkTarget("https://github.com/fancydirty/mediary-scout", ORIGIN)).toBe("external");
    expect(linkTarget("https://github.com/fancydirty/mediary-scout/releases/download/v2026.10.02/a.dmg", ORIGIN)).toBe(
      "external",
    );
    expect(linkTarget("http://127.0.0.1:9999/", ORIGIN)).toBe("external");
  });

  it("opens nothing for other schemes or garbage", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "mailto:someone@example.com", "not a url", ""]) {
      expect(linkTarget(url, ORIGIN)).toBe("other");
    }
  });
});
