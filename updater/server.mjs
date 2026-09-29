// Mediary Scout updater: the only process with Docker access. Listens on the compose
// network only (no published port). One job at a time; status persisted to the state dir.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Same shape as apps/web/lib/release-version.ts TAG_RE, plus that file's calendar check
// (v2026.02.31 matches the pattern and is still not a date). Keep the two in sync.
const TAG_RE = /^v(20\d{2})\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(?:\.([2-9]|[1-9]\d+))?$/;

const PHASE_MESSAGES = {
  idle: "",
  waiting: "有任务在进行，等它结束再继续。",
  backing_up: "正在备份数据库。",
  building: "正在构建新版本，构建期间一切照常。",
  switching: "正在替换，网页会短暂打不开，完成后自动刷新。",
  verifying: "正在检查新版本是否正常。",
  done: "更新完成。",
  rolled_back: "新版本没通过自检，已自动回到原来的版本，一切照常。",
  failed: "更新没成功，原来的版本仍在运行。",
};

const TERMINAL_PHASES = new Set(["idle", "done", "rolled_back", "failed"]);
const STEP_PHASES = new Set(["waiting", "backing_up", "building", "switching", "verifying"]);
const INTERRUPTED_MESSAGE = "更新被中断了，原来的版本仍在运行。";
const RESUME_ROLLBACK_MESSAGE = "更新中途被打断，正在回到原来的版本。";
const ROLLING_BACK_MESSAGE = "新版本没通过自检，正在回到原来的版本，网页会短暂打不开。";
const MAX_BODY = 1024;

export function isReleaseTag(value) {
  if (typeof value !== "string") return false;
  const match = TAG_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

function idleStatus() {
  return {
    phase: "idle",
    targetTag: null,
    fromCommit: null,
    startedAt: null,
    finishedAt: null,
    message: "",
    logTail: "",
  };
}

/** Only a 200 JSON `{"busy": false}` means idle. A failed or odd answer counts as busy
 *  (keep waiting) and is logged: starting on a failed probe could cut running tasks. */
export function interpretBusyResponse(status, body) {
  if (status !== 200) {
    return {
      busy: true,
      failed: true,
      log: status ? `==> BUSY_CHECK http ${status}` : "==> BUSY_CHECK unreachable",
    };
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.busy === "boolean") return { busy: parsed.busy, failed: false };
  } catch {
    // fall through
  }
  return { busy: true, failed: true, log: "==> BUSY_CHECK unparsable" };
}

export function readLimitedBody(stream, limit = MAX_BODY) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    stream.on("data", (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        finish({ error: "too_big" });
        return;
      }
      chunks.push(buf);
    });
    stream.on("end", () => finish({ body: Buffer.concat(chunks).toString("utf8") }));
    stream.on("error", () => finish({ error: "too_big" }));
  });
}

/** Write-then-rename in the same directory: a kill mid-write never leaves a truncated
 *  status.json, which would drop the recorded commit a rollback needs. */
function writeStatusFile(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function createUpdater(opts) {
  const statusFile = join(opts.stateDir, "status.json");
  let status = idleStatus();
  if (existsSync(statusFile)) {
    try {
      const loaded = JSON.parse(readFileSync(statusFile, "utf8"));
      if (loaded && typeof loaded === "object") status = { ...idleStatus(), ...loaded };
    } catch {
      status = idleStatus();
    }
  }
  // A job cut off by an updater restart is not running any more. Where it stopped
  // decides what to do: after the swap began, the new version may be the one
  // serving, so go back to the recorded commit; before it, the old version never
  // stopped, but the deploy folder may be left on the new tag, so check it back out.
  // `pendingRestore` stays in the file until the restore succeeds, so a second restart
  // retries it; the phase already says the update failed and the old version kept running.
  let resume = null;
  const from = typeof status.fromCommit === "string" && /^[0-9a-f]{40}$/.test(status.fromCommit) ? status.fromCommit : null;
  if (!TERMINAL_PHASES.has(status.phase)) {
    const swapStarted = status.phase === "switching" || status.phase === "verifying";
    if (from && swapStarted) {
      resume = { mode: "rollback", commit: from };
      status = { ...status, phase: "switching", message: RESUME_ROLLBACK_MESSAGE, finishedAt: null };
    } else {
      if (from) resume = { mode: "restore", commit: from };
      status = {
        ...status,
        phase: "failed",
        message: INTERRUPTED_MESSAGE,
        finishedAt: opts.now(),
        ...(from ? { pendingRestore: true } : {}),
      };
    }
    writeStatusFile(statusFile, status);
  } else if (status.pendingRestore === true && from) {
    resume = { mode: "restore", commit: from };
  }
  let job = null;
  // Seeded from the saved tail, so a recovery after a restart adds to the lines that
  // explain the interruption instead of replacing them. A new update starts it over.
  const log = typeof status.logTail === "string" && status.logTail ? status.logTail.split("\n") : [];

  const save = (patch) => {
    status = { ...status, ...patch };
    if (patch.phase && !Object.prototype.hasOwnProperty.call(patch, "message")) {
      status.message = PHASE_MESSAGES[patch.phase] ?? status.message;
    }
    status.logTail = log.slice(-40).join("\n");
    writeStatusFile(statusFile, status);
  };

  // Whether the last probe failed, so the give-up message can say why.
  let lastProbeFailed = false;
  async function acquisitionsBusy() {
    const result = await opts.acquisitionsRunning();
    if (typeof result === "boolean") {
      lastProbeFailed = false;
      return result;
    }
    const code = result && typeof result.status === "number" ? result.status : 0;
    const body = result && typeof result.body === "string" ? result.body : "";
    const interpreted = interpretBusyResponse(code, body);
    lastProbeFailed = interpreted.failed;
    if (interpreted.log && log.at(-1) !== interpreted.log) {
      log.push(interpreted.log);
      save({});
    }
    return interpreted.busy;
  }

  async function run(tag) {
    const { pendingRestore: _stale, ...fresh } = status;
    status = fresh;
    log.length = 0;
    save({ phase: "waiting", targetTag: tag, fromCommit: null, startedAt: opts.now(), finishedAt: null });
    let waited = 0;
    while (await acquisitionsBusy()) {
      if (waited >= opts.waitLimitMs) {
        const message = lastProbeFailed ? "连不上网页服务，这次先不更新了。" : "有任务一直没结束，这次先不更新了。";
        save({ phase: "failed", message, finishedAt: opts.now() });
        return;
      }
      await opts.sleep(opts.waitPollMs);
      waited += opts.waitPollMs;
    }
    let buildFailed = false;
    // Set once this job has saved switching or verifying. From then on the saved phase never
    // goes back to a pre-swap one: a restart during the rollback would read it as "the old
    // version never stopped" and only check the folder out, leaving the failed version up.
    let pastSwap = false;
    const code = await opts.runUpdate(tag, (line) => {
      log.push(line);
      if (line.startsWith("==> BUILD_FAILED")) buildFailed = true;
      const from = /^==> FROM ([0-9a-f]{40})/.exec(line);
      if (from) save({ fromCommit: from[1] });
      if (line.startsWith("==> VERIFY_FAILED") || line.startsWith("==> UP_FAILED")) {
        pastSwap = true;
        save({ phase: "switching", message: ROLLING_BACK_MESSAGE });
      }
      const step = /^==> STEP (\w+)/.exec(line);
      if (step && STEP_PHASES.has(step[1])) {
        const swapPhase = step[1] === "switching" || step[1] === "verifying";
        if (swapPhase) pastSwap = true;
        if (swapPhase || !pastSwap) save({ phase: step[1] });
      }
    });
    const outcome =
      code === 0
        ? { phase: "done" }
        : code === 10
          ? buildFailed
            ? { phase: "rolled_back", message: "新版本构建没成功，原来的版本一直在运行，没有受影响。" }
            : { phase: "rolled_back" }
          : code === 20
            ? {
                phase: "failed",
                message: "新版本没通过自检，自动回退也没成功。请在部署目录运行 ./scripts/deploy.sh 恢复。",
                needsManualRecovery: true,
              }
            : code === 30
              ? {
                  phase: "failed",
                  message:
                    "部署目录里有改过的文件，自动更新不会覆盖它们。请先还原或提交这些改动（git status 可以看到），再更新。",
                }
              : code === 40
                ? { phase: "failed", message: "替换前没能让网页暂停开始新任务，这次先不更新了，原来的版本一直在运行。" }
                : code === 50
                  ? // Still serving the old version, but the checkout is left on the new tag: retry it.
                    { phase: "failed", message: INTERRUPTED_MESSAGE, pendingRestore: true }
                  : { phase: "failed" };
    save({ ...outcome, finishedAt: opts.now() });
    if (code === 50 && status.fromCommit) await resumeAfterRestart({ mode: "restore", commit: status.fromCommit });
  }

  async function resumeAfterRestart({ mode, commit }) {
    const code = await opts.runUpdate([mode, commit], (line) => {
      log.push(line);
      save({});
    });
    if (mode === "restore") {
      // The status already says the update was cut off and the old version kept running.
      if (code === 0) {
        const { pendingRestore: _done, ...rest } = status;
        status = rest;
      } else {
        log.push("==> RESTORE_FAILED");
      }
      save({});
      return;
    }
    save({
      ...(code === 10
        ? { phase: "rolled_back", message: "更新中途被打断，已自动回到原来的版本，一切照常。" }
        : {
            phase: "failed",
            message: "更新中途被打断，自动回退也没成功。请在部署目录运行 ./scripts/deploy.sh 恢复。",
            needsManualRecovery: true,
          }),
      finishedAt: opts.now(),
    });
  }
  if (resume) {
    job = resumeAfterRestart(resume).finally(() => {
      job = null;
    });
  }

  return {
    // repoCommit is read fresh: it is the deploy folder's HEAD, which the web falls back
    // to when its image has no BUILD_COMMIT (built without GIT_SHA).
    status: () => ({ ...status, repoCommit: opts.repoCommit() }),
    start(tag) {
      if (!isReleaseTag(tag)) return { accepted: false, reason: "bad_tag" };
      if (job) return { accepted: false, reason: "busy" };
      // A rollback that failed needs a person (./scripts/deploy.sh). Once the running web
      // serves the deploy folder's HEAD again, that happened: clear it and go on.
      if (status.needsManualRecovery === true) {
        const head = opts.repoCommit();
        const serving = opts.servingCommit ? opts.servingCommit() : null;
        if (!head || head !== serving) return { accepted: false, reason: "needs_recovery" };
        const { needsManualRecovery: _cleared, ...rest } = status;
        status = rest;
        save({});
      }
      // A cut-off update's checkout is not back on the old commit yet: try that again
      // first. The new update runs only once it worked, from the right commit.
      if (status.pendingRestore === true && typeof status.fromCommit === "string") {
        const commit = status.fromCommit;
        job = resumeAfterRestart({ mode: "restore", commit })
          .then(() => (status.pendingRestore === true ? undefined : run(tag)))
          .finally(() => {
            job = null;
          });
        return { accepted: true };
      }
      job = run(tag).finally(() => {
        job = null;
      });
      return { accepted: true };
    },
    idle: () => job ?? Promise.resolve(),
  };
}

function sameToken(presented, expected) {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function createUpdaterHttp(updater, token) {
  return (req, res) => {
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!presented || !sameToken(presented, token)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(updater.status()));
      return;
    }
    if (req.method === "POST" && req.url === "/update") {
      readLimitedBody(req, MAX_BODY)
        .then((result) => {
          if (result.error) {
            res.writeHead(400).end();
            return;
          }
          let tag = null;
          try {
            tag = JSON.parse(result.body).tag;
          } catch {
            tag = null;
          }
          const outcome = updater.start(tag);
          const status = outcome.accepted ? 202 : outcome.reason === "busy" || outcome.reason === "needs_recovery" ? 409 : 400;
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(outcome));
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(400).end();
        });
      return;
    }
    res.writeHead(404).end();
  };
}

/** Runs run-update.sh with a release tag, or with ["rollback" | "restore", commit]. */
function shellRunner(scriptPath) {
  return (args, onLine) =>
    new Promise((resolve) => {
      const argv = Array.isArray(args) ? args : [args];
      const child = spawn("sh", [scriptPath, ...argv], { cwd: process.env.UPDATER_REPO_DIR ?? "/repo" });
      let buffer = "";
      const feed = (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) onLine(line);
      };
      child.stdout.on("data", feed);
      child.stderr.on("data", feed);
      child.on("close", (code) => {
        if (buffer) onLine(buffer);
        resolve(code ?? 20);
      });
    });
}

function loadToken(stateDir) {
  const file = join(stateDir, "token");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o644 });
  return readFileSync(file, "utf8").trim();
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const stateDir = process.env.UPDATER_STATE_DIR ?? "/state";
  mkdirSync(stateDir, { recursive: true });
  const token = loadToken(stateDir);
  const webBase = process.env.UPDATER_WEB_BASE ?? "http://web:3000";
  const updater = createUpdater({
    stateDir,
    runUpdate: shellRunner(join(fileURLToPath(new URL(".", import.meta.url)), "run-update.sh")),
    acquisitionsRunning: async () => {
      try {
        const response = await fetch(`${webBase}/api/update/busy`, {
          headers: { authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        return { status: response.status, body: await response.text() };
      } catch {
        return { status: 0, body: "" };
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date().toISOString(),
    waitPollMs: 30_000,
    waitLimitMs: 2 * 60 * 60 * 1000,
    // The commit the running web container was built from (its BUILD_COMMIT).
    servingCommit: () => {
      try {
        const project = execFileSync(
          "docker",
          ["inspect", "-f", '{{ index .Config.Labels "com.docker.compose.project" }}', hostname()],
          { encoding: "utf8" },
        ).trim();
        const commit = execFileSync(
          "docker",
          ["compose", "-p", project, "--project-directory", process.env.UPDATER_REPO_DIR ?? "/repo", "exec", "-T", "web", "cat", "BUILD_COMMIT"],
          // stderr: compose prints its variable warnings there; keep them out of the log.
          { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
      } catch {
        return null;
      }
    },
    // As the deploy folder's owner (see run-update.sh), so git does not refuse the repo.
    repoCommit: () => {
      try {
        const owner = execFileSync("stat", ["-c", "%u:%g", process.env.UPDATER_REPO_DIR ?? "/repo"], {
          encoding: "utf8",
        }).trim();
        const head = execFileSync("su-exec", [owner, "git", "-C", process.env.UPDATER_REPO_DIR ?? "/repo", "rev-parse", "HEAD"], {
          encoding: "utf8",
          env: { ...process.env, HOME: "/tmp" },
        }).trim();
        return /^[0-9a-f]{40}$/.test(head) ? head : null;
      } catch {
        return null;
      }
    },
  });
  createServer(createUpdaterHttp(updater, token)).listen(8787, "0.0.0.0", () => {
    console.log("[updater] listening on :8787 (compose network only)");
  });
}
