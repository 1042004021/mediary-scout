import { describe, expect, it } from "vitest";
import { linkHistoryByKey, linkHistoryNoteForUrl } from "../src/acquisition-v2/link-history.js";
import { readTransferFate } from "../src/user-requests.js";

const SHARE = "https://www.123pan.com/s/Ab-cD_12";
const SAME_SHARE = "https://www.123pan.cn/s/Ab-cD_12?pwd=1234";
const OTHER = "https://www.123pan.com/s/OtherKey1";

describe("link history notes", () => {
  it("every recorded transfer thrown away: 文件每次都被丢掉", () => {
    const notes = linkHistoryByKey([
      { url: SHARE, startedAt: "2026-09-01T00:00:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 12 } },
      { url: SAME_SHARE, startedAt: "2026-09-26T04:25:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 12 } },
    ]);
    expect(linkHistoryNoteForUrl(notes, SHARE)).toBe("近 30 天转过 2 次（最近 09-26），文件每次都被丢掉");
  });

  it("some rows have no fate and every recorded one was thrown away: 有记录的 N 次", () => {
    const notes = linkHistoryByKey([
      { url: SHARE, startedAt: "2026-09-10T00:00:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 12 } },
      { url: SHARE, startedAt: "2026-09-20T00:00:00.000Z", materializedCount: 12 },
      { url: SHARE, startedAt: "2026-09-18T00:00:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 12 } },
    ]);
    expect(linkHistoryNoteForUrl(notes, SHARE)).toBe("近 30 天转过 3 次（最近 09-20），有记录的 2 次文件都被丢掉");
  });

  it("the most recent recorded fate kept files: 最近一次留下 K 个文件", () => {
    const notes = linkHistoryByKey([
      { url: SHARE, startedAt: "2026-09-20T00:00:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 12 } },
      { url: SHARE, startedAt: "2026-09-25T08:00:00.000Z", materializedCount: 12, fate: { kept: 12, thrownAway: 0 } },
    ]);
    expect(linkHistoryNoteForUrl(notes, SHARE)).toBe("近 30 天转过 2 次（最近 09-25），最近一次留下 12 个文件");
  });

  it("no recorded fate: times and last date only", () => {
    const notes = linkHistoryByKey([
      { url: SHARE, startedAt: "2026-09-01T00:00:00.000Z", materializedCount: 4 },
      { url: SHARE, startedAt: "2026-09-20T00:00:00.000Z", materializedCount: 4 },
      { url: SHARE, startedAt: "2026-09-15T00:00:00.000Z", materializedCount: 4 },
    ]);
    expect(linkHistoryNoteForUrl(notes, SHARE)).toBe("近 30 天转过 3 次（最近 09-20）");
  });

  it("a newer all-discarded fate after one that kept files adds no fate phrase", () => {
    const notes = linkHistoryByKey([
      { url: SHARE, startedAt: "2026-09-01T00:00:00.000Z", materializedCount: 12, fate: { kept: 12, thrownAway: 0 } },
      { url: SHARE, startedAt: "2026-09-26T00:00:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 12 } },
    ]);
    expect(linkHistoryNoteForUrl(notes, SHARE)).toBe("近 30 天转过 2 次（最近 09-26）");
  });

  it("skips a url with no link key and a transfer that landed nothing", () => {
    const notes = linkHistoryByKey([
      { url: "https://example.com/not-a-share", startedAt: "2026-09-26T00:00:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 12 } },
      { url: null, startedAt: "2026-09-26T00:00:00.000Z", materializedCount: 12 },
      { url: SHARE, startedAt: "2026-09-26T00:00:00.000Z", materializedCount: 0, fate: { kept: 0, thrownAway: 0 } },
      { url: OTHER, startedAt: "2026-09-19T00:00:00.000Z", materializedCount: 3 },
    ]);
    expect(linkHistoryNoteForUrl(notes, SHARE)).toBeUndefined();
    expect(linkHistoryNoteForUrl(notes, "https://example.com/not-a-share")).toBeUndefined();
    expect(linkHistoryNoteForUrl(notes, OTHER)).toBe("近 30 天转过 1 次（最近 09-19）");
  });

  it("two titles of one link get the same annotation", () => {
    const notes = linkHistoryByKey([
      { url: SHARE, startedAt: "2026-09-26T04:25:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 12 } },
    ]);
    const titles = ["黄泉的使者 (2026)", "🎬 黄泉的使者 (2026) 已更新"];
    const annotated = titles.map((title) => ({ title, linkHistory: linkHistoryNoteForUrl(notes, SHARE) }));
    expect(annotated[0]!.linkHistory).toBe(annotated[1]!.linkHistory);
    expect(annotated[0]!.linkHistory).toBe("近 30 天转过 1 次（最近 09-26），文件每次都被丢掉");
  });

  it("a fate is two non-negative integers that count at least one file", () => {
    expect(readTransferFate({ kept: 0, thrownAway: -1 })).toBeUndefined();
    expect(readTransferFate({ kept: 0.5, thrownAway: 2 })).toBeUndefined();
    expect(readTransferFate({ kept: 0, thrownAway: 0 })).toBeUndefined();
    expect(readTransferFate({ kept: 0, thrownAway: 12 })).toEqual({ kept: 0, thrownAway: 12 });
    expect(readTransferFate({ kept: 3, thrownAway: 0 })).toEqual({ kept: 3, thrownAway: 0 });
  });

  it("a link whose only fates are malformed gets no fate phrase", () => {
    const notes = linkHistoryByKey([
      { url: SHARE, startedAt: "2026-09-20T00:00:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: -1 } },
      { url: SHARE, startedAt: "2026-09-26T00:00:00.000Z", materializedCount: 12, fate: { kept: 0.5, thrownAway: 2 } },
      { url: SHARE, startedAt: "2026-09-22T00:00:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 0 } },
    ]);
    expect(linkHistoryNoteForUrl(notes, SHARE)).toBe("近 30 天转过 3 次（最近 09-26）");
  });

  it("a malformed fate counts as not recorded", () => {
    const notes = linkHistoryByKey([
      { url: SHARE, startedAt: "2026-09-20T00:00:00.000Z", materializedCount: 12, fate: { kept: "0", thrownAway: 12 } as never },
      { url: SHARE, startedAt: "2026-09-21T00:00:00.000Z", materializedCount: 12, fate: { kept: 0, thrownAway: 12 } },
    ]);
    expect(linkHistoryNoteForUrl(notes, SHARE)).toBe("近 30 天转过 2 次（最近 09-21），有记录的 1 次文件都被丢掉");
  });
});
