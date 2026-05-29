import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  emptyActivityState,
  listActivity,
  loadActivityState,
  recordActivity,
} from "../src/realtime/tools/activity-store.js";
import { closeDatabase } from "../src/realtime/tools/database.js";

async function withActivityFile(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-activity-"));
  const filePath = path.join(directory, "activity", "log.db");
  try {
    await callback(filePath);
  } finally {
    closeDatabase(filePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("missing activity state loads as empty", async () => {
  await withActivityFile(async (filePath) => {
    assert.deepEqual(await loadActivityState(filePath), emptyActivityState());
  });
});

test("records sanitized entries and lists newest first", async () => {
  await withActivityFile(async (filePath) => {
    await recordActivity(
      {
        kind: "web_search",
        time: "2026-01-01T00:00:00.000Z",
        query: "first",
        resultCount: 1,
        results: [{ title: "T", url: "https://example.com", snippet: "snip" }],
      },
      filePath,
    );
    await recordActivity(
      {
        kind: "web_fetch",
        time: "2026-01-02T00:00:00.000Z",
        url: "https://example.com/page",
        title: "Page",
        text: "body",
      },
      filePath,
    );

    const all = await listActivity(undefined, filePath);
    assert.equal(all.length, 2);
    assert.equal(all[0].kind, "web_fetch");
    assert.equal(all[1].kind, "web_search");

    const searches = await listActivity("web_search", filePath);
    assert.equal(searches.length, 1);
    assert.equal(searches[0].query, "first");
    assert.deepEqual(searches[0].results, [
      { title: "T", url: "https://example.com", snippet: "snip" },
    ]);
  });
});

test("ignores invalid kinds and caps per kind at 50", async () => {
  await withActivityFile(async (filePath) => {
    assert.equal(await recordActivity({ kind: "nope" }, filePath), null);

    for (let index = 0; index < 55; index += 1) {
      await recordActivity(
        {
          kind: "web_search",
          time: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
          query: `q${index}`,
        },
        filePath,
      );
    }
    const searches = await listActivity("web_search", filePath);
    assert.equal(searches.length, 50);
    assert.equal(searches[0].query, "q54");
  });
});

test("excerpts are clamped to safe lengths", async () => {
  await withActivityFile(async (filePath) => {
    await recordActivity(
      {
        kind: "web_fetch",
        url: "https://example.com",
        title: "Title",
        text: "x".repeat(2000),
      },
      filePath,
    );
    const [entry] = await listActivity("web_fetch", filePath);
    assert.equal(entry.text.length, 600);
  });
});
