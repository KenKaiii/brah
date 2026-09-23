import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeLauncherTool, rankApps } from "../src/realtime/tools/launcher-tools.js";

function recorder() {
  const calls = { openExternal: [], openPath: [], showItemInFolder: [] };
  return {
    calls,
    options: {
      openExternal: async (url) => {
        calls.openExternal.push(url);
      },
      openPath: async (target) => {
        calls.openPath.push(target);
        return "";
      },
      showItemInFolder: (target) => {
        calls.showItemInFolder.push(target);
      },
    },
  };
}

test("open_link opens web links and adds https to bare domains", async () => {
  const { calls, options } = recorder();
  const bare = await executeLauncherTool("open_link", { url: "youtube.com" }, options);
  assert.equal(bare.status, "opened");
  assert.equal(bare.url, "https://youtube.com/");
  const mail = await executeLauncherTool("open_link", { url: "mailto:hi@example.com" }, options);
  assert.equal(mail.status, "opened");
  assert.deepEqual(calls.openExternal, ["https://youtube.com/", "mailto:hi@example.com"]);
});

test("open_link refuses schemes that could run code or read local files", async () => {
  const { calls, options } = recorder();
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "vscode://file/x",
    "smb://server/share",
    "not a url",
  ]) {
    const result = await executeLauncherTool("open_link", { url }, options);
    assert.equal(result.status, "invalid_arguments", url);
  }
  assert.equal(calls.openExternal.length, 0);
});

test("open_app finds installed apps by loose name and never opens a non-app", async () => {
  const appsDir = await mkdtemp(path.join(tmpdir(), "brah-apps-"));
  try {
    for (const name of [
      "Google Chrome.app",
      "Chrome Remote Desktop.app",
      "Spotify.app",
      "Notes.app",
      "Notion.app",
      "Utilities/Terminal.app",
    ]) {
      await mkdir(path.join(appsDir, name), { recursive: true });
    }
    await writeFile(path.join(appsDir, "evil.sh"), "x");
    const { calls, options } = recorder();
    const common = { ...options, platform: "darwin", appDirectories: [appsDir] };

    const chrome = await executeLauncherTool("open_app", { name: "chrome" }, common);
    assert.equal(chrome.app, "Google Chrome");
    const spotify = await executeLauncherTool("open_app", { name: "Spotify app" }, common);
    assert.equal(spotify.app, "Spotify");
    const terminal = await executeLauncherTool("open_app", { name: "terminal" }, common);
    assert.equal(terminal.app, "Terminal");
    const nothing = await executeLauncherTool("open_app", { name: "evil" }, common);
    assert.equal(nothing.status, "not_found");
    const ambiguous = await executeLauncherTool("open_app", { name: "ot" }, common);
    assert.equal(ambiguous.status, "ambiguous");
    assert.deepEqual(ambiguous.candidates.sort(), [
      "Chrome Remote Desktop",
      "Notes",
      "Notion",
      "Spotify",
    ]);

    assert.deepEqual(calls.openPath, [
      path.join(appsDir, "Google Chrome.app"),
      path.join(appsDir, "Spotify.app"),
      path.join(appsDir, "Utilities", "Terminal.app"),
    ]);
  } finally {
    await rm(appsDir, { force: true, recursive: true });
  }
});

test("rankApps resolves spoken nicknames", () => {
  const apps = [
    { name: "Visual Studio Code", path: "a" },
    { name: "System Settings", path: "b" },
  ];
  assert.equal(rankApps(apps, "vscode")[0].name, "Visual Studio Code");
  assert.equal(rankApps(apps, "Settings app")[0].name, "System Settings");
});

test("rankApps prefers whole-word and shorter names", () => {
  const ranked = rankApps(
    [
      { name: "Chrome Remote Desktop", path: "a" },
      { name: "Google Chrome", path: "b" },
      { name: "Chromium", path: "c" },
      { name: "Chromebook Recovery", path: "d" },
    ],
    "chrome",
  );
  assert.deepEqual(
    ranked.map((app) => app.name),
    ["Google Chrome", "Chrome Remote Desktop", "Chromebook Recovery"],
  );
});

test("open_file opens documents, reveals on request, and refuses executables", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "brah-open-"));
  try {
    await writeFile(path.join(root, "report.pdf"), "x");
    await writeFile(path.join(root, "install.command"), "x");
    await writeFile(path.join(root, "run-me"), "x");
    await chmod(path.join(root, "run-me"), 0o755);
    await mkdir(path.join(root, ".ssh"));
    await writeFile(path.join(root, ".ssh", "id_rsa"), "x");
    const { calls, options } = recorder();
    const common = { ...options, rootPath: root };

    const opened = await executeLauncherTool("open_file", { path: "report.pdf" }, common);
    assert.equal(opened.status, "opened");
    const revealed = await executeLauncherTool(
      "open_file",
      { path: "install.command", reveal: true },
      common,
    );
    assert.equal(revealed.status, "revealed");

    for (const target of ["install.command", "run-me"]) {
      const refused = await executeLauncherTool("open_file", { path: target }, common);
      assert.equal(refused.status, "error", target);
      assert.match(refused.message, /can't be opened/);
    }
    const secret = await executeLauncherTool("open_file", { path: ".ssh/id_rsa" }, common);
    assert.equal(secret.status, "invalid_arguments");
    const outside = await executeLauncherTool("open_file", { path: "/etc/hosts" }, common);
    assert.equal(outside.status, "invalid_arguments");
    const missing = await executeLauncherTool("open_file", { path: "nope.pdf" }, common);
    assert.match(missing.message, /find_files/);

    assert.deepEqual(calls.openPath, [path.join(root, "report.pdf")]);
    assert.deepEqual(calls.showItemInFolder, [path.join(root, "install.command")]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("unknown launcher tool names pass through as null", async () => {
  assert.equal(await executeLauncherTool("web_search", {}, {}), null);
});
