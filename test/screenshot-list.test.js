import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listSavedScreenshots } from "../src/realtime/tools/screenshot-list.js";

test("lists the newest 30 screenshots without reading older images", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brah-screenshot-list-"));
  try {
    for (let index = 0; index < 40; index += 1) {
      const name = `screenshot-${String(index).padStart(2, "0")}.png`;
      const file = path.join(dir, name);
      await fs.writeFile(file, Buffer.from([index]));
      const date = new Date(1_700_000_000_000 + index * 1_000);
      await fs.utimes(file, date, date);
    }
    await fs.writeFile(path.join(dir, "notes.txt"), "not an image");

    const readNames = [];
    const fileSystem = {
      readdir: (...args) => fs.readdir(...args),
      stat: (...args) => fs.stat(...args),
      async readFile(file) {
        readNames.push(path.basename(file));
        return fs.readFile(file);
      },
    };
    const entries = await listSavedScreenshots(dir, fileSystem);

    assert.equal(entries.length, 30);
    assert.equal(entries[0].name, "screenshot-39.png");
    assert.equal(entries.at(-1).name, "screenshot-10.png");
    assert.deepEqual(
      entries[0].dataUrl,
      `data:image/png;base64,${Buffer.from([39]).toString("base64")}`,
    );
    assert.equal(readNames.length, 30);
    assert.ok(readNames.every((name) => name.endsWith(".png") && name >= "screenshot-10.png"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fills the list from older screenshots when newer reads fail", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brah-screenshot-list-"));
  try {
    for (let index = 0; index < 32; index += 1) {
      const file = path.join(dir, `screenshot-${String(index).padStart(2, "0")}.png`);
      await fs.writeFile(file, Buffer.from([index]));
      const date = new Date(1_700_000_000_000 + index * 1_000);
      await fs.utimes(file, date, date);
    }
    const readNames = [];
    const fileSystem = {
      readdir: (...args) => fs.readdir(...args),
      stat: (...args) => fs.stat(...args),
      async readFile(file) {
        const name = path.basename(file);
        readNames.push(name);
        if (name === "screenshot-31.png") {
          throw new Error("Image removed during listing");
        }
        return fs.readFile(file);
      },
    };
    const entries = await listSavedScreenshots(dir, fileSystem);

    assert.equal(entries.length, 30);
    assert.equal(entries[0].name, "screenshot-30.png");
    assert.equal(entries.at(-1).name, "screenshot-01.png");
    assert.equal(readNames.length, 31);
    assert.ok(readNames.includes("screenshot-01.png"));
    assert.ok(!readNames.includes("screenshot-00.png"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("returns an empty list when the screenshots folder does not exist", async () => {
  assert.deepEqual(
    await listSavedScreenshots(path.join(os.tmpdir(), `brah-missing-${randomUUID()}`)),
    [],
  );
});
