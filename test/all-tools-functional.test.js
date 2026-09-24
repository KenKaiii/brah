import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDatabase } from "../src/realtime/tools/database.js";
import { executeRealtimeTool } from "../src/realtime/tools/index.js";
import { getRealtimeToolDefinitions } from "../src/realtime/tools/tool-schemas.js";

async function withToolHarness(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-tools-"));
  const launcherCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.hostname === "chatgpt.com" &&
      parsedUrl.pathname === "/backend-api/codex/responses"
    ) {
      const body = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, "Bearer test-token");
      assert.equal(init.headers["ChatGPT-Account-ID"], "acc-test");
      const sawScreenshot = body.input.some((item) => item.type === "function_call_output");
      const events = sawScreenshot
        ? [
            { type: "response.created", response: { id: "computer-response-2" } },
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                name: "task_complete",
                arguments: JSON.stringify({ summary: "Computer task finished." }),
                call_id: "call-done",
              },
            },
          ]
        : [
            { type: "response.created", response: { id: "computer-response-1" } },
            {
              type: "response.output_item.done",
              item: {
                type: "function_call",
                name: "computer_screenshot",
                arguments: "{}",
                call_id: "call-shot",
              },
            },
          ];
      return createResponse({
        url,
        contentType: "text/event-stream",
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      });
    }
    if (parsedUrl.hostname === "html.duckduckgo.com") {
      return createResponse({
        url,
        body: `
          <div class="result">
            <h2><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fresult">Functional Result</a></h2>
            <a class="result__snippet">A functional search summary.</a>
          </div></div>
        `,
      });
    }
    return createResponse({
      url,
      body: "<html><head><title>Functional Page</title></head><body><main><p>Fetched page body.</p></main></body></html>",
    });
  };
  try {
    await callback({
      planner: { storePath: path.join(directory, "planner", "items.json") },
      memory: { storePath: path.join(directory, "memory", "brah.db") },
      screenshot: {
        ...createScreenshotHarness(directory),
      },
      computerUse: {
        openAI: { accessToken: "test-token", accountId: "acc-test" },
        computerTargetFactory: async () => createComputerHarness(),
      },
      fileSystem: { rootPath: directory, platform: "linux" },
      launcher: {
        openExternal: async (url) => {
          launcherCalls.push(["link", url]);
        },
        openPath: async (target) => {
          launcherCalls.push(["path", target]);
          return "";
        },
        showItemInFolder: () => {},
        platform: "darwin",
        appDirectories: [path.join(directory, "Apps")],
      },
      launcherCalls,
    });
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase(path.join(directory, "memory", "brah.db"));
    await rm(directory, { force: true, recursive: true });
  }
}

function createComputerHarness() {
  return {
    actionTarget: {
      mouse: {
        click: async () => {},
        dblclick: async () => {},
        move: async () => {},
        down: async () => {},
        up: async () => {},
        wheel: async () => {},
      },
      keyboard: {
        press: async () => {},
        type: async () => {},
        down: async () => {},
        up: async () => {},
      },
      wait: async () => {},
    },
    captureScreenshot: async () => Buffer.from("89504e470d0a1a0a", "hex"),
    close: async () => {},
  };
}

function createScreenshotHarness(directory) {
  const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
  const thumbnail = {
    getSize: () => ({ width: 320, height: 180 }),
    isEmpty: () => false,
    resize: () => thumbnail,
    toJPEG: () => Buffer.from("ffd8ffe0", "hex"),
    toPNG: () => pngBytes,
  };
  const sources = [
    {
      display_id: "101",
      id: "screen:101:0",
      name: "Entire Screen",
      thumbnail,
    },
    {
      display_id: "",
      id: "window:202:0",
      name: "Notes Window",
      thumbnail,
    },
    {
      display_id: "",
      id: "window:303:0",
      name: "Example Domain - Chrome",
      thumbnail,
    },
  ];
  return {
    desktopCapturer: {
      async getSources(options) {
        assert.deepEqual(options.types, ["screen", "window"]);
        return sources;
      },
    },
    screen: {
      getPrimaryDisplay: () => ({ id: 101 }),
    },
    userDataPath: directory,
  };
}

function createResponse({ body, contentType = "text/html", ok = true, status = 200, url }) {
  return {
    ok,
    status,
    url,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? contentType : null;
      },
    },
    async text() {
      return body;
    },
  };
}

test("every registered Realtime tool executes a functional path", async () => {
  await withToolHarness(async (options) => {
    const observedNames = [];
    const diagnosticEvents = [];
    options.screenshot.logger = async (event, details) => {
      diagnosticEvents.push({ event, details });
    };

    let result = await executeRealtimeTool(
      "add_task",
      {
        name: "Ship functional tests",
        description: "Cover every registered realtime tool path",
        priority: "high",
      },
      options,
    );
    observedNames.push("add_task");
    assert.equal(result.status, "created");
    assert.equal(result.task.id, "task-ship-functional-tests");

    result = await executeRealtimeTool("list_tasks", {}, options);
    observedNames.push("list_tasks");
    assert.equal(result.status, "listed");
    assert.equal(result.tasks.length, 1);

    result = await executeRealtimeTool(
      "update_task_status",
      { query: "Ship functional tests", status: "completed" },
      options,
    );
    observedNames.push("update_task_status");
    assert.equal(result.status, "updated");
    assert.equal(result.item.status, "completed");

    result = await executeRealtimeTool(
      "update_task",
      { query: "Ship functional tests", priority: "low" },
      options,
    );
    observedNames.push("update_task");
    assert.equal(result.status, "updated");
    assert.equal(result.item.priority, "low");

    result = await executeRealtimeTool("delete_task", { query: "Ship functional tests" }, options);
    observedNames.push("delete_task");
    assert.equal(result.status, "deleted");

    result = await executeRealtimeTool(
      "add_calendar_item",
      {
        title: "Tool review",
        description: "Review the working realtime tools after tests",
        date: "Today",
        time: "5 PM",
      },
      options,
    );
    observedNames.push("add_calendar_item");
    assert.equal(result.status, "created");
    assert.equal(result.calendarItem.id, "calendar-tool-review");

    result = await executeRealtimeTool("list_calendar_items", {}, options);
    observedNames.push("list_calendar_items");
    assert.equal(result.status, "listed");
    assert.equal(result.calendarItems.length, 1);

    result = await executeRealtimeTool(
      "update_calendar_item",
      { query: "Tool review", time: "6 PM" },
      options,
    );
    observedNames.push("update_calendar_item");
    assert.equal(result.status, "updated");
    assert.equal(result.item.time, "6 PM");

    result = await executeRealtimeTool("delete_calendar_item", { query: "Tool review" }, options);
    observedNames.push("delete_calendar_item");
    assert.equal(result.status, "deleted");

    result = await executeRealtimeTool(
      "web_search",
      { query: "functional test", maxResults: 3 },
      options,
    );
    observedNames.push("web_search");
    assert.equal(result.status, "searched");
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0].url, "https://example.com/result");

    result = await executeRealtimeTool(
      "web_fetch",
      { url: "https://example.com/result", maxLength: 500 },
      options,
    );
    observedNames.push("web_fetch");
    assert.equal(result.status, 200);
    assert.equal(result.title, "Functional Page");
    assert.match(result.text, /Fetched page body/);

    result = await executeRealtimeTool("list_screenshot_sources", {}, options);
    observedNames.push("list_screenshot_sources");
    assert.equal(result.status, "listed");
    assert.deepEqual(result.sources, [
      { id: "source-1", name: "Entire Screen", type: "screen" },
      { id: "source-2", name: "Notes Window", type: "window" },
      { id: "source-3", name: "Example Domain - Chrome", type: "window" },
    ]);

    result = await executeRealtimeTool(
      "take_screenshot",
      { target: "source", source_id: "source-2", reason: "functional test" },
      options,
    );
    observedNames.push("take_screenshot");
    assert.equal(result.status, "captured");
    assert.equal(result.source.name, "Notes Window");
    assert.equal(result.source.type, "window");
    assert.equal(result.reason, "functional test");
    assert.deepEqual(result.dimensions, { width: 320, height: 180 });
    assert.deepEqual(await readFile(result.path), Buffer.from("89504e470d0a1a0a", "hex"));

    result = await executeRealtimeTool(
      "analyze_screen",
      { target: "window", window_query: "browser", question: "What text is visible?" },
      options,
    );
    observedNames.push("analyze_screen");
    assert.equal(result.status, "captured_for_realtime_analysis");
    assert.equal(result.source.name, "Example Domain - Chrome");
    assert.equal(result.realtimeInput.type, "message");
    assert.equal(result.realtimeInput.role, "user");
    assert.match(result.realtimeInput.content[0].text, /What text is visible/);
    assert.equal(result.realtimeInput.content[1].type, "input_image");
    assert.match(result.realtimeInput.content[1].image_url, /^data:image\/jpeg;base64,/);
    assert.ok(
      diagnosticEvents.some((entry) => entry.event === "screenshot.capture.written"),
      "expected screenshot diagnostics to record file writes",
    );

    result = await executeRealtimeTool(
      "write_file",
      { path: "notes/todo.md", content: "first draft" },
      options,
    );
    observedNames.push("write_file");
    assert.equal(result.status, "created");

    result = await executeRealtimeTool("read_file", { path: "notes/todo.md" }, options);
    observedNames.push("read_file");
    assert.equal(result.status, "read");
    assert.equal(result.content, "first draft");

    result = await executeRealtimeTool(
      "edit_file",
      { path: "notes/todo.md", oldText: "first", newText: "second" },
      options,
    );
    observedNames.push("edit_file");
    assert.equal(result.status, "edited");
    assert.equal(result.replacements, 1);

    result = await executeRealtimeTool("find_files", { query: "todo" }, options);
    observedNames.push("find_files");
    assert.equal(result.status, "found");
    assert.equal(result.results[0].name, "todo.md");

    result = await executeRealtimeTool("open_file", { path: "notes/todo.md" }, options);
    observedNames.push("open_file");
    assert.equal(result.status, "opened");

    result = await executeRealtimeTool("open_link", { url: "example.com" }, options);
    observedNames.push("open_link");
    assert.equal(result.status, "opened");

    await mkdir(path.join(options.fileSystem.rootPath, "Apps", "Notes.app"), { recursive: true });
    result = await executeRealtimeTool("open_app", { name: "notes" }, options);
    observedNames.push("open_app");
    assert.equal(result.status, "opened");
    assert.equal(result.app, "Notes");
    assert.equal(options.launcherCalls.length, 3);

    result = await executeRealtimeTool(
      "computer_use_task",
      { task: "Open example.com and report back", url: "https://example.com", maxSteps: 2 },
      options,
    );
    observedNames.push("computer_use_task");
    assert.equal(result.status, "completed");
    assert.equal(result.finalText, "Computer task finished.");
    assert.equal(result.steps, 1);

    result = await executeRealtimeTool(
      "remember",
      { category: "preferences", subject: "coffee", content: "Takes it black" },
      options,
    );
    observedNames.push("remember");
    assert.equal(result.status, "saved");

    result = await executeRealtimeTool("list_facts", { query: "black" }, options);
    observedNames.push("list_facts");
    assert.equal(result.count, 1);

    result = await executeRealtimeTool(
      "forget",
      { category: "preferences", subject: "coffee" },
      options,
    );
    observedNames.push("forget");
    assert.equal(result.status, "forgotten");

    result = await executeRealtimeTool(
      "soul_set",
      { aspect: "tone", content: "Be direct." },
      options,
    );
    observedNames.push("soul_set");
    assert.equal(result.status, "saved");

    result = await executeRealtimeTool("soul_list", {}, options);
    observedNames.push("soul_list");
    assert.equal(result.count, 1);

    result = await executeRealtimeTool("soul_delete", { aspect: "tone" }, options);
    observedNames.push("soul_delete");
    assert.equal(result.status, "deleted");

    result = await executeRealtimeTool("daily_log", { entry: "Ran the tool suite" }, options);
    observedNames.push("daily_log");
    assert.equal(result.status, "logged");

    result = await executeRealtimeTool("cancel_computer_use", {}, options);
    observedNames.push("cancel_computer_use");
    assert.equal(result.status, "idle");

    result = await executeRealtimeTool("end_call", { reason: "Ken said goodbye" }, options);
    observedNames.push("end_call");
    assert.equal(result.status, "call_ended");
    assert.equal(result.reason, "Ken said goodbye");

    assert.deepEqual(
      observedNames.sort(),
      getRealtimeToolDefinitions()
        .map((tool) => tool.name)
        .sort(),
    );
  });
});

test("unknown Realtime tool returns an error result", async () => {
  assert.deepEqual(await executeRealtimeTool("missing_tool", {}), {
    status: "error",
    message: "Unknown realtime tool: missing_tool",
  });
});
