import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDatabase } from "../src/realtime/tools/database.js";
import { executeMemoryTool } from "../src/realtime/tools/memory-tools.js";

async function withMemoryTools(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-memory-tools-"));
  const storePath = path.join(directory, "memory", "facts.db");
  try {
    await callback({ storePath });
  } finally {
    closeDatabase(storePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("executeMemoryTool ignores tool names it does not own", async () => {
  assert.equal(await executeMemoryTool("web_search", { query: "hi" }), null);
});

test("remember saves an atomic fact and reports the subject", async () => {
  await withMemoryTools(async (options) => {
    const result = await executeMemoryTool(
      "remember",
      { category: "preferences", subject: "coffee_preference", content: "Drinks flat whites" },
      options,
    );
    assert.equal(result.status, "saved");
    assert.equal(result.message, "Remembered: coffee_preference");
    assert.equal(typeof result.id, "number");
    assert.equal(result.category, "preferences");
  });
});

test("remember rejects missing or invalid fields", async () => {
  await withMemoryTools(async (options) => {
    const result = await executeMemoryTool(
      "remember",
      { category: "preferences", subject: "" },
      options,
    );
    assert.equal(result.status, "invalid_arguments");
  });
});

test("list_facts returns saved facts and supports category filter", async () => {
  await withMemoryTools(async (options) => {
    await executeMemoryTool(
      "remember",
      { category: "people", subject: "partner_name", content: "Sam" },
      options,
    );
    await executeMemoryTool(
      "remember",
      { category: "work", subject: "employer", content: "UnstableMind" },
      options,
    );

    let result = await executeMemoryTool("list_facts", {}, options);
    assert.equal(result.status, "listed");
    assert.equal(result.count, 2);

    result = await executeMemoryTool("list_facts", { category: "people" }, options);
    assert.equal(result.count, 1);
    assert.equal(result.facts[0].subject, "partner_name");

    result = await executeMemoryTool("list_facts", { category: "empty" }, options);
    assert.equal(result.count, 0);
    assert.equal(result.message, "No facts in category: empty");
  });
});

test("recall_memory keyword-searches facts", async () => {
  await withMemoryTools(async (options) => {
    await executeMemoryTool(
      "remember",
      { category: "people", subject: "partner_name", content: "Sam loves hiking" },
      options,
    );
    let result = await executeMemoryTool("recall_memory", { query: "hiking" }, options);
    assert.equal(result.status, "recalled");
    assert.equal(result.mode, "keyword");
    assert.equal(result.count, 1);
    assert.equal(result.facts[0].subject, "partner_name");

    result = await executeMemoryTool("recall_memory", { query: "skydiving" }, options);
    assert.equal(result.count, 0);

    result = await executeMemoryTool("recall_memory", {}, options);
    assert.equal(result.status, "invalid_arguments");
  });
});

test("update_fact corrects an existing fact by id", async () => {
  await withMemoryTools(async (options) => {
    const saved = await executeMemoryTool(
      "remember",
      { category: "work", subject: "current_project", content: "Building Brah" },
      options,
    );

    let result = await executeMemoryTool(
      "update_fact",
      { id: saved.id, content: "Shipping Brah memory", sensitive: true },
      options,
    );
    assert.equal(result.status, "updated");

    const listed = await executeMemoryTool("list_facts", {}, options);
    assert.equal(listed.facts[0].content, "Shipping Brah memory");

    result = await executeMemoryTool("update_fact", { id: saved.id }, options);
    assert.equal(result.status, "invalid_arguments");

    result = await executeMemoryTool("update_fact", { id: 9999, content: "missing" }, options);
    assert.equal(result.status, "not_found");

    result = await executeMemoryTool("update_fact", { content: "no id" }, options);
    assert.equal(result.status, "invalid_arguments");
  });
});

test("forget deletes by id or by category + subject", async () => {
  await withMemoryTools(async (options) => {
    const saved = await executeMemoryTool(
      "remember",
      { category: "notes", subject: "one", content: "First" },
      options,
    );
    await executeMemoryTool(
      "remember",
      { category: "notes", subject: "two", content: "Second" },
      options,
    );

    let result = await executeMemoryTool("forget", { id: saved.id }, options);
    assert.equal(result.status, "deleted");

    result = await executeMemoryTool("forget", { category: "notes", subject: "two" }, options);
    assert.equal(result.status, "deleted");

    result = await executeMemoryTool("forget", { id: saved.id }, options);
    assert.equal(result.status, "not_found");

    result = await executeMemoryTool("forget", {}, options);
    assert.equal(result.status, "invalid_arguments");
  });
});

test("daily_log journals an entry and skips near-duplicates the same day", async () => {
  await withMemoryTools(async (options) => {
    let result = await executeMemoryTool(
      "daily_log",
      { entry: "Worked on the daily logs feature for the memory tab" },
      options,
    );
    assert.equal(result.status, "logged");
    assert.equal(typeof result.date, "string");

    // Same topic again -> deduped
    result = await executeMemoryTool(
      "daily_log",
      { entry: "Worked on the daily logs feature for the memory tab" },
      options,
    );
    assert.equal(result.status, "skipped");

    // Materially new entry -> logged
    result = await executeMemoryTool(
      "daily_log",
      { entry: "Switched to reviewing the screenshot capture pipeline" },
      options,
    );
    assert.equal(result.status, "logged");

    result = await executeMemoryTool("daily_log", { entry: "" }, options);
    assert.equal(result.status, "invalid_arguments");
  });
});
