import {
  normalizeCalendarDate,
  normalizeCalendarDescription,
  normalizeCalendarTime,
  normalizeCalendarTitle,
  normalizeTaskDescription,
  normalizeTaskName,
  normalizeTaskStatus,
  taskPriorities,
  taskStatuses,
} from "./planner-items.js";
import {
  createCalendarItem,
  createTask,
  deleteCalendarItem,
  deleteTask,
  listCalendarItems,
  listTasks,
  updateCalendarItem,
  updateTask,
  updateTaskStatus,
} from "./planner-store.js";

export async function executePlannerTool(name, args, options = {}) {
  switch (name) {
    case "add_task":
      return addTask(args, options);
    case "list_tasks":
      return listTaskTool(options);
    case "delete_task":
      return deleteTaskTool(args, options);
    case "update_task_status":
      return updateTaskStatusTool(args, options);
    case "update_task":
      return updateTaskTool(args, options);
    case "update_calendar_item":
      return updateCalendarItemTool(args, options);
    case "add_calendar_item":
      return addCalendarItem(args, options);
    case "list_calendar_items":
      return listCalendarItemsTool(options);
    case "delete_calendar_item":
      return deleteCalendarItemTool(args, options);
    default:
      return null;
  }
}

async function addTask(args, options) {
  const validation = validateStrings(args, {
    name: { min: 1, max: 60 },
    description: { min: 1, max: 120 },
  });
  if (!validation.ok) {
    return validation.error;
  }
  if (!taskPriorities.includes(args.priority)) {
    return invalidArguments("priority must be one of high, medium, or low.");
  }
  const task = await createTask(
    {
      name: normalizeTaskName(args.name),
      description: normalizeTaskDescription(args.description),
      priority: args.priority,
      status: "todo",
    },
    options.storePath,
  );
  return {
    status: "created",
    message: "Task added to the local Tasks list.",
    task,
  };
}

async function listTaskTool(options) {
  const tasks = await listTasks(options.storePath);
  return {
    status: "listed",
    message:
      tasks.length > 0
        ? "Use the task id for update_task or delete_task follow-ups."
        : "There are no tasks to delete or update.",
    tasks: tasks.map((task) => ({
      id: task.id,
      name: task.name,
      priority: task.priority,
      status: task.status,
      description: task.description,
    })),
  };
}

async function deleteTaskTool(args, options) {
  const validation = validateStrings(args, { query: { min: 1, max: 80 } });
  return validation.ok ? deleteTask(args.query, options.storePath) : validation.error;
}

async function updateTaskStatusTool(args, options) {
  const validation = validateStrings(args, { query: { min: 1, max: 80 } });
  if (!validation.ok) {
    return validation.error;
  }
  if (!taskStatuses.includes(args.status)) {
    return invalidArguments("status must be one of todo, in_progress, or completed.");
  }
  return updateTaskStatus(args.query, normalizeTaskStatus(args.status), options.storePath);
}

async function updateTaskTool(args, options) {
  const validation = validateStrings(args, { query: { min: 1, max: 80 } });
  if (!validation.ok) {
    return validation.error;
  }
  const changes = collectChanges(args, {
    name: { min: 1, max: 60, normalize: normalizeTaskName },
    description: { min: 1, max: 120, normalize: normalizeTaskDescription },
  });
  if (!changes.ok) {
    return changes.error;
  }
  if (args.priority !== undefined) {
    if (!taskPriorities.includes(args.priority)) {
      return invalidArguments("priority must be one of high, medium, or low.");
    }
    changes.value.priority = args.priority;
  }
  if (args.status !== undefined) {
    if (!taskStatuses.includes(args.status)) {
      return invalidArguments("status must be one of todo, in_progress, or completed.");
    }
    changes.value.status = args.status;
  }
  if (Object.keys(changes.value).length === 0) {
    return invalidArguments("Provide at least one of name, description, priority, or status.");
  }
  return updateTask(args.query, changes.value, options.storePath);
}

async function updateCalendarItemTool(args, options) {
  const validation = validateStrings(args, { query: { min: 1, max: 80 } });
  if (!validation.ok) {
    return validation.error;
  }
  const changes = collectChanges(args, {
    title: { min: 1, max: 48, normalize: normalizeCalendarTitle },
    description: { min: 1, max: 120, normalize: normalizeCalendarDescription },
    date: { min: 1, max: 24, normalize: normalizeCalendarDate },
    time: { min: 1, max: 24, normalize: normalizeCalendarTime },
  });
  if (!changes.ok) {
    return changes.error;
  }
  if (Object.keys(changes.value).length === 0) {
    return invalidArguments("Provide at least one of title, description, date, or time.");
  }
  return updateCalendarItem(args.query, changes.value, options.storePath);
}

// Validates the optional string fields that are present and normalizes them.
function collectChanges(args, shape) {
  const value = {};
  for (const [key, bounds] of Object.entries(shape)) {
    if (args[key] === undefined) {
      continue;
    }
    const check = validateStrings(args, { [key]: bounds });
    if (!check.ok) {
      return check;
    }
    value[key] = bounds.normalize(args[key]);
  }
  return { ok: true, value };
}

async function addCalendarItem(args, options) {
  const validation = validateStrings(args, {
    title: { min: 1, max: 48 },
    description: { min: 1, max: 120 },
    date: { min: 1, max: 24 },
    time: { min: 1, max: 24 },
  });
  if (!validation.ok) {
    return validation.error;
  }
  const calendarItem = await createCalendarItem(
    {
      title: normalizeCalendarTitle(args.title),
      description: normalizeCalendarDescription(args.description),
      date: normalizeCalendarDate(args.date),
      time: normalizeCalendarTime(args.time),
    },
    options.storePath,
  );
  return {
    status: "created",
    message: "Calendar item added to the local Calendar list.",
    calendarItem,
  };
}

async function listCalendarItemsTool(options) {
  const calendarItems = await listCalendarItems(options.storePath);
  return {
    status: "listed",
    message:
      calendarItems.length > 0
        ? "Use the calendar item id for update_calendar_item or delete_calendar_item follow-ups."
        : "There are no calendar items.",
    calendarItems: calendarItems.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      date: item.date,
      time: item.time,
    })),
  };
}

async function deleteCalendarItemTool(args, options) {
  const validation = validateStrings(args, { query: { min: 1, max: 80 } });
  return validation.ok ? deleteCalendarItem(args.query, options.storePath) : validation.error;
}

function validateStrings(args, shape) {
  if (!isRecord(args)) {
    return { ok: false, error: invalidArguments("Arguments must be an object.") };
  }
  for (const [key, bounds] of Object.entries(shape)) {
    const value = args[key];
    if (typeof value !== "string") {
      return { ok: false, error: invalidArguments(`${key} must be a string.`) };
    }
    const trimmed = value.trim();
    if (trimmed.length < bounds.min || trimmed.length > bounds.max) {
      return {
        ok: false,
        error: invalidArguments(
          `${key} must be between ${bounds.min} and ${bounds.max} characters.`,
        ),
      };
    }
  }
  return { ok: true };
}

function invalidArguments(message) {
  return {
    status: "invalid_arguments",
    message,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
