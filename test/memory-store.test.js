import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDatabase, getDatabase } from "../src/realtime/tools/database.js";
import {
  decayFactImportance,
  deleteFact,
  deleteFactBySubject,
  FACTS_STORE_BUDGET,
  getAllFacts,
  getFactsByCategory,
  getFactsForContext,
  getFactsMemoryUsage,
  saveFact,
  searchFacts,
  updateFact,
} from "../src/realtime/tools/memory-store.js";

async function withMemoryStore(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-memory-"));
  const filePath = path.join(directory, "memory", "facts.db");
  try {
    await callback(filePath);
  } finally {
    closeDatabase(filePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("saveFact inserts a fact and returns a numeric id", async () => {
  await withMemoryStore((filePath) => {
    const id = saveFact(
      { category: "preferences", subject: "coffee_preference", content: "Drinks flat whites" },
      filePath,
    );
    assert.equal(typeof id, "number");
    const facts = getAllFacts(filePath);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].category, "preferences");
    assert.equal(facts[0].subject, "coffee_preference");
    assert.equal(facts[0].content, "Drinks flat whites");
    assert.equal(facts[0].importance, 50);
    assert.equal(facts[0].sensitive, false);
  });
});

test("saveFact upserts by category + subject instead of duplicating", async () => {
  await withMemoryStore((filePath) => {
    const first = saveFact(
      { category: "preferences", subject: "coffee_preference", content: "Drinks flat whites" },
      filePath,
    );
    const second = saveFact(
      { category: "preferences", subject: "coffee_preference", content: "Switched to espresso" },
      filePath,
    );
    assert.equal(first, second);
    const facts = getAllFacts(filePath);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].content, "Switched to espresso");
  });
});

test("saveFact preserves the sensitive flag unless explicitly provided", async () => {
  await withMemoryStore((filePath) => {
    const id = saveFact(
      { category: "people", subject: "partner_health", content: "Private", sensitive: true },
      filePath,
    );
    saveFact({ category: "people", subject: "partner_health", content: "Still private" }, filePath);
    assert.equal(getAllFacts(filePath)[0].sensitive, true);
    saveFact(
      { category: "people", subject: "partner_health", content: "Now public", sensitive: false },
      filePath,
    );
    assert.equal(getAllFacts(filePath)[0].sensitive, false);
    assert.equal(getAllFacts(filePath)[0].id, id);
  });
});

test("updateFact changes only the provided fields", async () => {
  await withMemoryStore((filePath) => {
    const id = saveFact(
      { category: "work", subject: "current_project", content: "Building Brah" },
      filePath,
    );
    assert.equal(updateFact(id, { content: "Shipping Brah memory" }, filePath), true);
    assert.equal(updateFact(id, {}, filePath), false);
    assert.equal(updateFact(9999, { content: "missing" }, filePath), false);
    const fact = getAllFacts(filePath)[0];
    assert.equal(fact.subject, "current_project");
    assert.equal(fact.content, "Shipping Brah memory");
  });
});

test("deleteFact and deleteFactBySubject remove rows", async () => {
  await withMemoryStore((filePath) => {
    const id = saveFact({ category: "notes", subject: "one", content: "First" }, filePath);
    saveFact({ category: "notes", subject: "two", content: "Second" }, filePath);
    assert.equal(deleteFact(id, filePath), true);
    assert.equal(deleteFact(id, filePath), false);
    assert.equal(deleteFactBySubject("notes", "two", filePath), true);
    assert.equal(getAllFacts(filePath).length, 0);
  });
});

test("searchFacts matches content, subject, and category with a limit of 6", async () => {
  await withMemoryStore((filePath) => {
    for (let index = 0; index < 8; index += 1) {
      saveFact(
        {
          category: "projects",
          subject: `project_${index}`,
          content: `Working on widget ${index}`,
        },
        filePath,
      );
    }
    assert.equal(searchFacts("widget", undefined, filePath).length, 6);
    assert.equal(searchFacts("project_3", undefined, filePath).length, 1);
    assert.equal(searchFacts("widget", "projects", filePath).length, 6);
    assert.equal(searchFacts("widget", "people", filePath).length, 0);
  });
});

test("getFactsByCategory filters by category", async () => {
  await withMemoryStore((filePath) => {
    saveFact({ category: "people", subject: "partner_name", content: "Sam" }, filePath);
    saveFact({ category: "work", subject: "employer", content: "UnstableMind" }, filePath);
    const people = getFactsByCategory("people", filePath);
    assert.equal(people.length, 1);
    assert.equal(people[0].subject, "partner_name");
  });
});

test("getFactsForContext groups facts under Known Facts and marks them accessed", async () => {
  await withMemoryStore((filePath) => {
    assert.equal(getFactsForContext(filePath), "");
    saveFact({ category: "people", subject: "partner_name", content: "Sam" }, filePath);
    saveFact({ category: "work", subject: "employer", content: "UnstableMind" }, filePath);
    const context = getFactsForContext(filePath);
    assert.match(context, /^## Known Facts/);
    assert.match(context, /### people/);
    assert.match(context, /- \*\*partner_name\*\*: Sam _\(as of \d{4}-\d{2}-\d{2}\)_/);
    assert.match(context, /### work/);
    for (const fact of getAllFacts(filePath)) {
      assert.notEqual(fact.last_accessed_at, null);
    }
  });
});

test("getFactsMemoryUsage reports usage against the 15000-char store budget", async () => {
  await withMemoryStore((filePath) => {
    assert.equal(FACTS_STORE_BUDGET, 15000);
    const empty = getFactsMemoryUsage(filePath);
    assert.equal(empty.usedChars, 0);
    assert.equal(empty.budgetChars, 15000);
    assert.equal(empty.pct, 0);

    saveFact({ category: "people", subject: "partner_name", content: "Sam" }, filePath);
    const usage = getFactsMemoryUsage(filePath);
    assert.ok(usage.usedChars > 0);
    assert.equal(usage.budgetChars, 15000);
    assert.equal(usage.pct, Math.round((usage.usedChars / 15000) * 100));
  });
});

test("decayFactImportance demotes stale facts and skips fresh ones", async () => {
  await withMemoryStore((filePath) => {
    const staleId = saveFact({ category: "notes", subject: "stale", content: "Old" }, filePath);
    const freshId = saveFact({ category: "notes", subject: "fresh", content: "New" }, filePath);
    const db = getDatabase(filePath);
    db.prepare("UPDATE facts SET last_accessed_at = datetime('now', '-100 days') WHERE id = ?").run(
      staleId,
    );
    db.prepare("UPDATE facts SET last_accessed_at = datetime('now') WHERE id = ?").run(freshId);
    assert.equal(decayFactImportance(filePath), 1);
    const byId = new Map(getAllFacts(filePath).map((fact) => [fact.id, fact]));
    assert.equal(byId.get(staleId).importance, 30);
    assert.equal(byId.get(freshId).importance, 50);
  });
});
