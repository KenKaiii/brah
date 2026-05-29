import {
  getDatabase,
  getDatabasePath,
  migrateLegacyStores,
  setDatabaseUserDataPath,
} from "./database.js";
import {
  createFallbackPlannerId,
  createPlannerCalendarItem,
  createPlannerTask,
  normalizeCalendarDate,
  normalizeCalendarDescription,
  normalizeCalendarTime,
  normalizeCalendarTitle,
  normalizeTaskDescription,
  normalizeTaskName,
  normalizeTaskPriority,
  normalizeTaskStatus,
} from "./planner-items.js";

export { setDatabaseUserDataPath };

export function getPlannerStorePath() {
  return getDatabasePath();
}

export function loadPlannerState(storePath = getPlannerStorePath()) {
  const db = getDatabase(storePath);
  return {
    tasks: db
      .prepare("SELECT id, name, description, priority, status FROM tasks ORDER BY seq")
      .all()
      .map(normalizeStoredTask),
    calendarItems: db
      .prepare("SELECT id, title, description, date, time FROM calendar_items ORDER BY seq")
      .all()
      .map(normalizeStoredCalendarItem),
  };
}

export function savePlannerState(state, storePath = getPlannerStorePath()) {
  const db = getDatabase(storePath);
  const tasks = (state.tasks ?? []).map(normalizeStoredTask);
  const calendarItems = (state.calendarItems ?? []).map(normalizeStoredCalendarItem);
  const insertTask = db.prepare(
    "INSERT OR REPLACE INTO tasks (id, name, description, priority, status) VALUES (?, ?, ?, ?, ?)",
  );
  const insertCalendar = db.prepare(
    "INSERT OR REPLACE INTO calendar_items (id, title, description, date, time) VALUES (?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM tasks; DELETE FROM calendar_items;");
    for (const task of tasks) {
      insertTask.run(task.id, task.name, task.description, task.priority, task.status);
    }
    for (const item of calendarItems) {
      insertCalendar.run(item.id, item.title, item.description, item.date, item.time);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createTask(input, storePath = getPlannerStorePath()) {
  const db = getDatabase(storePath);
  const existing = db.prepare("SELECT id FROM tasks").all();
  const task = normalizeStoredTask(createPlannerTask(input, existing));
  db.prepare(
    "INSERT INTO tasks (id, name, description, priority, status) VALUES (?, ?, ?, ?, ?)",
  ).run(task.id, task.name, task.description, task.priority, task.status);
  return task;
}

export function listTasks(storePath = getPlannerStorePath()) {
  return loadPlannerState(storePath).tasks;
}

export function deleteTask(query, storePath = getPlannerStorePath()) {
  const db = getDatabase(storePath);
  const match = findPlannerItem(listTasks(storePath), query, (task) => task.name);
  if (!match) {
    return {
      status: "not_found",
      message: "No matching task was found.",
    };
  }
  db.prepare("DELETE FROM tasks WHERE id = ?").run(match.id);
  return {
    status: "deleted",
    message: "Task deleted.",
    item: match,
  };
}

export function updateTaskStatus(query, status, storePath = getPlannerStorePath()) {
  const db = getDatabase(storePath);
  const match = findPlannerItem(listTasks(storePath), query, (task) => task.name);
  if (!match) {
    return {
      status: "not_found",
      message: "No matching task was found.",
    };
  }
  const updated = { ...match, status };
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(updated.status, updated.id);
  return {
    status: "updated",
    message: "Task status updated.",
    item: updated,
  };
}

export function createCalendarItem(input, storePath = getPlannerStorePath()) {
  const db = getDatabase(storePath);
  const existing = db.prepare("SELECT id FROM calendar_items").all();
  const item = normalizeStoredCalendarItem(createPlannerCalendarItem(input, existing));
  db.prepare(
    "INSERT INTO calendar_items (id, title, description, date, time) VALUES (?, ?, ?, ?, ?)",
  ).run(item.id, item.title, item.description, item.date, item.time);
  return item;
}

export function listCalendarItems(storePath = getPlannerStorePath()) {
  return loadPlannerState(storePath).calendarItems;
}

export function deleteCalendarItem(query, storePath = getPlannerStorePath()) {
  const db = getDatabase(storePath);
  const match = findPlannerItem(listCalendarItems(storePath), query, (item) => item.title);
  if (!match) {
    return {
      status: "not_found",
      message: "No matching calendar item was found.",
    };
  }
  db.prepare("DELETE FROM calendar_items WHERE id = ?").run(match.id);
  return {
    status: "deleted",
    message: "Calendar item deleted.",
    item: match,
  };
}

export function emptyPlannerState() {
  return {
    tasks: [],
    calendarItems: [],
  };
}

// Imports the legacy planner/items.json file (from userData or the old tmp dir)
// into SQLite, skipping any ids that already exist.
export function migrateLegacyPlannerStore(dbPath = getPlannerStorePath()) {
  migrateLegacyStores(
    [
      {
        relativePath: "planner/items.json",
        apply(db, parsed) {
          if (!isRecord(parsed)) {
            return;
          }
          const insertTask = db.prepare(
            "INSERT OR IGNORE INTO tasks (id, name, description, priority, status) VALUES (?, ?, ?, ?, ?)",
          );
          const insertCalendar = db.prepare(
            "INSERT OR IGNORE INTO calendar_items (id, title, description, date, time) VALUES (?, ?, ?, ?, ?)",
          );
          for (const raw of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
            const task = normalizeStoredTask(raw);
            insertTask.run(task.id, task.name, task.description, task.priority, task.status);
          }
          for (const raw of Array.isArray(parsed.calendarItems) ? parsed.calendarItems : []) {
            const item = normalizeStoredCalendarItem(raw);
            insertCalendar.run(item.id, item.title, item.description, item.date, item.time);
          }
        },
      },
    ],
    dbPath,
  );
}

function normalizeStoredTask(value) {
  const record = isRecord(value) ? value : {};
  const name = typeof record.name === "string" ? record.name : "";
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : createFallbackPlannerId("task", name),
    name: normalizeTaskName(name),
    description: normalizeTaskDescription(
      typeof record.description === "string" ? record.description : "",
    ),
    priority: normalizeTaskPriority(record.priority),
    status: normalizeTaskStatus(record.status),
  };
}

function normalizeStoredCalendarItem(value) {
  const record = isRecord(value) ? value : {};
  const title = typeof record.title === "string" ? record.title : "";
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : createFallbackPlannerId("calendar", title),
    title: normalizeCalendarTitle(title),
    description: normalizeCalendarDescription(
      typeof record.description === "string" ? record.description : "",
    ),
    date: normalizeCalendarDate(typeof record.date === "string" ? record.date : ""),
    time: normalizeCalendarTime(typeof record.time === "string" ? record.time : ""),
  };
}

function findPlannerItem(items, query, getName) {
  const normalizedQuery = String(query).trim().toLowerCase();
  if (!normalizedQuery) {
    return null;
  }
  return (
    items.find((item) => item.id.toLowerCase() === normalizedQuery) ??
    items.find((item) => getName(item).trim().toLowerCase() === normalizedQuery) ??
    items.find((item) => getName(item).trim().toLowerCase().includes(normalizedQuery)) ??
    null
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
