import { describe, expect, it } from "vitest";
import { formatBytes, type UserMessageReply } from "@media-track/workflow";
import {
  answeredMeta,
  appendChipText,
  composerPlaceholder,
  draftIsSendable,
  episodeLabel,
  formatSize,
  groupEpisodesBySeason,
  isMultiSeason,
  keepToastText,
  nowButtonMessageId,
  replyView,
  showsMessageCard,
  statusLabel,
  swapBadgeLabel,
  threadExchanges,
  toggleEpisode,
  visibleExchanges,
  type ThreadMessage,
} from "./user-message-state";

describe("user message state", () => {
  it("toggles episode tags and keeps them sorted", () => {
    expect(toggleEpisode(["S01E24"], "S01E13")).toEqual(["S01E13", "S01E24"]);
    expect(toggleEpisode(["S01E13", "S01E24"], "S01E13")).toEqual(["S01E24"]);
  });
  it("labels each status the way the mockup does", () => {
    expect(statusLabel({ status: "pending", urgent: false }, "明早 06:00", false)).toBe("等巡检 · 明早 06:00");
    expect(statusLabel({ status: "pending", urgent: true }, "明早 06:00", true)).toBe("排队中 · 这次处理完接着处理");
    expect(statusLabel({ status: "pending", urgent: true }, "明早 06:00", false)).toBe("排队中 · 马上处理");
    expect(statusLabel({ status: "processing", urgent: false }, "", false)).toBe("已锁定");
    expect(statusLabel({ status: "done", urgent: false }, "", false)).toBe("");
  });
  it("a draft is sendable with text, not with only whitespace", () => {
    expect(draftIsSendable("  ")).toBe(false);
    expect(draftIsSendable("换一个")).toBe(true);
  });
});

describe("episode labels", () => {
  it("drops the season on a one-season work and keeps it when several seasons show", () => {
    expect(episodeLabel("S01E13", false)).toBe("E13");
    expect(episodeLabel("S02E105", false)).toBe("E105");
    expect(episodeLabel("S01E13", true)).toBe("S01E13");
    expect(episodeLabel("MOVIE", false)).toBe("");
    expect(episodeLabel("E13", true)).toBe("E13");
  });

  it("several seasons = codes from more than one season", () => {
    expect(isMultiSeason(["S01E01", "S01E02"])).toBe(false);
    expect(isMultiSeason(["S01E01", "S02E01"])).toBe(true);
    expect(isMultiSeason(["MOVIE"])).toBe(false);
    expect(isMultiSeason([])).toBe(false);
  });

  it("groups the picker's episodes by season, in order", () => {
    expect(groupEpisodesBySeason(["S02E02", "S01E10", "S01E02", "S02E01", "MOVIE"])).toEqual([
      { season: 1, episodes: ["S01E02", "S01E10"] },
      { season: 2, episodes: ["S02E01", "S02E02"] },
    ]);
  });
});

const msg = (over: Partial<ThreadMessage> & { id: string }): ThreadMessage => ({
  body: "换",
  episodeTags: [],
  status: "pending",
  urgent: false,
  createdAt: "2026-09-27T06:00:00.000Z",
  processedAt: null,
  reply: null,
  ...over,
});
const reply = (runId: string, over: Partial<UserMessageReply> = {}): UserMessageReply => ({ results: [], oldFiles: [], runId, ...over });

describe("thread exchanges", () => {
  it("oldest first; messages one run answered share its reply; the ones a run holds go together", () => {
    // listUserMessages order: newest first.
    const newestFirst = [
      msg({ id: "m6", status: "pending" }),
      msg({ id: "m5", status: "processing" }),
      msg({ id: "m4", status: "processing" }),
      msg({ id: "m3", status: "done", reply: reply("run_b"), processedAt: "2026-09-26T09:00:00.000Z" }),
      msg({ id: "m2", status: "done", reply: reply("run_b"), processedAt: "2026-09-26T09:00:01.000Z" }),
      msg({ id: "m1", status: "done", reply: reply("run_a"), processedAt: "2026-09-25T09:00:00.000Z" }),
    ];

    const exchanges = threadExchanges(newestFirst);

    expect(exchanges.map((e) => [e.kind, e.messages.map((m) => m.id)])).toEqual([
      ["answered", ["m1"]],
      ["answered", ["m2", "m3"]],
      ["working", ["m4", "m5"]],
      ["waiting", ["m6"]],
    ]);
    const answered = exchanges[1]!;
    expect(answered.kind === "answered" && answered.reply?.runId).toBe("run_b");
    expect(answered.kind === "answered" && answered.processedAt).toBe("2026-09-26T09:00:01.000Z");
  });

  it("each waiting message stands alone (each has its own 修改 / 撤回)", () => {
    const exchanges = threadExchanges([msg({ id: "m2" }), msg({ id: "m1" })]);
    expect(exchanges.map((e) => e.messages.map((m) => m.id))).toEqual([["m1"], ["m2"]]);
  });
});

describe("visible exchanges — earlier ones fold into 「之前的留言」", () => {
  const answered = (id: string) => ({ kind: "answered" as const, messages: [msg({ id, status: "done" })], reply: reply(`run_${id}`), processedAt: null });
  const waiting = (id: string) => ({ kind: "waiting" as const, messages: [msg({ id })] });
  const working = (id: string) => ({ kind: "working" as const, messages: [msg({ id, status: "processing" })] });

  it("the latest answer and everything after it show; what came before folds", () => {
    const split = visibleExchanges([answered("a"), answered("b"), answered("c")]);
    expect(split.recent.map((e) => e.messages[0]!.id)).toEqual(["c"]);
    expect(split.earlier.map((e) => e.messages[0]!.id)).toEqual(["a", "b"]);
    expect(split.earlierCount).toBe(2);
  });

  it("nothing answered yet: everything shows", () => {
    const split = visibleExchanges([working("a"), waiting("b")]);
    expect(split.recent).toHaveLength(2);
    expect(split.earlierCount).toBe(0);
  });

  it("a new message waiting under the last answer keeps that answer in view", () => {
    const split = visibleExchanges([answered("a"), answered("b"), waiting("c")]);
    expect(split.recent.map((e) => e.messages[0]!.id)).toEqual(["b", "c"]);
    expect(split.earlierCount).toBe(1);
  });
});

describe("replyView — the agent's reply as a track list", () => {
  const mixed = reply("run_c", {
    results: [
      { episode: "S01E24", outcome: "not_found", note: "搜到的 4 个都是原来那份" },
      { episode: "S01E13", outcome: "replaced", label: "[喵萌奶茶屋] 黄泉的使者 13 [1080p]", sizeBytes: Math.round(1.1 * 1024 ** 3), note: "换掉了原来的 CR 版" },
    ],
    oldFiles: ["Season 01/13.mkv", "Season 01/24.mkv"],
  });
  const tv = { mediaType: "tv" as const, multiSeason: false };

  it("one replaced, one still looked for (mockup ⑤)", () => {
    const view = replyView(mixed, { ...tv, pending: new Set(["S01E24"]) });

    expect(view.summary).toBe("换好 1 集，1 集还在找");
    expect(view.rows).toEqual([
      { episode: "S01E13", label: "E13", resource: "[喵萌奶茶屋] 黄泉的使者 13 [1080p]", note: "换掉了原来的 CR 版", size: "1.1 GB", state: "replaced" },
      { episode: "S01E24", label: "E24", resource: "没有找到别的版本", note: "搜到的 4 个都是原来那份", size: "—", state: "looking" },
    ]);
    // E24's old file is its only copy: the label must not invite deleting every old file.
    expect(view.oldFilesLabel).toBe("旧文件都还在，换好的集确认新的能看再删：");
    expect(view.foot).toBe("换好的那集和旧文件放在一起，播放器里会看到两个 E13。");
  });

  it("an episode no longer 待换 (不换了, or replaced later) stops being looked for", () => {
    const view = replyView(mixed, { ...tv, pending: new Set() });
    expect(view.summary).toBe("换好 1 集");
    expect(view.rows[1]!.state).toBe("stopped");
  });

  it("everything replaced: the old files can go once the new ones play", () => {
    const view = replyView(
      reply("r", {
        results: [
          { episode: "S01E02", outcome: "replaced", label: "a", note: "" },
          { episode: "S01E01", outcome: "replaced", label: "b", note: "" },
        ],
        oldFiles: ["x"],
      }),
      { ...tv, pending: new Set() },
    );
    expect(view.summary).toBe("换好 2 集");
    expect(view.rows.map((r) => r.size)).toEqual(["—", "—"]);
    expect(view.oldFilesLabel).toBe("旧文件还在，确认新的能看再删：");
    expect(view.foot).toBe("换好的几集和旧文件放在一起，播放器里每集会看到两个。");
  });

  it("nothing replaced", () => {
    const results: UserMessageReply["results"] = [
      { episode: "S01E01", outcome: "not_found", note: "" },
      { episode: "S01E02", outcome: "not_found", note: "" },
    ];
    expect(replyView(reply("r", { results, oldFiles: ["x"] }), { ...tv, pending: new Set(["S01E01", "S01E02"]) })).toMatchObject({
      summary: "这次没找到能换的，2 集还在找",
      oldFilesLabel: "旧文件还在：",
      foot: null,
    });
    expect(replyView(reply("r", { results }), { ...tv, pending: new Set() })).toMatchObject({ summary: "这次没找到能换的", oldFilesLabel: null });
  });

  it("several seasons keep the season in the label", () => {
    const view = replyView(reply("r", { results: [{ episode: "S02E08", outcome: "not_found", note: "" }] }), {
      mediaType: "tv",
      multiSeason: true,
      pending: new Set(["S02E08"]),
    });
    expect(view.rows[0]!.label).toBe("S02E08");
  });

  it("a replaced episode whose resource name is missing still reads", () => {
    const view = replyView(reply("r", { results: [{ episode: "S01E01", outcome: "replaced", note: "" }] }), { ...tv, pending: new Set() });
    expect(view.rows[0]!.resource).toBe("没记下资源名");
  });

  it("carries the two flags the reply can raise", () => {
    expect(replyView(reply("r", { unidentified: true }), { ...tv, pending: new Set() })).toMatchObject({ unidentified: true, rejectedNotSaved: false, summary: "", rows: [] });
    expect(replyView(reply("r", { rejectedNotSaved: true }), { ...tv, pending: new Set() }).rejectedNotSaved).toBe(true);
  });

  it("a film (mockup ⑥)", () => {
    const notFound = reply("r", { results: [{ episode: "MOVIE", outcome: "not_found", note: "4 个是这部山寨片" }], oldFiles: ["Movies/x.mkv"] });
    const film = { mediaType: "movie" as const, multiSeason: false };
    expect(replyView(notFound, { ...film, pending: new Set(["MOVIE"]) })).toMatchObject({
      summary: "这次没找到能换的",
      rows: [{ episode: "MOVIE", label: "", resource: "没有找到别的版本", note: "4 个是这部山寨片", size: "—", state: "looking" }],
      oldFilesLabel: "旧文件还在：",
      foot: null,
    });
    const replaced = reply("r", { results: [{ episode: "MOVIE", outcome: "replaced", label: "Odyssey.2026.2160p", sizeBytes: 23 * 1024 ** 3, note: "" }], oldFiles: ["Movies/x.mkv"] });
    expect(replyView(replaced, { ...film, pending: new Set() })).toMatchObject({
      summary: "换好了",
      oldFilesLabel: "旧文件还在，确认新的能看再删：",
      foot: "新文件和旧文件放在一起，播放器里会看到两个版本。",
    });
  });
});

describe("formatSize", () => {
  it("formats like the rest of the app (notifications, activity page)", () => {
    for (const bytes of [512 * 1024, 850 * 1024 ** 2, Math.round(1.1 * 1024 ** 3), Math.round(23.4 * 1024 ** 3)]) {
      expect(formatSize(bytes)).toBe(formatBytes(bytes));
    }
  });
});

describe("appendChipText — a common phrase joins the draft", () => {
  it("fills an empty draft, joins a written one, never repeats", () => {
    expect(appendChipText("", "音画不同步")).toBe("音画不同步");
    expect(appendChipText("  ", "音画不同步")).toBe("音画不同步");
    expect(appendChipText("第 3 集", "音画不同步")).toBe("第 3 集，音画不同步");
    expect(appendChipText("第 3 集，", "音画不同步")).toBe("第 3 集，音画不同步");
    expect(appendChipText("第 3 集音画不同步", "音画不同步")).toBe("第 3 集音画不同步");
  });
});

describe("swapBadgeLabel — the 待换 badge beside the title", () => {
  it("counts a show's 待换 episodes; a film says 待换资源", () => {
    expect(swapBadgeLabel("tv", [])).toBeNull();
    expect(swapBadgeLabel("tv", ["S01E03", "S02E01"])).toBe("2 集待换");
    expect(swapBadgeLabel("movie", ["MOVIE"])).toBe("待换资源");
    expect(swapBadgeLabel("movie", [])).toBeNull();
  });
});

describe("showsMessageCard", () => {
  it("a tracked work with a file, or with messages / 待换 to show, gets the card", () => {
    expect(showsMessageCard({ tracked: true, hasFile: true, messageCount: 0, pendingCount: 0 })).toBe(true);
    // A film whose replace run is running reads 获取中, not 已入库 — the card must not vanish then.
    expect(showsMessageCard({ tracked: true, hasFile: false, messageCount: 1, pendingCount: 0 })).toBe(true);
    expect(showsMessageCard({ tracked: true, hasFile: false, messageCount: 0, pendingCount: 1 })).toBe(true);
    expect(showsMessageCard({ tracked: true, hasFile: false, messageCount: 0, pendingCount: 0 })).toBe(false);
    expect(showsMessageCard({ tracked: false, hasFile: true, messageCount: 0, pendingCount: 0 })).toBe(false);
  });
});

describe("the green 现在处理", () => {
  it("sits on the newest waiting message, only while it waits for the patrol", () => {
    expect(nowButtonMessageId([msg({ id: "m1" }), msg({ id: "m2" })])).toBe("m2");
    expect(nowButtonMessageId([msg({ id: "m1" }), msg({ id: "m2", urgent: true })])).toBeNull();
    expect(nowButtonMessageId([msg({ id: "m1" }), msg({ id: "m2", status: "processing" })])).toBe("m1");
    expect(nowButtonMessageId([msg({ id: "m1", status: "done" })])).toBeNull();
  });
});

describe("copy", () => {
  it("the toast after 不换了", () => {
    expect(keepToastText(["S01E24"], { mediaType: "tv", multiSeason: false, obtained: new Set(["S01E24"]) })).toBe("E24 不换了，恢复成已获取");
    // A 待换 episode whose file is missing goes back to 缺集, not 已获取.
    expect(keepToastText(["S02E08"], { mediaType: "tv", multiSeason: true, obtained: new Set() })).toBe("S02E08 不换了");
    expect(keepToastText(["MOVIE"], { mediaType: "movie", multiSeason: false, obtained: new Set() })).toBe("不换了，保留现在这份");
  });

  it("the composer's placeholder", () => {
    expect(composerPlaceholder({ mediaType: "tv", active: false, open: false })).toBe("哪一集有问题？告诉 agent，下次巡检它会换一个");
    expect(composerPlaceholder({ mediaType: "movie", active: false, open: false })).toBe("这部有问题？告诉 agent，下次巡检它会换一个");
    expect(composerPlaceholder({ mediaType: "tv", active: true, open: false })).toBe("还有别的？写在这里，排在上面这条后面");
    expect(composerPlaceholder({ mediaType: "tv", active: true, open: true })).toBe("说说哪里不对，想换成什么样");
  });

  it("when an answer came", () => {
    const now = "2026-09-27T08:00:00.000Z"; // 16:00 in China
    expect(answeredMeta("2026-09-27T06:31:00.000Z", now)).toBe("今天 14:31 处理完");
    expect(answeredMeta("2026-09-26T06:31:00.000Z", now)).toBe("昨天处理完");
    expect(answeredMeta("2026-09-20T06:31:00.000Z", now)).toBe("9月20日处理完");
  });
});
