import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAgentProfile, saveAgentProfile } from "../src/realtime/tools/agent-profile-store.js";
import { closeDatabase } from "../src/realtime/tools/database.js";

async function withProfileDb(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-agent-"));
  const filePath = path.join(directory, "brah.db");
  try {
    await callback(filePath);
  } finally {
    closeDatabase(filePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("missing agent profile falls back to defaults", async () => {
  await withProfileDb((filePath) => {
    const profile = loadAgentProfile(filePath);
    // Default profile has no hardcoded identity; the name is set by whoever
    // installs the app (or extracted into memory later).
    assert.equal(profile.name, "");
    assert.deepEqual(profile.goals, []);
  });
});

test("agent profile normalizes and persists name, about, and goals", async () => {
  await withProfileDb((filePath) => {
    const saved = saveAgentProfile(
      {
        name: "  Sam  ",
        about: "  I run a bakery and have a dog named Benji.  ",
        goals: ["  Ship the app  ", "", "Ship the app", "Learn guitar"],
      },
      filePath,
    );
    assert.equal(saved.name, "Sam");
    assert.equal(saved.about, "I run a bakery and have a dog named Benji.");
    assert.deepEqual(saved.goals, ["Ship the app", "Learn guitar"]);

    closeDatabase(filePath);
    const reloaded = loadAgentProfile(filePath);
    assert.equal(reloaded.name, "Sam");
    assert.equal(reloaded.about, "I run a bakery and have a dog named Benji.");
    assert.deepEqual(reloaded.goals, ["Ship the app", "Learn guitar"]);
  });
});

test("agent profile persists the realtime model and rejects junk values", async () => {
  await withProfileDb((filePath) => {
    const saved = saveAgentProfile({ name: "Sam", model: "gpt-realtime-2.1-mini" }, filePath);
    assert.equal(saved.model, "gpt-realtime-2.1-mini");

    closeDatabase(filePath);
    assert.equal(loadAgentProfile(filePath).model, "gpt-realtime-2.1-mini");

    const junk = saveAgentProfile({ name: "Sam", model: "gpt-5-turbo" }, filePath);
    assert.equal(junk.model, "gpt-realtime-2.1");
  });
});

test("agent profile persists the task model alongside the realtime model", async () => {
  await withProfileDb((filePath) => {
    saveAgentProfile({ model: "gpt-realtime-2.1-mini", taskModel: "gpt-6-luna" }, filePath);
    closeDatabase(filePath);
    const reloaded = loadAgentProfile(filePath);
    assert.equal(reloaded.taskModel, "gpt-6-luna");
    assert.equal(reloaded.model, "gpt-realtime-2.1-mini");
  });
});

test("saving an empty profile clears name and goals", async () => {
  await withProfileDb((filePath) => {
    saveAgentProfile({ name: "Sam", about: "x", goals: ["A"] }, filePath);
    const cleared = saveAgentProfile({ name: "", about: "", goals: [] }, filePath);
    assert.equal(cleared.name, "");
    assert.equal(cleared.about, "");
    assert.deepEqual(cleared.goals, []);
  });
});

test("custom instructions persist across reloads", async () => {
  await withProfileDb((filePath) => {
    saveAgentProfile({ customInstructions: "  Use metric units.  " }, filePath);
    closeDatabase(filePath);
    assert.equal(loadAgentProfile(filePath).customInstructions, "Use metric units.");
  });
});
