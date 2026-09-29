import { describe, expect, it } from "vitest";
import { appVersionFromTag, isNewerAppVersion } from "../src/release-version.js";
import { parseReleaseTag } from "../../web/lib/release-version";

describe("appVersionFromTag", () => {
  it("maps a release tag to the app version it ships as", () => {
    expect(appVersionFromTag("v2026.09.28")).toBe("2026.928.0");
    expect(appVersionFromTag("v2026.09.28.2")).toBe("2026.928.2");
    expect(appVersionFromTag("v2026.10.02")).toBe("2026.1002.0");
    expect(appVersionFromTag("v2027.01.05")).toBe("2027.105.0");
    expect(appVersionFromTag("v2026.12.31.11")).toBe("2026.1231.11");
    expect(appVersionFromTag("v2028.02.29")).toBe("2028.229.0");
  });

  it("rejects anything that is not a real release tag", () => {
    for (const bad of [
      "v1.4.1",
      "2026.09.28",
      "v2026.9.28",
      "v2026.13.01",
      "v2026.09.28.0",
      "v2026.09.28.1",
      "v2026.02.31",
      "v2026.02.29",
      "main",
      "v2026.09.28;rm -rf /",
      "",
      "v0000.02.29",
      "v1999.12.31",
      "v2100.01.01",
    ]) {
      expect(appVersionFromTag(bad)).toBeNull();
    }
  });

  it("keeps release order and stays above every 1.x release", () => {
    const tags = ["v2026.09.28", "v2026.09.28.2", "v2026.09.28.10", "v2026.10.02", "v2026.12.31", "v2027.01.05"];
    const versions = tags.map((tag) => appVersionFromTag(tag)!);
    for (let index = 1; index < versions.length; index += 1) {
      expect(isNewerAppVersion(versions[index]!, versions[index - 1]!)).toBe(true);
      expect(isNewerAppVersion(versions[index - 1]!, versions[index]!)).toBe(false);
    }
    expect(isNewerAppVersion("2026.928.0", "1.4.1")).toBe(true);
  });

  it("accepts exactly the tags the web 「更新」 tab accepts", () => {
    const inputs = [
      "v2026.09.28",
      "v2026.09.28.2",
      "v2026.09.28.10",
      "v2026.09.28.0",
      "v2026.09.28.1",
      "v2026.02.29",
      "v2028.02.29",
      "v2026.04.31",
      "v2026.13.01",
      "v2026.9.28",
      "v1.4.1",
      "",
      "v0008.02.29",
      "v2100.01.01",
    ];
    for (const input of inputs) {
      expect(appVersionFromTag(input) !== null).toBe(parseReleaseTag(input) !== null);
    }
  });
});

describe("isNewerAppVersion", () => {
  it("compares the three numbers, and never calls unparseable input newer", () => {
    expect(isNewerAppVersion("2026.1002.0", "2026.928.5")).toBe(true);
    expect(isNewerAppVersion("2026.928.0", "2026.928.0")).toBe(false);
    expect(isNewerAppVersion("garbage", "1.4.1")).toBe(false);
    expect(isNewerAppVersion("2026.928.0", "1.4.1-beta")).toBe(false);
  });
});
