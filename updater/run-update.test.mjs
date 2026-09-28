import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./run-update.sh", import.meta.url));
const FROM = "a".repeat(40);
const TAG_COMMIT = "b".repeat(40);
const TAG = "v2026.10.02";

function writeExe(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** One line per invocation: `name arg arg ...`. Shared by every stub via STUB_LOG. */
const LOG_FN = `
log_call() {
  printf '%s' "$1" >> "$STUB_LOG"
  shift
  for arg in "$@"; do
    printf ' %s' "$arg" >> "$STUB_LOG"
  done
  printf '\\n' >> "$STUB_LOG"
}
`;

function installStubs(bin) {
  writeExe(bin, "stat", `#!/bin/sh\n${LOG_FN}\nlog_call stat "$@"\nif [ "\${1-}" = "-c" ]; then printf '%s:%s\\n' "$(id -u)" "$(id -g)"; fi\n`);
  writeExe(bin, "hostname", `#!/bin/sh\n${LOG_FN}\nlog_call hostname "$@"\nprintf '%s\\n' updater-test\n`);
  writeExe(bin, "sleep", `#!/bin/sh\nexit 0\n`);
  writeExe(bin, "chown", `#!/bin/sh\n${LOG_FN}\nlog_call chown "$@"\nexit 0\n`);
  writeExe(
    bin,
    "su-exec",
    `#!/bin/sh\n${LOG_FN}\nlog_call su-exec "$@"\nshift\nexec "$@"\n`,
  );
  writeExe(
    bin,
    "wget",
    `#!/bin/sh
${LOG_FN}
case "$*" in
  *--post-data*)
    log_call hold "$@"
    if [ -f "$STUB_DIR/fail-hold" ]; then exit 1; fi
    printf '%s\\n' '{"ok":true}'
    exit 0
    ;;
esac
log_call wget "$@"
n=0
if [ -f "$STUB_DIR/wget-n" ]; then n=$(cat "$STUB_DIR/wget-n"); fi
n=$((n + 1))
printf '%s\\n' "$n" > "$STUB_DIR/wget-n"
if [ -f "$STUB_DIR/wget-lines" ]; then
  line=$(sed -n "\${n}p" "$STUB_DIR/wget-lines" || true)
  if [ -z "$line" ]; then line=$(tail -n 1 "$STUB_DIR/wget-lines" || true); fi
else
  line='{"busy":false}'
fi
if [ "$line" = FAIL ]; then exit 1; fi
printf '%s\\n' "$line"
`,
  );
  writeExe(
    bin,
    "git",
    `#!/bin/sh
${LOG_FN}
log_call git "$@"
cmd=""
for arg in "$@"; do
  case "$arg" in
    status|rev-parse|fetch|checkout) cmd="$arg" ;;
  esac
done
case "$cmd" in
  status)
    if [ -f "$STUB_DIR/status-out" ]; then cat "$STUB_DIR/status-out"; fi
    ;;
  rev-parse)
    cat "$STUB_DIR/head"
    ;;
  fetch)
    ;;
  checkout)
    ref=""
    for arg in "$@"; do ref="$arg"; done
    case "$ref" in
      refs/tags/*) printf '%s\\n' "$GIT_TAG_COMMIT" > "$STUB_DIR/head" ;;
      *) printf '%s\\n' "$ref" > "$STUB_DIR/head" ;;
    esac
    ;;
  *)
    echo "unexpected git: $*" >&2
    exit 99
    ;;
esac
`,
  );
  writeExe(
    bin,
    "docker",
    `#!/bin/sh
${LOG_FN}
log_call docker "$@"
if [ "\${1-}" = "inspect" ]; then
  printf '%s\\n' mediary
  exit 0
fi
args="$*"
if printf '%s' "$args" | grep -q pg_dump; then
  if [ -f "$STUB_DIR/fail-pg-dump" ]; then exit 1; fi
  printf '%s\\n' DUMP
  exit 0
fi
if printf '%s' "$args" | grep -q 'build web'; then
  printf '%s\\n' "\${GIT_SHA-}" >> "$STUB_DIR/git-shas"
  if [ -f "$STUB_DIR/fail-build" ]; then exit 1; fi
  exit 0
fi
if printf '%s' "$args" | grep -q ' up '; then
  n=0
  if [ -f "$STUB_DIR/up-n" ]; then n=$(cat "$STUB_DIR/up-n"); fi
  n=$((n + 1))
  printf '%s\\n' "$n" > "$STUB_DIR/up-n"
  if [ -f "$STUB_DIR/fail-first-up" ] && [ "$n" = 1 ]; then exit 1; fi
  exit 0
fi
if printf '%s' "$args" | grep -q 'BUILD_COMMIT'; then
  last=""
  if [ -f "$STUB_DIR/git-shas" ]; then last=$(tail -n 1 "$STUB_DIR/git-shas"); fi
  if [ -f "$STUB_DIR/never-report" ]; then
    printf '%s\\n' mismatch
    exit 0
  fi
  if [ -f "$STUB_DIR/hide-shas" ] && grep -qx "$last" "$STUB_DIR/hide-shas"; then
    printf '%s\\n' mismatch
    exit 0
  fi
  printf '%s\\n' "$last"
  exit 0
fi
if printf '%s' "$args" | grep -q 'node -e'; then
  exit 0
fi
echo "unexpected docker: $*" >&2
exit 99
`,
  );
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "run-update-"));
  const repo = join(root, "repo");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const stubDir = join(root, "stub");
  mkdirSync(repo);
  mkdirSync(state);
  mkdirSync(bin);
  mkdirSync(stubDir);
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(stubDir, "head"), `${FROM}\n`);
  writeFileSync(join(state, "token"), "t0k3n\n");
  installStubs(bin);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    UPDATER_REPO_DIR: repo,
    UPDATER_STATE_DIR: state,
    UPDATER_WEB_BASE: "http://web.test:3000",
    STUB_DIR: stubDir,
    STUB_LOG: log,
    GIT_TAG_COMMIT: TAG_COMMIT,
  };
  return { repo, stubDir, log, env };
}

function run(env, tag = TAG) {
  return runArgs(env, [tag]);
}

function runArgs(env, args) {
  return new Promise((resolve) => {
    const child = spawn("sh", [SCRIPT, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function linesOf(log) {
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

/** docker / git / wget calls, in order, reduced to the step the script meant. */
function signatures(log) {
  return linesOf(log)
    .filter((line) => /^(docker|git|wget|hold) /.test(line))
    .map((line) => {
      if (line.startsWith("hold ")) return line.includes('{"hold":true}') ? "hold" : "release";
      if (line.startsWith("wget ")) return "wget";
      if (line.includes("pg_dump")) return "pg_dump";
      if (line.includes("build web")) return "build";
      if (line.includes(" up ")) return "up";
      if (line.includes("BUILD_COMMIT")) return "cat_commit";
      if (line.includes("node -e") || line.includes(" node ")) return "health";
      if (line.startsWith("docker ") && line.includes(" inspect ")) return "inspect";
      if (line.startsWith("git ") && line.includes(" status ")) return "status";
      if (line.startsWith("git ") && line.includes(" rev-parse ")) return "rev-parse";
      if (line.startsWith("git ") && line.includes(" fetch ")) return "fetch";
      if (line.startsWith("git ") && line.includes(" checkout ")) return `checkout ${line.trim().split(" ").at(-1)}`;
      return line;
    });
}

function gitShas(stubDir) {
  return readFileSync(join(stubDir, "git-shas"), "utf8").trim().split("\n");
}

describe("run-update.sh", { timeout: 60_000 }, () => {
  it("updates, backing up before the build and swapping only web", async () => {
    const { repo, stubDir, log, env } = setup();
    const result = await run(env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(signatures(log)).toEqual([
      "status",
      "inspect",
      "rev-parse",
      "pg_dump",
      "fetch",
      `checkout refs/tags/${TAG}`,
      "rev-parse",
      "build",
      "hold",
      "wget",
      "up",
      "cat_commit",
      "health",
    ]);
    const hold = linesOf(log).find((line) => line.startsWith("hold "));
    expect(hold).toContain("http://web.test:3000/api/update/hold");
    expect(hold).toContain("Bearer t0k3n");
    const dockerLines = linesOf(log).filter((line) => line.startsWith("docker "));
    const dumpAt = dockerLines.findIndex((line) => line.includes("pg_dump"));
    const buildAt = dockerLines.findIndex((line) => line.includes("build web"));
    expect(dumpAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeGreaterThan(dumpAt);
    const ups = dockerLines.filter((line) => line.includes(" up "));
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatch(/up -d --no-deps web$/);
    expect(ups[0]).toContain(`--project-directory ${repo}`);
    const wget = linesOf(log).find((line) => line.startsWith("wget "));
    expect(wget).toContain("http://web.test:3000/api/update/busy");
    expect(wget).toContain("Bearer t0k3n");
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT]);
    const backups = readdirSync(join(repo, "backups"));
    const gz = backups.filter((name) => name.endsWith(".sql.gz"));
    expect(gz).toEqual([expect.stringMatching(/^pre-update-\d{8}-\d{6}\.sql\.gz$/)]);
    expect(backups.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(result.stdout).toContain(`==> DONE ${TAG}`);
  });

  it("stops before docker or checkout when tracked files are edited", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "status-out"), " M docker-compose.yml\n");
    const result = await run(env);
    expect(result.code).toBe(30);
    expect(result.stdout).toContain("==> LOCAL_CHANGES");
    expect(linesOf(log).some((line) => line.startsWith("docker "))).toBe(false);
    expect(linesOf(log).some((line) => line.includes(" checkout"))).toBe(false);
    expect(signatures(log).every((step) => step === "status")).toBe(true);
  });

  it("checks the previous commit back out when the build fails, and does not swap", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-build"), "1");
    const result = await run(env);
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> BUILD_FAILED");
    expect(signatures(log)).toEqual([
      "status",
      "inspect",
      "rev-parse",
      "pg_dump",
      "fetch",
      `checkout refs/tags/${TAG}`,
      "rev-parse",
      "build",
      `checkout ${FROM}`,
    ]);
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT]);
  });

  it("rolls back when the new container never reports the target commit", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "hide-shas"), `${TAG_COMMIT}\n`);
    const result = await run(env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> ROLLED_BACK");
    expect(result.stdout).not.toContain("ROLLBACK_FAILED");
    const steps = signatures(log);
    expect(steps.filter((step) => step === "cat_commit")).toHaveLength(91);
    expect(steps.filter((step) => step === "build")).toHaveLength(2);
    expect(steps.filter((step) => step === "up")).toHaveLength(2);
    for (const line of linesOf(log).filter((entry) => entry.includes(" up "))) {
      expect(line).toMatch(/up -d --no-deps web$/);
    }
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT, FROM]);
    expect(steps.filter((step) => step.startsWith("checkout "))).toEqual([
      `checkout refs/tags/${TAG}`,
      `checkout ${FROM}`,
    ]);
  });

  it("exits 20 when the rollback never verifies either", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "never-report"), "1");
    const result = await run(env);
    expect(result.code).toBe(20);
    expect(result.stdout).toContain("==> ROLLBACK_FAILED");
    expect(result.stdout).not.toContain("==> ROLLED_BACK");
    const steps = signatures(log);
    expect(steps.filter((step) => step === "cat_commit")).toHaveLength(180);
    expect(steps.filter((step) => step === "health")).toHaveLength(0);
    expect(steps.filter((step) => step === "build")).toHaveLength(2);
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT, FROM]);
    expect(steps).toContain(`checkout ${FROM}`);
  });

  it("accepts only real release tags, the same rule as the web", async () => {
    const accepted = ["v2026.10.02", "v2026.10.02.2", "v2026.10.02.12", "v2028.02.29", "v2000.02.29", "v2026.12.31"];
    const rejected = [
      "main",
      "v2026.10.02;rm -rf /",
      "v2026.10.02.2foo",
      "v2026.10.02.1",
      "v2026.10.02.01",
      "v2026.02.29",
      "v2026.02.30",
      "v2026.04.31",
      "v2026.13.01",
      "v2026.00.10",
      "v1900.02.29",
      "v2026.10.02 ",
      "v2026.10.02\nx",
      "",
    ];
    for (const tag of accepted) {
      const { env } = setup();
      const result = await run(env, tag);
      expect({ tag, code: result.code }).toEqual({ tag, code: 0 });
    }
    for (const tag of rejected) {
      const { log, env } = setup();
      const result = await run(env, tag);
      expect({ tag, code: result.code }).toEqual({ tag, code: 2 });
      expect(linesOf(log)).toEqual([]);
    }
  });

  it("rejects a non-release tag before calling anything", async () => {
    for (const tag of ["main", "v2026.10.02;rm -rf /"]) {
      const { log, env } = setup();
      const result = await run(env, tag);
      expect(result.code).not.toBe(0);
      expect(linesOf(log)).toEqual([]);
      expect(result.stdout).toContain("not a release tag");
    }
  });

  it("prints one waiting step, then switches once the busy probe goes idle", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n{"busy":true}\n{"busy":false}\n');
    const result = await run(env);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n").filter((line) => line === "==> STEP waiting")).toHaveLength(1);
    expect(result.stdout.indexOf("==> STEP waiting")).toBeLessThan(result.stdout.indexOf("==> STEP switching"));
    expect(signatures(log).filter((step) => step === "wget")).toHaveLength(3);
  });

  it("keeps waiting while the probe fails or answers something unexpected", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(
      join(stubDir, "wget-lines"),
      'FAIL\n<html>{"busy":false}</html>\n{"busy":false}garbage\n{"busy":true}\n{"busy":false}\n',
    );
    const result = await run(env);
    expect(result.code).toBe(0);
    const checks = result.stdout.split("\n").filter((line) => line.startsWith("==> BUSY_CHECK"));
    expect(checks).toEqual(["==> BUSY_CHECK unreachable", "==> BUSY_CHECK unexpected", "==> BUSY_CHECK busy"]);
    expect(signatures(log).filter((step) => step === "wget")).toHaveLength(5);
    expect(result.stdout.indexOf("==> BUSY_CHECK busy")).toBeLessThan(result.stdout.indexOf("==> STEP switching"));
  });

  it("switches after the wait limit when the probe never works, and says why", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "wget-lines"), "FAIL\n");
    const result = await run(env);
    expect(result.code).toBe(0);
    expect(signatures(log).filter((step) => step === "wget")).toHaveLength(60);
    expect(result.stdout).toContain("==> STILL_BUSY (unreachable)");
  });

  it("still waits and swaps when taking the hold fails", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-hold"), "1");
    const result = await run(env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("==> HOLD_FAILED");
    expect(signatures(log).filter((step) => step === "release")).toEqual([]);
  });

  it("never takes the hold when the build fails", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-build"), "1");
    await run(env);
    expect(signatures(log).some((step) => step === "hold" || step === "release")).toBe(false);
  });

  it("releases the hold when it stops after taking it and before the swap", async () => {
    const { stubDir, log, env } = setup();
    // An error while waiting after the hold: `sleep` fails, and set -e ends the script.
    writeFileSync(join(stubDir, "wget-lines"), '{"busy":true}\n');
    writeExe(join(stubDir, "..", "bin"), "sleep", "#!/bin/sh\nexit 1\n");
    const result = await run(env);
    expect(result.code).not.toBe(0);
    const steps = signatures(log);
    expect(steps).toContain("hold");
    expect(steps.at(-1)).toBe("release");
    expect(steps).not.toContain("up");
  });

  it("rolls back when `up` itself fails instead of exiting through set -e", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-first-up"), "1");
    const result = await run(env);
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> UP_FAILED");
    expect(result.stdout).toContain("==> ROLLED_BACK");
    expect(signatures(log).filter((step) => step === "up")).toHaveLength(2);
    expect(gitShas(stubDir)).toEqual([TAG_COMMIT, FROM]);
    // The swap was attempted, so the old process and its hold may be gone: no release.
    expect(signatures(log)).not.toContain("release");
  });

  it("rollback mode rebuilds and swaps back to the given commit, without a backup or a tag", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    const result = await runArgs(env, ["rollback", FROM]);
    expect(result.code).toBe(10);
    expect(result.stdout).toContain("==> RESUMED_ROLLBACK");
    expect(result.stdout).toContain("==> ROLLED_BACK");
    expect(signatures(log)).toEqual(["status", "inspect", `checkout ${FROM}`, "build", "up", "cat_commit", "health"]);
    expect(gitShas(stubDir)).toEqual([FROM]);
  });

  it("restore mode checks the old commit out and releases the hold", async () => {
    const { stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "head"), `${TAG_COMMIT}\n`);
    const result = await runArgs(env, ["restore", FROM]);
    expect(result.code).toBe(0);
    expect(signatures(log)).toEqual(["status", "inspect", `checkout ${FROM}`, "release"]);
  });

  it("rollback and restore refuse anything but a full commit id", async () => {
    for (const bad of ["main", "abc", `${FROM};id`, `${FROM}0`, ""]) {
      for (const mode of ["rollback", "restore"]) {
        const { log, env } = setup();
        const result = await runArgs(env, [mode, bad]);
        expect({ mode, bad, code: result.code }).toEqual({ mode, bad, code: 2 });
        expect(linesOf(log)).toEqual([]);
      }
    }
  });

  it("stops before checkout or build when pg_dump fails, and leaves no temp dump", async () => {
    const { repo, stubDir, log, env } = setup();
    writeFileSync(join(stubDir, "fail-pg-dump"), "1");
    const result = await run(env);
    expect(result.code).not.toBe(0);
    expect(signatures(log)).toEqual(["status", "inspect", "rev-parse", "pg_dump"]);
    const backups = readdirSync(join(repo, "backups"));
    expect(backups.filter((name) => name.endsWith(".sql.tmp"))).toEqual([]);
    expect(backups.filter((name) => name.endsWith(".sql.gz"))).toEqual([]);
  });
});
