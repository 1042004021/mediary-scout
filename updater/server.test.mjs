import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseReleaseTag } from "../apps/web/lib/release-version.ts";
import { createUpdater, createUpdaterHttp, interpretBusyResponse, isReleaseTag, readLimitedBody } from "./server.mjs";

const SAMPLES = [
  "v2026.09.28",
  "v2026.09.28.2",
  "v2026.09.28.10",
  "v2028.02.29",
  "v1.4.1",
  "2026.09.28",
  "v2026.9.28",
  "v2026.13.01",
  "v2026.09.28.0",
  "v2026.09.28.02",
  "main",
  "v2026.09.28;rm -rf /",
  "",
  "v2026.02.31",
  "v2026.02.29",
  "v2026.04.31",
  "v2026.11.31",
];

function fakeRunner(lines, code) {
  return (_tag, onLine) =>
    new Promise((resolve) => {
      for (const line of lines) onLine(line);
      resolve(code);
    });
}

function make(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "updater-"));
  const updater = createUpdater({
    stateDir: dir,
    runUpdate:
      opts.runUpdate ??
      fakeRunner(
        ["==> STEP backing_up", "==> STEP building", "==> STEP switching", "==> STEP verifying", "==> DONE v2026.10.02"],
        0,
      ),
    acquisitionsRunning: opts.acquisitionsRunning ?? (async () => false),
    sleep: async () => {},
    now: () => "2026-10-02T20:00:00.000Z",
    waitPollMs: 1,
    waitLimitMs: opts.waitLimitMs ?? 1000,
    repoCommit: () => "a".repeat(40),
  });
  return { updater, dir };
}

function call(port, { method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(updater, token, fn) {
  const server = createServer(createUpdaterHttp(updater, token));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    return await fn(typeof address === "object" && address ? address.port : 0);
  } finally {
    server.close();
    await once(server, "close");
  }
}

describe("updater", () => {
  it("accepts the same tags as the web release parser", () => {
    for (const sample of SAMPLES) {
      expect(isReleaseTag(sample)).toBe(parseReleaseTag(sample) !== null);
    }
  });

  it("runs an update to done and persists the status", async () => {
    const { updater, dir } = make();
    expect(updater.start("v2026.10.02").accepted).toBe(true);
    await updater.idle();
    expect(updater.status()).toMatchObject({ phase: "done", targetTag: "v2026.10.02" });
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).phase).toBe("done");
  });

  it("reports the deploy folder's commit with every status", () => {
    const { updater } = make();
    expect(updater.status().repoCommit).toBe("a".repeat(40));
  });

  it("refuses a non-release ref", () => {
    const { updater } = make();
    expect(updater.start("main")).toEqual({ accepted: false, reason: "bad_tag" });
    expect(updater.start("v2026.10.02; rm -rf /")).toEqual({ accepted: false, reason: "bad_tag" });
    for (const sample of SAMPLES) {
      if (parseReleaseTag(sample)) continue;
      expect(updater.start(sample)).toEqual({ accepted: false, reason: "bad_tag" });
    }
  });

  it("refuses a second update while one is running", async () => {
    const { updater } = make();
    updater.start("v2026.10.02");
    expect(updater.start("v2026.10.02")).toEqual({ accepted: false, reason: "busy" });
    await updater.idle();
  });

  it("maps exit 10 to rolled_back, and says the old version never stopped when the build failed", async () => {
    const { updater } = make({ runUpdate: fakeRunner(["==> STEP building", "==> BUILD_FAILED"], 10) });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "rolled_back",
      message: "新版本构建没成功，原来的版本一直在运行，没有受影响。",
    });
  });

  it("maps a failed check after the swap to rolled_back with the rollback message", async () => {
    const { updater } = make({
      runUpdate: fakeRunner(["==> STEP switching", "==> STEP verifying", "==> VERIFY_FAILED", "==> ROLLED_BACK"], 10),
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "rolled_back",
      message: "新版本没通过自检，已自动回到原来的版本，一切照常。",
    });
  });

  it("maps exit 30 (edited files in the deploy folder) to a failed update that says why", async () => {
    const { updater } = make({ runUpdate: fakeRunner(["==> LOCAL_CHANGES", " M docker-compose.yml"], 30) });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status().phase).toBe("failed");
    expect(updater.status().message).toContain("部署目录里有改过的文件");
  });

  it("waits for tasks, and gives up after the limit", async () => {
    const { updater } = make({ acquisitionsRunning: async () => true, waitLimitMs: 0 });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({ phase: "failed", message: "有任务一直没结束，这次先不更新了。" });
  });

  it("says a task is in progress while it waits", async () => {
    let updater;
    let seen = "";
    const made = make({
      waitLimitMs: 10_000,
      acquisitionsRunning: async () => {
        if (!seen) {
          seen = updater.status().message;
          return true;
        }
        return false;
      },
    });
    updater = made.updater;
    updater.start("v2026.10.02");
    await updater.idle();
    expect(seen).toBe("有任务在进行，等它结束再继续。");
    expect(updater.status().phase).toBe("done");
  });

  it("loads a status persisted as building as failed", () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        phase: "building",
        targetTag: "v2026.10.02",
        fromCommit: "c".repeat(40),
        startedAt: "2026-10-02T19:00:00.000Z",
        finishedAt: null,
        message: "正在构建新版本，构建期间一切照常。",
        logTail: "",
      }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: fakeRunner([], 0),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    expect(updater.status()).toMatchObject({
      phase: "failed",
      message: "更新被中断了，原来的版本仍在运行。",
      finishedAt: "2026-10-02T20:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).phase).toBe("failed");
  });

  it("after a restart during the swap, goes back to the recorded commit", async () => {
    for (const phase of ["switching", "verifying"]) {
      const dir = mkdtempSync(join(tmpdir(), "updater-"));
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({ phase, targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
      );
      const calls = [];
      const updater = createUpdater({
        stateDir: dir,
        runUpdate: (args, onLine) => {
          calls.push(args);
          onLine("==> ROLLED_BACK");
          return Promise.resolve(10);
        },
        acquisitionsRunning: async () => false,
        sleep: async () => {},
        now: () => "2026-10-02T20:00:00.000Z",
        waitPollMs: 1,
        waitLimitMs: 1000,
        repoCommit: () => "a".repeat(40),
      });
      // Busy while the rollback runs: a new update must not start on top of it.
      expect(updater.start("v2026.10.03")).toEqual({ accepted: false, reason: "busy" });
      await updater.idle();
      expect(calls).toEqual([["rollback", "c".repeat(40)]]);
      expect(updater.status()).toMatchObject({
        phase: "rolled_back",
        message: "更新中途被打断，已自动回到原来的版本，一切照常。",
        finishedAt: "2026-10-02T20:00:00.000Z",
      });
      expect(updater.status().logTail).toContain("==> ROLLED_BACK");
    }
  });

  it("says a person is needed when that rollback fails too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "verifying", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: () => Promise.resolve(20),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "failed",
      message: "更新中途被打断，自动回退也没成功。请在部署目录运行 ./scripts/deploy.sh 恢复。",
    });
  });

  it("after a restart before the swap, only checks the old commit back out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "building", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const calls = [];
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args) => {
        calls.push(args);
        return Promise.resolve(0);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    await updater.idle();
    expect(calls).toEqual([["restore", "c".repeat(40)]]);
    expect(updater.status()).toMatchObject({ phase: "failed", message: "更新被中断了，原来的版本仍在运行。" });
  });

  it("retries a cut-off restore on the next start, and stops once it succeeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ phase: "building", targetTag: "v2026.10.02", fromCommit: "c".repeat(40), startedAt: "x", finishedAt: null, message: "", logTail: "" }),
    );
    const boot = (code, calls) =>
      createUpdater({
        stateDir: dir,
        runUpdate: (args) => {
          calls.push(args);
          return code === "hang" ? new Promise(() => {}) : Promise.resolve(code);
        },
        acquisitionsRunning: async () => false,
        sleep: async () => {},
        now: () => "2026-10-02T20:00:00.000Z",
        waitPollMs: 1,
        waitLimitMs: 1000,
        repoCommit: () => "a".repeat(40),
      });
    // First start: the restore is killed before it finishes.
    const first = [];
    boot("hang", first);
    expect(first).toEqual([["restore", "c".repeat(40)]]);
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))).toMatchObject({ phase: "failed", pendingRestore: true });
    // Second start: tried again, and it works.
    const second = [];
    const updater = boot(0, second);
    await updater.idle();
    expect(second).toEqual([["restore", "c".repeat(40)]]);
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).pendingRestore).toBeUndefined();
    // Third start: nothing left to do.
    const third = [];
    await boot(0, third).idle();
    expect(third).toEqual([]);
  });

  it("a new update first retries a pending restore, and does not start while it keeps failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        phase: "failed",
        targetTag: "v2026.10.02",
        fromCommit: "c".repeat(40),
        startedAt: "x",
        finishedAt: "y",
        message: "更新被中断了，原来的版本仍在运行。",
        logTail: "",
        pendingRestore: true,
      }),
    );
    const calls = [];
    let restoreCode = 1;
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: (args) => {
        calls.push(args);
        if (Array.isArray(args)) return Promise.resolve(restoreCode);
        return Promise.resolve(0);
      },
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => "a".repeat(40),
    });
    await updater.idle(); // the start-up retry, which fails
    calls.length = 0;
    expect(updater.start("v2026.10.03")).toEqual({ accepted: true });
    await updater.idle();
    expect(calls).toEqual([["restore", "c".repeat(40)]]); // failed again: no update ran
    expect(updater.status().pendingRestore).toBe(true);

    restoreCode = 0;
    calls.length = 0;
    updater.start("v2026.10.03");
    await updater.idle();
    expect(calls).toEqual([["restore", "c".repeat(40)], "v2026.10.03"]);
    expect(updater.status()).toMatchObject({ phase: "done", targetTag: "v2026.10.03" });
    expect(updater.status().pendingRestore).toBeUndefined();
  });

  it("exit 50 records a pending restore and retries it right away", async () => {
    const calls = [];
    let restoreCode = 1;
    const { updater } = make({
      runUpdate: (args, onLine) => {
        calls.push(args);
        if (Array.isArray(args)) return Promise.resolve(restoreCode);
        onLine(`==> FROM ${"c".repeat(40)}`);
        onLine("==> RESTORE_FAILED");
        return Promise.resolve(50);
      },
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(calls).toEqual(["v2026.10.02", ["restore", "c".repeat(40)]]);
    expect(updater.status()).toMatchObject({ phase: "failed", pendingRestore: true, message: "更新被中断了，原来的版本仍在运行。" });

    restoreCode = 0;
    calls.length = 0;
    updater.start("v2026.10.03");
    await updater.idle();
    expect(calls[0]).toEqual(["restore", "c".repeat(40)]);
    expect(updater.status().pendingRestore).toBeUndefined();
  });

  it("writes status.json atomically, leaving no temp file behind", async () => {
    const { updater, dir } = make();
    updater.start("v2026.10.02");
    await updater.idle();
    expect(readdirSync(dir).sort()).toEqual(["status.json"]);
  });

  it("maps exit 40 (could not pause new tasks) to a failed update that says nothing was swapped", async () => {
    const { updater } = make({ runUpdate: fakeRunner(["==> HOLD_FAILED"], 40) });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({
      phase: "failed",
      message: "替换前没能让网页暂停开始新任务，这次先不更新了，原来的版本一直在运行。",
    });
  });

  it("keeps a finished status across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        phase: "done",
        targetTag: "v2026.10.02",
        fromCommit: null,
        startedAt: "2026-10-02T19:00:00.000Z",
        finishedAt: "2026-10-02T19:10:00.000Z",
        message: "更新完成。",
        logTail: "",
      }),
    );
    const updater = createUpdater({
      stateDir: dir,
      runUpdate: fakeRunner([], 0),
      acquisitionsRunning: async () => false,
      sleep: async () => {},
      now: () => "2026-10-02T20:00:00.000Z",
      waitPollMs: 1,
      waitLimitMs: 1000,
      repoCommit: () => null,
    });
    expect(updater.status().phase).toBe("done");
    expect(updater.status().message).toBe("更新完成。");
  });

  it("keeps waiting through failed and unparsable busy answers, logging each once, then updates", async () => {
    const replies = [
      { status: 500, body: "nope" },
      { status: 500, body: "nope" },
      { status: 200, body: "<html>login</html>" },
      { status: 0, body: "" },
      { status: 200, body: '{"busy":false}' },
    ];
    let n = 0;
    let started = false;
    const { updater } = make({
      acquisitionsRunning: async () => replies[n++],
      runUpdate: (_tag, onLine) => {
        started = true;
        onLine("==> DONE v2026.10.02");
        return Promise.resolve(0);
      },
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(n).toBe(5);
    expect(started).toBe(true);
    expect(updater.status().phase).toBe("done");
    const checks = updater.status().logTail.split("\n").filter((line) => line.startsWith("==> BUSY_CHECK"));
    expect(checks).toEqual(["==> BUSY_CHECK http 500", "==> BUSY_CHECK unparsable", "==> BUSY_CHECK unreachable"]);
  });

  it("gives up with a web-service message when the probe never works", async () => {
    let started = false;
    const { updater } = make({
      acquisitionsRunning: async () => ({ status: 0, body: "" }),
      waitLimitMs: 0,
      runUpdate: () => {
        started = true;
        return Promise.resolve(0);
      },
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(started).toBe(false);
    expect(updater.status()).toMatchObject({ phase: "failed", message: "连不上网页服务，这次先不更新了。" });
  });

  it("gives up with the busy message when the web keeps saying busy", async () => {
    const { updater } = make({ acquisitionsRunning: async () => ({ status: 200, body: '{"busy":true}' }), waitLimitMs: 0 });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status()).toMatchObject({ phase: "failed", message: "有任务一直没结束，这次先不更新了。" });
  });
});

describe("interpretBusyResponse", () => {
  it("trusts only a 200 JSON boolean; everything else counts as busy and is logged", () => {
    expect(interpretBusyResponse(200, '{"busy":true}')).toEqual({ busy: true, failed: false });
    expect(interpretBusyResponse(200, '{"busy":false}')).toEqual({ busy: false, failed: false });
    expect(interpretBusyResponse(401, '{"busy":false}')).toMatchObject({ busy: true, failed: true, log: "==> BUSY_CHECK http 401" });
    expect(interpretBusyResponse(302, "")).toMatchObject({ busy: true, failed: true, log: "==> BUSY_CHECK http 302" });
    expect(interpretBusyResponse(200, '<html>{"busy":false}')).toMatchObject({ busy: true, failed: true, log: "==> BUSY_CHECK unparsable" });
    expect(interpretBusyResponse(200, '{"busy":"no"}')).toMatchObject({ busy: true, failed: true });
    expect(interpretBusyResponse(0, "")).toMatchObject({ busy: true, failed: true, log: "==> BUSY_CHECK unreachable" });
  });
});

describe("readLimitedBody", () => {
  it("rejects once the running total passes the cap, even when each chunk is smaller", async () => {
    const stream = new PassThrough();
    const pending = readLimitedBody(stream, 1024);
    stream.write(Buffer.alloc(600, 0x61));
    stream.write(Buffer.alloc(600, 0x62));
    stream.end();
    await expect(pending).resolves.toEqual({ error: "too_big" });
  });

  it("returns a body that fits", async () => {
    const stream = new PassThrough();
    const pending = readLimitedBody(stream, 1024);
    stream.end('{"tag":"v2026.10.02"}');
    await expect(pending).resolves.toEqual({ body: '{"tag":"v2026.10.02"}' });
  });
});

describe("updater http", () => {
  it("rejects a missing or wrong token, including one of a different length", async () => {
    const { updater } = make();
    await withServer(updater, "t0k3n", async (port) => {
      expect((await call(port, { method: "GET", path: "/status" })).status).toBe(401);
      expect((await call(port, { method: "GET", path: "/status", token: "nope" })).status).toBe(401);
      expect((await call(port, { method: "GET", path: "/status", token: "t0k3n-longer" })).status).toBe(401);
      const ok = await call(port, { method: "GET", path: "/status", token: "t0k3n" });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body).repoCommit).toBe("a".repeat(40));
    });
  });

  it("does not start an update when the POST body exceeds the cap", async () => {
    let runs = 0;
    const { updater } = make({
      runUpdate: () => {
        runs += 1;
        return Promise.resolve(0);
      },
    });
    const body = JSON.stringify({ tag: "v2026.10.02", padding: "x".repeat(2000) });
    await withServer(updater, "t0k3n", async (port) => {
      const response = await call(port, { method: "POST", path: "/update", token: "t0k3n", body });
      expect(response.status).toBe(400);
    });
    await updater.idle();
    expect(runs).toBe(0);
    expect(updater.status().phase).toBe("idle");
  });

  it("starts an update for a release tag and refuses a second one", async () => {
    let release = () => {};
    const { updater } = make({
      // Hold the job open: a fast fake would finish before the second POST is sent.
      runUpdate: (_tag, onLine) =>
        new Promise((resolve) => {
          release = () => {
            onLine("==> STEP building");
            resolve(0);
          };
        }),
    });
    await withServer(updater, "t0k3n", async (port) => {
      const accepted = await call(port, {
        method: "POST",
        path: "/update",
        token: "t0k3n",
        body: JSON.stringify({ tag: "v2026.10.02" }),
      });
      expect(accepted.status).toBe(202);
      const again = await call(port, {
        method: "POST",
        path: "/update",
        token: "t0k3n",
        body: JSON.stringify({ tag: "v2026.10.02" }),
      });
      expect(again.status).toBe(409);
      release();
    });
    await updater.idle();
    expect(updater.status().phase).toBe("done");
  });
});
