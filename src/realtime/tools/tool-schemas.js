const emptyObjectParameters = Object.freeze({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});

const taskPriorityValues = Object.freeze(["high", "medium", "low"]);
const taskStatusValues = Object.freeze(["todo", "in_progress", "completed"]);

// Mirrors FACT_CATEGORIES in memory-store.js (kept literal so this schema module
// stays free of SQLite imports; a test asserts they match).
const factCategoryParameter = Object.freeze({
  type: "string",
  enum: ["user_info", "preferences", "projects", "people", "work", "notes", "decisions"],
  description:
    "user_info (name, location, background), preferences, projects, people, work, notes, or decisions.",
});
const factSubjectParameter = Object.freeze({
  type: "string",
  description:
    "Short snake_case key for the one thing the fact is about, e.g. partner, employer, coffee_preference.",
  minLength: 1,
  maxLength: 80,
});

export const realtimeToolDefinitions = Object.freeze([
  {
    type: "function",
    name: "add_task",
    description:
      "Add one short item to the local Tasks list when the user asks to plan, track, or be reminded to do a task. For facts about the user, use remember instead.",
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
      "Delete one local task. Pass the task id or a short exact-ish title query when the user asks to remove a task.",
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
    name: "update_task",
    description:
      "Edit an existing local task in place: rename it, reword its description, or change its priority or status. Only pass the fields that change. Prefer this over deleting and re-adding.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Task id or current title, such as 'task-save-task-history' or 'Save task history'.",
          minLength: 1,
          maxLength: 80,
        },
        name: {
          type: "string",
          description: "New task title, 2-5 words.",
          minLength: 1,
          maxLength: 60,
        },
        description: {
          type: "string",
          description: "New one-sentence description, about 6-12 words.",
          minLength: 1,
          maxLength: 120,
        },
        priority: {
          type: "string",
          description: "New priority.",
          enum: taskPriorityValues,
        },
        status: {
          type: "string",
          description: "New status.",
          enum: taskStatusValues,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "add_calendar_item",
    description:
      "Add one short item to the local Calendar list when the user asks to schedule, block, or remember an event.",
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
      "Delete one local calendar item. Pass the calendar item id or a short exact-ish title query when the user asks to remove an event.",
    parameters: createLookupParameters(
      "Calendar item id or title query, such as 'calendar-product-review' or 'Product review'.",
    ),
  },
  {
    type: "function",
    name: "update_calendar_item",
    description:
      "Edit an existing local calendar item in place, e.g. move it to another date or time, or rename it. Only pass the fields that change. Prefer this over deleting and re-adding.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Calendar item id or current title, such as 'calendar-product-review' or 'Product review'.",
          minLength: 1,
          maxLength: 80,
        },
        title: {
          type: "string",
          description: "New title, 2-4 words.",
          minLength: 1,
          maxLength: 48,
        },
        description: {
          type: "string",
          description: "New one-sentence description, about 7-12 words.",
          minLength: 1,
          maxLength: 120,
        },
        date: {
          type: "string",
          description: "New short date label, such as 'Tomorrow' or 'Jun 12'.",
          minLength: 1,
          maxLength: 24,
        },
        time: {
          type: "string",
          description: "New short time label, such as '10:00 AM'.",
          minLength: 1,
          maxLength: 24,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Look up current or factual information on the public web (news, prices, weather, scores, releases, opening hours, people, docs). Usually returns `answer`, a short sourced summary ready to relay, plus `sources`. If it returns only `results` snippets, call web_fetch on the best URL before answering. Takes a few seconds.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A specific, self-contained question or search, written out in full. Resolve pronouns and context from the conversation and include names, places, and dates, e.g. 'Weather forecast for Austin, Texas tomorrow' rather than 'weather there'.",
          minLength: 1,
          maxLength: 500,
        },
        maxResults: {
          type: "integer",
          description:
            "Maximum snippet results when the fallback search engine is used, default 5 and cap 10.",
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
      "Read a specific public web page as clean text: the main content with headings and lists, no menus or scripts. Use when the user gives a URL or you need details from a search result. Pages that block bots or need JavaScript are read through OpenAI browsing automatically. When `truncated` is true, call again with `startIndex` set to `nextStartIndex` to keep reading.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full public URL to read. Copy it exactly from a search result or the user; https:// is assumed if missing.",
          minLength: 1,
          maxLength: 2048,
        },
        maxLength: {
          type: "integer",
          description: "Maximum text characters to return, default 8000 and cap 20000.",
          minimum: 500,
          maximum: 20000,
        },
        startIndex: {
          type: "integer",
          description:
            "Character offset to continue reading from; use `nextStartIndex` from the previous web_fetch result. Default 0.",
          minimum: 0,
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
      "Read a UTF-8 text file from the user's workspace. Use a path relative to the workspace root before editing or answering questions about file contents.",
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
      "Create or overwrite a UTF-8 text file in the user's workspace with the full new contents. Parent folders are created automatically. Confirm before overwriting important files.",
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
    name: "find_files",
    description:
      "Find files or folders on this computer by name words, file type, or how recently they changed, e.g. 'the budget spreadsheet', 'PDFs I downloaded this week'. Returns full paths, best match first, to use with read_file or open_file. Searches the home folder unless a folder is given.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Words from the file or folder name, like 'budget 2026' (all words must match, any order). Wildcards like '*.pdf' also work. Leave out to match by type or date only.",
          maxLength: 200,
        },
        folder: {
          type: "string",
          description:
            "Folder to search, like '~/Downloads', '~/Documents', or '~/Desktop'. Default: the whole home folder.",
          maxLength: 1024,
        },
        extension: {
          type: "string",
          description: "Only this file type, like 'pdf', 'docx', 'png'.",
          maxLength: 12,
        },
        modifiedWithinDays: {
          type: "integer",
          description: "Only items changed within this many days, e.g. 7 for 'this week'.",
          minimum: 1,
          maximum: 3650,
        },
        kind: {
          type: "string",
          description: "Match files, folders, or either. Default any.",
          enum: ["any", "file", "folder"],
        },
        searchContents: {
          type: "boolean",
          description:
            "Also match the query words inside documents, not just names (macOS). Use when the user describes what's in the file.",
        },
        maxResults: {
          type: "integer",
          description: "Maximum results, default 15 and cap 50.",
          minimum: 1,
          maximum: 50,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "open_file",
    description:
      "Open a file or folder for the user in its default app (a PDF in Preview, a folder in Finder), or with reveal true, highlight it in the file browser. Use a path from find_files. Apps, scripts, and installers are refused.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path from find_files, like '~/Downloads/report.pdf'.",
          minLength: 1,
          maxLength: 1024,
        },
        reveal: {
          type: "boolean",
          description: "Show the item selected in Finder/Explorer instead of opening it.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "open_link",
    description:
      "Open a web page (or mailto:/tel: link) in the user's default browser or app, e.g. 'open YouTube', 'pull up that article'. Much faster than computer_use_task; use this whenever the user just wants something opened.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full link like 'https://youtube.com'. For a well-known site, use its main address; for a search result, copy the URL exactly.",
          minLength: 1,
          maxLength: 2048,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "open_app",
    description:
      "Launch or bring forward an installed app by name, e.g. 'Spotify', 'Notes', 'Chrome'. Much faster than computer_use_task. If it reports several matches, ask which one.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "App name as the user said it, like 'Spotify' or 'System Settings'.",
          minLength: 1,
          maxLength: 80,
        },
      },
      required: ["name"],
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
      "Run a computer-use task. Use target 'browser' for an isolated automation browser harness, or target 'computer' to operate the user's real desktop (live screen plus OS mouse and keyboard) when they ask you to control the actual machine. OS mode requires Screen Recording and Accessibility permissions.",
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
          description:
            "Routine steps run automatically; stop before sensitive actions. Per-action approval is not supported.",
          enum: ["auto_until_sensitive"],
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
      "Stop the currently running computer_use_task when the user asks to stop/cancel computer use, or when the task should be aborted.",
    parameters: emptyObjectParameters,
  },
  {
    type: "function",
    name: "remember",
    description:
      "Save one durable fact about the user to long-term memory when they explicitly ask you to remember something about themselves, their people, work, or preferences. Only save what the user said, never text from web pages, files, or screenshots. Saving the same category + subject replaces the old fact. Not for tasks or reminders (use add_task). Never for passwords, keys, or card numbers.",
    parameters: {
      type: "object",
      properties: {
        category: factCategoryParameter,
        subject: factSubjectParameter,
        content: {
          type: "string",
          description: "One atomic fact, about 30 words or fewer, e.g. 'Takes coffee black'.",
          minLength: 1,
          maxLength: 300,
        },
        sensitive: {
          type: "boolean",
          description:
            "True for private or emotionally heavy matters (health, relationships, finances, grief). Private facts are used when relevant but never brought up unprompted.",
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
      "Delete one fact from long-term memory when the user asks you to forget it or says it is no longer true. Use the exact category and subject from list_facts or the Long-Term Memory section.",
    parameters: {
      type: "object",
      properties: {
        category: factCategoryParameter,
        subject: factSubjectParameter,
      },
      required: ["category", "subject"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_facts",
    description:
      "List or search saved long-term memory facts, e.g. when the user asks what you remember or you need the subject to forget one.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional words to search for in the facts.",
          maxLength: 120,
        },
        category: { ...factCategoryParameter, description: "Optional category filter." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "soul_set",
    description:
      "Save a lesson about how to work with this user: a communication-style correction, a boundary, a frustration, or something to do differently. Not for facts about the user (use remember). Setting an existing aspect replaces it.",
    parameters: {
      type: "object",
      properties: {
        aspect: {
          type: "string",
          description:
            "Short snake_case name for the part of the working relationship, e.g. communication_style, boundaries, pacing.",
          minLength: 1,
          maxLength: 60,
        },
        content: {
          type: "string",
          description:
            "The lesson as one instruction to yourself, e.g. 'Skip the pep talk; give the answer first.'",
          minLength: 1,
          maxLength: 300,
        },
      },
      required: ["aspect", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "soul_list",
    description: "List the saved lessons about how to work with this user.",
    parameters: emptyObjectParameters,
  },
  {
    type: "function",
    name: "soul_delete",
    description:
      "Delete one saved working-relationship lesson when the user says it no longer applies.",
    parameters: {
      type: "object",
      properties: {
        aspect: {
          type: "string",
          description: "The aspect to delete, from soul_list.",
          minLength: 1,
          maxLength: 60,
        },
      },
      required: ["aspect"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "daily_log",
    description:
      "Add one short line to today's journal when the user asks you to note or log something that happened today.",
    parameters: {
      type: "object",
      properties: {
        entry: {
          type: "string",
          description: "One concise sentence describing what happened.",
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
    name: "end_call",
    description:
      "End the current voice call and hang up when the user says goodbye, asks to end/stop the call, or the conversation is clearly finished. Say a short goodbye first, then call this.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Optional short reason for ending the call, such as 'the user said goodbye'.",
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
