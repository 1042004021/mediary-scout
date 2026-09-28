import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  dialog,
  nativeImage,
  net,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pickFreePort,
  buildServerEnv,
  waitForHealthy,
  httpProbe,
  resolveServerEntry,
} from "./server-launch.js";
import { onWindowClose, trayMenuState, type TrayItem } from "./lifecycle.js";
import {
  loadOrCreateAgentToken,
  buildAgentManifest,
  agentManifestPath,
  writeAgentManifest,
} from "./agent-manifest.js";
import { APP_ID } from "./app-identity.js";
import { linkTarget } from "./external-links.js";
import {
  RELEASES_LATEST_URL,
  decideUpdateNotice,
  parseLatestRelease,
  shouldCheckForUpdate,
  type LatestRelease,
} from "./update-check.js";

let serverProc: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let serverBooted = false;
// A newer published release, once a check has found one (tray item + notification).
let offeredUpdate: LatestRelease | null = null;
let lastUpdateCheckAt: number | null = null;
// Held so its click handler is not garbage-collected with it.
let updateNotification: Notification | null = null;

const FIRST_UPDATE_CHECK_DELAY_MS = 60_000;
const UPDATE_TICK_MS = 60 * 60_000;

// Single-instance lock: a 2nd launch focuses the existing window instead of
// spawning a second server (which would fight over the SQLite DB + patrol).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Windows shows a notification only when this matches the AppUserModelID on the Start
  // Menu shortcut, which electron-builder's NSIS sets to the appId.
  if (process.platform === "win32") app.setAppUserModelId(APP_ID);

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // macOS: clicking the Dock icon after the window was closed-to-tray should bring
  // it back (the standard "activate" gesture), not require a relaunch.
  app.on("activate", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });
  app.on("will-quit", () => {
    // SIGTERM the server child so it exits cleanly; WAL keeps SQLite durable.
    serverProc?.kill("SIGTERM");
    serverProc = null;
  });

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    dialog.showErrorBox(
      "Mediary Scout",
      `启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
    app.quit();
  });
}

async function bootstrap(): Promise<void> {
  const url = await startServer();
  createWindow(url);
  createTray();
  startUpdateChecks();
}

async function startServer(): Promise<string> {
  const port = await pickFreePort();
  const sqlitePath = path.join(app.getPath("userData"), "mediary.db");
  const agentToken = loadOrCreateAgentToken({
    tokenFilePath: path.join(app.getPath("userData"), "agent-token"),
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (p, content, mode) => writeFileSync(p, content, { mode }),
    randomBytes,
  });
  const entry = resolveServerEntry({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // dev: apps/desktop/dist/main.js → repo root is three levels up.
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
  });
  serverProc = spawn(process.execPath, [entry], {
    // The standalone server reads BUILD_COMMIT relative to its own folder; Next's server.js also chdirs there, this just does not depend on it.
    cwd: path.dirname(entry),
    env: {
      ...buildServerEnv({ port, sqlitePath, baseEnv: process.env }),
      MEDIA_TRACK_AGENT_TOKEN: agentToken,
    },
    stdio: "inherit",
  });
  serverProc.on("exit", (code) => {
    const wasBooted = serverBooted;
    serverProc = null;
    serverBooted = false;
    refreshTray(); // reflect the stopped server in the tray menu
    // Only surface an error for an UNEXPECTED exit AFTER a successful boot. A crash
    // DURING startup is already reported by bootstrap()'s catch — don't double-dialog.
    if (!isQuitting && wasBooted) {
      dialog.showErrorBox("Mediary Scout", `服务进程意外退出（code ${code ?? "null"}）。`);
    }
  });
  const url = `http://127.0.0.1:${port}/`;
  // Race the health wait against spawn failures AND an early child exit. spawn() reports
  // launch failures (ENOENT/EACCES) via an async "error" event; a booted-then-crashed
  // child (Next bundle error, missing native ABI, runtime exception) exits with a code.
  // Either must fail FAST (surfaced once by bootstrap()'s catch, with the exit code for
  // diagnosis) instead of hanging out the 60s health timeout with a generic message.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    serverProc!.once("error", (err) =>
      finish(() => reject(new Error(`无法启动服务进程：${err.message}`))),
    );
    serverProc!.once("exit", (code) =>
      finish(() => reject(new Error(`服务进程启动时退出（code ${code ?? "null"}）。`))),
    );
    waitForHealthy({ probe: httpProbe(url), timeoutMs: 60_000, intervalMs: 250 }).then(
      () => finish(resolve),
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
  serverBooted = true;
  writeAgentManifest({
    manifestPath: agentManifestPath(os.homedir()),
    content: buildAgentManifest({ port, token: agentToken, version: app.getVersion() }),
    mkdir: (p) => mkdirSync(p, { recursive: true, mode: 0o700 }),
    writeFile: (p, content, mode) => writeFileSync(p, content, { mode }),
  });
  return url;
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // 显示用中文主名;技术标识(appId / productName)保持英文不变 —— 改那些会让
    // 系统认成另一个应用,老用户升级时装出两份、数据还不通。
    title: "巡影 · Mediary Scout",
    show: true,
  });
  const serverOrigin = new URL(url).origin;
  // Links out of the app (GitHub, 请作者喝杯咖啡, installer downloads) open in the system
  // browser; Electron would otherwise open them in a new app window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    const kind = linkTarget(target, serverOrigin);
    if (kind === "external") void shell.openExternal(target).catch(() => undefined);
    return kind === "app" ? { action: "allow" } : { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => {
    const kind = linkTarget(event.url, serverOrigin);
    // Only the app's own server may navigate this window. file:, javascript:, data:
    // and other schemes are dropped; http(s) elsewhere opens in the system browser.
    if (kind === "app") return;
    event.preventDefault();
    if (kind === "external") void shell.openExternal(event.url).catch(() => undefined);
  });
  mainWindow.on("close", (event) => {
    const decision = onWindowClose({ isQuitting });
    if (decision.preventDefault) event.preventDefault();
    if (decision.hideWindow) mainWindow?.hide();
  });
  void mainWindow.loadURL(url);
}

// A 22×22 monochrome "play" glyph as a macOS template image (black + alpha; the OS
// recolors it for light/dark menu bars). Embedded as a data URL so the tray is VISIBLE
// with no external asset / packaging step — close-to-tray is the primary lifecycle, so
// an invisible icon would make the app inoperable.
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAN0lEQVR42mNgGAUDCf7T0uD/tDSY6hb8x4FpZvB/WhpMkQX/aWX4gBo8NCJv8GeQoVMIjQLqAABeq02ztviApQAAAABJRU5ErkJggg==";

function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  icon.setTemplateImage(true); // macOS: auto-recolor for the menu bar
  tray = new Tray(icon);
  tray.setToolTip("巡影 · Mediary Scout");
  refreshTray();
}

function refreshTray(): void {
  if (!tray) return;
  const state = trayMenuState({
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    // Use serverBooted, not `serverProc !== null`: the process is non-null the instant
    // spawn() returns (before the health check passes), so serverProc would falsely show
    // "running" during startup / after an early crash.
    serverReady: serverBooted,
    update: offeredUpdate ? { tag: offeredUpdate.tag } : null,
  });
  const template: MenuItemConstructorOptions[] = state.items.map((item: TrayItem) => ({
    id: item.id,
    label: item.label,
    type: item.type,
    enabled: item.enabled,
    // Only set `checked` when the item actually has it (exactOptionalPropertyTypes forbids
    // passing an explicit `undefined` to an optional-only prop).
    ...(item.checked !== undefined ? { checked: item.checked } : {}),
    click: () => handleTrayClick(item.id),
  }));
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function handleTrayClick(id: TrayItem["id"]): void {
  if (id === "open") {
    mainWindow?.show();
    mainWindow?.focus();
  } else if (id === "update") {
    if (offeredUpdate) void shell.openExternal(offeredUpdate.pageUrl).catch(() => undefined);
  } else if (id === "openAtLogin") {
    const next = !app.getLoginItemSettings().openAtLogin;
    app.setLoginItemSettings({ openAtLogin: next });
    refreshTray();
  } else if (id === "quit") {
    isQuitting = true;
    app.quit();
  }
}

/** Packaged builds only: a dev build reports the repo's placeholder version. */
function startUpdateChecks(): void {
  if (!app.isPackaged) return;
  setTimeout(() => void checkForUpdate(), FIRST_UPDATE_CHECK_DELAY_MS);
  // Hourly against the wall clock: a laptop that slept through the day still checks when it wakes.
  setInterval(() => {
    if (shouldCheckForUpdate({ now: Date.now(), lastCheckedAt: lastUpdateCheckAt })) void checkForUpdate();
  }, UPDATE_TICK_MS);
}

async function checkForUpdate(): Promise<void> {
  try {
    // Electron's network stack: follows the system proxy settings, unlike Node's fetch.
    const response = await net.fetch(RELEASES_LATEST_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": `mediary-scout-desktop/${app.getVersion()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.log(`[update] check failed: HTTP ${response.status}`);
      return;
    }
    const latest = parseLatestRelease(await response.json());
    if (latest === null) {
      // Keep the tray offer; a hiccup or a half-uploaded release is not a reason to forget it.
      console.log("[update] latest release is not complete yet; will retry");
      return;
    }
    lastUpdateCheckAt = Date.now();
    const notice = decideUpdateNotice({ latest, currentVersion: app.getVersion(), notifiedTag: readNotifiedTag() });
    offeredUpdate = notice.offer;
    refreshTray();
    console.log(`[update] ${notice.offer ? `offering ${notice.offer.tag}` : `up to date (${app.getVersion()})`}`);
    if (notice.notify && notice.offer) showUpdateNotification(notice.offer);
  } catch (error) {
    // Offline or rate-limited: the hourly tick tries again.
    console.log(`[update] check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function showUpdateNotification(update: LatestRelease): void {
  if (!Notification.isSupported()) return;
  updateNotification = new Notification({ title: "巡影有新版本", body: `${update.tag} 已发布，点这里查看和下载。` });
  updateNotification.on("click", () => void shell.openExternal(update.pageUrl).catch(() => undefined));
  updateNotification.show();
  writeNotifiedTag(update.tag);
}

function notifiedTagPath(): string {
  return path.join(app.getPath("userData"), "update-notified-tag");
}

function readNotifiedTag(): string | null {
  try {
    return readFileSync(notifiedTagPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeNotifiedTag(tag: string): void {
  try {
    writeFileSync(notifiedTagPath(), `${tag}\n`);
  } catch {
    // Not fatal: the notice would show once more on the next launch.
  }
}
