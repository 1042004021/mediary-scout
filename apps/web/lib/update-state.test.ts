import { describe, expect, it } from "vitest";
import { buildUpdateView } from "./update-state";

const feed = [
  { tag: "v2026.10.02", date: "2026-10-02", commit: "c".repeat(40), notes: [] },
  { tag: "v2026.09.28", date: "2026-09-28", commit: "b".repeat(40), notes: [] },
];
const base = { feed, updater: null, relation: null };

describe("buildUpdateView", () => {
  it("names the current release and offers the newer one", () => {
    const view = buildUpdateView({ ...base, currentCommit: "b".repeat(40) });
    expect(view.current).toEqual({ label: "v2026.09.28", tag: "v2026.09.28" });
    expect(view.available?.tag).toBe("v2026.10.02");
    expect(view.releases.map((r) => [r.tag, r.isCurrent])).toEqual([
      ["v2026.10.02", false],
      ["v2026.09.28", true],
    ]);
  });
  it("is up to date on the newest release", () => {
    const view = buildUpdateView({ ...base, currentCommit: "c".repeat(40) });
    expect(view.available).toBeNull();
    expect(view.status).toBe("latest");
  });
  it("offers the newest release to an untagged build only when that build is behind it", () => {
    const behind = buildUpdateView({ ...base, currentCommit: "d".repeat(40), relation: "behind" });
    expect(behind.current).toEqual({ label: "dddddddd · 开发版本", tag: null });
    expect(behind.available?.tag).toBe("v2026.10.02");
    expect(behind.status).toBe("available");
    for (const relation of ["ahead", "identical", "diverged", null] as const) {
      expect(buildUpdateView({ ...base, currentCommit: "d".repeat(40), relation }).available).toBeNull();
    }
  });
  it("only claims 已是最新 when the comparison was actually made", () => {
    const status = (relation: "ahead" | "identical" | "diverged" | null) =>
      buildUpdateView({ ...base, currentCommit: "d".repeat(40), relation }).status;
    expect(status("ahead")).toBe("latest");
    expect(status("identical")).toBe("latest");
    expect(status("diverged")).toBe("unknown");
    expect(status(null)).toBe("unknown");
  });
  it("says so when an untagged build is newer than the newest release", () => {
    const view = buildUpdateView({ ...base, currentCommit: "d".repeat(40), relation: "ahead" });
    expect(view.current.label).toBe("dddddddd · 比 v2026.10.02 新的开发版本");
  });
  it("calls a build with no stamped commit 未知版本 and offers nothing", () => {
    const view = buildUpdateView({ ...base, currentCommit: null });
    expect(view.current).toEqual({ label: "未知版本", tag: null });
    expect(view.available).toBeNull();
    expect(view.status).toBe("unknown");
  });
  it("offers nothing when the feed is empty (offline)", () => {
    const view = buildUpdateView({ ...base, currentCommit: "d".repeat(40), feed: [] });
    expect(view.available).toBeNull();
    expect(view.status).toBe("offline");
  });
});
