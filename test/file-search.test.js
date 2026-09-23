import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSpotlightQuery } from "../src/realtime/tools/file-search.js";
import { executeFileSystemTool } from "../src/realtime/tools/filesystem-tools.js";

// Forces the portable directory walk so tests don't depend on Spotlight.
async function withTree(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "brah-find-"));
  try {
    await mkdir(path.join(root, "Documents", "Taxes"), { recursive: true });
    await mkdir(path.join(root, "Downloads"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "budget-lib"), { recursive: true });
    await mkdir(path.join(root, ".ssh"), { recursive: true });
    await writeFile(path.join(root, "Documents", "Budget 2026.xlsx"), "x");
    await writeFile(path.join(root, "Documents", "Taxes", "budget-notes.md"), "x");
    await writeFile(path.join(root, "Downloads", "Invoice March.pdf"), "x");
    await writeFile(path.join(root, "Downloads", "old-report.pdf"), "x");
    await writeFile(path.join(root, "node_modules", "budget-lib", "budget.js"), "x");
    await writeFile(path.join(root, ".ssh", "budget_key"), "x");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(path.join(root, "Downloads", "old-report.pdf"), old, old);
    await callback(root, { rootPath: root, platform: "linux" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("find_files matches all name words in any order, skipping junk and protected folders", async () => {
  await withTree(async (_root, options) => {
    const result = await executeFileSystemTool("find_files", { query: "budget" }, options);
    assert.equal(result.status, "found");
    const names = result.results.map((entry) => entry.name).sort();
    assert.deepEqual(names, ["Budget 2026.xlsx", "budget-notes.md"]);
    for (const entry of result.results) {
      assert.ok(path.isAbsolute(entry.path) || entry.path.startsWith("~"), entry.path);
      assert.equal(entry.kind, "file");
      assert.match(entry.modified, /^\d{4}-\d{2}-\d{2}/);
    }

    const both = await executeFileSystemTool("find_files", { query: "2026 budget" }, options);
    assert.deepEqual(
      both.results.map((entry) => entry.name),
      ["Budget 2026.xlsx"],
    );
  });
});

test("find_files ranks an exact file name above longer names", async () => {
  await withTree(async (root, options) => {
    await writeFile(path.join(root, "Documents", "package-lock.json"), "x");
    await writeFile(path.join(root, "Documents", "package.json"), "x");
    const result = await executeFileSystemTool("find_files", { query: "package.json" }, options);
    assert.equal(result.results[0].name, "package.json");
  });
});

test("find_files filters by extension, recency, kind, and folder", async () => {
  await withTree(async (_root, options) => {
    const pdfs = await executeFileSystemTool("find_files", { extension: ".PDF" }, options);
    assert.deepEqual(pdfs.results.map((entry) => entry.name).sort(), [
      "Invoice March.pdf",
      "old-report.pdf",
    ]);

    const recent = await executeFileSystemTool(
      "find_files",
      { extension: "pdf", modifiedWithinDays: 7 },
      options,
    );
    assert.deepEqual(
      recent.results.map((entry) => entry.name),
      ["Invoice March.pdf"],
    );

    const folders = await executeFileSystemTool(
      "find_files",
      { query: "taxes", kind: "folder" },
      options,
    );
    assert.deepEqual(
      folders.results.map((entry) => [entry.name, entry.kind]),
      [["Taxes", "folder"]],
    );

    const scoped = await executeFileSystemTool(
      "find_files",
      { query: "budget", folder: "Documents/Taxes" },
      options,
    );
    assert.deepEqual(
      scoped.results.map((entry) => entry.name),
      ["budget-notes.md"],
    );

    const wildcard = await executeFileSystemTool("find_files", { query: "invoice*.pdf" }, options);
    assert.deepEqual(
      wildcard.results.map((entry) => entry.name),
      ["Invoice March.pdf"],
    );
  });
});

test("find_files rejects bad input and folders outside the sandbox", async () => {
  await withTree(async (_root, options) => {
    const table = [
      [{}, "invalid_arguments", /at least one/],
      [{ query: "x", kind: "symlink" }, "invalid_arguments", /kind must be/],
      [{ extension: "p d f" }, "invalid_arguments", /extension/],
      [{ query: "x", folder: "../.." }, "invalid_arguments", /inside the workspace/],
      [{ query: "x", folder: ".ssh" }, "invalid_arguments", /protected/],
      [{ query: "x", folder: "Nope" }, "error", /was not found/],
    ];
    for (const [args, status, pattern] of table) {
      const result = await executeFileSystemTool("find_files", args, options);
      assert.equal(result.status, status, JSON.stringify(args));
      assert.match(result.message, pattern);
    }
  });
});

test("find_files does not follow a symlink out of the sandbox", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "brah-outside-"));
  try {
    await writeFile(path.join(outside, "budget-secret.txt"), "x");
    await withTree(async (root, options) => {
      await symlink(outside, path.join(root, "Documents", "linked"));
      const result = await executeFileSystemTool("find_files", { query: "secret" }, options);
      assert.equal(result.resultCount, 0);
      assert.match(result.message, /Nothing matched/);
    });
  } finally {
    await rm(outside, { force: true, recursive: true });
  }
});

test("find_files on macOS drops Spotlight hits that resolve outside the sandbox", async () => {
  await withTree(async (root) => {
    const calls = [];
    const result = await executeFileSystemTool(
      "find_files",
      { query: "budget notes" },
      {
        rootPath: root,
        platform: "darwin",
        execFileImpl: (file, args, _opts, callback) => {
          calls.push([file, args]);
          callback(
            null,
            [
              path.join(root, "Documents", "Taxes", "budget-notes.md"),
              "/etc/budget-notes",
              path.join(root, ".ssh", "budget_notes"),
            ].join("\n"),
          );
        },
      },
    );
    assert.equal(calls[0][0], "mdfind");
    assert.deepEqual(calls[0][1].slice(0, 2), ["-onlyin", root]);
    assert.equal(result.engine, "spotlight");
    assert.deepEqual(
      result.results.map((entry) => entry.name),
      ["budget-notes.md"],
    );
  });
});

test("Spotlight query only embeds sanitized word tokens", () => {
  const query = buildSpotlightQuery({
    tokens: ["budget", "2026"],
    extension: "xlsx",
    modifiedWithinDays: 7,
    kind: "any",
    searchContents: false,
  });
  assert.equal(
    query,
    'kMDItemFSName == "*budget*"cd && kMDItemFSName == "*2026*"cd && kMDItemFSName == "*.xlsx"c && kMDItemFSContentChangeDate >= $time.today(-7)',
  );
});
