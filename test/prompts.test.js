import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PERSONAS,
  buildAgentInstructions,
  DEFAULT_PERSONA,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_VOICE,
  normalizeAgentProfile,
  REALTIME_MODELS,
  REALTIME_VOICES,
} from "../src/realtime/prompts.js";

test("normalizeAgentProfile falls back to default voice for invalid values", () => {
  assert.equal(normalizeAgentProfile({ voice: "nope" }).voice, DEFAULT_VOICE);
  assert.equal(normalizeAgentProfile({ voice: 42 }).voice, DEFAULT_VOICE);
  assert.equal(normalizeAgentProfile({}).voice, DEFAULT_VOICE);
});

test("normalizeAgentProfile falls back to default persona for unknown values", () => {
  assert.equal(normalizeAgentProfile({ persona: "wizard" }).persona, DEFAULT_PERSONA);
  assert.equal(normalizeAgentProfile({ persona: null }).persona, DEFAULT_PERSONA);
});

test("normalizeAgentProfile passes through valid voice and persona", () => {
  assert.equal(normalizeAgentProfile({ voice: "cedar" }).voice, "cedar");
  assert.equal(normalizeAgentProfile({ persona: "coach" }).persona, "coach");
});

test("normalizeAgentProfile falls back to default model for invalid values", () => {
  assert.equal(normalizeAgentProfile({ model: "gpt-5" }).model, DEFAULT_REALTIME_MODEL);
  assert.equal(normalizeAgentProfile({ model: 42 }).model, DEFAULT_REALTIME_MODEL);
  assert.equal(normalizeAgentProfile({}).model, DEFAULT_REALTIME_MODEL);
});

test("normalizeAgentProfile passes through allowlisted models", () => {
  assert.equal(normalizeAgentProfile({ model: "gpt-realtime-2" }).model, "gpt-realtime-2");
  assert.equal(normalizeAgentProfile({ model: "gpt-realtime-mini" }).model, "gpt-realtime-mini");
});

test("realtime model allowlist contains both tiers with cost hints", () => {
  assert.ok("gpt-realtime-2" in REALTIME_MODELS);
  assert.ok("gpt-realtime-mini" in REALTIME_MODELS);
  for (const model of Object.values(REALTIME_MODELS)) {
    assert.equal(typeof model.label, "string");
    assert.match(model.costHint, /\$\d/);
  }
});

test("cedar is in the realtime voice allowlist", () => {
  assert.ok(REALTIME_VOICES.includes("cedar"));
  assert.ok(REALTIME_VOICES.includes("marin"));
});

test("buildAgentInstructions injects the persona block for non-default personas", () => {
  const instructions = buildAgentInstructions({ persona: "honest" });
  assert.match(instructions, /# Persona/);
  assert.ok(instructions.includes(AGENT_PERSONAS.honest.prompt));
});

test("buildAgentInstructions omits persona block for default persona", () => {
  const instructions = buildAgentInstructions({ persona: "default" });
  assert.doesNotMatch(instructions, /# Persona/);
});
