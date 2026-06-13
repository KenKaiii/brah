import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  safeStorage,
  screen,
  shell,
  systemPreferences,
} from "electron";
import electronUpdater from "electron-updater";
import {
  computerUseBrowserDocsUrl,
  createOsPermissionSnapshot,
  getMacOsPrivacySettingsUrl,
  getWindowsPrivacySettingsUrl,
  isKnownOsPermissionId,
} from "./os-permissions.js";
import { buildRealtimeInstructions } from "./realtime/prompts.js";
import {
  listActivity,
  migrateLegacyActivityStore,
  recordActivity,
} from "./realtime/tools/activity-store.js";
import { loadAgentProfile, saveAgentProfile } from "./realtime/tools/agent-profile-store.js";
import { setDatabaseUserDataPath } from "./realtime/tools/database.js";
import { executeRealtimeTool, getRealtimeToolDefinitions } from "./realtime/tools/index.js";
import {
  loadMicrophoneDeviceId,
  saveMicrophoneDeviceId,
} from "./realtime/tools/microphone-store.js";
import {
  deleteCalendarItem,
  deleteTask,
  listCalendarItems,
  listTasks,
  migrateLegacyPlannerStore,
  updateTaskStatus,
} from "./realtime/tools/planner-store.js";
import { loadWindowPosition, saveWindowPosition } from "./realtime/tools/window-state-store.js";

const { autoUpdater } = electronUpdater;
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// When the launching terminal/parent closes the stdout/stderr pipe, console
// writes raise EPIPE. Without a listener Node turns that into an uncaught
// exception that kills the app, so swallow broken-pipe errors on both streams.
for (const stream of [process.stdout, process.stderr]) {
  stream.on?.("error", (error) => {
    if (error?.code !== "EPIPE" && error?.code !== "ERR_STREAM_DESTROYED") {
      throw error;
    }
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDevelopment = !app.isPackaged;

const openAIAuthConfig = Object.freeze({
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
  redirectHost: "localhost",
  redirectPort: 1455,
  redirectPath: "/auth/callback",
});

const realtimeDefaults = Object.freeze({
  model: "gpt-realtime-2",
  voice: "marin",
  sampleRate: 24_000,
});

const windowModes = Object.freeze({
  // `alwaysOnTop` is only set for the transient call overlay so it stays visible
  // while the user works in other apps. The main UI (orb/panel) behaves like a
  // normal window and can be sent behind other windows.
  orb: { width: 172, height: 188, placement: "bottom-right", alwaysOnTop: false },
  call: { width: 226, height: 52, placement: "bottom-center", alwaysOnTop: true },
  panel: { width: 440, height: 600, placement: "bottom-right", alwaysOnTop: false },
});

let mainWindow;
let windowMode = "panel";
let windowFadeTimer = null;
let windowFadeResolve = null;
let activeComputerUseController = null;
// User-chosen window position (set by dragging the panel), persisted across
// launches. Only the draggable main panel honors it; transient call/orb modes
// keep their anchored placement.
let userWindowPosition = null;
let suppressMoveSave = false;
let moveSaveTimer = null;
// Set while we resize the window ourselves, so the resize guard ignores it.
let suppressBoundsGuard = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: windowModes.panel.width,
    height: windowModes.panel.height,
    minWidth: windowModes.panel.width,
    minHeight: windowModes.panel.height,
    maxWidth: windowModes.panel.width,
    maxHeight: windowModes.panel.height,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: windowModes.panel.alwaysOnTop,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  applyWindowBounds(getWindowBoundsForMode(windowModes.panel, "panel"));
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Persist the position whenever the user drags the panel so it is restored on
  // the next launch. Programmatic moves (mode switches) are suppressed.
  mainWindow.on("move", handleWindowMove);
  // macOS auto-resizes this frameless, transparent window during screen capture
  // (desktopCapturer.getSources), ignoring even maxSize — it stretched the
  // computer-use pill to ~84px. Snap any unexpected resize back to the mode size.
  mainWindow.on("resize", enforceModeBounds);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url);
      if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") {
        shell.openExternal(url);
      }
    } catch {
      /* ignore malformed URL */
    }
    return { action: "deny" };
  });

  // Keep the renderer pinned to the packaged index.html so the privileged
  // window.brah bridge can never be inherited by a remote origin.
  const blockOffOrigin = (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  };
  mainWindow.webContents.on("will-navigate", blockOffOrigin);
  mainWindow.webContents.on("will-redirect", blockOffOrigin);
}

function handleWindowMove() {
  if (suppressMoveSave || windowMode !== "panel" || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (moveSaveTimer !== null) {
    clearTimeout(moveSaveTimer);
  }
  moveSaveTimer = setTimeout(() => {
    moveSaveTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const [x, y] = mainWindow.getPosition();
    userWindowPosition = { x, y };
    try {
      saveWindowPosition(userWindowPosition);
    } catch (error) {
      safeConsole("warn", "Failed to persist window position", error);
    }
  }, 400);
}

// Applies bounds without recording them as a user-initiated move or tripping the
// resize guard.
function applyWindowBounds(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  suppressMoveSave = true;
  suppressBoundsGuard = true;
  mainWindow.setBounds(bounds, false);
  setImmediate(() => {
    suppressMoveSave = false;
    suppressBoundsGuard = false;
  });
}

// Reverts any externally-driven resize (e.g. macOS during screen capture) back
// to the current mode's exact size, keeping the window's current position.
function enforceModeBounds() {
  if (suppressBoundsGuard || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const expected = windowModes[windowMode];
  if (!expected) {
    return;
  }
  const bounds = mainWindow.getBounds();
  if (bounds.width === expected.width && bounds.height === expected.height) {
    return;
  }
  suppressBoundsGuard = true;
  mainWindow.setBounds(
    { x: bounds.x, y: bounds.y, width: expected.width, height: expected.height },
    false,
  );
  setImmediate(() => {
    suppressBoundsGuard = false;
  });
}

function clampToVisibleArea(x, y, width, height) {
  const display = screen.getDisplayMatching({ x, y, width, height }) ?? screen.getPrimaryDisplay();
  const area = display.workArea;
  const clampedX = Math.min(Math.max(x, area.x), area.x + area.width - width);
  const clampedY = Math.min(Math.max(y, area.y), area.y + area.height - height);
  return { x: Math.round(clampedX), y: Math.round(clampedY) };
}

async function setMainWindowMode(mode, { animate = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return windowMode;
  }
  const target = windowModes[mode] ?? windowModes.orb;
  windowMode = windowModes[mode] ? mode : "orb";
  const targetBounds = getWindowBoundsForMode(target, windowMode);
  const currentBounds = mainWindow.getBounds();
  const sizeChanged =
    currentBounds.width !== targetBounds.width || currentBounds.height !== targetBounds.height;
  // When the renderer fades its own shell around the switch (`animate: false`),
  // skip the native window fade: the content is already invisible during the
  // resize, so a second fade only adds latency and a blank gap.
  if (sizeChanged && animate) {
    await fadeMainWindowTo(0, 110);
  }
  // Pin BOTH min and max to the mode size. This frameless, transparent window
  // is otherwise auto-grown by macOS during screen capture (it stretched the
  // computer-use pill to ~84px tall); locking max prevents any such resize.
  mainWindow.setMinimumSize(targetBounds.width, targetBounds.height);
  mainWindow.setMaximumSize(targetBounds.width, targetBounds.height);
  // Only the transient call overlay floats above other apps; the main UI is a
  // normal window so it can be sent behind other windows.
  mainWindow.setAlwaysOnTop(Boolean(target.alwaysOnTop));
  applyWindowBounds(targetBounds);
  if (sizeChanged && animate) {
    await fadeMainWindowTo(1, 130);
  }
  return windowMode;
}

function getWindowBoundsForMode(target, mode) {
  // The main panel is the only draggable surface, so it restores the user's
  // saved position; call/orb keep their anchored placement.
  if (mode === "panel" && userWindowPosition) {
    const { x, y } = clampToVisibleArea(
      userWindowPosition.x,
      userWindowPosition.y,
      target.width,
      target.height,
    );
    return { x, y, width: target.width, height: target.height };
  }
  const display = screen.getPrimaryDisplay();
  const margin = target.placement === "bottom-center" ? 14 : 24;
  const x =
    target.placement === "bottom-center"
      ? Math.round(display.workArea.x + (display.workArea.width - target.width) / 2)
      : Math.round(display.workArea.x + display.workArea.width - target.width - margin);
  return {
    x,
    y: Math.round(display.workArea.y + display.workArea.height - target.height - margin),
    width: target.width,
    height: target.height,
  };
}

function endActiveFade() {
  if (windowFadeTimer !== null) {
    clearInterval(windowFadeTimer);
    windowFadeTimer = null;
  }
  // Resolve a superseded fade's promise so anything awaiting it (e.g. the
  // window:set-mode IPC handler) never hangs — a hung await leaves the IPC
  // reply unsent ("reply was never sent").
  if (windowFadeResolve !== null) {
    const resolvePrevious = windowFadeResolve;
    windowFadeResolve = null;
    resolvePrevious();
  }
}

function fadeMainWindowTo(targetOpacity, duration) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve();
  }
  endActiveFade();
  const startOpacity = mainWindow.getOpacity();
  const startedAt = Date.now();

  return new Promise((resolve) => {
    windowFadeResolve = resolve;
    windowFadeTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        endActiveFade();
        return;
      }
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      const opacity = startOpacity + (targetOpacity - startOpacity) * eased;
      mainWindow.setOpacity(Math.max(0.01, Math.min(1, opacity)));
      if (progress >= 1) {
        clearInterval(windowFadeTimer);
        windowFadeTimer = null;
        windowFadeResolve = null;
        mainWindow.setOpacity(targetOpacity);
        resolve();
      }
    }, 1000 / 60);
  });
}

function wireUpdateEvents() {
  autoUpdater.autoDownload = false;

  autoUpdater.on("checking-for-update", () => {
    mainWindow?.webContents.send("update:status", "Checking for updates…");
  });

  autoUpdater.on("update-available", () => {
    mainWindow?.webContents.send("update:status", "Update available. Downloading…");
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on("update-not-available", () => {
    mainWindow?.webContents.send("update:status", "You are running the latest version.");
  });

  autoUpdater.on("error", (error) => {
    mainWindow?.webContents.send("update:status", `Update error: ${error.message}`);
  });

  autoUpdater.on("update-downloaded", () => {
    mainWindow?.webContents.send("update:status", "Update downloaded. It will install on restart.");
  });
}

ipcMain.handle("app:get-version", () => app.getVersion());
ipcMain.handle("update:check", async () => {
  if (isDevelopment) {
    return "Updates are checked only in packaged builds.";
  }

  await autoUpdater.checkForUpdates();
  return "Update check started.";
});

ipcMain.handle("openai:get-status", async () => {
  const [credentials, apiKey] = await Promise.all([
    getFreshOpenAICredentials(),
    loadOpenAIApiKey(),
  ]);
  const base = credentials ? credentialsToStatus(credentials) : { connected: false };
  const authMethod = apiKey ? "api-key" : credentials ? "oauth" : null;
  return {
    ...base,
    connected: Boolean(apiKey) || base.connected,
    authMethod,
    apiKey: apiKeyToStatus(apiKey),
  };
});

ipcMain.handle("openai:set-api-key", async (_event, key) => {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!isPlausibleOpenAIApiKey(trimmed)) {
    throw new Error("That doesn't look like an OpenAI API key (expected sk-…).");
  }
  await verifyOpenAIApiKey(trimmed);
  await saveOpenAIApiKey(trimmed);
  await writeDiagnosticLog("openai.api_key.saved", { length: trimmed.length });
  return apiKeyToStatus(trimmed);
});

ipcMain.handle("openai:clear-api-key", async () => {
  await clearOpenAIApiKey();
  await writeDiagnosticLog("openai.api_key.cleared", {});
  return apiKeyToStatus(null);
});

ipcMain.handle("openai:login", async () => {
  const credentials = await loginOpenAI();
  return credentialsToStatus(credentials);
});

ipcMain.handle("openai:logout", async () => {
  await clearOpenAICredentials();
  return { connected: false };
});

ipcMain.handle("openai:create-realtime-secret", async (_event, options = {}) => {
  // API key takes precedence over OAuth: it is the path users explicitly pay
  // for, and the OAuth realtime route is currently broken upstream (CLAUDE.md).
  const apiKey = await loadOpenAIApiKey();
  const credentials = apiKey ? null : await getFreshOpenAICredentials();
  if (!apiKey && !credentials) {
    throw new Error("Add an API key or sign in to OpenAI before starting Realtime.");
  }

  const profile = loadAgentProfile();
  return createRealtimeClientSecret(apiKey ?? credentials.accessToken, {
    ...options,
    model: profile.model,
    voice: profile.voice,
    instructions: buildRealtimeInstructions({ profile }),
    authMethod: apiKey ? "api-key" : "oauth",
  });
});

ipcMain.handle("agent:get-profile", () => loadAgentProfile());
ipcMain.handle("agent:set-profile", (_event, profile) => saveAgentProfile(profile));
ipcMain.handle("audio:get-microphone", () => loadMicrophoneDeviceId());
ipcMain.handle("audio:set-microphone", (_event, deviceId) => saveMicrophoneDeviceId(deviceId));

ipcMain.handle("planner:list-tasks", () => listTasks());
ipcMain.handle("planner:list-calendar", () => listCalendarItems());
ipcMain.handle("planner:delete-tasks", (_event, ids) => deletePlannerTasks(ids));
ipcMain.handle("planner:complete-tasks", (_event, ids) => completePlannerTasks(ids));
ipcMain.handle("planner:delete-calendar-items", (_event, ids) => deletePlannerCalendarItems(ids));
ipcMain.handle("activity:list", (_event, kind) => listActivity(kind));
ipcMain.handle("screenshots:list", () => listScreenshots());
ipcMain.handle("screenshots:reveal", (_event, name) => revealScreenshot(name));
ipcMain.handle("screenshots:delete", (_event, names) => deleteScreenshots(names));
ipcMain.handle("window:set-mode", (_event, mode, options) => setMainWindowMode(mode, options));
ipcMain.handle("window:set-focusable", (_event, focusable) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  mainWindow.setFocusable(Boolean(focusable));
  return Boolean(focusable);
});
ipcMain.handle("window:minimize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  mainWindow.minimize();
  return true;
});
ipcMain.handle("app:quit", () => {
  app.quit();
  return true;
});
ipcMain.handle("permissions:get-status", async () => getOsPermissionStatus());
ipcMain.handle("permissions:request", async (_event, id) => requestOsPermission(id));
ipcMain.handle("permissions:open-settings", async (_event, id) => openOsPermissionSettings(id));
ipcMain.handle("diagnostics:get-log-path", () => getDiagnosticLogPath());
ipcMain.handle("diagnostics:open-log", async () => {
  await shell.openPath(getDiagnosticLogPath());
  return getDiagnosticLogPath();
});
ipcMain.handle("diagnostics:write", async (_event, event, details = {}) => {
  await writeDiagnosticLog(`renderer.${event}`, sanitizeDiagnosticValue(details));
  return { ok: true };
});
ipcMain.handle("diagnostics:privacy", async () => collectPrivacyDiagnostics());
ipcMain.handle("tools:get-definitions", () => getRealtimeToolDefinitions());
ipcMain.handle("tools:execute", async (_event, name, args = {}) => {
  if (typeof name !== "string" || !name.trim()) {
    return {
      status: "invalid_arguments",
      message: "Tool name must be a non-empty string.",
    };
  }
  const startedAt = Date.now();
  await writeDiagnosticLog("tool.execute.start", {
    tool: name,
    args: sanitizeDiagnosticValue(args),
    permissions: summarizePermissionSnapshot(await getOsPermissionStatus()),
  });
  const isComputerUse = name === "computer_use_task";
  const abortController = isComputerUse ? new AbortController() : null;
  if (abortController) {
    activeComputerUseController?.abort();
    activeComputerUseController = abortController;
  }
  try {
    const credentials = isComputerUse ? await getFreshOpenAICredentials() : null;
    const screenshotOptions = {
      desktopCapturer,
      screen,
      userDataPath: app.getPath("userData"),
      logger: createToolLogger(name),
      ...(credentials ? { openAI: { accessToken: credentials.accessToken } } : {}),
    };
    const result = await executeRealtimeTool(name, args, {
      screenshot: screenshotOptions,
      computerUse: {
        ...(credentials
          ? {
              openAI: {
                accessToken: credentials.accessToken,
                accountId: credentials.accountId,
              },
            }
          : {}),
        originator: "ggcoder",
        logger: createToolLogger(name),
        desktopCapturer,
        screen,
        ensureOsControlAllowed,
        signal: abortController?.signal,
      },
      session: {
        cancelComputerUse,
      },
      fileSystem: {
        rootPath: app.getPath("home"),
      },
    });
    await writeDiagnosticLog("tool.execute.finish", {
      tool: name,
      elapsedMs: Date.now() - startedAt,
      result: summarizeToolResult(result),
    });
    await recordToolActivity(name, args, result);
    broadcastDataChanged(categoryForTool(name));
    return result;
  } catch (error) {
    await writeDiagnosticLog(
      "tool.execute.error",
      sanitizeDiagnosticValue({
        tool: name,
        elapsedMs: Date.now() - startedAt,
        error: formatDiagnosticError(error),
      }),
    );
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Tool execution failed.",
    };
  } finally {
    if (abortController && activeComputerUseController === abortController) {
      activeComputerUseController = null;
    }
  }
});

ipcMain.handle("tools:cancel-computer-use", () => cancelComputerUse());

function cancelComputerUse() {
  if (activeComputerUseController) {
    activeComputerUseController.abort();
    return { cancelled: true };
  }
  return { cancelled: false };
}

app.whenReady().then(() => {
  if (process.env.BRAH_REALTIME_PROBE === "1") {
    void runRealtimeProbe();
    return;
  }
  initializeDataStore();
  void startDiagnosticSession();
  wireUpdateEvents();
  createMainWindow();

  if (!isDevelopment) {
    autoUpdater.checkForUpdatesAndNotify();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      return;
    }
    // Reopening from the Dock should restore a minimized companion window.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
      mainWindow.restore();
      mainWindow.show();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function initializeDataStore() {
  setDatabaseUserDataPath(app.getPath("userData"));
  try {
    migrateLegacyPlannerStore();
    migrateLegacyActivityStore();
  } catch (error) {
    safeConsole("warn", "Legacy store migration failed", error);
  }
  try {
    userWindowPosition = loadWindowPosition();
  } catch (error) {
    safeConsole("warn", "Failed to load window position", error);
  }
}

function getDiagnosticLogPath() {
  return path.join(app.getPath("userData"), "diagnostics.log");
}

function broadcastDataChanged(category) {
  if (!category || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("data:changed", { category });
}

function categoryForTool(name) {
  switch (name) {
    case "add_task":
    case "delete_task":
    case "update_task_status":
      return "tasks";
    case "add_calendar_item":
    case "delete_calendar_item":
      return "calendar";
    case "take_screenshot":
    case "analyze_screen":
      return "screenshots";
    case "web_search":
    case "web_fetch":
      return "web";
    case "computer_use_task":
      return "computer";
    default:
      return null;
  }
}

async function recordToolActivity(name, args, result) {
  if (!isRecord(result)) {
    return;
  }
  try {
    if (name === "web_search") {
      await recordActivity({
        kind: "web_search",
        query: typeof result.query === "string" ? result.query : args?.query,
        resultCount: result.resultCount,
        results: result.results,
      });
      return;
    }
    if (name === "web_fetch") {
      await recordActivity({
        kind: "web_fetch",
        url: result.url ?? args?.url,
        title: result.title,
        text: result.text,
      });
      return;
    }
    if (name === "computer_use_task") {
      await recordActivity({
        kind: "computer_use",
        task: typeof args?.task === "string" ? args.task : "",
        statusText: result.status,
        steps: result.steps,
        finalText: result.finalText,
      });
    }
  } catch (error) {
    console.warn("Failed to record activity", error);
  }
}

function toIdList(value) {
  if (Array.isArray(value)) {
    return value.map((id) => String(id)).filter((id) => id.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value];
  }
  return [];
}

// These handlers intentionally do not broadcastDataChanged: the panel that
// invoked them refreshes itself in place (without reanimating), so a broadcast
// would trigger a redundant animated reload.
function deletePlannerTasks(ids) {
  let deleted = 0;
  for (const id of toIdList(ids)) {
    if (deleteTask(id).status === "deleted") {
      deleted += 1;
    }
  }
  return { status: "ok", deleted };
}

function completePlannerTasks(ids) {
  let updated = 0;
  for (const id of toIdList(ids)) {
    if (updateTaskStatus(id, "completed").status === "updated") {
      updated += 1;
    }
  }
  return { status: "ok", updated };
}

function deletePlannerCalendarItems(ids) {
  let deleted = 0;
  for (const id of toIdList(ids)) {
    if (deleteCalendarItem(id).status === "deleted") {
      deleted += 1;
    }
  }
  return { status: "ok", deleted };
}

async function deleteScreenshots(names) {
  const screenshotsDir = path.join(app.getPath("userData"), "screenshots");
  let deleted = 0;
  for (const name of toIdList(names)) {
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      continue;
    }
    const filePath = path.join(screenshotsDir, name);
    if (path.dirname(filePath) !== screenshotsDir) {
      continue;
    }
    try {
      await fs.unlink(filePath);
      deleted += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        safeConsole("warn", "Failed to delete screenshot", error);
      }
    }
  }
  return { status: "ok", deleted };
}

async function listScreenshots() {
  const screenshotsDir = path.join(app.getPath("userData"), "screenshots");
  let names;
  try {
    names = await fs.readdir(screenshotsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const pngNames = names.filter((name) => name.toLowerCase().endsWith(".png"));
  const entries = await Promise.all(
    pngNames.map(async (name) => {
      const filePath = path.join(screenshotsDir, name);
      try {
        const [stats, bytes] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
        return {
          name,
          dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
          createdAt: stats.mtimeMs,
        };
      } catch {
        return null;
      }
    }),
  );
  return entries
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30);
}

async function revealScreenshot(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    throw new Error("Invalid screenshot name.");
  }
  const screenshotsDir = path.join(app.getPath("userData"), "screenshots");
  const filePath = path.join(screenshotsDir, name);
  if (path.dirname(filePath) !== screenshotsDir) {
    throw new Error("Invalid screenshot path.");
  }
  shell.showItemInFolder(filePath);
  return { revealed: true };
}

const MAX_DIAGNOSTIC_LOG_BYTES = 1_000_000;

async function writeDiagnosticLog(event, details = {}) {
  // Per-line entries stay lean (time/event/details) so the log is easy to read
  // and copy-paste; the static environment context lives in the session.start
  // header written once per launch.
  const entry = { time: new Date().toISOString(), event, details };
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await fs.mkdir(path.dirname(getDiagnosticLogPath()), { recursive: true });
    await fs.appendFile(getDiagnosticLogPath(), line);
  } catch (error) {
    safeConsole("error", "diagnostic log write failed", error);
  }
  safeConsole("info", "diagnostic", event, details);
}

// Rotates the log when it grows large and writes a session header so every run
// in the log is self-describing (app version, platform, displays).
async function startDiagnosticSession() {
  const logPath = getDiagnosticLogPath();
  try {
    const stats = await fs.stat(logPath);
    if (stats.size > MAX_DIAGNOSTIC_LOG_BYTES) {
      await fs.rename(logPath, `${logPath}.prev`);
    }
  } catch {
    // No existing log to rotate.
  }
  const primary = screen.getPrimaryDisplay();
  await writeDiagnosticLog("session.start", {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform} ${process.arch}`,
    osRelease: os.release(),
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    displayCount: screen.getAllDisplays().length,
    primaryWorkArea: primary.workArea,
  });
}

function safeConsole(level, ...args) {
  try {
    console[level](...args);
  } catch (error) {
    if (error?.code !== "EPIPE" && error?.code !== "ERR_STREAM_DESTROYED") {
      throw error;
    }
  }
}

function createToolLogger(tool) {
  return async (event, details = {}) => {
    await writeDiagnosticLog(event, sanitizeDiagnosticValue({ tool, ...details }));
  };
}

function summarizePermissionSnapshot(permissions) {
  return Object.fromEntries(permissions.map((permission) => [permission.id, permission.status]));
}

function summarizeToolResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const summary = {
    status: result.status,
    message: typeof result.message === "string" ? result.message.slice(0, 500) : undefined,
    path: result.path,
    dimensions: result.dimensions,
    source: result.source,
    resultCount: result.resultCount,
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

const SECRET_KEY =
  /(token|secret|authorization|bearer|password|passwd|api[-_]?key|apikey|client_secret|refresh|access_token|cookie|credential|private[-_]?key)/i;
const SECRET_VALUE =
  /\b(sk-[A-Za-z0-9_-]{16,}|ek_[A-Za-z0-9]+|eyJ[A-Za-z0-9._-]{20,}|Bearer\s+[A-Za-z0-9._-]+)\b/g;

function scrubString(str) {
  let out = str.replace(SECRET_VALUE, "[redacted]");
  // Strip query/fragment from any http(s) URL value (codes/tokens live there).
  try {
    const u = new URL(out);
    if (u.protocol === "http:" || u.protocol === "https:") {
      if (u.search || u.hash) out = `${u.origin}${u.pathname}?[redacted]`;
    }
  } catch {
    /* not a URL */
  }
  return out.slice(0, 500);
}

function sanitizeDiagnosticValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeDiagnosticValue);
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? scrubString(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[redacted]" : sanitizeDiagnosticValue(item),
    ]),
  );
}

function formatDiagnosticError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

async function collectPrivacyDiagnostics() {
  const diagnostics = {
    appPath: app.getAppPath(),
    executablePath: app.getPath("exe"),
    isPackaged: app.isPackaged,
    bundleIdentifier: app.getApplicationNameForProtocol("file") || null,
    statuses: Object.fromEntries(
      (await getOsPermissionStatus()).map((permission) => [permission.id, permission.status]),
    ),
    tccRows: process.platform === "darwin" ? await readMacOsTccRows() : [],
  };
  await writeDiagnosticLog("privacy.diagnostics", diagnostics);
  return diagnostics;
}

async function readMacOsTccRows() {
  const dbPath = "/Library/Application Support/com.apple.TCC/TCC.db";
  try {
    const { stdout } = await execFileAsync("sqlite3", [
      dbPath,
      "select service,client,client_type,auth_value,auth_reason,flags,last_modified from access where client like '%brah%' or client like '%Brah%' or client='com.unstablemind.brah' order by service,client;",
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [service, client, clientType, authValue, authReason, flags, lastModified] =
          line.split("|");
        return { service, client, clientType, authValue, authReason, flags, lastModified };
      });
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  }
}

async function getOsPermissionStatus() {
  return createOsPermissionSnapshot({
    microphone: getMediaAccessStatus("microphone"),
    screen: getMediaAccessStatus("screen"),
    accessibility: getAccessibilityStatus(),
    computer: await getComputerUseBrowserStatus(),
  });
}

async function requestOsPermission(id) {
  if (!isKnownOsPermissionId(id)) {
    throw new Error("Unknown OS permission.");
  }
  if (id === "microphone") {
    if (process.platform === "darwin") {
      await systemPreferences.askForMediaAccess("microphone");
    } else if (process.platform === "win32") {
      await openOsPermissionSettings("microphone");
    }
    return getOsPermissionStatus();
  }
  if (id === "screen") {
    await requestScreenRecordingAccess();
    return getOsPermissionStatus();
  }
  if (id === "accessibility" && process.platform === "darwin") {
    systemPreferences.isTrustedAccessibilityClient(true);
    return getOsPermissionStatus();
  }
  if (id === "computer") {
    await installComputerUseBrowser();
    return getOsPermissionStatus();
  }
  await openOsPermissionSettings(id);
  return getOsPermissionStatus();
}

async function openOsPermissionSettings(id) {
  if (!isKnownOsPermissionId(id)) {
    throw new Error("Unknown OS permission.");
  }
  if (id === "computer") {
    await shell.openExternal(computerUseBrowserDocsUrl);
    return { opened: true };
  }
  if (process.platform === "darwin") {
    await shell.openExternal(getMacOsPrivacySettingsUrl(id));
    return { opened: true };
  }
  if (process.platform === "win32") {
    await shell.openExternal(getWindowsPrivacySettingsUrl(id));
    return { opened: true };
  }
  return { opened: false, message: "Open your system privacy settings manually." };
}

async function requestScreenRecordingAccess() {
  try {
    await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
  } catch {
    // The status check below reports the meaningful permission state.
  }
  if (process.platform === "darwin" && getMediaAccessStatus("screen") !== "granted") {
    await openOsPermissionSettings("screen");
  }
}

function getMediaAccessStatus(mediaType) {
  try {
    return systemPreferences.getMediaAccessStatus(mediaType);
  } catch {
    return process.platform === "linux" ? "unsupported" : "unknown";
  }
}

function ensureOsControlAllowed() {
  // OS-level mouse/keyboard control only requires platform privacy grants on macOS.
  // Windows (and other platforms) drive nut-js without Screen Recording or Accessibility grants.
  if (process.platform !== "darwin") {
    return { ok: true };
  }
  const screenGranted = getMediaAccessStatus("screen") === "granted";
  const accessibilityGranted = getAccessibilityStatus() === "granted";
  if (screenGranted && accessibilityGranted) {
    return { ok: true };
  }
  const missing = [
    screenGranted ? "" : "Screen Recording",
    accessibilityGranted ? "" : "Accessibility Control",
  ].filter(Boolean);
  return {
    ok: false,
    message: `Grant ${missing.join(" and ")} in the permissions screen before controlling the computer.`,
  };
}

function getAccessibilityStatus() {
  if (process.platform !== "darwin") {
    return "unsupported";
  }
  return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-determined";
}

async function getComputerUseBrowserStatus() {
  try {
    const { chromium } = await import("playwright");
    const executablePath = chromium.executablePath();
    return executablePath && existsSync(executablePath) ? "granted" : "not-determined";
  } catch {
    return "unknown";
  }
}

async function installComputerUseBrowser() {
  let cliPath;
  try {
    cliPath = require.resolve("playwright/cli.js");
  } catch {
    throw new Error("Playwright is not installed. Run `npm install` then retry.");
  }
  try {
    await execFileAsync(process.execPath, [cliPath, "install", "chromium"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : String(error);
    throw new Error(`Failed to install the automation browser: ${detail}`);
  }
}

async function loginOpenAI() {
  const redirectUri = createOpenAIRedirectUri();
  const verifier = createPkceVerifier();
  const challenge = createPkceChallenge(verifier);
  const state = randomBytes(24).toString("base64url");
  const callbackServer = await startOAuthCallbackServer({ state });
  const authUrl = new URL(openAIAuthConfig.authorizeUrl);
  authUrl.searchParams.set("client_id", openAIAuthConfig.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", openAIAuthConfig.scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("id_token_add_organizations", "true");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authUrl.searchParams.set("originator", "ggcoder");

  try {
    await shell.openExternal(authUrl.toString());
    const callback = await callbackServer.waitForCallback;
    if (callback.error) {
      throw new Error(`OpenAI login failed: ${callback.error}`);
    }
    if (!callback.code) {
      throw new Error("OpenAI login did not return an authorization code.");
    }

    const credentials = await exchangeOpenAICode({
      code: callback.code,
      codeVerifier: verifier,
      redirectUri,
    });
    await saveOpenAICredentials(credentials);
    return credentials;
  } finally {
    callbackServer.close();
  }
}

function createOpenAIRedirectUri() {
  return `http://localhost:${openAIAuthConfig.redirectPort}${openAIAuthConfig.redirectPath}`;
}

function createPkceVerifier() {
  return randomBytes(48).toString("base64url");
}

function createPkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function startOAuthCallbackServer({ state }) {
  let server;
  let timeout;
  let resolveCallback;
  let rejectCallback;
  const waitForCallback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  await new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      try {
        const callback = parseOAuthCallbackRequest(request.url ?? "/");
        const responseBody = callback.error
          ? "<html><body><h1>OpenAI login failed</h1><p>You can close this tab.</p></body></html>"
          : "<html><body><h1>OpenAI login complete</h1><p>You can return to Brah.</p></body></html>";
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(responseBody),
          Connection: "close",
        });
        response.end(responseBody);
        if (callback.state !== state) {
          rejectCallback(new Error("OpenAI login state mismatch."));
          return;
        }
        resolveCallback(callback);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Invalid OpenAI login callback.");
        rejectCallback(error);
      }
    });

    server.once("error", reject);
    server.listen(openAIAuthConfig.redirectPort, "127.0.0.1", () => {
      server.off("error", reject);
      timeout = setTimeout(() => {
        rejectCallback(new Error("OpenAI login callback timed out."));
        server.close();
      }, 120_000);
      resolve();
    });
  });

  return {
    waitForCallback,
    close() {
      clearTimeout(timeout);
      server?.close();
    },
  };
}

function parseOAuthCallbackRequest(rawUrl) {
  const url = new URL(rawUrl, createOpenAIRedirectUri());
  if (url.pathname !== openAIAuthConfig.redirectPath) {
    throw new Error(`Unexpected OpenAI OAuth callback path: ${url.pathname}`);
  }

  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    error: url.searchParams.get("error") ?? undefined,
  };
}

async function exchangeOpenAICode({ code, codeVerifier, redirectUri }) {
  return tokenJsonToCredentials(
    await postOpenAIForm(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: openAIAuthConfig.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
      "OpenAI token exchange",
    ),
  );
}

async function refreshOpenAICredentials(credentials) {
  const refreshed = tokenJsonToCredentials(
    await postOpenAIForm(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: openAIAuthConfig.clientId,
      }),
      "OpenAI token refresh",
    ),
    credentials.refreshToken,
  );
  await saveOpenAICredentials(refreshed);
  return refreshed;
}

async function postOpenAIForm(body, label) {
  const response = await fetch(openAIAuthConfig.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return parseJsonResponse(response, label);
}

async function createRealtimeClientSecret(bearerToken, options) {
  const session = buildRealtimeSessionConfig(options);
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session }),
  });
  const raw = await parseJsonResponse(response, "Realtime client secret request");
  const value = typeof raw.value === "string" ? raw.value : undefined;
  if (!value) {
    throw new Error("Realtime client secret response did not include a value.");
  }

  // Prefer the model the mint *response* reports over what we asked for, so the
  // renderer's indicator reflects what the server actually provisioned.
  const mintedModel = typeof raw.session?.model === "string" ? raw.session.model : session.model;
  return {
    value,
    expiresAt: parseExpiresAt(raw.expires_at),
    model: mintedModel,
    authMethod: options.authMethod ?? "oauth",
    raw,
  };
}

function buildRealtimeSessionConfig(options) {
  const model = typeof options.model === "string" ? options.model : realtimeDefaults.model;
  const voice = typeof options.voice === "string" ? options.voice : realtimeDefaults.voice;
  const instructions =
    typeof options.instructions === "string" && options.instructions.trim()
      ? options.instructions.trim()
      : buildRealtimeInstructions();

  return {
    type: "realtime",
    model,
    instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: realtimeDefaults.sampleRate },
        noise_reduction: { type: "near_field" },
        transcription: { model: "gpt-4o-transcribe" },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "high",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: "audio/pcm", rate: realtimeDefaults.sampleRate },
        voice,
        speed: 1.0,
      },
    },
    max_output_tokens: 4096,
    // `reasoning` is only accepted by gpt-realtime-2; gpt-realtime/-mini reject
    // it with 400 "Unsupported option for this model" (probed 2026-06-13).
    ...(model.startsWith("gpt-realtime-2") ? { reasoning: { effort: "minimal" } } : {}),
    tools: getRealtimeToolDefinitions(),
    tool_choice: "auto",
    tracing: "auto",
  };
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${String(text).slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function runRealtimeProbe() {
  const offer = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:abcd",
    "a=ice-pwd:abcdefghijklmnopqrstuvwx",
    "a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF",
    "a=setup:actpass",
    "a=mid:0",
    "a=sendrecv",
    "a=rtcp-mux",
    "a=rtpmap:111 opus/48000/2",
    "",
  ].join("\r\n");
  const out = {};
  try {
    const credentials = await getFreshOpenAICredentials();
    out.hasCredentials = !!credentials;
    if (credentials) {
      const model = realtimeDefaults.model;
      const secret = await createRealtimeClientSecret(credentials.accessToken, { model });
      out.mint = { ok: true, value: `${secret.value.slice(0, 8)}\u2026` };
      const pub = await fetch(`https://api.openai.com/v1/realtime/calls?model=${model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret.value}`, "Content-Type": "application/sdp" },
        body: offer,
      });
      out.callPublic = {
        status: pub.status,
        location: pub.headers.get("location"),
        body: (await pub.text()).slice(0, 200),
      };
      const back = await fetch("https://chatgpt.com/backend-api/codex/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
          originator: "codex_cli_rs",
          "User-Agent": "codex_cli_rs/0.0.0",
        },
        body: JSON.stringify({
          sdp: offer,
          session: { type: "realtime", model, instructions: "hi" },
        }),
      });
      out.callBackend = {
        status: back.status,
        location: back.headers.get("location"),
        body: (await back.text()).slice(0, 200),
      };
    }
  } catch (error) {
    out.error = String(error?.stack || error);
  }
  console.log(`BRAH_PROBE ${JSON.stringify(out)}`);
  app.quit();
}

async function getFreshOpenAICredentials() {
  const credentials = await loadOpenAICredentials();
  if (!credentials) {
    return null;
  }
  const refreshMarginMs = 5 * 60 * 1000;
  if (credentials.expiresAt - refreshMarginMs > Date.now()) {
    return credentials;
  }
  return refreshOpenAICredentials(credentials);
}

async function loadOpenAICredentials() {
  try {
    const raw = await fs.readFile(credentialsPath(), "utf8");
    const payload = JSON.parse(raw);
    const serialized = typeof payload.data === "string" ? payload.data : undefined;
    if (!serialized) {
      return null;
    }
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(serialized, "base64"))
      : Buffer.from(serialized, "base64").toString("utf8");
    return parseCredentials(JSON.parse(json));
  } catch {
    return null;
  }
}

async function saveOpenAICredentials(credentials) {
  if (!safeStorage.isEncryptionAvailable()) {
    await writeDiagnosticLog("openai.credentials.encryption_unavailable", {
      backend: safeStorage.getSelectedStorageBackend?.() ?? "unknown",
    });
    throw new Error(
      "Secure credential storage is unavailable; refusing to store OpenAI tokens in cleartext.",
    );
  }
  await fs.mkdir(path.dirname(credentialsPath()), { recursive: true });
  const json = JSON.stringify(credentials);
  const data = safeStorage.encryptString(json).toString("base64");
  await fs.writeFile(credentialsPath(), JSON.stringify({ data }, null, 2), { mode: 0o600 });
}

async function clearOpenAICredentials() {
  await fs.rm(credentialsPath(), { force: true });
}

function credentialsPath() {
  return path.join(app.getPath("userData"), "openai-credentials.json");
}

async function loadOpenAIApiKey() {
  try {
    const raw = await fs.readFile(apiKeyPath(), "utf8");
    const payload = JSON.parse(raw);
    const serialized = typeof payload.data === "string" ? payload.data : undefined;
    if (!serialized) {
      return null;
    }
    const key = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(serialized, "base64"))
      : Buffer.from(serialized, "base64").toString("utf8");
    return isPlausibleOpenAIApiKey(key) ? key : null;
  } catch {
    return null;
  }
}

async function saveOpenAIApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    await writeDiagnosticLog("openai.api_key.encryption_unavailable", {
      backend: safeStorage.getSelectedStorageBackend?.() ?? "unknown",
    });
    throw new Error(
      "Secure credential storage is unavailable; refusing to store the API key in cleartext.",
    );
  }
  await fs.mkdir(path.dirname(apiKeyPath()), { recursive: true });
  const data = safeStorage.encryptString(key).toString("base64");
  await fs.writeFile(apiKeyPath(), JSON.stringify({ data }, null, 2), { mode: 0o600 });
}

async function clearOpenAIApiKey() {
  await fs.rm(apiKeyPath(), { force: true });
}

function apiKeyPath() {
  return path.join(app.getPath("userData"), "openai-api-key.json");
}

function isPlausibleOpenAIApiKey(key) {
  return typeof key === "string" && /^sk-[A-Za-z0-9_-]{20,}$/.test(key);
}

// Auth-only probe: lists models without consuming tokens, so a bad key fails
// here instead of mid-call.
async function verifyOpenAIApiKey(key) {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (response.ok) {
    return;
  }
  if (response.status === 401) {
    throw new Error("OpenAI rejected this API key (401). Check the key and try again.");
  }
  throw new Error(`API key verification failed (${response.status}).`);
}

function apiKeyToStatus(key) {
  return key ? { present: true, last4: key.slice(-4) } : { present: false, last4: null };
}

function tokenJsonToCredentials(response, fallbackRefreshToken) {
  if (!isRecord(response)) {
    throw new Error("OpenAI token response was not an object.");
  }
  if (typeof response.access_token !== "string") {
    throw new Error("OpenAI token response did not include an access token.");
  }
  const refreshToken = response.refresh_token ?? fallbackRefreshToken;
  if (typeof refreshToken !== "string") {
    throw new Error("OpenAI token response did not include a refresh token.");
  }
  if (typeof response.expires_in !== "number") {
    throw new Error("OpenAI token response did not include expires_in.");
  }
  const credentials = {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + response.expires_in * 1000,
  };
  const accountId = getAccountId(response.access_token);
  return accountId ? { ...credentials, accountId } : credentials;
}

function parseCredentials(value) {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    return null;
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
  };
}

function credentialsToStatus(credentials) {
  return {
    connected: true,
    expiresAt: credentials.expiresAt,
    accountId: credentials.accountId ?? null,
  };
}

function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = isRecord(payload?.["https://api.openai.com/auth"])
    ? payload["https://api.openai.com/auth"]
    : null;
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

function decodeJwt(token) {
  try {
    const parts = token.split(".");
    const payload = parts[1];
    if (parts.length !== 3 || !payload) {
      return null;
    }
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function parseExpiresAt(value) {
  if (typeof value !== "number") {
    return undefined;
  }
  return value > 10_000_000_000 ? value : value * 1000;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
