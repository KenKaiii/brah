import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneSavedScreenshots } from "../src/realtime/tools/screenshot-retention.js";
import { executeScreenshotTool } from "../src/realtime/tools/screenshot-tools.js";

test("saving a screenshot removes the oldest capture once there are more than 100", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brah-retention-capture-"));
  try {
    const screenshotsDir = path.join(dir, "screenshots");
    await fs.mkdir(screenshotsDir);
    for (let index = 0; index < 100; index += 1) {
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString().replace(/[:.]/g, "-");
      const file = path.join(screenshotsDir, `screenshot-${stamp}.png`);
      await fs.writeFile(file, Buffer.from([index]));
      const date = new Date(1_700_000_000_000 + index * 1_000);
      await fs.utimes(file, date, date);
    }
    const thumbnail = {
      isEmpty: () => false,
      getSize: () => ({ width: 320, height: 180 }),
      toPNG: () => Buffer.from("89504e470d0a1a0a", "hex"),
      toJPEG: () => Buffer.from("ffd8ffe0", "hex"),
    };
    const result = await executeScreenshotTool(
      "take_screenshot",
      {},
      {
        userDataPath: dir,
        screen: { getPrimaryDisplay: () => ({ id: 101 }) },
        desktopCapturer: {
          getSources: async () => [
            { id: "screen:101:0", display_id: "101", name: "Screen", thumbnail },
          ],
        },
      },
    );

    assert.equal(result.status, "captured");
    assert.equal((await fs.readdir(screenshotsDir)).length, 100);
    assert.equal((await fs.stat(result.path)).isFile(), true);
    await assert.rejects(
      fs.stat(path.join(screenshotsDir, "screenshot-2026-01-01T00-00-00-000Z.png")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("retains the just-saved capture even when older files have future timestamps", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brah-retention-future-"));
  try {
    const screenshotsDir = path.join(dir, "screenshots");
    await fs.mkdir(screenshotsDir);
    for (let index = 0; index < 100; index += 1) {
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString().replace(/[:.]/g, "-");
      const file = path.join(screenshotsDir, `screenshot-${stamp}.png`);
      await fs.writeFile(file, Buffer.from([index]));
      const future = new Date("2100-01-01T00:00:00.000Z");
      await fs.utimes(file, future, future);
    }
    const thumbnail = {
      isEmpty: () => false,
      getSize: () => ({ width: 320, height: 180 }),
      toPNG: () => Buffer.from("89504e470d0a1a0a", "hex"),
      toJPEG: () => Buffer.from("ffd8ffe0", "hex"),
    };
    const options = {
      userDataPath: dir,
      screen: { getPrimaryDisplay: () => ({ id: 101 }) },
      desktopCapturer: {
        getSources: async () => [
          { id: "screen:101:0", display_id: "101", name: "Screen", thumbnail },
        ],
      },
    };
    const result = await executeScreenshotTool("take_screenshot", {}, options);
    assert.equal(result.status, "captured");
    assert.equal((await fs.stat(result.path)).isFile(), true);
    assert.equal((await fs.readdir(screenshotsDir)).length, 100);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("captures made at the same timestamp keep distinct files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brah-retention-unique-"));
  try {
    const thumbnail = {
      isEmpty: () => false,
      getSize: () => ({ width: 320, height: 180 }),
      toPNG: () => Buffer.from("89504e470d0a1a0a", "hex"),
      toJPEG: () => Buffer.from("ffd8ffe0", "hex"),
    };
    const options = {
      userDataPath: dir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      screen: { getPrimaryDisplay: () => ({ id: 101 }) },
      desktopCapturer: {
        getSources: async () => [
          { id: "screen:101:0", display_id: "101", name: "Screen", thumbnail },
        ],
      },
    };
    const first = await executeScreenshotTool("take_screenshot", {}, options);
    const second = await executeScreenshotTool("take_screenshot", {}, options);
    assert.equal(first.status, "captured");
    assert.equal(second.status, "captured");
    assert.notEqual(first.path, second.path);
    assert.equal((await fs.readdir(path.join(dir, "screenshots"))).length, 2);
    assert.equal((await fs.stat(first.path)).isFile(), true);
    assert.equal((await fs.stat(second.path)).isFile(), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("keeps the newest 100 captures and never deletes unrelated images", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brah-retention-"));
  try {
    for (let index = 0; index < 103; index += 1) {
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `screenshot-${stamp}.png`);
      await fs.writeFile(file, Buffer.from([index]));
      const date = new Date(1_700_000_000_000 + index * 1_000);
      await fs.utimes(file, date, date);
    }
    await fs.writeFile(path.join(dir, "personal.png"), "not managed by Brah");
    const removed = [];
    const fileSystem = {
      readdir: (...args) => fs.readdir(...args),
      lstat: (...args) => fs.lstat(...args),
      async unlink(file) {
        removed.push(path.basename(file));
        assert.equal((await fs.readdir(dir)).length, 105 - removed.length);
        await fs.unlink(file);
      },
    };

    assert.deepEqual(await pruneSavedScreenshots(dir, { fileSystem }), { found: 103, deleted: 3 });
    assert.deepEqual(removed, [
      "screenshot-2026-01-01T00-00-00-000Z.png",
      "screenshot-2026-01-01T00-00-01-000Z.png",
      "screenshot-2026-01-01T00-00-02-000Z.png",
    ]);
    assert.equal((await fs.readdir(dir)).length, 101);
    assert.equal(await fs.readFile(path.join(dir, "personal.png"), "utf8"), "not managed by Brah");
    assert.deepEqual(await pruneSavedScreenshots(dir), { found: 100, deleted: 0 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
