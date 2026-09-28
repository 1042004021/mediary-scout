import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("logs non-200 and unparsable busy responses into the job log and does not treat them as busy", async () => {
    const replies = [
      { status: 500, body: "nope" },
      { status: 200, body: "<html>login</html>" },
    ];
    let n = 0;
    const { updater } = make({
      acquisitionsRunning: async () => replies[n++],
    });
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status().phase).toBe("done");
    expect(updater.status().logTail).toContain("==> BUSY_CHECK http 500");
    updater.start("v2026.10.02");
    await updater.idle();
    expect(updater.status().phase).toBe("done");
    expect(updater.status().logTail).toContain("==> BUSY_CHECK unparsable");
  });
});

describe("interpretBusyResponse", () => {
  it("trusts only a 200 JSON boolean and logs everything else", () => {
    expect(interpretBusyResponse(200, '{"busy":true}')).toEqual({ busy: true });
    expect(interpretBusyResponse(200, '{"busy":false}')).toEqual({ busy: false });
    expect(interpretBusyResponse(401, '{"busy":true}')).toMatchObject({ busy: false, log: "==> BUSY_CHECK http 401" });
    expect(interpretBusyResponse(200, '<html>{"busy":true}')).toMatchObject({ busy: false, log: "==> BUSY_CHECK unparsable" });
    expect(interpretBusyResponse(0, "")).toMatchObject({ busy: false, log: "==> BUSY_CHECK unreachable" });
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
