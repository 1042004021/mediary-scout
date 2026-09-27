import { describe, expect, it } from "vitest";
import { formatBytes, type UserMessageReply } from "@media-track/workflow";
import {
  EDIT_SETTLE_MS,
  answeredMeta,
  appendChipText,
  composerPlaceholder,
  draftIsSendable,
  editorAfterRefresh,
  editorAfterSettleTimeout,
  editorNotice,
  episodeLabel,
  formatSize,
  groupEpisodesBySeason,
  isMultiSeason,
  keepToastText,
  mergeIntoComposer,
  missedEpisodes,
  nowButtonMessageId,
  replacedLaterByRun,
  replyView,
  showsMessageCard,
  statusLabel,
  swapBadgeLabel,
  threadExchanges,
  toggleEpisode,
  visibleExchanges,
  type EditingMessage,
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

  it("one a later reply replaced says so; otherwise it is just no longer 待换", () => {
    const later = replyView(mixed, { ...tv, pending: new Set(), replacedLater: new Set(["S01E24"]) });
    expect(later.rows.map((r) => r.state)).toEqual(["replaced", "replacedLater"]);
    // Still 待换 wins: a later reply replaced it, yet a newer request brought it back.
    expect(replyView(mixed, { ...tv, pending: new Set(["S01E24"]), replacedLater: new Set(["S01E24"]) }).rows[1]!.state).toBe("looking");
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

  it("carries the rejected-list flag; an unidentified reply has no rows (its hint goes under the message: missedEpisodes)", () => {
    expect(replyView(reply("r", { unidentified: true }), { ...tv, pending: new Set() })).toMatchObject({ rejectedNotSaved: false, summary: "", rows: [] });
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

describe("replacedLaterByRun — which episodes a newer reply replaced", () => {
  it("per answered run: the episodes replaced by any reply after it", () => {
    const exchanges = threadExchanges([
      msg({ id: "m3", status: "done", reply: reply("run_c", { results: [{ episode: "S01E05", outcome: "replaced", note: "" }] }), processedAt: "2026-09-27T01:00:00.000Z" }),
      msg({ id: "m2", status: "done", reply: reply("run_b", { results: [{ episode: "S01E24", outcome: "replaced", note: "" }, { episode: "S01E03", outcome: "not_found", note: "" }] }), processedAt: "2026-09-26T01:00:00.000Z" }),
      msg({ id: "m1", status: "done", reply: reply("run_a", { results: [{ episode: "S01E24", outcome: "not_found", note: "" }] }), processedAt: "2026-09-25T01:00:00.000Z" }),
    ]);

    const later = replacedLaterByRun(exchanges);

    expect([...(later.get("run_a") ?? [])].sort()).toEqual(["S01E05", "S01E24"]);
    expect([...(later.get("run_b") ?? [])]).toEqual(["S01E05"]);
    expect([...(later.get("run_c") ?? [])]).toEqual([]);
  });
});

describe("editorAfterRefresh — a message's editor when a fresh render arrives", () => {
  const original = { body: "第 1 集发蓝", tags: ["S01E01"] };
  const editing = (over: Partial<EditingMessage> = {}): EditingMessage => ({ id: "m1", body: "第 1 集发蓝，换个中字的", tags: ["S01E01"], original, saved: null, ...over });
  const inView = (over: Partial<ThreadMessage> = {}) => msg({ id: "m1", body: original.body, episodeTags: original.tags, ...over });

  it("still waiting: the editor stays", () => {
    expect(editorAfterRefresh(editing(), inView())).toEqual({ kind: "keep" });
  });

  it("taken by a run while being edited: the notice, and the words typed go to the composer", () => {
    expect(editorAfterRefresh(editing(), inView({ status: "processing" }))).toEqual({
      kind: "taken",
      typed: { body: "第 1 集发蓝，换个中字的", tags: ["S01E01"] },
    });
    // Nothing was changed: nothing to carry over, only the notice.
    expect(editorAfterRefresh(editing({ body: original.body }), inView({ status: "done" }))).toEqual({ kind: "taken", typed: null });
    // Blanks alone are no change (the store trims).
    expect(editorAfterRefresh(editing({ body: ` ${original.body} ` }), inView({ status: "processing" }))).toEqual({ kind: "taken", typed: null });
    // A changed tag is a change.
    expect(editorAfterRefresh(editing({ body: original.body, tags: [] }), inView({ status: "processing" }))).toEqual({
      kind: "taken",
      typed: { body: original.body, tags: [] },
    });
  });

  it("gone from the thread (withdrawn elsewhere): the editor closes; changed words go to the composer", () => {
    expect(editorAfterRefresh(editing(), undefined)).toEqual({ kind: "gone", typed: { body: "第 1 集发蓝，换个中字的", tags: ["S01E01"] } });
    expect(editorAfterRefresh(editing({ body: original.body }), undefined)).toEqual({ kind: "gone", typed: null });
  });

  it("saved: stays open until a render carries the new words, then closes", () => {
    const saved = editing({ saved: { body: "第 1 集发蓝，换个中字的", tags: ["S01E01"] } });
    // A render fetched before the save landed still has the old words.
    expect(editorAfterRefresh(saved, inView())).toEqual({ kind: "keep" });
    expect(editorAfterRefresh(saved, inView({ body: "第 1 集发蓝，换个中字的" }))).toEqual({ kind: "close" });
    // Taken right after the save: the run has the new words — nothing was lost.
    expect(editorAfterRefresh(saved, inView({ body: "第 1 集发蓝，换个中字的", status: "processing" }))).toEqual({ kind: "close" });
    // Changed again elsewhere, or gone: nothing to wait for.
    expect(editorAfterRefresh(saved, inView({ body: "别的话" }))).toEqual({ kind: "close" });
    expect(editorAfterRefresh(saved, undefined)).toEqual({ kind: "close" });
  });
});

describe("editorNotice — what the card says when an open editor closes on its own", () => {
  const typed = { body: "第 1 集发蓝，换个中字的", tags: ["S01E01"] };

  it("taken by a run: says so, and where the changed words went", () => {
    expect(editorNotice({ kind: "taken", typed })).toBe("agent 已经开始处理这条留言了。改过的内容挪到了输入框里，可以再发一条");
    expect(editorNotice({ kind: "taken", typed: null })).toBe("agent 已经开始处理这条留言了");
  });

  it("withdrawn elsewhere: says so the same way — the words typed are not dropped silently", () => {
    expect(editorNotice({ kind: "gone", typed })).toBe("这条留言已经撤回了。改过的内容挪到了输入框里，可以再发一条");
    expect(editorNotice({ kind: "gone", typed: null })).toBe("这条留言已经撤回了");
  });

  it("an editor that stays, or closes as asked: nothing to say", () => {
    expect(editorNotice({ kind: "keep" })).toBeNull();
    expect(editorNotice({ kind: "close" })).toBeNull();
  });
});

describe("editorAfterSettleTimeout — a saved editor whose fresh render is late", () => {
  const original = { body: "第 1 集发蓝", tags: ["S01E01"] };
  const stored = { body: "第 1 集发蓝，换个中字的", tags: ["S01E01"] };
  const saved: EditingMessage = { id: "m1", body: stored.body, tags: stored.tags, original, saved: stored };
  const inView = (over: Partial<ThreadMessage> = {}) => msg({ id: "m1", body: stored.body, episodeTags: stored.tags, ...over });

  it("waits about eight seconds, then the editor is editable again on the words as stored", () => {
    expect(EDIT_SETTLE_MS).toBe(8000);
    expect(editorAfterSettleTimeout(saved, "m1")).toEqual({ id: "m1", body: stored.body, tags: stored.tags, original: stored, saved: null });
  });

  it("from then on it is an ordinary editor on the stored words", () => {
    const reopened = editorAfterSettleTimeout(saved, "m1")!;
    // The late render arrives: still waiting for the patrol, so it stays open, editable.
    expect(editorAfterRefresh(reopened, inView())).toEqual({ kind: "keep" });
    // Taken by a run without a word typed since: the run has the stored words, nothing moves.
    expect(editorAfterRefresh(reopened, inView({ status: "processing" }))).toEqual({ kind: "taken", typed: null });
    // Typed on after it came back: that moves to the composer.
    expect(editorAfterRefresh({ ...reopened, body: `${stored.body}，要 1080p` }, inView({ status: "processing" }))).toEqual({
      kind: "taken",
      typed: { body: `${stored.body}，要 1080p`, tags: stored.tags },
    });
  });

  it("leaves anything else alone: another message's editor, one never saved, no editor", () => {
    expect(editorAfterSettleTimeout(saved, "m2")).toBe(saved);
    const unsaved: EditingMessage = { ...saved, saved: null };
    expect(editorAfterSettleTimeout(unsaved, "m1")).toBe(unsaved);
    expect(editorAfterSettleTimeout(null, "m1")).toBeNull();
  });
});

describe("missedEpisodes — the 「没看出是哪几集」 hint goes under the message it is about", () => {
  const unidentified = reply("run_u", { unidentified: true, results: [{ episode: "S01E04", outcome: "not_found", note: "" }] });

  it("the flag is one per run: only a message that named no episode gets the hint", () => {
    expect(missedEpisodes({ episodeTags: [], reply: unidentified }, "tv")).toBe(true);
    expect(missedEpisodes({ episodeTags: ["S01E04"], reply: unidentified }, "tv")).toBe(false);
  });

  it("no hint without the flag, without a reply, or for a film (it always has its one file)", () => {
    expect(missedEpisodes({ episodeTags: [], reply: reply("run_ok") }, "tv")).toBe(false);
    expect(missedEpisodes({ episodeTags: [], reply: null }, "tv")).toBe(false);
    expect(missedEpisodes({ episodeTags: [], reply: unidentified }, "movie")).toBe(false);
  });
});

describe("mergeIntoComposer — words from a closed editor join the composer", () => {
  it("fills an empty draft, else goes on a new line; tags join without repeats, in order", () => {
    expect(mergeIntoComposer({ draft: "", tags: [] }, { body: "第 1 集发蓝", tags: ["S01E01"] })).toEqual({ draft: "第 1 集发蓝", tags: ["S01E01"] });
    expect(mergeIntoComposer({ draft: "还有第 3 集  ", tags: ["S01E03", "S01E01"] }, { body: "第 1 集发蓝", tags: ["S01E01", "S01E02"] })).toEqual({
      draft: "还有第 3 集\n第 1 集发蓝",
      tags: ["S01E01", "S01E02", "S01E03"],
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
