import { describe, expect, it } from "vitest";
import { compareReleaseTags, parseReleaseTag, parseReleaseNotes } from "./release-version";

describe("parseReleaseTag", () => {
  it("accepts vYYYY.MM.DD and vYYYY.MM.DD.N", () => {
    expect(parseReleaseTag("v2026.09.28")).toEqual({ tag: "v2026.09.28", date: "2026-09-28", seq: 0 });
    expect(parseReleaseTag("v2026.09.28.2")).toEqual({ tag: "v2026.09.28.2", date: "2026-09-28", seq: 2 });
  });
  it("rejects anything else (old semver, refs, injection)", () => {
    for (const bad of ["v1.4.1", "2026.09.28", "v2026.9.28", "v2026.13.01", "v2026.09.28.0", "main", "v2026.09.28;rm -rf /", ""]) {
      expect(parseReleaseTag(bad)).toBeNull();
    }
  });
  it("rejects dates that do not exist", () => {
    for (const bad of ["v2026.02.31", "v2026.02.29", "v2026.04.31", "v2026.11.31"]) {
      expect(parseReleaseTag(bad)).toBeNull();
    }
    expect(parseReleaseTag("v2028.02.29")?.date).toBe("2028-02-29");
  });
});

describe("compareReleaseTags", () => {
  it("orders by date then sequence", () => {
    const tags = ["v2026.09.28.2", "v2026.10.02", "v2026.09.28"];
    expect([...tags].sort(compareReleaseTags)).toEqual(["v2026.09.28", "v2026.09.28.2", "v2026.10.02"]);
  });
});

describe("parseReleaseNotes", () => {
  it("reads 新增 / 改进 / 修复 bullet lines and ignores everything else", () => {
    const md = "# v2026.09.28\n\n- 修复 巡检不会重复转存同一个资源包\n- 新增 光鸭支持分享链接\n* 改进 临时文件夹会被自动清理\n- 随便写的一行\n\n说明段落";
    expect(parseReleaseNotes(md)).toEqual([
      { kind: "fix", text: "巡检不会重复转存同一个资源包" },
      { kind: "add", text: "光鸭支持分享链接" },
      { kind: "improve", text: "临时文件夹会被自动清理" },
    ]);
  });
  it("returns [] for empty or malformed input", () => {
    expect(parseReleaseNotes("")).toEqual([]);
    expect(parseReleaseNotes("no bullets here")).toEqual([]);
  });
});
