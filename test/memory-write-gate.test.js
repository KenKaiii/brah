import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryWriteGate,
  MEMORY_WRITE_TOOLS,
  UNTRUSTED_CONTENT_TOOLS,
} from "../src/realtime/tools/memory-write-gate.js";
import { getRealtimeToolDefinitions } from "../src/realtime/tools/tool-schemas.js";

test("memory writes the user asked for directly are allowed", () => {
  const gate = createMemoryWriteGate();
  gate.noteUserTurn();
  gate.noteToolRan("list_tasks");
  for (const name of MEMORY_WRITE_TOOLS) {
    assert.deepEqual(gate.check(name), { ok: true }, name);
  }
});

test("after untrusted content arrives, every memory write needs a new user turn", () => {
  for (const source of UNTRUSTED_CONTENT_TOOLS) {
    const gate = createMemoryWriteGate();
    gate.noteUserTurn();
    gate.noteToolRan(source);
    for (const name of MEMORY_WRITE_TOOLS) {
      const result = gate.check(name);
      assert.equal(result.ok, false, `${source} -> ${name}`);
      assert.equal(result.result.status, "needs_user_confirmation");
      assert.match(result.result.message, new RegExp(source));
    }
    // Reading memory stays available: it cannot plant anything.
    assert.deepEqual(gate.check("list_facts"), { ok: true });
  }
});

test("the user speaking again re-opens memory writes", () => {
  const gate = createMemoryWriteGate();
  gate.noteToolRan("web_fetch");
  assert.equal(gate.check("soul_set").ok, false);
  gate.noteUserTurn();
  assert.deepEqual(gate.check("soul_set"), { ok: true });
});

test("the gate names the first untrusted source even after more tools run", () => {
  const gate = createMemoryWriteGate();
  gate.noteToolRan("read_file");
  gate.noteToolRan("web_search");
  assert.match(gate.check("remember").result.message, /content from read_file/);
});

test("every gated or untrusted tool name is a real registered tool", () => {
  const registered = new Set(getRealtimeToolDefinitions().map((tool) => tool.name));
  for (const name of [...MEMORY_WRITE_TOOLS, ...UNTRUSTED_CONTENT_TOOLS]) {
    assert.ok(registered.has(name), name);
  }
});
