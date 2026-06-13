import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getAllDailyLogs, getDailyLog } from "../src/realtime/tools/daily-logs-store.js";
import { closeDatabase } from "../src/realtime/tools/database.js";
import { extractMemory } from "../src/realtime/tools/memory-extractor.js";
import { getAllFacts } from "../src/realtime/tools/memory-store.js";

async function withStore(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-extract-"));
  const storePath = path.join(directory, "memory", "brah.db");
  try {
    await callback(storePath);
  } finally {
    closeDatabase(storePath);
    await rm(directory, { force: true, recursive: true });
  }
}

function mockFetch(jsonContent) {
  return async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ choices: [{ message: { content: JSON.stringify(jsonContent) } }] });
    },
  });
}

test("extractMemory skips when no API key is provided", async () => {
  await withStore(async (storePath) => {
    const result = await extractMemory({
      transcript: [{ role: "user", text: "I live in Bali" }],
      apiKey: "",
      storePath,
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "no_api_key");
    assert.equal(getAllFacts(storePath).length, 0);
  });
});

test("extractMemory skips an empty transcript", async () => {
  await withStore(async (storePath) => {
    const result = await extractMemory({ transcript: [], apiKey: "sk-test", storePath });
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "empty_transcript");
  });
});

test("extractMemory persists facts and daily logs returned by the model", async () => {
  await withStore(async (storePath) => {
    const result = await extractMemory({
      transcript: [
        { role: "user", text: "My dog Max passed away yesterday, I'm devastated." },
        { role: "assistant", text: "I'm so sorry, Ken." },
      ],
      apiKey: "sk-test",
      storePath,
      fetchImpl: mockFetch({
        facts: [
          { category: "people", subject: "pet", content: "Dog Max passed away", sensitive: true },
        ],
        logs: ["Ken's dog Max passed away yesterday; he's grieving"],
      }),
    });

    assert.equal(result.status, "extracted");
    assert.equal(result.savedFacts, 1);
    assert.equal(result.savedLogs, 1);

    const facts = getAllFacts(storePath);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].subject, "pet");
    assert.equal(facts[0].sensitive, true);

    const logs = getAllDailyLogs(storePath);
    assert.equal(logs.length, 1);
    assert.match(logs[0].content, /Max passed away/);
  });
});

test("extractMemory forgets a fact the model marks for removal", async () => {
  await withStore(async (storePath) => {
    await extractMemory({
      transcript: [{ role: "user", text: "I have a dog" }],
      apiKey: "sk-test",
      storePath,
      fetchImpl: mockFetch({
        facts: [{ category: "people", subject: "pet", content: "Has a dog named Max" }],
      }),
    });
    assert.equal(getAllFacts(storePath).length, 1);

    const result = await extractMemory({
      transcript: [{ role: "user", text: "Max passed away, I don't have a pet anymore" }],
      apiKey: "sk-test",
      storePath,
      fetchImpl: mockFetch({ forget: [{ category: "people", subject: "pet" }] }),
    });
    assert.equal(result.forgotFacts, 1);
    assert.equal(getAllFacts(storePath).length, 0);
  });
});

test("extractMemory does not forget a subject it is overwriting in the same turn", async () => {
  await withStore(async (storePath) => {
    await extractMemory({
      transcript: [{ role: "user", text: "seed" }],
      apiKey: "sk-test",
      storePath,
      fetchImpl: mockFetch({
        facts: [{ category: "user_info", subject: "location", content: "Kuala Lumpur" }],
      }),
    });

    // Model both writes the new value and (wrongly) lists the same key to forget;
    // the overwrite must win so the merged value is not lost.
    const result = await extractMemory({
      transcript: [{ role: "user", text: "I moved to Bali" }],
      apiKey: "sk-test",
      storePath,
      fetchImpl: mockFetch({
        facts: [{ category: "user_info", subject: "location", content: "Bali" }],
        forget: [{ category: "user_info", subject: "location" }],
      }),
    });
    assert.equal(result.savedFacts, 1);
    assert.equal(result.forgotFacts, 0);
    const facts = getAllFacts(storePath);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].content, "Bali");
  });
});

test("extractMemory drops malformed facts and invalid categories", async () => {
  await withStore(async (storePath) => {
    const result = await extractMemory({
      transcript: [{ role: "user", text: "ramble" }],
      apiKey: "sk-test",
      storePath,
      fetchImpl: mockFetch({
        facts: [
          { category: "not_a_category", subject: "x", content: "y" },
          { category: "work", subject: "", content: "missing subject" },
          { category: "work", subject: "role", content: "Staff engineer" },
        ],
        logs: [""],
      }),
    });
    assert.equal(result.savedFacts, 1);
    assert.equal(result.savedLogs, 0);
    assert.equal(getAllFacts(storePath)[0].subject, "role");
  });
});

test("extractMemory dedupes a log entry already present today", async () => {
  await withStore(async (storePath) => {
    const entry = "Ken shipped the memory extractor feature today";
    const first = await extractMemory({
      transcript: [{ role: "user", text: "I shipped the extractor" }],
      apiKey: "sk-test",
      storePath,
      fetchImpl: mockFetch({ facts: [], logs: [entry] }),
    });
    assert.equal(first.savedLogs, 1);

    const second = await extractMemory({
      transcript: [{ role: "user", text: "I shipped the extractor" }],
      apiKey: "sk-test",
      storePath,
      fetchImpl: mockFetch({ facts: [], logs: [entry] }),
    });
    assert.equal(second.savedLogs, 0);
    assert.equal(getDailyLog(undefined, storePath).content.split("\n").length, 1);
  });
});

test("extractMemory reports an error when the model request fails", async () => {
  await withStore(async (storePath) => {
    const result = await extractMemory({
      transcript: [{ role: "user", text: "hi" }],
      apiKey: "sk-test",
      storePath,
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        async text() {
          return "server error";
        },
      }),
    });
    assert.equal(result.status, "error");
    assert.equal(getAllFacts(storePath).length, 0);
  });
});
