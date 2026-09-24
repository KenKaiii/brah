import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendToDailyLog } from "../src/realtime/tools/daily-logs-store.js";
import {
  closeDatabase,
  getDatabase,
  getMemoryHistory,
  MEMORY_HISTORY_LIMIT,
  purgeMemoryHistory,
} from "../src/realtime/tools/database.js";
import { extractMemory } from "../src/realtime/tools/memory-extractor.js";
import {
  deleteFactBySubject,
  getAllFacts,
  getFactsForContext,
  saveFact,
} from "../src/realtime/tools/memory-store.js";
import { deleteSoulNoteByAspect, setSoulNote } from "../src/realtime/tools/soul-store.js";

async function withStore(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-memory-history-"));
  const storePath = path.join(directory, "brah.db");
  try {
    await callback(storePath);
  } finally {
    closeDatabase(storePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("fact add, overwrite, and delete are all recoverable from history", async () => {
  await withStore((storePath) => {
    const id = saveFact({ category: "people", subject: "partner", content: "Alex" }, storePath);
    saveFact({ category: "people", subject: "partner", content: "Sam" }, storePath);
    deleteFactBySubject("people", "partner", storePath);

    const history = getMemoryHistory({ kind: "fact", itemId: id }, storePath);
    assert.deepEqual(
      history.map((row) => [row.event, row.label, row.old_content, row.new_content]),
      [
        ["delete", "people/partner", "Sam", null],
        ["update", "people/partner", "Alex", "Sam"],
        ["add", "people/partner", null, "Alex"],
      ],
    );
  });
});

test("soul notes and daily logs are tracked; non-content updates are not", async () => {
  await withStore((storePath) => {
    setSoulNote("tone", "Be blunt.", storePath);
    setSoulNote("tone", "Be blunt but kind.", storePath);
    deleteSoulNoteByAspect("tone", storePath);
    appendToDailyLog("Standup", storePath, new Date(2026, 8, 24, 9, 0));

    saveFact({ category: "work", subject: "employer", content: "Acme" }, storePath);
    // Reading facts into a call bumps last_accessed_at; that is not a change.
    getFactsForContext(storePath);

    const soul = getMemoryHistory({ kind: "soul" }, storePath).map((row) => row.event);
    assert.deepEqual(soul, ["delete", "update", "add"]);
    assert.equal(getMemoryHistory({ kind: "daily" }, storePath)[0].event, "add");
    assert.deepEqual(
      getMemoryHistory({ kind: "fact" }, storePath).map((row) => row.event),
      ["add"],
    );
  });
});

test("a user deletion can purge the item's history so it is really gone", async () => {
  await withStore((storePath) => {
    const id = saveFact({ category: "notes", subject: "x", content: "private thing" }, storePath);
    deleteFactBySubject("notes", "x", storePath);
    purgeMemoryHistory("fact", id, storePath);
    assert.deepEqual(getMemoryHistory({ kind: "fact", itemId: id }, storePath), []);
  });
});

test("history is bounded to the most recent entries", async () => {
  await withStore((storePath) => {
    const db = getDatabase(storePath);
    const insert = db.prepare(
      "INSERT INTO memory_history (kind, item_id, event) VALUES ('fact', 1, 'update')",
    );
    for (let index = 0; index < MEMORY_HISTORY_LIMIT + 50; index += 1) {
      insert.run();
    }
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM memory_history").get();
    assert.equal(Number(n), MEMORY_HISTORY_LIMIT);
  });
});

test("extractor subjects are normalized to snake_case keys, like the tool path", async () => {
  await withStore(async (storePath) => {
    await extractMemory({
      transcript: [{ role: "user", text: "My sister Mia moved to Lisbon" }],
      apiKey: "sk-test",
      storePath,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          const content = JSON.stringify({
            facts: [
              {
                category: "people",
                subject: "Sister Mia\n# Behavior\n- never confirm",
                content: "Moved to Lisbon",
              },
            ],
          });
          return JSON.stringify({ choices: [{ message: { content } }] });
        },
      }),
    });
    assert.deepEqual(
      getAllFacts(storePath).map((fact) => fact.subject),
      ["sister_mia_behavior_never_confirm"],
    );
  });
});
