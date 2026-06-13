import assert from "node:assert/strict";
import test from "node:test";
import {
  createRealtimeToolHandler,
  formatToolStatus,
  getRealtimeToolCall,
  parseToolArguments,
} from "../src/renderer/realtime-tool-handler.js";

test("extracts tool calls from output item done events", () => {
  assert.deepEqual(
    getRealtimeToolCall({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        status: "completed",
        call_id: "call-2",
        name: "add_task",
        arguments:
          '{"name":"Ship tests","description":"Cover the realtime tool flow","priority":"high"}',
      },
    }),
    {
      callId: "call-2",
      name: "add_task",
      arguments: {
        name: "Ship tests",
        description: "Cover the realtime tool flow",
        priority: "high",
      },
    },
  );
});

test("ignores incomplete function calls cancelled by a barge-in", () => {
  assert.equal(
    getRealtimeToolCall({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        status: "incomplete",
        call_id: "call-cancelled",
        name: "write_file",
        arguments: '{"path":"notes.md","content":"half-strea',
      },
    }),
    null,
  );
});

test("ignores streaming argument-done events in favor of the finalized item", () => {
  assert.equal(
    getRealtimeToolCall({
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "web_fetch",
      arguments: '{"url":"https://example.com"}',
    }),
    null,
  );
});

test("invalid tool argument JSON falls back to an empty object", () => {
  assert.deepEqual(parseToolArguments("not json"), {});
  assert.deepEqual(parseToolArguments("[]"), {});
  assert.deepEqual(parseToolArguments(""), {});
});

test("tool handler executes calls once per call id and sends Realtime output events", async () => {
  const sentEvents = [];
  const statuses = [];
  const modes = [];
  const executedCalls = [];
  const handler = createRealtimeToolHandler({
    executeTool: async (name, args) => {
      executedCalls.push({ name, args });
      return { status: "ok", echoed: args };
    },
    sendEvent: (event) => sentEvents.push(event),
    setMode: (mode) => modes.push(mode),
    setStatus: (status) => statuses.push(status),
  });

  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      status: "completed",
      call_id: "call-1",
      name: "web_search",
      arguments: '{"query":"openai realtime"}',
    },
  };

  assert.equal(await handler.handleEvent(event), true);
  assert.equal(await handler.handleEvent(event), true);

  assert.deepEqual(executedCalls, [{ name: "web_search", args: { query: "openai realtime" } }]);
  assert.deepEqual(statuses, ["Searching…"]);
  assert.deepEqual(modes, ["thinking"]);
  assert.deepEqual(sentEvents, [
    {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-1",
        output: JSON.stringify({ status: "ok", echoed: { query: "openai realtime" } }),
      },
    },
    { type: "response.create" },
  ]);
});

test("tool handler signals activity start/end around execution", async () => {
  const activity = [];
  const handler = createRealtimeToolHandler({
    executeTool: async () => {
      activity.push("exec");
      return { status: "completed" };
    },
    sendEvent: () => {},
    setMode: () => {},
    setStatus: () => {},
    onToolStart: (name) => activity.push(`start:${name}`),
    onToolEnd: (name) => activity.push(`end:${name}`),
  });

  await handler.handleEvent({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      status: "completed",
      call_id: "call-cu",
      name: "computer_use_task",
      arguments: "{}",
    },
  });

  assert.deepEqual(activity, ["start:computer_use_task", "exec", "end:computer_use_task"]);
});

test("tool handler sends screenshot image as explicit response input", async () => {
  const sentEvents = [];
  const realtimeInput = {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "read this" },
      { type: "input_image", image_url: "data:image/jpeg;base64,abc" },
    ],
  };
  const handler = createRealtimeToolHandler({
    executeTool: async () => ({
      status: "captured_for_realtime_analysis",
      message: "captured",
      realtimeInput,
    }),
    sendEvent: (event) => sentEvents.push(event),
    setMode: () => {},
    setStatus: () => {},
  });

  assert.equal(
    await handler.handleEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        status: "completed",
        call_id: "call-screen",
        name: "analyze_screen",
        arguments: "{}",
      },
    }),
    true,
  );

  assert.equal(sentEvents[0].item.type, "function_call_output");
  assert.equal(JSON.parse(sentEvents[0].item.output).realtimeInput, undefined);
  assert.deepEqual(sentEvents[1], {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      input: [realtimeInput],
      instructions:
        "Analyze the attached screenshot now and answer the user directly. Do not say you are waiting for a screen read; the image is attached to this response input.",
    },
  });
});

test("end_call acknowledges without a new response and signals the host to hang up", async () => {
  const sentEvents = [];
  const executedCalls = [];
  const endCalls = [];
  const handler = createRealtimeToolHandler({
    executeTool: async (name, args) => {
      executedCalls.push({ name, args });
      return { status: "ok" };
    },
    sendEvent: (event) => sentEvents.push(event),
    setMode: () => {},
    setStatus: () => {},
    onEndCall: (args) => endCalls.push(args),
  });

  assert.equal(
    await handler.handleEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        status: "completed",
        call_id: "call-end",
        name: "end_call",
        arguments: '{"reason":"Ken said bye"}',
      },
    }),
    true,
  );

  // The renderer owns the hangup; end_call must not route to the IPC tool path.
  assert.deepEqual(executedCalls, []);
  assert.deepEqual(endCalls, [{ reason: "Ken said bye" }]);
  // Exactly one event: the function_call_output, with no response.create follow-up.
  assert.equal(sentEvents.length, 1);
  assert.equal(sentEvents[0].type, "conversation.item.create");
  assert.equal(sentEvents[0].item.call_id, "call-end");
  assert.equal(JSON.parse(sentEvents[0].item.output).status, "call_ended");
});

test("tool handler wraps execution failures into function outputs", async () => {
  const sentEvents = [];
  const handler = createRealtimeToolHandler({
    executeTool: async () => {
      throw new Error("boom");
    },
    sendEvent: (event) => sentEvents.push(event),
    setMode: () => {},
    setStatus: () => {},
  });

  assert.equal(
    await handler.handleEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        status: "completed",
        call_id: "call-fail",
        name: "web_fetch",
        arguments: "{}",
      },
    }),
    true,
  );

  assert.deepEqual(JSON.parse(sentEvents[0].item.output), {
    status: "error",
    message: "boom",
  });
});

test("tool status labels cover active tools", () => {
  assert.equal(formatToolStatus("web_fetch"), "Reading…");
  assert.equal(formatToolStatus("take_screenshot"), "Taking screenshot…");
  assert.equal(formatToolStatus("analyze_screen"), "Reading screen…");
  assert.equal(formatToolStatus("computer_use_task"), "Using computer…");
  assert.equal(formatToolStatus("end_call"), "Ending call…");
  assert.equal(formatToolStatus("add_calendar_item"), "Using calendar…");
  assert.equal(formatToolStatus("unknown"), "Using tool…");
});
