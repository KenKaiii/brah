import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRealtimeInstructions } from "../src/realtime/prompts.js";
import { getDailyLog, updateDailyLogContent } from "../src/realtime/tools/daily-logs-store.js";
import { closeDatabase } from "../src/realtime/tools/database.js";
import { executeRealtimeTool } from "../src/realtime/tools/index.js";
import { FACT_CATEGORIES, getAllFacts } from "../src/realtime/tools/memory-store.js";
import { executeMemoryTool } from "../src/realtime/tools/memory-tools.js";
import {
  getAllSoulNotes,
  getSoulContext,
  SOUL_CONTEXT_BUDGET,
  SOUL_NOTE_LIMIT,
  setSoulNote,
  updateSoulNoteContent,
} from "../src/realtime/tools/soul-store.js";
import { getRealtimeToolDefinitions } from "../src/realtime/tools/tool-schemas.js";

async function withStore(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-memory-tools-"));
  const storePath = path.join(directory, "brah.db");
  try {
    await callback(storePath);
  } finally {
    closeDatabase(storePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("remember saves a fact, and saving the same subject again replaces it", async () => {
  await withStore(async (storePath) => {
    const first = await executeMemoryTool(
      "remember",
      { category: "preferences", subject: "Coffee Preference", content: "Flat white" },
      { storePath },
    );
    const second = await executeMemoryTool(
      "remember",
      { category: "preferences", subject: "coffee_preference", content: "Black, no sugar" },
      { storePath },
    );
    assert.equal(first.status, "saved");
    assert.equal(second.status, "updated");
    assert.equal(first.memoryChanged, true);
    const facts = getAllFacts(storePath);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].subject, "coffee_preference");
    assert.equal(facts[0].content, "Black, no sugar");
  });
});

test("remember rejects an unknown category or missing content", async () => {
  await withStore(async (storePath) => {
    const badCategory = await executeMemoryTool(
      "remember",
      { category: "gossip", subject: "x", content: "y" },
      { storePath },
    );
    const noContent = await executeMemoryTool(
      "remember",
      { category: "notes", subject: "x", content: "   " },
      { storePath },
    );
    assert.equal(badCategory.status, "invalid_arguments");
    assert.equal(noContent.status, "invalid_arguments");
    assert.equal(getAllFacts(storePath).length, 0);
  });
});

test("forget deletes by category + subject and reports not_found otherwise", async () => {
  await withStore(async (storePath) => {
    await executeMemoryTool(
      "remember",
      { category: "people", subject: "partner", content: "Alex" },
      { storePath },
    );
    const missing = await executeMemoryTool(
      "forget",
      { category: "people", subject: "sister" },
      { storePath },
    );
    const forgotten = await executeMemoryTool(
      "forget",
      { category: "people", subject: "Partner" },
      { storePath },
    );
    assert.equal(missing.status, "not_found");
    assert.equal(forgotten.status, "forgotten");
    assert.equal(getAllFacts(storePath).length, 0);
  });
});

test("list_facts lists, filters by category, and searches", async () => {
  await withStore(async (storePath) => {
    for (const [category, subject, content] of [
      ["people", "partner", "Alex, a nurse"],
      ["work", "employer", "Works at Acme"],
    ]) {
      await executeMemoryTool("remember", { category, subject, content }, { storePath });
    }
    const all = await executeMemoryTool("list_facts", {}, { storePath });
    const work = await executeMemoryTool("list_facts", { category: "work" }, { storePath });
    const search = await executeMemoryTool("list_facts", { query: "nurse" }, { storePath });
    const bad = await executeMemoryTool("list_facts", { category: "nope" }, { storePath });
    assert.equal(all.count, 2);
    assert.deepEqual(
      work.facts.map((fact) => fact.subject),
      ["employer"],
    );
    assert.deepEqual(
      search.facts.map((fact) => fact.subject),
      ["partner"],
    );
    assert.equal(bad.status, "invalid_arguments");
  });
});

test("soul_set upserts by aspect; soul_list and soul_delete round-trip", async () => {
  await withStore(async (storePath) => {
    const saved = await executeMemoryTool(
      "soul_set",
      { aspect: "Communication Style", content: "Answer first, no pep talk." },
      { storePath },
    );
    const replaced = await executeMemoryTool(
      "soul_set",
      { aspect: "communication_style", content: "Answer first. Keep it to two sentences." },
      { storePath },
    );
    const listed = await executeMemoryTool("soul_list", {}, { storePath });
    assert.equal(saved.status, "saved");
    assert.equal(replaced.status, "updated");
    assert.deepEqual(listed.notes, [
      { aspect: "communication_style", content: "Answer first. Keep it to two sentences." },
    ]);

    const deleted = await executeMemoryTool(
      "soul_delete",
      { aspect: "communication style" },
      { storePath },
    );
    const again = await executeMemoryTool(
      "soul_delete",
      { aspect: "communication_style" },
      { storePath },
    );
    assert.equal(deleted.status, "deleted");
    assert.equal(again.status, "not_found");
    assert.equal(getAllSoulNotes(storePath).length, 0);
  });
});

test("daily_log appends a timestamped line to today's log", async () => {
  await withStore(async (storePath) => {
    const now = new Date(2026, 8, 24, 14, 5);
    const result = await executeMemoryTool(
      "daily_log",
      { entry: "Shipped the screenshot fix" },
      { storePath, now },
    );
    assert.equal(result.status, "logged");
    assert.equal(result.date, "2026-09-24");
    assert.match(getDailyLog("2026-09-24", storePath).content, /Shipped the screenshot fix$/);
  });
});

test("memory tools ignore non-object arguments and other tool names", async () => {
  await withStore(async (storePath) => {
    assert.equal(await executeMemoryTool("add_task", {}, { storePath }), null);
    const result = await executeMemoryTool("remember", null, { storePath });
    assert.equal(result.status, "invalid_arguments");
  });
});

test("executeRealtimeTool dispatches memory tools through options.memory", async () => {
  await withStore(async (storePath) => {
    const result = await executeRealtimeTool(
      "remember",
      { category: "notes", subject: "wifi", content: "Router is in the hallway" },
      { memory: { storePath } },
    );
    assert.equal(result.status, "saved");
  });
});

test("soul context lists the newest notes first and stays inside its budget", async () => {
  await withStore((storePath) => {
    setSoulNote("pacing", "Slow down when I'm stressed.", storePath);
    setSoulNote("boundaries", "No work talk after 8pm.", storePath);
    assert.equal(
      getSoulContext(storePath),
      "- boundaries: No work talk after 8pm.\n- pacing: Slow down when I'm stressed.",
    );
    for (let index = 0; index < 20; index += 1) {
      setSoulNote(`aaa_${index}`, "x".repeat(250), storePath);
    }
    // A fresh correction always makes the budget, however many older notes exist.
    setSoulNote("tone", "Be blunt.", storePath);
    const context = getSoulContext(storePath);
    assert.ok(context.length <= SOUL_CONTEXT_BUDGET);
    assert.ok(context.startsWith("- tone: Be blunt."));
  });
});

test("working notes are capped; updating an existing aspect still works at the cap", async () => {
  await withStore((storePath) => {
    for (let index = 0; index < SOUL_NOTE_LIMIT; index += 1) {
      assert.equal(setSoulNote(`aspect_${index}`, "note", storePath).ok, true);
    }
    const overflow = setSoulNote("one_more", "note", storePath);
    assert.equal(overflow.ok, false);
    assert.match(overflow.error, /already 30 working notes/);
    assert.equal(setSoulNote("aspect_0", "changed", storePath).ok, true);
    assert.equal(getAllSoulNotes(storePath).length, SOUL_NOTE_LIMIT);
  });
});

test("soul and daily log text can be edited by id, never to empty", async () => {
  await withStore((storePath) => {
    const note = setSoulNote("tone", "Be blunt.", storePath).value;
    assert.equal(updateSoulNoteContent(note.id, "  Be blunt but kind.  ", storePath), true);
    assert.equal(updateSoulNoteContent(note.id, "   ", storePath), false);
    assert.equal(getAllSoulNotes(storePath)[0].content, "Be blunt but kind.");

    const now = new Date(2026, 8, 24, 9, 0);
    return executeMemoryTool("daily_log", { entry: "Standup" }, { storePath, now }).then(() => {
      const log = getDailyLog("2026-09-24", storePath);
      assert.equal(updateDailyLogContent(log.id, "Standup moved to 10", storePath), true);
      assert.equal(getDailyLog("2026-09-24", storePath).content, "Standup moved to 10");
    });
  });
});

test("fact category enum in the tool schemas matches the memory store", () => {
  const remember = getRealtimeToolDefinitions().find((tool) => tool.name === "remember");
  assert.deepEqual(remember.parameters.properties.category.enum, [...FACT_CATEGORIES]);
});

test("soul notes get their own prompt section before long-term memory", () => {
  const instructions = buildRealtimeInstructions({
    soulContext: "- tone: Be blunt.",
    memoryContext: "## Known Facts",
  });
  const soulAt = instructions.indexOf("# Working Together");
  assert.ok(soulAt > 0);
  assert.ok(soulAt < instructions.indexOf("# Long-Term Memory"));
  assert.match(instructions, /- tone: Be blunt\./);
});
