import { appendToDailyLog } from "./daily-logs-store.js";
import { checkMemoryText, describeRejectedMemory } from "./memory-guard.js";
import {
  deleteFactBySubject,
  FACT_CATEGORIES,
  getAllFacts,
  normalizeFactSubject,
  saveFact,
  searchFacts,
} from "./memory-store.js";
import {
  deleteSoulNoteByAspect,
  getAllSoulNotes,
  normalizeSoulAspect,
  setSoulNote,
} from "./soul-store.js";

// Explicit memory tools for the voice agent. These complement (not replace) the
// background extractor: the extractor quietly catches durable facts after each
// turn, while these let the user say "remember that…" / "forget…" and have it
// land immediately. Both write the same SQLite tables, and facts upsert by
// category + subject, so an explicit save and a later extraction never duplicate.
// Every write passes the memory guard, because memory outlives the call: text
// that reads like a command to the model, or a credential, is refused.

const MEMORY_TOOL_NAMES = new Set([
  "remember",
  "forget",
  "list_facts",
  "soul_set",
  "soul_list",
  "soul_delete",
  "daily_log",
]);
const FACT_CONTENT_MAX_LENGTH = 300;
const LOG_ENTRY_MAX_LENGTH = 400;
const LIST_LIMIT = 40;

/**
 * @param {string} name Tool name.
 * @param {object} args Tool arguments (untrusted model output).
 * @param {{ storePath?: string, now?: Date }} options Test seams.
 * @returns {Promise<object|null>} Result for a memory tool, or null otherwise.
 */
export async function executeMemoryTool(name, args = {}, options = {}) {
  if (!MEMORY_TOOL_NAMES.has(name)) {
    return null;
  }
  const input = isRecord(args) ? args : {};
  const storePath = options.storePath;
  switch (name) {
    case "remember":
      return remember(input, storePath);
    case "forget":
      return forget(input, storePath);
    case "list_facts":
      return listFacts(input, storePath);
    case "soul_set":
      return soulSet(input, storePath);
    case "soul_list":
      return soulList(storePath);
    case "soul_delete":
      return soulDelete(input, storePath);
    case "daily_log":
      return dailyLog(input, storePath, options.now);
    default:
      return null;
  }
}

function remember(input, storePath) {
  const category = readCategory(input.category);
  const subject = normalizeFactSubject(input.subject);
  const raw = readText(input.content, FACT_CONTENT_MAX_LENGTH);
  if (!category) {
    return invalid(`category must be one of: ${FACT_CATEGORIES.join(", ")}.`);
  }
  if (!subject || !raw) {
    return invalid("subject and content are required.");
  }
  const checked = checkMemoryText(raw);
  if (!checked.ok) {
    return rejected(checked.reason);
  }
  const content = checked.value;
  const sensitive = input.sensitive === true;
  const replaced = getAllFacts(storePath).some(
    (fact) => fact.category === category && fact.subject === subject,
  );
  const id = saveFact({ category, subject, content, sensitive, source: "voice" }, storePath);
  return {
    status: replaced ? "updated" : "saved",
    fact: { id, category, subject, content, sensitive },
    memoryChanged: true,
  };
}

function forget(input, storePath) {
  const category = readCategory(input.category);
  const subject = normalizeFactSubject(input.subject);
  if (!category || !subject) {
    return invalid("category and subject are required. Call list_facts to find them.");
  }
  if (!deleteFactBySubject(category, subject, storePath)) {
    return {
      status: "not_found",
      message: `No memory for ${category}/${subject}. Call list_facts to find the right one.`,
    };
  }
  return { status: "forgotten", category, subject, memoryChanged: true };
}

function listFacts(input, storePath) {
  const query = readText(input.query, 120);
  const category = input.category === undefined ? "" : readCategory(input.category);
  if (input.category !== undefined && !category) {
    return invalid(`category must be one of: ${FACT_CATEGORIES.join(", ")}.`);
  }
  const facts = query
    ? searchFacts(query, category || undefined, storePath)
    : getAllFacts(storePath).filter((fact) => !category || fact.category === category);
  return {
    status: "ok",
    count: facts.length,
    facts: facts.slice(0, LIST_LIMIT).map((fact) => ({
      category: fact.category,
      subject: fact.subject,
      content: fact.content,
      sensitive: fact.sensitive,
    })),
    truncated: facts.length > LIST_LIMIT,
  };
}

function soulSet(input, storePath) {
  const checked = checkMemoryText(input.content, { kind: "soul" });
  if (!checked.ok) {
    return checked.reason === "empty" ? invalid("content is required.") : rejected(checked.reason);
  }
  const result = setSoulNote(input.aspect, checked.value, storePath);
  if (!result.ok) {
    return invalid(`${result.error}.`);
  }
  return {
    status: result.replaced ? "updated" : "saved",
    note: { aspect: result.value.aspect, content: result.value.content },
    memoryChanged: true,
  };
}

function soulList(storePath) {
  const notes = getAllSoulNotes(storePath);
  return {
    status: "ok",
    count: notes.length,
    notes: notes.map((note) => ({ aspect: note.aspect, content: note.content })),
  };
}

function soulDelete(input, storePath) {
  const aspect = normalizeSoulAspect(input.aspect);
  if (!aspect) {
    return invalid("aspect is required. Call soul_list to find it.");
  }
  if (!deleteSoulNoteByAspect(aspect, storePath)) {
    return { status: "not_found", message: `No soul note for ${aspect}.` };
  }
  return { status: "deleted", aspect, memoryChanged: true };
}

function dailyLog(input, storePath, now = new Date()) {
  const checked = checkMemoryText(readText(input.entry, LOG_ENTRY_MAX_LENGTH));
  if (!checked.ok) {
    return checked.reason === "empty" ? invalid("entry is required.") : rejected(checked.reason);
  }
  const entry = checked.value;
  const log = appendToDailyLog(entry, storePath, now);
  return { status: "logged", date: log.date, entry, memoryChanged: true };
}

function readCategory(value) {
  const category = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FACT_CATEGORIES.includes(category) ? category : "";
}

function readText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function invalid(message) {
  return { status: "invalid_arguments", message };
}

function rejected(reason) {
  return { status: "rejected", reason, message: describeRejectedMemory(reason) };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
