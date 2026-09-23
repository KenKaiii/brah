import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComputerTools,
  parseCodexSseStream,
  runComputerUseTask,
} from "../src/realtime/tools/computer-use-tools.js";

test("parseCodexSseStream extracts items, final text, and response id", () => {
  const text = sse([
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.done",
      item: { type: "function_call", name: "computer_screenshot", arguments: "{}", call_id: "c1" },
    },
    {
      type: "response.output_item.done",
      item: { type: "message", content: [{ type: "output_text", text: "hi" }] },
    },
    { type: "response.completed", response: { id: "resp_1" } },
  ]);
  const parsed = parseCodexSseStream(text);
  assert.equal(parsed.responseId, "resp_1");
  assert.equal(parsed.finalText, "hi");
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].name, "computer_screenshot");
  assert.equal(parsed.completed, true);
  assert.equal(parsed.error, undefined);
});

test("parseCodexSseStream captures a terminal response.failed error", () => {
  const parsed = parseCodexSseStream(
    sse([
      { type: "response.created", response: { id: "r" } },
      { type: "response.failed", response: { error: { message: "boom" } } },
    ]),
  );
  assert.equal(parsed.error, "boom");
  assert.equal(parsed.completed, false);
});

test("buildComputerTools exposes action tools plus task_complete; navigate only for browser", () => {
  const browser = buildComputerTools("browser").map((t) => t.name);
  const os = buildComputerTools("computer").map((t) => t.name);
  for (const name of ["computer_screenshot", "computer_click", "computer_type", "task_complete"]) {
    assert.ok(browser.includes(name), `browser missing ${name}`);
    assert.ok(os.includes(name), `os missing ${name}`);
  }
  assert.ok(browser.includes("computer_navigate"));
  assert.ok(browser.includes("computer_back"));
  assert.ok(browser.includes("computer_forward"));
  assert.ok(!os.includes("computer_navigate"));
  assert.ok(!os.includes("computer_back"));
  for (const tool of buildComputerTools("browser")) {
    assert.equal(tool.type, "function", tool.name);
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
  }
});

test("runComputerUseTask drives a Codex custom-tool loop and completes", async () => {
  const requests = [];
  const actions = [];
  const fetchImpl = createQueuedFetch(requests, [
    sse([
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.done",
        item: { type: "reasoning", id: "rs_1", encrypted_content: "enc-abc", summary: [] },
      },
      callItem("computer_screenshot", "{}", "c1"),
    ]),
    sse([
      { type: "response.created", response: { id: "resp_2" } },
      callItem("computer_click", JSON.stringify({ x: 12, y: 34, button: "left" }), "c2"),
    ]),
    sse([
      { type: "response.created", response: { id: "resp_3" } },
      callItem("task_complete", JSON.stringify({ summary: "Clicked the button." }), "c3"),
    ]),
  ]);

  const result = await runComputerUseTask(
    { task: "Click the button", url: "https://example.com", maxSteps: 5 },
    {
      openAI: { accessToken: "tok", accountId: "acc-123" },
      originator: "ggcoder",
      fetchImpl,
      computerTargetFactory: async (args) => {
        assert.equal(args.url, "https://example.com");
        return createTarget(actions);
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "Clicked the button.");
  assert.equal(result.responseId, "resp_3");
  assert.deepEqual(actions, [
    ["screenshot-capture"],
    ["click", 12, 34, { button: "left" }],
    ["screenshot-capture"],
    ["close"],
  ]);

  // Auth + transport contract.
  assert.equal(requests[0].headers.Authorization, "Bearer tok");
  assert.equal(requests[0].headers["ChatGPT-Account-ID"], "acc-123");
  assert.equal(requests[0].headers.originator, "ggcoder");
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.model, "gpt-6-sol");
  assert.deepEqual(requests[0].body.include, ["reasoning.encrypted_content"]);
  assert.equal(requests[0].body.reasoning.summary, "auto");
  assert.equal(requests[0].body.reasoning.effort, "medium");
  assert.ok(requests[0].body.tools.some((t) => t.name === "task_complete"));

  // Second turn must echo function_call + output + the screenshot image.
  const turn2 = requests[1].body.input;
  assert.ok(turn2.some((i) => i.type === "function_call" && i.call_id === "c1"));
  assert.ok(turn2.some((i) => i.type === "function_call_output" && i.call_id === "c1"));
  // Reasoning items must be replayed verbatim (encrypted_content intact) for store:false.
  const reasoning = turn2.find((i) => i.type === "reasoning");
  assert.ok(reasoning, "expected reasoning item replayed on turn 2");
  assert.equal(reasoning.id, "rs_1");
  assert.equal(reasoning.encrypted_content, "enc-abc");
  const image = turn2.find(
    (i) => i.type === "message" && i.content?.some((c) => c.type === "input_image"),
  );
  assert.ok(image, "expected screenshot image input on turn 2");
  assert.match(
    image.content.find((c) => c.type === "input_image").image_url,
    /^data:image\/png;base64,/,
  );

  // Third turn should prune the older screenshot to a stub, keeping only the newest image.
  const turn3 = requests[2].body.input;
  const imageMessages = turn3.filter(
    (i) => i.type === "message" && i.content?.some((c) => c.type === "input_image"),
  );
  assert.equal(imageMessages.length, 1);
  assert.ok(
    turn3.some(
      (i) =>
        i.type === "message" &&
        i.content?.some(
          (c) => c.type === "input_text" && c.text === "[previous screenshot omitted]",
        ),
    ),
  );
});

test("runComputerUseTask completes when the model returns a plain message", async () => {
  const fetchImpl = createQueuedFetch(
    [],
    [
      sse([
        { type: "response.created", response: { id: "resp_1" } },
        {
          type: "response.output_item.done",
          item: { type: "message", content: [{ type: "output_text", text: "Nothing to do." }] },
        },
      ]),
    ],
  );
  const result = await runComputerUseTask(
    { task: "noop" },
    {
      openAI: { accessToken: "tok", accountId: "acc" },
      fetchImpl,
      computerTargetFactory: async () => createTarget([]),
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "Nothing to do.");
});

test("runComputerUseTask requires an account id", async () => {
  const result = await runComputerUseTask(
    { task: "do it" },
    { openAI: { accessToken: "tok" }, fetchImpl: async () => fail() },
  );
  assert.equal(result.status, "error");
  assert.match(result.message, /account id/);
});

test("runComputerUseTask blocks OS mode without permissions", async () => {
  let factoryCalled = false;
  const result = await runComputerUseTask(
    { task: "do it", target: "computer" },
    {
      openAI: { accessToken: "tok", accountId: "acc" },
      fetchImpl: async () => fail(),
      ensureOsControlAllowed: () => ({ ok: false, message: "Grant Accessibility Control first." }),
      computerTargetFactory: async () => {
        factoryCalled = true;
        return createTarget([]);
      },
    },
  );
  assert.equal(result.status, "permission_required");
  assert.match(result.message, /Accessibility Control/);
  assert.equal(factoryCalled, false);
});

test("runComputerUseTask surfaces a streamed response.failed as an error", async () => {
  const fetchImpl = createQueuedFetch(
    [],
    [
      sse([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.failed", response: { error: { message: "content policy violation" } } },
      ]),
    ],
  );
  const actions = [];
  const result = await runComputerUseTask(
    { task: "do it" },
    {
      openAI: { accessToken: "tok", accountId: "acc" },
      fetchImpl,
      computerTargetFactory: async () => createTarget(actions),
    },
  );
  assert.equal(result.status, "error");
  assert.match(result.message, /content policy violation/);
});

test("runComputerUseTask returns cancelled when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  const result = await runComputerUseTask(
    { task: "do it" },
    {
      openAI: { accessToken: "tok", accountId: "acc" },
      signal: controller.signal,
      fetchImpl: async () => {
        fetched = true;
        throw new Error("should not fetch");
      },
      computerTargetFactory: async () => createTarget([]),
    },
  );
  assert.equal(result.status, "cancelled");
  assert.equal(fetched, false);
});

test("runComputerUseTask treats an aborted in-flight request as cancelled", async () => {
  const controller = new AbortController();
  let sawSignal = false;
  const result = await runComputerUseTask(
    { task: "do it" },
    {
      openAI: { accessToken: "tok", accountId: "acc" },
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        sawSignal = init.signal === controller.signal;
        controller.abort();
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
      },
      computerTargetFactory: async () => createTarget([]),
    },
  );
  assert.equal(result.status, "cancelled");
  assert.equal(sawSignal, true);
});

test("runComputerUseTask rejects an unknown target", async () => {
  const result = await runComputerUseTask({ task: "do it", target: "phone" }, {});
  assert.equal(result.status, "invalid_arguments");
  assert.match(result.message, /browser or computer/);
});

function fail() {
  throw new Error("fetch should not be called");
}

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function callItem(name, args, callId) {
  return {
    type: "response.output_item.done",
    item: { type: "function_call", name, arguments: args, call_id: callId },
  };
}

function createQueuedFetch(requests, bodies) {
  let index = 0;
  return async (_url, init) => {
    requests.push({ headers: init.headers, body: JSON.parse(init.body) });
    const text = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return text;
      },
    };
  };
}

function createTarget(actions) {
  return {
    actionTarget: {
      mouse: {
        click: async (...args) => actions.push(["click", ...args]),
        dblclick: async (...args) => actions.push(["dblclick", ...args]),
        move: async (...args) => actions.push(["move", ...args]),
        down: async (...args) => actions.push(["mouseDown", ...args]),
        up: async (...args) => actions.push(["mouseUp", ...args]),
        wheel: async (...args) => actions.push(["wheel", ...args]),
      },
      keyboard: {
        press: async (...args) => actions.push(["press", ...args]),
        type: async (...args) => actions.push(["type", ...args]),
        down: async (...args) => actions.push(["down", ...args]),
        up: async (...args) => actions.push(["up", ...args]),
      },
      wait: async (...args) => actions.push(["wait", ...args]),
    },
    captureScreenshot: async () => {
      actions.push(["screenshot-capture"]);
      return Buffer.from("png");
    },
    navigateTo: async (url) => actions.push(["navigate", url]),
    close: async () => actions.push(["close"]),
  };
}
