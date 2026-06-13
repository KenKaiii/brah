import assert from "node:assert/strict";
import test from "node:test";
import {
  createPermissionDeniedResult,
  formatPermissionPrompt,
  getToolPermissionRequest,
} from "../src/realtime/tool-permissions.js";

test("getToolPermissionRequest classifies every active tool with a summary", () => {
  assert.deepEqual(
    getToolPermissionRequest("computer_use_task", {
      task: "Open example",
      url: "https://example.com",
    }),
    {
      toolName: "computer_use_task",
      label: "Use computer",
      level: "sensitive",
      description:
        "Let OpenAI operate a browser harness or, in OS mode, control the real machine's mouse and keyboard from screenshots.",
      summary: "task: Open example, url: https://example.com",
    },
  );
  assert.equal(
    getToolPermissionRequest("computer_use_task", { task: "Open Settings", target: "computer" })
      .level,
    "destructive",
  );
  assert.deepEqual(getToolPermissionRequest("delete_task", { query: "Old task" }), {
    toolName: "delete_task",
    label: "Delete task",
    level: "destructive",
    description: "Delete a task from your local Tasks list.",
    summary: "query: Old task",
  });
  assert.deepEqual(getToolPermissionRequest("web_search", { query: "weather" }), {
    toolName: "web_search",
    label: "Search web",
    level: "network",
    description: "Send a search query to DuckDuckGo.",
    summary: "query: weather",
  });
});

test("formatPermissionPrompt includes label, description, details, and risk", () => {
  assert.equal(
    formatPermissionPrompt(getToolPermissionRequest("web_fetch", { url: "https://example.com" })),
    "Read web page?\n\nFetch and read a public web page.\n\nDetails: url: https://example.com\n\nRisk: network",
  );
});

test("createPermissionDeniedResult returns a model-visible denial", () => {
  assert.deepEqual(createPermissionDeniedResult(getToolPermissionRequest("analyze_screen", {})), {
    status: "permission_denied",
    message: "The user did not approve Analyze screen. Ask before trying this tool again.",
    tool: "analyze_screen",
  });
});
