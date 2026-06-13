import assert from "node:assert/strict";
import test from "node:test";
import { getRealtimeToolDefinitions } from "../src/realtime/tools/tool-schemas.js";

const expectedToolNames = [
  "add_task",
  "list_tasks",
  "delete_task",
  "update_task_status",
  "add_calendar_item",
  "list_calendar_items",
  "delete_calendar_item",
  "web_search",
  "web_fetch",
  "read_file",
  "write_file",
  "edit_file",
  "list_screenshot_sources",
  "take_screenshot",
  "analyze_screen",
  "computer_use_task",
  "cancel_computer_use",
  "end_call",
];

test("Realtime tool definitions expose every active function exactly once", () => {
  const tools = getRealtimeToolDefinitions();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    expectedToolNames,
  );
  assert.equal(new Set(tools.map((tool) => tool.name)).size, expectedToolNames.length);
});

test("tool definitions are function schemas with object parameters", () => {
  for (const tool of getRealtimeToolDefinitions()) {
    assert.equal(tool.type, "function", tool.name);
    assert.equal(typeof tool.description, "string", tool.name);
    assert.equal(tool.parameters.type, "object", tool.name);
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    assert.ok(Array.isArray(tool.parameters.required), tool.name);
  }
});

test("computer_use_task target enum offers browser and computer modes", () => {
  const tool = getRealtimeToolDefinitions().find((item) => item.name === "computer_use_task");
  assert.deepEqual(tool.parameters.properties.target.enum, ["browser", "computer"]);
});

test("returned tool definitions are cloned to prevent caller mutation", () => {
  const first = getRealtimeToolDefinitions();
  first[0].name = "mutated";
  first[0].parameters.properties.name.type = "number";

  const second = getRealtimeToolDefinitions();
  assert.equal(second[0].name, "add_task");
  assert.equal(second[0].parameters.properties.name.type, "string");
});
