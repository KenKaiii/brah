import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PERSONAS,
  buildAgentInstructions,
  DEFAULT_PERSONA,
  DEFAULT_VOICE,
  normalizeAgentProfile,
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
  assert.equal(normalizeAgentProfile({ persona: "hype" }).persona, "hype");
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
