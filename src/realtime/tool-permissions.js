const toolPermissionMetadata = Object.freeze({
  add_task: {
    level: "low",
    label: "Add task",
    description: "Add a task to your local Tasks list.",
  },
  list_tasks: {
    level: "read",
    label: "Read tasks",
    description: "Read your local Tasks list.",
  },
  delete_task: {
    level: "destructive",
    label: "Delete task",
    description: "Delete a task from your local Tasks list.",
  },
  update_task_status: {
    level: "write",
    label: "Update task",
    description: "Change a task status in your local Tasks list.",
  },
  add_calendar_item: {
    level: "write",
    label: "Add calendar item",
    description: "Add an item to your local Calendar list.",
  },
  list_calendar_items: {
    level: "read",
    label: "Read calendar",
    description: "Read your local Calendar list.",
  },
  delete_calendar_item: {
    level: "destructive",
    label: "Delete calendar item",
    description: "Delete an item from your local Calendar list.",
  },
  remember: {
    level: "write",
    label: "Save memory",
    description: "Save a fact about you to local long-term memory.",
  },
  forget: {
    level: "destructive",
    label: "Forget memory",
    description: "Delete a fact from local long-term memory.",
  },
  list_facts: {
    level: "read",
    label: "Read memory",
    description: "Read the facts stored in local long-term memory.",
  },
  update_fact: {
    level: "write",
    label: "Update memory",
    description: "Correct a fact stored in local long-term memory.",
  },
  recall_memory: {
    level: "read",
    label: "Recall memory",
    description: "Search the facts stored in local long-term memory.",
  },
  daily_log: {
    level: "low",
    label: "Daily log",
    description: "Add an entry to today's local daily log.",
  },
  web_search: {
    level: "network",
    label: "Search web",
    description: "Send a search query to DuckDuckGo.",
  },
  web_fetch: {
    level: "network",
    label: "Read web page",
    description: "Fetch and read a public web page.",
  },
  read_file: {
    level: "read",
    label: "Read file",
    description: "Read a text file from your local workspace.",
  },
  write_file: {
    level: "write",
    label: "Write file",
    description: "Create or overwrite a file in your local workspace.",
  },
  edit_file: {
    level: "write",
    label: "Edit file",
    description: "Replace text inside a file in your local workspace.",
  },
  list_screenshot_sources: {
    level: "screen",
    label: "List screen sources",
    description: "List visible screens and windows available for capture.",
  },
  take_screenshot: {
    level: "screen",
    label: "Take screenshot",
    description: "Capture and save a screenshot locally.",
  },
  analyze_screen: {
    level: "sensitive",
    label: "Analyze screen",
    description: "Capture a screenshot and send it to OpenAI for vision/OCR analysis.",
  },
  computer_use_task: {
    level: "sensitive",
    label: "Use computer",
    description:
      "Let OpenAI operate a browser harness or, in OS mode, control the real machine's mouse and keyboard from screenshots.",
  },
  end_call: {
    level: "low",
    label: "End call",
    description: "Hang up and end the current voice call.",
  },
});

export function getToolPermissionRequest(name, args = {}) {
  const metadata = toolPermissionMetadata[name] ?? {
    level: "unknown",
    label: name,
    description: "Run a realtime tool.",
  };
  return {
    toolName: name,
    label: metadata.label,
    level: resolveToolLevel(name, metadata.level, args),
    description: metadata.description,
    summary: summarizeToolRequest(name, args),
  };
}

export function createPermissionDeniedResult(request) {
  return {
    status: "permission_denied",
    message: `Ken did not approve ${request.label}. Ask before trying this tool again.`,
    tool: request.toolName,
  };
}

export function formatPermissionPrompt(request) {
  const parts = [
    `${request.label}?`,
    request.description,
    request.summary ? `Details: ${request.summary}` : "",
    `Risk: ${request.level}`,
  ].filter(Boolean);
  return parts.join("\n\n");
}

function resolveToolLevel(name, level, args) {
  if (name === "computer_use_task" && isRecord(args) && args.target === "computer") {
    return "destructive";
  }
  return level;
}

function summarizeToolRequest(name, args) {
  switch (name) {
    case "add_task":
      return summarizeFields(args, ["name", "priority"]);
    case "delete_task":
    case "update_task_status":
      return summarizeFields(args, ["query", "status"]);
    case "add_calendar_item":
      return summarizeFields(args, ["title", "date", "time"]);
    case "delete_calendar_item":
      return summarizeFields(args, ["query"]);
    case "remember":
      return summarizeFields(args, ["category", "subject", "content"]);
    case "forget":
      return summarizeFields(args, ["id", "category", "subject"]);
    case "list_facts":
      return summarizeFields(args, ["category"]);
    case "update_fact":
      return summarizeFields(args, ["id", "subject", "content"]);
    case "recall_memory":
      return summarizeFields(args, ["query"]);
    case "daily_log":
      return summarizeFields(args, ["entry"]);
    case "web_search":
      return summarizeFields(args, ["query"]);
    case "web_fetch":
      return summarizeFields(args, ["url"]);
    case "read_file":
      return summarizeFields(args, ["path"]);
    case "write_file":
      return summarizeFields(args, ["path"]);
    case "edit_file":
      return summarizeFields(args, ["path", "replaceAll"]);
    case "take_screenshot":
    case "analyze_screen":
      return summarizeFields(args, ["target", "source_id", "reason", "question"]);
    case "computer_use_task":
      return summarizeFields(args, ["task", "target", "url", "autonomy", "maxSteps"]);
    case "end_call":
      return summarizeFields(args, ["reason"]);
    default:
      return "";
  }
}

function summarizeFields(args, fields) {
  if (!isRecord(args)) {
    return "";
  }
  return fields
    .map((field) => formatField(field, args[field]))
    .filter(Boolean)
    .join(", ");
}

function formatField(field, value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `${field}: ${text.slice(0, 140)}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
