import { appendToDailyLog, getDailyLog } from "./daily-logs-store.js";
import {
  deleteFact,
  deleteFactBySubject,
  getAllFacts,
  getFactsByCategory,
  saveFact,
  searchFacts,
  updateFact,
} from "./memory-store.js";

// Memory tools ported from pocket-agent's memory-tools.ts: remember, forget,
// list_facts, update_fact, and recall_memory operate on the SQLite facts store;
// daily_log journals to the daily_logs store. recall_memory uses keyword (LIKE)
// search — pocket-agent's degraded mode — because Brah has no embedding pipeline.

export async function executeMemoryTool(name, args, options = {}) {
  switch (name) {
    case "remember":
      return rememberTool(args, options);
    case "forget":
      return forgetTool(args, options);
    case "list_facts":
      return listFactsTool(args, options);
    case "update_fact":
      return updateFactTool(args, options);
    case "recall_memory":
      return recallMemoryTool(args, options);
    case "daily_log":
      return dailyLogTool(args, options);
    default:
      return null;
  }
}

async function rememberTool(args, options) {
  const validation = validateStrings(args, {
    category: { min: 1, max: 60 },
    subject: { min: 1, max: 80 },
    content: { min: 1, max: 300 },
  });
  if (!validation.ok) {
    return validation.error;
  }
  const id = saveFact(
    {
      category: args.category.trim(),
      subject: args.subject.trim(),
      content: args.content.trim(),
      sensitive: typeof args.sensitive === "boolean" ? args.sensitive : undefined,
    },
    options.storePath,
  );
  return {
    status: "saved",
    message: `Remembered: ${args.subject.trim()}`,
    id,
    category: args.category.trim(),
    subject: args.subject.trim(),
  };
}

async function forgetTool(args, options) {
  if (!isRecord(args)) {
    return invalidArguments("Arguments must be an object.");
  }
  if (typeof args.id === "number") {
    return deleteFact(args.id, options.storePath)
      ? { status: "deleted", message: "Fact forgotten." }
      : { status: "not_found", message: "Fact not found." };
  }
  if (typeof args.category === "string" && typeof args.subject === "string") {
    return deleteFactBySubject(args.category.trim(), args.subject.trim(), options.storePath)
      ? { status: "deleted", message: "Fact forgotten." }
      : { status: "not_found", message: "Fact not found." };
  }
  return invalidArguments("Provide either id OR category+subject.");
}

async function listFactsTool(args, options) {
  const category = isRecord(args) && typeof args.category === "string" ? args.category.trim() : "";
  const facts = category
    ? getFactsByCategory(category, options.storePath)
    : getAllFacts(options.storePath);
  return {
    status: "listed",
    message:
      facts.length > 0
        ? "Use the fact id for update_fact or forget follow-ups."
        : category
          ? `No facts in category: ${category}`
          : "No facts stored yet.",
    count: facts.length,
    facts: facts.map(toToolFact),
  };
}

async function updateFactTool(args, options) {
  if (!isRecord(args) || typeof args.id !== "number") {
    return invalidArguments("id is required and must be a number.");
  }
  const fields = {
    ...(typeof args.category === "string" ? { category: args.category.trim() } : {}),
    ...(typeof args.subject === "string" ? { subject: args.subject.trim() } : {}),
    ...(typeof args.content === "string" ? { content: args.content.trim() } : {}),
    ...(typeof args.sensitive === "boolean" ? { sensitive: args.sensitive } : {}),
  };
  if (Object.keys(fields).length === 0) {
    return invalidArguments("Provide at least one field to update.");
  }
  return updateFact(args.id, fields, options.storePath)
    ? { status: "updated", message: `Updated fact ${args.id}.` }
    : { status: "not_found", message: "Fact not found or nothing changed." };
}

async function recallMemoryTool(args, options) {
  const validation = validateStrings(args, { query: { min: 1, max: 240 } });
  if (!validation.ok) {
    return validation.error;
  }
  const facts = searchFacts(args.query.trim(), undefined, options.storePath);
  return {
    status: "recalled",
    message:
      facts.length > 0
        ? "Facts matching the query, most recently updated first."
        : "No matching facts in memory.",
    mode: "keyword",
    count: facts.length,
    facts: facts.map(toToolFact),
  };
}

async function dailyLogTool(args, options) {
  const validation = validateStrings(args, { entry: { min: 1, max: 400 } });
  if (!validation.ok) {
    return validation.error;
  }
  const entry = args.entry.trim();

  // Skip entries that duplicate something already journaled today, so repeated
  // turns about the same topic don't bloat the log (pocket-agent's dedup).
  const todayLog = getDailyLog(undefined, options.storePath);
  if (todayLog && isDuplicateLogEntry(todayLog.content, entry)) {
    return {
      status: "skipped",
      message:
        "Skipped — this topic is already logged today. Only log if something materially new happened.",
      date: todayLog.date,
    };
  }

  const log = appendToDailyLog(entry, options.storePath);
  return {
    status: "logged",
    message: "Entry added to today's daily log.",
    date: log.date,
  };
}

/** Extract meaningful words (>3 chars) from text, lowercased. */
function extractWords(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

/**
 * True when a new entry is too similar to any existing entry in today's log.
 * Mirrors pocket-agent: prefix match against an entry's body, or >50% word
 * overlap with any single existing entry.
 */
function isDuplicateLogEntry(existingContent, newEntry) {
  const entries = existingContent.split(/\n/).filter((line) => line.startsWith("["));
  if (entries.length === 0) {
    return false;
  }

  const newWords = extractWords(newEntry);
  if (newWords.size === 0) {
    return false;
  }

  const newNormalized = newEntry
    .toLowerCase()
    .replace(/^\[.*?\]\s*/, "")
    .slice(0, 60);

  for (const entry of entries) {
    const entryBody = entry.replace(/^\[.*?\]\s*/, "").toLowerCase();
    if (newNormalized.length >= 20 && entryBody.startsWith(newNormalized)) {
      return true;
    }

    const entryWords = extractWords(entryBody);
    if (entryWords.size === 0) {
      continue;
    }
    let overlap = 0;
    for (const word of newWords) {
      if (entryWords.has(word)) {
        overlap += 1;
      }
    }
    if (overlap / newWords.size > 0.5) {
      return true;
    }
  }
  return false;
}

function toToolFact(fact) {
  return {
    id: fact.id,
    category: fact.category,
    subject: fact.subject,
    content: fact.content,
  };
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
