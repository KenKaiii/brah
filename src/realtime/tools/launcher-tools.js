import { opendir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSandboxPath, toDisplayPath } from "./sandbox-path.js";

// open_link / open_app / open_file: quick hand-offs to the OS so simple
// "open X" requests never need the slow computer-use loop. Nothing here runs a
// shell: links go through the OS URL handler, apps are only launched when found
// in the standard application folders, and files that could execute code are
// refused.

const allowedLinkProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);
// Opening these with the default handler runs code or installs software.
const executableExtensions = new Set([
  ".app",
  ".command",
  ".tool",
  ".sh",
  ".bash",
  ".zsh",
  ".csh",
  ".pkg",
  ".mpkg",
  ".dmg",
  ".terminal",
  ".scpt",
  ".applescript",
  ".workflow",
  ".action",
  ".jar",
  ".exe",
  ".msi",
  ".bat",
  ".cmd",
  ".com",
  ".ps1",
  ".vbs",
  ".js",
  ".jse",
  ".wsf",
  ".lnk",
  ".url",
  ".webloc",
  ".inetloc",
  ".fileloc",
  ".mobileconfig",
  ".prefpane",
  ".kext",
  ".plugin",
  ".bundle",
  ".saver",
  ".qlgenerator",
  ".mdimporter",
  ".xpc",
  ".docker",
  ".vsix",
  ".scr",
  ".reg",
  ".py",
  ".rb",
  ".pl",
]);
const APP_SCAN_MAX_DEPTH = 2;
// Spoken nicknames that share no word with the real app name.
const APP_ALIASES = Object.freeze({
  vscode: "visual studio code",
  "vs code": "visual studio code",
  settings: "system settings",
  preferences: "system settings",
  "system preferences": "system settings",
  itunes: "music",
  appstore: "app store",
  word: "microsoft word",
  excel: "microsoft excel",
  powerpoint: "microsoft powerpoint",
  outlook: "microsoft outlook",
  teams: "microsoft teams",
});

/**
 * @param {string} name
 * @param {unknown} args
 * @param {{ openExternal?: (url: string) => Promise<void>, openPath?: (p: string) => Promise<string>, showItemInFolder?: (p: string) => void, platform?: string, appDirectories?: string[], rootPath?: string }} [options]
 */
export async function executeLauncherTool(name, args, options = {}) {
  switch (name) {
    case "open_link":
      return openLink(args, options);
    case "open_app":
      return openApp(args, options);
    case "open_file":
      return openFile(args, options);
    default:
      return null;
  }
}

async function openLink(args, options) {
  if (!isRecord(args) || typeof args.url !== "string" || !args.url.trim()) {
    return invalidArguments("url must be a non-empty string.");
  }
  let candidate = args.url.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate) && /^[\w-]+(\.[\w-]+)+([/?#:]|$)/.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return invalidArguments("url must be a valid link like https://example.com.");
  }
  if (!allowedLinkProtocols.has(url.protocol)) {
    return invalidArguments("Only web (http/https), mailto:, and tel: links can be opened.");
  }
  if (typeof options.openExternal !== "function") {
    return errorResult("Opening links is not available here.");
  }
  try {
    await options.openExternal(url.toString());
    return {
      status: "opened",
      url: url.toString(),
      message: "Opened in the default app. It's now on screen; don't read the link aloud.",
    };
  } catch (error) {
    return errorResult(`Could not open the link: ${describe(error)}`);
  }
}

async function openApp(args, options) {
  if (!isRecord(args) || typeof args.name !== "string" || !args.name.trim()) {
    return invalidArguments("name must be a non-empty string.");
  }
  const query = args.name.trim().slice(0, 80);
  if (typeof options.openPath !== "function") {
    return errorResult("Opening apps is not available here.");
  }
  const platform = options.platform ?? process.platform;
  const apps = await listInstalledApps(platform, options.appDirectories);
  if (apps.length === 0) {
    return errorResult("Couldn't list installed apps on this computer.");
  }
  const ranked = rankApps(apps, query);
  if (ranked.length === 0) {
    return {
      status: "not_found",
      message: `No installed app matches "${query}". Ask the user for the exact app name, or use open_link if they meant a website.`,
    };
  }
  const [best, second] = ranked;
  // Only a loose substring match with several equally loose candidates is a
  // guess worth asking about; anything stronger picks the best-ranked app.
  if (best.score === 1 && second?.score === 1) {
    return {
      status: "ambiguous",
      candidates: ranked.slice(0, 5).map((app) => app.name),
      message: `Several apps match "${query}". Ask which one, then call open_app with the exact name.`,
    };
  }
  const error = await options.openPath(best.path);
  if (error) {
    return errorResult(`Could not open ${best.name}: ${error}`);
  }
  return { status: "opened", app: best.name, message: `${best.name} is opening.` };
}

async function openFile(args, options) {
  if (!isRecord(args) || typeof args.path !== "string") {
    return invalidArguments("path must be a string.");
  }
  const resolved = await resolveSandboxPath(args.path, options);
  if (!resolved.ok) {
    return invalidArguments(resolved.message);
  }
  let info;
  try {
    info = await stat(resolved.value);
  } catch {
    return errorResult(`${args.path} was not found. Use find_files to locate it first.`);
  }
  const reveal = args.reveal === true;
  const extension = path.extname(resolved.value).toLowerCase();
  if (!reveal && (executableExtensions.has(extension) || isExecutableFile(info))) {
    return errorResult(
      "That file is an app, script, or installer, which can't be opened this way. Use reveal true to show it in the file browser instead.",
    );
  }
  const display = toDisplayPath(resolved.value);
  if (reveal) {
    if (typeof options.showItemInFolder !== "function") {
      return errorResult("Showing files is not available here.");
    }
    options.showItemInFolder(resolved.value);
    return { status: "revealed", path: display, message: "Showing it in the file browser." };
  }
  if (typeof options.openPath !== "function") {
    return errorResult("Opening files is not available here.");
  }
  const error = await options.openPath(resolved.value);
  if (error) {
    return errorResult(`Could not open ${display}: ${error}`);
  }
  return {
    status: "opened",
    path: display,
    message: info.isDirectory() ? "Opened the folder." : "Opened in its default app.",
  };
}

function isExecutableFile(info) {
  // Plain files with an execute bit are scripts/binaries (skip on Windows,
  // where mode bits are synthetic).
  return process.platform !== "win32" && info.isFile() && (info.mode & 0o111) !== 0;
}

export function defaultAppDirectories(platform, env = process.env) {
  if (platform === "darwin") {
    return [
      "/Applications",
      "/System/Applications",
      "/System/Applications/Utilities",
      "/Applications/Utilities",
      path.join(os.homedir(), "Applications"),
    ];
  }
  if (platform === "win32") {
    return [
      path.join(
        env.ProgramData ?? "C:\\ProgramData",
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
      ),
      path.join(
        env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
      ),
    ];
  }
  return ["/usr/share/applications", path.join(os.homedir(), ".local/share/applications")];
}

async function listInstalledApps(platform, directories = defaultAppDirectories(platform)) {
  const extension = platform === "darwin" ? ".app" : platform === "win32" ? ".lnk" : ".desktop";
  const apps = new Map();
  const visit = async (dir, depth) => {
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    for await (const entry of handle) {
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase().endsWith(extension)) {
        const name = entry.name.slice(0, -extension.length);
        if (!apps.has(name.toLowerCase()) && !/^uninstall/i.test(name)) {
          apps.set(name.toLowerCase(), { name, path: full });
        }
      } else if (entry.isDirectory() && depth < APP_SCAN_MAX_DEPTH) {
        await visit(full, depth + 1);
      }
    }
  };
  for (const dir of directories) {
    await visit(dir, 0);
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Exact name > every query word is a whole word of the name > prefix of the
// name or of a word > substring. Ties go to the shorter (more canonical) name,
// so "chrome" picks Google Chrome over Chrome Remote Desktop.
export function rankApps(apps, query) {
  const normalize = (value) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const spoken =
    normalize(query)
      .replace(/\bapp\b/g, "")
      .trim() || normalize(query);
  const wanted = APP_ALIASES[spoken] ?? spoken;
  return apps
    .map((app) => {
      const name = normalize(app.name);
      const words = name.split(" ");
      let score = 0;
      if (name === wanted) score = 4;
      else if (wanted.split(" ").every((word) => words.includes(word))) score = 3;
      else if (name.startsWith(wanted) || words.some((word) => word.startsWith(wanted))) {
        score = 2;
      } else if (name.replace(/ /g, "").includes(wanted.replace(/ /g, ""))) score = 1;
      return { ...app, score };
    })
    .filter((app) => app.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function invalidArguments(message) {
  return { status: "invalid_arguments", message };
}

function errorResult(message) {
  return { status: "error", message };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
