const emptyObjectParameters = Object.freeze({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});

const taskPriorityValues = Object.freeze(["high", "medium", "low"]);
const taskStatusValues = Object.freeze(["todo", "in_progress", "completed"]);

export const realtimeToolDefinitions = Object.freeze([
  {
    type: "function",
    name: "add_task",
    description:
      "Add one short item to the local Tasks list when Ken asks to remember, plan, or track a task.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Task title, 2-5 words, like 'Save task history'.",
          minLength: 1,
          maxLength: 60,
        },
        description: {
          type: "string",
          description: "One concise sentence, about 6-12 words.",
          minLength: 1,
          maxLength: 120,
        },
        priority: {
          type: "string",
          description: "Visible priority badge for the task.",
          enum: taskPriorityValues,
        },
      },
      required: ["name", "description", "priority"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_tasks",
    description:
      "Read the current local Tasks list before answering task questions or choosing an id for updates/deletes.",
    parameters: emptyObjectParameters,
  },
  {
    type: "function",
    name: "delete_task",
    description:
      "Delete one local task. Pass the task id or a short exact-ish title query when Ken asks to remove a task.",
    parameters: createLookupParameters(
      "Task id or title query, such as 'task-save-task-history' or 'Save task history'.",
    ),
  },
  {
    type: "function",
    name: "update_task_status",
    description:
      "Change one local task status, for example marking it todo, in progress, or completed.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Task id or title query, such as 'task-save-task-history' or 'Save task history'.",
          minLength: 1,
          maxLength: 80,
        },
        status: {
          type: "string",
          description: "New task status.",
          enum: taskStatusValues,
        },
      },
      required: ["query", "status"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "add_calendar_item",
    description:
      "Add one short item to the local Calendar list when Ken asks to schedule, block, or remember an event.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Calendar title, 2-4 words, like 'Product review'.",
          minLength: 1,
          maxLength: 48,
        },
        description: {
          type: "string",
          description: "One concise sentence, about 7-12 words.",
          minLength: 1,
          maxLength: 120,
        },
        date: {
          type: "string",
          description: "Short visible date label, such as 'Today', 'Tomorrow', or 'Jun 12'.",
          minLength: 1,
          maxLength: 24,
        },
        time: {
          type: "string",
          description: "Short visible time label, such as '10:00 AM' or '1:30 PM'.",
          minLength: 1,
          maxLength: 24,
        },
      },
      required: ["title", "description", "date", "time"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_calendar_items",
    description:
      "Read the current local Calendar list before answering calendar questions or choosing an id to delete.",
    parameters: emptyObjectParameters,
  },
  {
    type: "function",
    name: "delete_calendar_item",
    description:
      "Delete one local calendar item. Pass the calendar item id or a short exact-ish title query when Ken asks to remove an event.",
    parameters: createLookupParameters(
      "Calendar item id or title query, such as 'calendar-product-review' or 'Product review'.",
    ),
  },
  {
    type: "function",
    name: "remember",
    description:
      "Save a fact to long-term memory. Keep each fact atomic (under 30 words, one piece of info per call). Use specific keys like 'partner_name' not 'family'. Save proactively when Ken shares something meaningful. If Ken asks you NOT to remember something, do not save it. For private or emotionally heavy facts (health, relationships, finances), save with sensitive true so they are never proactively brought up.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Category: user_info, preferences, projects, people, work, notes, decisions.",
          minLength: 1,
          maxLength: 60,
        },
        subject: {
          type: "string",
          description:
            "Specific, descriptive key, such as 'partner_name', 'coffee_preference', or 'current_project'.",
          minLength: 1,
          maxLength: 80,
        },
        content: {
          type: "string",
          description: "The fact to remember (max 25-30 words, one piece of info only).",
          minLength: 1,
          maxLength: 300,
        },
        sensitive: {
          type: "boolean",
          description:
            "Mark true for private/emotionally heavy facts (health, relationships, finances). Sensitive facts are remembered but never proactively brought up unprompted.",
        },
      },
      required: ["category", "subject", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "forget",
    description:
      "Remove a fact from long-term memory. Forget by category + subject, or by fact id from list_facts/recall_memory.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Category of the fact to forget.",
          minLength: 1,
          maxLength: 60,
        },
        subject: {
          type: "string",
          description: "Subject of the fact to forget.",
          minLength: 1,
          maxLength: 80,
        },
        id: {
          type: "integer",
          description: "Fact id (alternative to category+subject).",
          minimum: 1,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_facts",
    description:
      "List all known facts from long-term memory. Use when Ken asks 'what do you know about me' or before updating/forgetting a fact.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional: filter by category.",
          minLength: 1,
          maxLength: 60,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_fact",
    description:
      "Correct or refine an existing fact by its id (get ids from list_facts or recall_memory). Use when Ken updates info that is already remembered, instead of creating a duplicate.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "The fact id to update.",
          minimum: 1,
        },
        category: {
          type: "string",
          description: "New category (optional).",
          minLength: 1,
          maxLength: 60,
        },
        subject: {
          type: "string",
          description: "New subject key (optional).",
          minLength: 1,
          maxLength: 80,
        },
        content: {
          type: "string",
          description: "New content (optional).",
          minLength: 1,
          maxLength: 300,
        },
        sensitive: {
          type: "boolean",
          description:
            "Set true to mark the fact private/sensitive (never proactively brought up unprompted), false to unmark (optional).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "recall_memory",
    description:
      "Search your own long-term memory for facts matching a query (keyword match on content, subject, and category). Use mid-conversation when you need to remember something specific Ken mentioned before.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to recall, in natural language keywords.",
          minLength: 1,
          maxLength: 240,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "daily_log",
    description:
      "Journal one concise line about what Ken worked on, talked about, decided, or how he seemed. Log at major topic changes or session endings, not every message. The auto-timestamped entry is kept for a few days and injected for continuity.",
    parameters: {
      type: "object",
      properties: {
        entry: {
          type: "string",
          description: "One concise line describing what happened (auto-timestamped).",
          minLength: 1,
          maxLength: 400,
        },
      },
      required: ["entry"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Search the public web for current information and return concise result summaries.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Public web search query.",
          minLength: 1,
          maxLength: 240,
        },
        maxResults: {
          type: "integer",
          description: "Maximum number of search results to return, default 5 and cap 10.",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "web_fetch",
    description:
      "Fetch and read a public HTTP or HTTPS page, stripping scripts, styles, and markup.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public http:// or https:// URL to fetch.",
          minLength: 1,
          maxLength: 2048,
        },
        maxLength: {
          type: "integer",
          description: "Maximum text characters to return, default 8000 and cap 20000.",
          minimum: 500,
          maximum: 20000,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_file",
    description:
      "Read a UTF-8 text file from Ken's workspace. Use a path relative to the workspace root before editing or answering questions about file contents.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path, such as 'notes/todo.md'.",
          minLength: 1,
          maxLength: 1024,
        },
        maxBytes: {
          type: "integer",
          description: "Maximum bytes to read, default 60000 and cap 200000.",
          minimum: 1,
          maximum: 200000,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file in Ken's workspace with the full new contents. Parent folders are created automatically. Confirm before overwriting important files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to write.",
          minLength: 1,
          maxLength: 1024,
        },
        content: {
          type: "string",
          description: "Full file contents to write.",
          maxLength: 1000000,
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "edit_file",
    description:
      "Replace an exact text snippet inside an existing workspace file. oldText must match exactly and uniquely unless replaceAll is true. Read the file first to copy the snippet.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to edit.",
          minLength: 1,
          maxLength: 1024,
        },
        oldText: {
          type: "string",
          description:
            "Exact existing text to replace, including surrounding context to stay unique.",
          minLength: 1,
          maxLength: 100000,
        },
        newText: {
          type: "string",
          description: "Replacement text.",
          maxLength: 100000,
        },
        replaceAll: {
          type: "boolean",
          description:
            "Replace every occurrence instead of requiring a unique match. Defaults to false.",
        },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_screenshot_sources",
    description:
      "List sanitized screen/window capture targets using stable session-local source ids. Use before taking a source screenshot.",
    parameters: {
      type: "object",
      properties: {
        includeScreens: {
          type: "boolean",
          description: "Whether to include screen sources. Defaults to true.",
        },
        includeWindows: {
          type: "boolean",
          description: "Whether to include window sources. Defaults to true.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "take_screenshot",
    description:
      "Capture a primary screen, listed source, or window matched by title/app query (for example browser, YouTube, Chrome, Slack) and save it locally.",
    parameters: createScreenshotTargetParameters({ includeQuestion: false }),
  },
  {
    type: "function",
    name: "analyze_screen",
    description:
      "Capture a primary screen, listed source, or window matched by title/app query (for example browser, YouTube, Chrome, Slack), then send the pixels to the active Realtime vision session.",
    parameters: createScreenshotTargetParameters({ includeQuestion: true }),
  },
  {
    type: "function",
    name: "computer_use_task",
    description:
      "Run a computer-use task. Use target 'browser' for an isolated automation browser harness, or target 'computer' to operate Ken's real desktop (live screen plus OS mouse and keyboard) when he asks you to control the actual machine. OS mode requires Screen Recording and Accessibility permissions.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
        },
        target: {
          type: "string",
          enum: ["browser", "computer"],
        },
        url: {
          type: "string",
          maxLength: 2048,
        },
        autonomy: {
          type: "string",
          enum: ["ask_before_actions", "auto_until_sensitive"],
        },
        maxSteps: {
          type: "integer",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "cancel_computer_use",
    description:
      "Stop the currently running computer_use_task when Ken asks to stop/cancel computer use, or when the task should be aborted.",
    parameters: emptyObjectParameters,
  },
  {
    type: "function",
    name: "end_call",
    description:
      "End the current voice call and hang up when Ken says goodbye, asks to end/stop the call, or the conversation is clearly finished. Say a short goodbye first, then call this.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Optional short reason for ending the call, such as 'Ken said goodbye'.",
          maxLength: 120,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
]);

export function getRealtimeToolDefinitions() {
  return structuredClone(realtimeToolDefinitions);
}

function createScreenshotTargetParameters({ includeQuestion }) {
  return {
    type: "object",
    properties: {
      source_id: {
        type: "string",
        description:
          "Session-local source id from list_screenshot_sources, required when target is source.",
        minLength: 1,
        maxLength: 40,
      },
      window_query: {
        type: "string",
        description:
          "Natural-language window/app/title query, required when target is window. Examples: browser, YouTube, Chrome, Slack, GG Coder, Google Search.",
        minLength: 1,
        maxLength: 120,
      },
      target: {
        type: "string",
        description:
          "Capture the primary screen, a previously listed source, or the best window matching window_query.",
        enum: ["primary_screen", "source", "window"],
      },
      reason: {
        type: "string",
        description: "Short user-facing reason for taking the screenshot.",
        maxLength: 160,
      },
      ...(includeQuestion
        ? {
            question: {
              type: "string",
              description: "Optional OCR/vision question to answer about the captured screen.",
              maxLength: 500,
            },
          }
        : {}),
    },
    required: [],
    additionalProperties: false,
  };
}

function createLookupParameters(description) {
  return {
    type: "object",
    properties: {
      query: {
        type: "string",
        description,
        minLength: 1,
        maxLength: 80,
      },
    },
    required: ["query"],
    additionalProperties: false,
  };
}
