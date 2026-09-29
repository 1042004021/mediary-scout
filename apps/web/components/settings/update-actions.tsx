"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { checkForUpdatesAction, startUpdateAction } from "../../app/update-actions";
import { copyText } from "../../lib/copy-text";
import { ACTIVE_UPDATER_PHASES as ACTIVE } from "../../lib/update-state";
import type { UpdaterStatus } from "../../lib/updater-client";

const PROGRESS: Record<string, number> = { waiting: 5, backing_up: 15, building: 50, switching: 80, verifying: 92 };

export function UpdateNowButton({ tag, initial }: { tag: string | null; initial: UpdaterStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState<UpdaterStatus | null>(initial);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const running = status ? ACTIVE.has(status.phase) : false;
  // The script waits again right before the swap (phase "waiting" after "building");
  // never let the bar move backwards.
  const shown = useRef(0);
  if (status) shown.current = Math.max(shown.current, PROGRESS[status.phase] ?? 10);

  useEffect(() => {
    if (!running) return;
    let sawDown = false;
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch("/api/update/status", { cache: "no-store" });
          if (!response.ok) throw new Error(String(response.status));
          const next = ((await response.json()) as { updater: UpdaterStatus | null }).updater;
          if (stopped) return;
          const step = nextPollStep(next, sawDown);
          if (step === "reload") window.location.reload();
          else if (step === "wait") {
            // The updater did not answer (it may be restarting): keep the bar and keep polling.
            sawDown = true;
            setMessage("正在重启…");
          } else setStatus(next);
        } catch {
          if (stopped) return;
          sawDown = true;
          setMessage("正在重启…");
        }
      })();
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running]);

  if (running && status) {
    return (
      <div className="update-progress" role="status">
        <div className="update-muted">{message || status.message}</div>
        <div className="update-bar">
          <i style={{ width: `${shown.current}%` }} />
        </div>
      </div>
    );
  }
  if (!tag) return null;
  return (
    <div className="update-now">
      <button
        type="button"
        className="primary-button"
        disabled={pending}
        onClick={() => {
          startTransition(() => {
            void startUpdateAction(tag).then(
              (result) => {
                setMessage(result.message);
                if (result.ok) setStatus({ ...(status ?? emptyStatus()), phase: "waiting", message: "准备更新…" });
                // Another tab or the scheduled update already started one. The server
                // render has the live progress; pull it in so "已经在更新了。" becomes a bar.
                else if (result.reason === "busy") router.refresh();
              },
              () => setMessage("连不上更新助手，稍后再试。"),
            );
          });
        }}
      >
        立即更新
      </button>
      {message ? <span className="update-muted">{message}</span> : null}
    </div>
  );
}

export function CheckUpdatesButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="ghost-button"
      disabled={pending}
      onClick={() => {
        startTransition(() => {
          void checkForUpdatesAction().then(
            () => router.refresh(),
            () => undefined,
          );
        });
      }}
    >
      {pending ? "检查中…" : "检查更新"}
    </button>
  );
}

export function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost-button"
      onClick={() => {
        void copyText(command).then((ok) => {
          setCopied(ok);
          if (ok) window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

/** What the progress poller does with one /api/update/status answer. A null status is
 *  not "done": the updater may be restarting, and clearing the status would unmount the
 *  poller, which would then never reload the page. */
export function nextPollStep(next: UpdaterStatus | null, sawDown: boolean): "reload" | "wait" | "show" {
  if (!next) return "wait";
  if (sawDown || !ACTIVE.has(next.phase)) return "reload";
  return "show";
}

function emptyStatus(): UpdaterStatus {
  return { phase: "idle", targetTag: null, fromCommit: null, startedAt: null, finishedAt: null, message: "", logTail: "" };
}
