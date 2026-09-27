"use client";

/* Hallmark · component: user-message thread (work detail page) · genre: modern-minimal
 * theme: project (apps/web/DESIGN.md, Spotify) · pixel standard: docs/superpowers/design/2026-09-26-user-message-mockup.html
 * states: resting · composing + chips · picking episodes · waiting for the patrol (修改 / 撤回 / 现在处理) · editing
 * · queued behind a run · processing (equalizer + live activity) · answered (track list · 不换了 + undo toast
 * · copy path) · film 待换 bar · unidentified · rejected list not saved · error */

import { useEffect, useId, useRef, useState, useTransition, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import {
  editUserMessageAction,
  keepEpisodesAsIsAction,
  postUserMessageAction,
  processMessagesNowAction,
  withdrawUserMessageAction,
} from "../app/actions";
import { relativeDayLabel } from "../lib/relative-day";
import { runAction } from "../lib/run-action";
import type { MessageRunView, MessageThreadView } from "../lib/user-message-server";
import {
  answeredMeta,
  appendChipText,
  composerPlaceholder,
  draftIsSendable,
  episodeLabel,
  groupEpisodesBySeason,
  isMultiSeason,
  keepToastText,
  nowButtonMessageId,
  replyView,
  statusLabel,
  threadExchanges,
  toggleEpisode,
  visibleExchanges,
  type Exchange,
  type ReplyRow,
  type ThreadMessage,
} from "../lib/user-message-state";
import { useSwapKeep } from "./swap-keep";

/** 「不换了」 waits this long for 撤销 before it is sent (as deleting a note does). */
const UNDO_MS = 6000;
const COPIED_MS = 2500;
/** USER_MESSAGE_LIMITS.bodyMax — the card cannot import the workflow package; the
 *  server validates the same limit. */
const BODY_MAX = 500;

/** The common ways to say what is wrong (mockup ②): the chip, and what it adds to the draft. */
const CHIPS = [
  { label: "画面偏色", fill: "画面发蓝 / 偏色" },
  { label: "假片 / 不是这部", fill: "是假片，不是这部" },
  { label: "没有中字", fill: "没有中文字幕" },
  { label: "画质太差", fill: "画质太差，想要 1080p 以上" },
  { label: "音画不同步", fill: "音画不同步" },
] as const;

const OUT_TONE = { replaced: "is-ok", looking: "is-bad", stopped: "is-off" } as const;

interface Work {
  tmdbId: number;
  mediaType: "movie" | "tv";
  /** The page's workspace drive (undefined = primary). The server resolves the work. */
  storageId: string | undefined;
}

export interface UserMessageThreadProps {
  work: Work;
  view: MessageThreadView;
  run: MessageRunView;
  /** 「明早 06:00」: when the next patrol reads a message left now. */
  nextPatrol: string;
  /** Episode codes in the library (TV): the picker's cells. [] for a film. */
  episodes: string[];
  /** Server "now", so the server render and hydration write the same times. */
  now: string;
}

/**
 * The detail page's message card: one sentence to the agent about a bad episode or a bad
 * film; the agent's reply under it. Every action refreshes the page itself afterwards
 * (the actions do not revalidate), and the live progress while a run works arrives
 * through the page's AcquiringPoller — this card never polls.
 */
export function UserMessageThread(props: UserMessageThreadProps) {
  // One instance per work: the App Router reuses components across /show pages, and no
  // draft or waiting 不换了 may carry to the next work (the old instance's unmount sends
  // its waiting 不换了 against its own work).
  const { work } = props;
  return <ThreadForOneWork key={`${work.mediaType}:${work.tmdbId}:${work.storageId ?? ""}`} {...props} />;
}

function ThreadForOneWork({ work, view, run, nextPatrol, episodes, now }: UserMessageThreadProps) {
  const router = useRouter();
  const [sending, startSend] = useTransition();
  const [acting, startAct] = useTransition();
  const [, startKeep] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The composer.
  const [draft, setDraft] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [focused, setFocused] = useState(false);
  /** 「再留一条」 was pressed under an answer. */
  const [revealed, setRevealed] = useState(false);
  /** Just sent: the composer stays until the fresh render shows the new message. */
  const [holdOpen, setHoldOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // One waiting message edited in place.
  const [editing, setEditing] = useState<{ id: string; body: string; tags: string[] } | null>(null);
  // 不换了 and its undo. The episodes are shared with the page (the 待换 cells, the badge).
  const { kept, add: keepOnPage, remove: unkeepOnPage } = useSwapKeep();
  const [toast, setToast] = useState<{ episodes: string[]; text: string } | null>(null);
  const waitingKeep = useRef<{ episodes: string[]; work: Work; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** Sent and saved; still overridden on the page until a fresh render reflects them. */
  const settledKeeps = useRef(new Set<string>());
  const focusUndo = useRef(false);
  const undoRef = useRef<HTMLButtonElement>(null);
  const pickerId = useId();

  const movie = work.mediaType === "movie";
  const exchanges = threadExchanges(view.messages);
  const { earlier, recent, earlierCount } = visibleExchanges(exchanges);
  const last = exchanges.at(-1);
  const latestAnswered = [...recent].reverse().find((e) => e.kind === "answered");
  const pending = new Set(view.pendingReplacements.filter((e) => !kept.has(e)));
  const multiSeason = isMultiSeason([
    ...episodes,
    ...view.pendingReplacements,
    ...view.messages.flatMap((m) => [...m.episodeTags, ...(m.reply?.results.map((r) => r.episode) ?? [])]),
  ]);
  const obtained = new Set(episodes);
  // An urgent message waits for the run in flight rather than going with a queued one.
  const busy = view.busy || run.waitsForRun;
  const nowId = nowButtonMessageId([...view.messages].reverse());
  const active = view.messages.some((m) => m.status === "pending" || m.status === "processing");
  const open = focused || draft !== "" || tags.length > 0 || picking;
  // Under an answer the composer folds into 「再留一条」 (mockup ⑤); otherwise it is always there.
  const composerShown = last?.kind !== "answered" || revealed || open || holdOpen;
  const canPick = !movie && episodes.length > 0;
  const editingId = editing && view.messages.some((m) => m.id === editing.id && m.status === "pending") ? editing.id : null;

  // A fresh server render: what a 不换了 saved is in the server's list now; an editor
  // whose message a run took is dropped (so it cannot pop back if the run hands it back).
  useEffect(() => {
    setHoldOpen(false);
    setEditing((cur) => (cur && view.messages.some((m) => m.id === cur.id && m.status === "pending") ? cur : null));
    if (settledKeeps.current.size === 0) return;
    const settled = [...settledKeeps.current];
    settledKeeps.current.clear();
    unkeepOnPage(settled);
  }, [view, unkeepOnPage]);

  // A 不换了 the user asked for is never dropped: leaving the page (or this work) sends it now.
  useEffect(() => {
    const flush = () => {
      const waiting = waitingKeep.current;
      if (!waiting) return;
      clearTimeout(waiting.timer);
      waitingKeep.current = null;
      void keepEpisodesAsIsAction({ ...waiting.work, episodes: waiting.episodes }).catch(() => undefined);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // The 不换了 button just went away with its row state: 撤销 takes the focus.
  useEffect(() => {
    if (toast && focusUndo.current) {
      focusUndo.current = false;
      undoRef.current?.focus({ preventScroll: true });
    }
  }, [toast]);

  const send = () => {
    if (!draftIsSendable(draft) || sending) return;
    setError(null);
    const input = { ...work, body: draft, episodeTags: tags };
    startSend(async () => {
      const r = await runAction(() => postUserMessageAction(input), setError);
      if (!r.ok) return;
      if (!r.value.success) {
        setError(r.value.message ?? "留言没发出去，再试一次");
        return;
      }
      setDraft("");
      setTags([]);
      setPicking(false);
      setRevealed(false);
      setHoldOpen(true);
      textareaRef.current?.blur();
      router.refresh();
    });
  };

  const onDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter breaks the line; never while an IME is composing.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  const onComposeBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setFocused(false);
    if (draft.trim() === "" && tags.length === 0 && !picking) setRevealed(false);
  };

  // A click on the pill's padding lands in the text box, as the mockup's <label> does.
  const onComposerMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, textarea")) return;
    event.preventDefault();
    textareaRef.current?.focus();
  };

  const togglePicking = () => {
    const next = !picking;
    setPicking(next);
    // The grid is below the box: let a phone's keyboard go down while picking.
    if (next) textareaRef.current?.blur();
  };

  const reveal = () => {
    flushSync(() => setRevealed(true));
    textareaRef.current?.focus();
  };

  const saveEdit = () => {
    if (!editing || !draftIsSendable(editing.body) || acting) return;
    const input = { id: editing.id, body: editing.body, episodeTags: editing.tags };
    setError(null);
    startAct(async () => {
      const r = await runAction(() => editUserMessageAction(input), setError);
      if (!r.ok) return;
      if (r.value.success) setEditing(null);
      else setError(r.value.message ?? "修改没成功，再试一次");
      // Either way: a message a run took meanwhile then shows locked, and its editor closes.
      router.refresh();
    });
  };

  const withdraw = (id: string) => {
    setError(null);
    startAct(async () => {
      const r = await runAction(() => withdrawUserMessageAction({ id }), setError);
      if (!r.ok) return;
      if (!r.value.success) setError(r.value.message ?? "撤回没成功，再试一次");
      router.refresh();
    });
  };

  const processNow = () => {
    setError(null);
    startAct(async () => {
      const r = await runAction(() => processMessagesNowAction(work), setError);
      if (!r.ok) return;
      if (!r.value.success) {
        setError(r.value.message ?? "没能开始处理，再试一次");
        return;
      }
      router.refresh();
    });
  };

  const commitKeep = (target: { episodes: string[]; work: Work }) => {
    startKeep(async () => {
      const r = await runAction(() => keepEpisodesAsIsAction({ ...target.work, episodes: target.episodes }), setError);
      if (r.ok && r.value.success) {
        for (const e of target.episodes) settledKeeps.current.add(e);
      } else {
        // Still 待换 on the server: show it again.
        if (r.ok) setError(r.value.message ?? "没能保存，再试一次");
        unkeepOnPage(target.episodes);
      }
      router.refresh();
    });
  };

  const keep = (episodesToKeep: string[]) => {
    setError(null);
    // One undo at a time: a second 不换了 sends the first right away.
    const waiting = waitingKeep.current;
    if (waiting) {
      clearTimeout(waiting.timer);
      waitingKeep.current = null;
      commitKeep(waiting);
    }
    const target = { episodes: episodesToKeep, work };
    keepOnPage(episodesToKeep);
    focusUndo.current = true;
    setToast({ episodes: episodesToKeep, text: keepToastText(episodesToKeep, { mediaType: work.mediaType, multiSeason, obtained }) });
    waitingKeep.current = {
      ...target,
      timer: setTimeout(() => {
        waitingKeep.current = null;
        setToast((shown) => (shown?.episodes === episodesToKeep ? null : shown));
        commitKeep(target);
      }, UNDO_MS),
    };
  };

  const undo = () => {
    const waiting = waitingKeep.current;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    waitingKeep.current = null;
    unkeepOnPage(waiting.episodes);
    setToast(null);
  };

  const tagChip = (code: string, remove: () => void) => {
    const label = episodeLabel(code, multiSeason);
    return (
      <button type="button" key={code} className="um-chip um-ep-tag" aria-label={`去掉 ${label}`} onClick={remove}>
        {label}
        <b aria-hidden="true">×</b>
      </button>
    );
  };

  const renderEditor = () =>
    editing ? (
      <div className="um-edit">
        <div className="um-composer is-open">
          <textarea
            aria-label="修改留言"
            rows={1}
            maxLength={BODY_MAX}
            value={editing.body}
            autoFocus
            onChange={(event) => {
              const body = event.target.value;
              setEditing((cur) => (cur ? { ...cur, body } : cur));
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(null);
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                saveEdit();
              }
            }}
          />
          {editing.tags.length > 0 ? (
            <div className="um-tools">
              {editing.tags.map((code) => tagChip(code, () => setEditing((cur) => (cur ? { ...cur, tags: cur.tags.filter((t) => t !== code) } : cur))))}
            </div>
          ) : null}
        </div>
        <div className="um-msg-actions">
          <button type="button" className="um-btn is-ghost" onClick={() => setEditing(null)}>
            取消
          </button>
          <button type="button" className="um-btn is-go" onClick={saveEdit} disabled={acting || !draftIsSendable(editing.body)}>
            保存
          </button>
        </div>
      </div>
    ) : null;

  const renderUserMessage = (m: ThreadMessage) => {
    const label = statusLabel(m, nextPatrol, busy);
    const inline = m.episodeTags.map((code) => episodeLabel(code, multiSeason)).filter(Boolean);
    const snippet = m.body.length > 30 ? `${m.body.slice(0, 30)}…` : m.body;
    return (
      <div className="um-msg" key={m.id}>
        <div className="um-av is-me" aria-hidden="true">
          我
        </div>
        <div>
          <div className="um-who">
            <b>你</b>
            <span>{relativeDayLabel(m.createdAt, now)}</span>
            {label ? <span className={`um-status ${m.status === "pending" ? "is-wait" : "is-done"}`}>{label}</span> : null}
          </div>
          {editingId === m.id ? (
            renderEditor()
          ) : (
            <>
              <div className={`um-body${m.status === "pending" ? "" : " is-locked"}`}>
                {inline.map((tag) => (
                  <span className="um-ep-inline" key={tag}>
                    {tag}
                  </span>
                ))}
                {inline.length > 0 ? " " : null}
                {m.body}
              </div>
              {m.status === "pending" ? (
                <div className="um-msg-actions">
                  <button
                    type="button"
                    className="um-btn is-ghost"
                    onClick={() => {
                      setError(null);
                      setEditing({ id: m.id, body: m.body, tags: m.episodeTags });
                    }}
                    disabled={acting}
                    aria-label={`修改这条留言：${snippet}`}
                  >
                    修改
                  </button>
                  <button type="button" className="um-btn is-ghost" onClick={() => withdraw(m.id)} disabled={acting} aria-label={`撤回这条留言：${snippet}`}>
                    撤回
                  </button>
                  {nowId === m.id ? (
                    <button type="button" className="um-btn is-go" onClick={processNow} disabled={acting}>
                      <PlayIcon />
                      现在处理
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  };

  const renderWorking = (fallback: string, key: string) => (
    <div className="um-msg" key={key}>
      <div className="um-av is-agent" aria-hidden="true">
        <AgentIcon />
      </div>
      <div>
        <div className="um-who">
          <b>agent</b>
          <span className="um-status is-run">
            <span className="um-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            正在处理
          </span>
        </div>
        <div className="um-ticker" role="status" aria-live="polite">
          <span>{run.activity ?? fallback}</span>
        </div>
      </div>
    </div>
  );

  const renderReply = (exchange: Extract<Exchange, { kind: "answered" }>) => {
    if (!exchange.reply) return null;
    const reply = replyView(exchange.reply, { mediaType: work.mediaType, multiSeason, pending });
    const latest = exchange === latestAnswered;
    const foot = latest ? reply.foot : null;
    const another = latest && !composerShown;
    return (
      <div className="um-msg" key={`reply-${exchange.reply.runId}`}>
        <div className="um-av is-agent" aria-hidden="true">
          <AgentIcon />
        </div>
        <div>
          <div className="um-who">
            <b>agent</b>
            {reply.summary ? <span>{reply.summary}</span> : null}
          </div>
          {reply.rows.length > 0 ? <Tracks rows={reply.rows} movie={movie} onKeep={keep} /> : null}
          {reply.unidentified ? <p className="um-note">没看出是哪几集——用「选集数」标出来，再发一次</p> : null}
          {reply.rejectedNotSaved ? <p className="um-note is-faint">这次拒掉的版本没能记下来，之后搜索时可能还会看到它</p> : null}
          {reply.oldFilesLabel ? <OldFiles label={reply.oldFilesLabel} paths={reply.oldFiles} /> : null}
          {foot || another ? (
            <div className="um-reply-foot">
              {foot ? <span>{foot}</span> : null}
              {another ? (
                <button type="button" className="um-btn is-outline" onClick={reveal}>
                  再留一条
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const renderExchange = (exchange: Exchange) => {
    const messages = exchange.messages.map(renderUserMessage);
    if (exchange.kind === "working") return [...messages, renderWorking("正在看你的留言", `working-${exchange.messages[0]!.id}`)];
    if (exchange.kind === "answered") return [...messages, renderReply(exchange)];
    return messages;
  };

  const meta = last?.kind === "answered" && last.processedAt ? answeredMeta(last.processedAt, now) : "";
  const pickGroups = picking ? groupEpisodesBySeason(episodes) : [];

  return (
    <>
      {movie && pending.has("MOVIE") ? (
        <div className="um-movie-state">
          <span>
            <b>还在找别的版本。</b>现在这份先留着，之后每次巡检都会接着找。
          </span>
          <button type="button" className="um-btn is-outline" onClick={() => keep(["MOVIE"])}>
            不换了
          </button>
        </div>
      ) : null}
      <section className="um-thread" aria-label="给 agent 的留言">
        {view.messages.length > 0 ? (
          <div className="um-thread-head">
            <h3>给 agent 的留言</h3>
            {meta ? <span className="um-meta">{meta}</span> : null}
          </div>
        ) : null}
        {recent.flatMap(renderExchange)}
        {/* A run looking for 待换 episodes with no new message (queued by the patrol). */}
        {run.running && !exchanges.some((e) => e.kind === "working") ? renderWorking("正在接着找待换的集", "working-pending") : null}
        {composerShown ? (
          <div className={`um-compose${view.messages.length > 0 ? " is-below" : ""}`} onFocus={() => setFocused(true)} onBlur={onComposeBlur}>
            <div className={`um-composer${open ? " is-open" : ""}`} onMouseDown={onComposerMouseDown}>
              <textarea
                ref={textareaRef}
                aria-label="留言内容"
                rows={1}
                maxLength={BODY_MAX}
                value={draft}
                placeholder={composerPlaceholder({ mediaType: work.mediaType, active, open })}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onDraftKeyDown}
              />
              {open ? <div className="um-tools">{tags.map((code) => tagChip(code, () => setTags((cur) => cur.filter((t) => t !== code))))}</div> : null}
              {open && canPick ? (
                <button
                  type="button"
                  className="um-btn is-ghost"
                  aria-pressed={picking}
                  aria-controls={picking ? pickerId : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={togglePicking}
                >
                  选集数
                </button>
              ) : null}
              <button type="button" className="um-go" aria-label="发送" disabled={!draftIsSendable(draft) || sending} onClick={send}>
                <SendIcon />
              </button>
            </div>
            {open && picking ? (
              <div className="um-pick" id={pickerId}>
                {pickGroups.map((group) => (
                  <div key={group.season}>
                    {multiSeason ? <div className="um-pick-season">{`第 ${group.season} 季`}</div> : null}
                    <div className="episode-grid um-pick-grid" role="group" aria-label={multiSeason ? `第 ${group.season} 季：选要换的集` : "选要换的集"}>
                      {group.episodes.map((code) => {
                        const selected = tags.includes(code);
                        const swapping = !selected && pending.has(code);
                        return (
                          <button
                            type="button"
                            key={code}
                            className={`episode-cell obtained${swapping ? " swap" : ""}`}
                            aria-pressed={selected}
                            onClick={() => setTags((cur) => toggleEpisode(cur, code))}
                          >
                            <strong>{code.replace(/^S\d+/, "")}</strong>
                            <span>{selected ? "要换" : swapping ? "待换" : "已获取"}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div className="um-pick-bar">
                  <span>{tags.length > 0 ? `选了 ${tags.length} 集` : "在格子上点要换的集"}</span>
                  <button type="button" className="um-btn is-ghost" onClick={() => setTags([])} disabled={tags.length === 0}>
                    清空
                  </button>
                </div>
              </div>
            ) : null}
            {open ? (
              <div className="um-chips" role="group" aria-label="常见说法">
                {CHIPS.map((chip) => (
                  <button
                    type="button"
                    key={chip.label}
                    className="um-chip"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setDraft((cur) => appendChipText(cur, chip.fill));
                      textareaRef.current?.focus();
                    }}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="um-error" role="status">
            {error}
          </p>
        ) : null}
        {earlierCount > 0 ? (
          <details className="um-earlier">
            <summary>{`之前的留言 · ${earlierCount} 条`}</summary>
            <div className="um-earlier-body">{earlier.flatMap(renderExchange)}</div>
          </details>
        ) : null}
      </section>
      <div className="um-toast-row" role="status" aria-live="polite">
        {toast ? (
          <div className="um-toast">
            <span>{toast.text}</span>
            <button type="button" ref={undoRef} onClick={undo}>
              撤销
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** The reply as a track list (集 / 这次用的资源 / 大小 / 结果). */
function Tracks({ rows, movie, onKeep }: { rows: ReplyRow[]; movie: boolean; onKeep: (episodes: string[]) => void }) {
  return (
    <div className={`um-tracks${movie ? " is-movie" : ""}`} role="table" aria-label="这次的处理结果">
      {movie ? null : (
        <div className="um-tracks-head" role="row">
          <span role="columnheader">集</span>
          <span role="columnheader">这次用的资源</span>
          <span role="columnheader">大小</span>
          <span role="columnheader">结果</span>
        </div>
      )}
      {rows.map((row) => (
        <div key={row.episode} className={`um-track${row.state === "replaced" ? "" : " is-fail"}`} role="row">
          {movie ? null : (
            <span className="um-no" role="cell">
              {row.label}
            </span>
          )}
          <span className="um-res" role="cell">
            <b title={row.resource}>{row.resource}</b>
            {row.note ? <small title={row.note}>{row.note}</small> : null}
          </span>
          <span className="um-size" role="cell">
            {row.size}
          </span>
          <span className={`um-out ${OUT_TONE[row.state]}`} role="cell">
            {row.state === "replaced" ? (
              <>
                <CheckIcon />
                换好了
              </>
            ) : row.state === "looking" ? (
              <>
                <span className="um-out-label">
                  <RetryIcon />
                  继续找
                </span>
                {/* A film's 不换了 is on the red bar above the card. */}
                {movie ? null : (
                  <button type="button" className="um-keep" onClick={() => onKeep([row.episode])} aria-label={`${row.label} 不换了`}>
                    不换了
                  </button>
                )}
              </>
            ) : (
              "不找了"
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Where the old files are (never deleted by the agent), each with 复制路径. */
function OldFiles({ label, paths }: { label: string; paths: string[] }) {
  const id = useId();
  return (
    <div className={`um-oldfile${paths.length > 1 ? " is-list" : ""}`}>
      <span>{label}</span>
      <div className="um-oldfile-files">
        {paths.map((path, i) => (
          <div className="um-oldfile-row" key={path}>
            <code id={`${id}-${i}`} title={path}>
              {path}
            </code>
            <CopyPathButton path={path} describedBy={`${id}-${i}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 「复制路径」 → 「已复制」 for a moment; no toast. */
function CopyPathButton({ path, describedBy }: { path: string; describedBy: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    const ok = await copyText(path);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  return (
    <button type="button" className="um-copy" data-state={state === "copied" ? "copied" : undefined} aria-describedby={describedBy} onClick={() => void copy()}>
      {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制路径"}
    </button>
  );
}

async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back below.
    }
  }
  // Plain http on the LAN — a common self-hosted setup — has no Clipboard API.
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
}

// The mockup's icon set, 16×16, drawn in currentColor.
function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 8h10M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
