import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDatabase } from "../src/realtime/tools/database.js";
import { executePlannerTool } from "../src/realtime/tools/planner-tools.js";

async function withStore(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-planner-edit-"));
  const storePath = path.join(directory, "brah.db");
  try {
    await callback({ storePath });
  } finally {
    closeDatabase(storePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("update_task renames and reprioritizes in place, keeping the id", async () => {
  await withStore(async (options) => {
    const created = await executePlannerTool(
      "add_task",
      {
        name: "Draft launch post",
        description: "Write the first draft of the post",
        priority: "low",
      },
      options,
    );
    const updated = await executePlannerTool(
      "update_task",
      { query: "launch post", name: "Publish launch post", priority: "high" },
      options,
    );
    assert.equal(updated.status, "updated");
    assert.equal(updated.item.id, created.task.id);
    assert.equal(updated.item.name, "Publish launch post");
    assert.equal(updated.item.priority, "high");
    assert.equal(updated.item.description, "Write the first draft of the post");
    assert.equal(updated.previous.name, "Draft launch post");

    const listed = await executePlannerTool("list_tasks", {}, options);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].name, "Publish launch post");
  });
});

test("update_task validates fields and requires at least one change", async () => {
  await withStore(async (options) => {
    await executePlannerTool(
      "add_task",
      { name: "Call the bank", description: "Ask about the card replacement", priority: "medium" },
      options,
    );
    const table = [
      [{ query: "bank" }, /at least one/],
      [{ query: "bank", priority: "urgent" }, /priority must be/],
      [{ query: "bank", status: "finished" }, /status must be/],
      [{ query: "bank", name: "" }, /name must be between/],
      [{ name: "x" }, /query must be a string/],
    ];
    for (const [args, pattern] of table) {
      const result = await executePlannerTool("update_task", args, options);
      assert.equal(result.status, "invalid_arguments", JSON.stringify(args));
      assert.match(result.message, pattern);
    }
    const missing = await executePlannerTool(
      "update_task",
      { query: "dentist", status: "completed" },
      options,
    );
    assert.equal(missing.status, "not_found");
  });
});

test("update_calendar_item reschedules without touching other fields", async () => {
  await withStore(async (options) => {
    const created = await executePlannerTool(
      "add_calendar_item",
      {
        title: "Product review",
        description: "Walk through the new onboarding flow with the team",
        date: "Tomorrow",
        time: "10:00 AM",
      },
      options,
    );
    const updated = await executePlannerTool(
      "update_calendar_item",
      { query: created.calendarItem.id, date: "Friday", time: "2:30 PM" },
      options,
    );
    assert.equal(updated.status, "updated");
    assert.equal(updated.item.id, created.calendarItem.id);
    assert.equal(updated.item.title, "Product review");
    assert.equal(updated.item.date, "Friday");
    assert.equal(updated.item.time, "2:30 PM");
    assert.equal(updated.previous.time, "10:00 AM");

    const none = await executePlannerTool(
      "update_calendar_item",
      { query: "Product review" },
      options,
    );
    assert.equal(none.status, "invalid_arguments");
  });
});
