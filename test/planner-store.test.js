import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDatabase } from "../src/realtime/tools/database.js";
import {
  createTask,
  emptyPlannerState,
  listTasks,
  loadPlannerState,
  savePlannerState,
} from "../src/realtime/tools/planner-store.js";

async function withPlannerFile(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-planner-"));
  const filePath = path.join(directory, "planner", "items.db");
  try {
    await callback(filePath);
  } finally {
    closeDatabase(filePath);
    await rm(directory, { force: true, recursive: true });
  }
}

async function reopen(filePath) {
  closeDatabase(filePath);
}

test("empty and missing planner state loads safely", async () => {
  await withPlannerFile(async (filePath) => {
    assert.deepEqual(await loadPlannerState(filePath), emptyPlannerState());
  });
});

test("planner state normalizes saved tasks and calendar items", async () => {
  await withPlannerFile(async (filePath) => {
    await savePlannerState(
      {
        tasks: [
          {
            id: "",
            name: "  Ship realtime functional tests now please ",
            description: "  Cover the realtime tool call flow in a deterministic harness. ",
            priority: "urgent",
            status: "done",
          },
        ],
        calendarItems: [
          {
            id: "",
            title: "  Test review sync today ",
            description: " Review the new realtime tool tests before shipping. ",
            date: " Tomorrow morning ",
            time: " 10:30 AM PST ",
          },
        ],
      },
      filePath,
    );

    await reopen(filePath);
    const loaded = await loadPlannerState(filePath);
    assert.deepEqual(loaded.tasks, [
      {
        id: "task-ship-realtime-functional-tests-now-please",
        name: "Ship realtime functional tests now",
        description: "Cover the realtime tool call flow in a deterministic harness",
        priority: "medium",
        status: "completed",
      },
    ]);
    assert.deepEqual(loaded.calendarItems, [
      {
        id: "calendar-test-review-sync-today",
        title: "Test review sync today",
        description: "Review the new realtime tool tests before shipping",
        date: "Tomorrow morning",
        time: "10:30 AM PST",
      },
    ]);
  });
});

test("concurrent createTask calls all persist without clobbering", async () => {
  await withPlannerFile(async (filePath) => {
    const count = 10;
    await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        createTask(
          {
            name: `Task number ${index + 1}`,
            description: `Description for task ${index + 1}`,
            priority: "medium",
            status: "todo",
          },
          filePath,
        ),
      ),
    );

    const tasks = await listTasks(filePath);
    assert.equal(tasks.length, count);
    const ids = new Set(tasks.map((task) => task.id));
    assert.equal(ids.size, count);
  });
});

test("created tasks persist across a reconnect", async () => {
  await withPlannerFile(async (filePath) => {
    await createTask(
      {
        name: "Persisted task",
        description: "Survives closing and reopening the database",
        priority: "high",
        status: "todo",
      },
      filePath,
    );

    await reopen(filePath);
    const tasks = await listTasks(filePath);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, "Persisted task");
    assert.equal(tasks[0].priority, "high");
  });
});

test("empty planner state is returned for a fresh database", async () => {
  await withPlannerFile(async (filePath) => {
    assert.deepEqual(await loadPlannerState(filePath), emptyPlannerState());
  });
});
