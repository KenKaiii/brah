import { appendToDailyLog, getDailyLog } from "./daily-logs-store.js";
import { deleteFactBySubject, getAllFacts, saveFact } from "./memory-store.js";

// Background memory extractor. Instead of relying on the realtime voice agent to
// call save tools mid-conversation (which it deprioritizes under conversational
// pressure), a dedicated cheap text model reads the recent transcript after each
// turn and writes durable facts + daily-log entries straight to SQLite. This is
// the "subconscious"/sleep-time memory pattern used by PostHog, Letta, LangMem:
// extraction is its own job, not a side-duty bolted onto the talker.
//
// Requires the API-key auth path — gpt-5.4-mini is a normal model and cannot go
// through the OAuth/Codex realtime backend. With no key the caller no-ops.

const EXTRACTOR_MODEL = "gpt-5.4-mini";
const EXTRACTOR_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MAX_OUTPUT_TOKENS = 800;

const FACT_CATEGORIES = Object.freeze([
  "user_info",
  "preferences",
  "projects",
  "people",
  "work",
  "notes",
  "decisions",
]);

function buildSystemPrompt(userName) {
  const who = userName?.trim() ? userName.trim() : "the user";
  return `You are the long-term memory keeper for ${who}'s personal voice assistant. After each stretch of conversation you read the recent transcript and the current memory, then decide what (if anything) should change in memory. You never speak to ${who}; you only output JSON describing memory changes.

Your guiding principle: memory should be a small, accurate, non-contradictory picture of who ${who} is and what is genuinely going on in their life. Quality over quantity. Most turns change nothing — returning all-empty arrays is the normal, correct result. Never record how ${who} operates the app (managing tasks, calendar, files, searches), conversational filler (greetings, thanks, confirmations), or fleeting moment-to-moment context (weather, what they're doing right now, small talk, passing moods). None of that is memory.

You control memory through three operations. Use the fewest needed; an empty operation is always acceptable.

facts — durable truths ABOUT ${who} themselves, not about this session. Each fact has:
   - category: one of user_info, preferences, projects, people, work, notes, decisions.
   - subject: a specific snake_case key naming the single real-world thing it describes (e.g. partner, employer, location, coffee_preference, current_project).
   - content: one atomic piece of information, about 30 words or fewer.
   - sensitive: true for private or emotionally heavy matters (health, relationships, finances, grief), otherwise false.
   A fact qualifies only if it would still matter weeks from now: identity (name, birthday, where they live), work/role, the important people and pets in their life, stable preferences, real projects, meaningful decisions, life goals, and significant life events or emotional disclosures. Significant life events and emotional disclosures matter most.

   Keeping facts clean is as important as adding them:
   - One subject per real-world thing. The current memory is given to you below; when something is already stored, REUSE its exact category and subject so your new content overwrites the old value in place. Do not invent a synonym key for a topic that already exists.
   - When new information changes or contradicts what is stored (a move, a breakup, a new job, a finished project, a changed preference), overwrite the existing fact so memory reflects only the present truth. Never leave the stale value sitting beside the new one.
   - Emit a fact only when it genuinely adds or changes something. If it merely repeats what is already stored, leave it out.

forget — remove a stored fact that should no longer exist. Provide its exact category and subject. Use this ONLY to:
   - collapse a true duplicate (two stored subjects describing the same real-world thing — keep one via facts, forget the redundant one), or
   - drop a fact that is now definitively false, obsolete, or that ${who} asked you to forget.
   Be conservative: never forget a fact merely because it was not mentioned this turn, and never forget identity, relationships, health, or other significant facts unless they are clearly superseded or explicitly retracted. When unsure, keep it. Updating content is done through facts (overwrite), not forget.

logs — a personal diary of ${who}'s life, not a record of activity. Add at most one short line, and only for something genuinely significant that happened today: a real decision, a milestone, a notable event, or how they are clearly feeling about something that matters. Ordinary days and minor details do not belong here — a walk, a coffee, a normal chat are not log-worthy. Today's log so far is shown to you; never record the same situation twice, even reworded. One real event gets one entry total, no matter how many turns discuss it. If today's log already reflects what happened, add nothing.

Return ONLY this JSON object, with empty arrays where there is nothing to do:
{"facts":[{"category":"...","subject":"...","content":"...","sensitive":false}],"forget":[{"category":"...","subject":"..."}],"logs":["..."]}`;
}

/**
 * Run extraction over a transcript window and persist any results.
 *
 * @param {object} params
 * @param {Array<{role: string, text: string}>} params.transcript Recent turns, oldest first.
 * @param {string} params.apiKey OpenAI API key (Bearer).
 * @param {string} [params.userName] The user's name, for natural log phrasing; defaults to "the user".
 * @param {string} [params.storePath] SQLite path (defaults to the app DB).
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch for tests.
 * @param {(event: string, details: object) => void} [params.logger]
 * @returns {Promise<{status: string, savedFacts?: number, savedLogs?: number, reason?: string}>}
 */
export async function extractMemory({
  transcript,
  apiKey,
  userName,
  storePath,
  fetchImpl = globalThis.fetch,
  logger,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { status: "skipped", reason: "no_api_key" };
  }
  const turns = normalizeTranscript(transcript);
  if (turns.length === 0) {
    return { status: "skipped", reason: "empty_transcript" };
  }

  const currentFacts = getAllFacts(storePath);
  const todayLog = getDailyLog(undefined, storePath);

  let parsed;
  try {
    parsed = await requestExtraction({
      apiKey,
      fetchImpl,
      currentFacts,
      todayLog,
      userName,
      transcriptText: formatTranscript(turns, userName),
    });
  } catch (error) {
    logger?.("memory.extract.error", { error: error instanceof Error ? error.message : "unknown" });
    return { status: "error", reason: "request_failed" };
  }

  let savedFacts = 0;
  const savedKeys = new Set();
  for (const fact of sanitizeFacts(parsed.facts)) {
    try {
      saveFact(fact, storePath);
      savedKeys.add(`${fact.category}\u0000${fact.subject}`);
      savedFacts += 1;
    } catch (error) {
      logger?.("memory.extract.fact_write_error", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  let forgotFacts = 0;
  for (const target of sanitizeForget(parsed.forget)) {
    // Never forget a fact that was just written this same turn (the model may
    // list a subject in both facts and forget when collapsing a duplicate — the
    // overwrite already won, so dropping it would lose the merged value).
    if (savedKeys.has(`${target.category}\u0000${target.subject}`)) {
      continue;
    }
    try {
      if (deleteFactBySubject(target.category, target.subject, storePath)) {
        forgotFacts += 1;
      }
    } catch (error) {
      logger?.("memory.extract.fact_forget_error", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  let savedLogs = 0;
  let runningLog = todayLog?.content ?? "";
  for (const entry of sanitizeLogs(parsed.logs)) {
    if (runningLog && isDuplicateLogEntry(runningLog, entry)) {
      continue;
    }
    try {
      const updated = appendToDailyLog(entry, storePath);
      runningLog = updated?.content ?? `${runningLog}\n${entry}`;
      savedLogs += 1;
    } catch (error) {
      logger?.("memory.extract.log_write_error", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  logger?.("memory.extract.finish", { savedFacts, forgotFacts, savedLogs });
  return { status: "extracted", savedFacts, forgotFacts, savedLogs };
}

async function requestExtraction({
  apiKey,
  fetchImpl,
  currentFacts,
  todayLog,
  userName,
  transcriptText,
}) {
  const factsContext =
    currentFacts.length > 0
      ? currentFacts
          .map((fact) => `- [${fact.category}] ${fact.subject}: ${fact.content}`)
          .join("\n")
      : "(none yet)";

  const todayLogContext = todayLog?.content?.trim()
    ? todayLog.content.trim()
    : "(nothing logged today)";

  const userContent = `Current memory (facts already saved — reuse these exact category/subject keys when updating or correcting a topic; only add a new subject for a genuinely new topic):\n${factsContext}\n\nToday's daily log so far (do NOT log the same situation again, even reworded — only log a genuinely new event):\n${todayLogContext}\n\nLatest conversation turns:\n${transcriptText}`;

  const response = await fetchImpl(EXTRACTOR_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EXTRACTOR_MODEL,
      reasoning_effort: "none",
      response_format: { type: "json_object" },
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: buildSystemPrompt(userName) },
        { role: "user", content: userContent },
      ],
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Extractor request failed (${response.status}): ${rawText.slice(0, 300)}`);
  }
  const payload = JSON.parse(rawText);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return { facts: [], forget: [], logs: [] };
  }
  const parsed = JSON.parse(content);
  return {
    facts: Array.isArray(parsed.facts) ? parsed.facts : [],
    forget: Array.isArray(parsed.forget) ? parsed.forget : [],
    logs: Array.isArray(parsed.logs) ? parsed.logs : [],
  };
}

function sanitizeFacts(facts) {
  if (!Array.isArray(facts)) {
    return [];
  }
  const clean = [];
  for (const fact of facts) {
    if (!isRecord(fact)) {
      continue;
    }
    const category = typeof fact.category === "string" ? fact.category.trim() : "";
    const subject = typeof fact.subject === "string" ? fact.subject.trim() : "";
    const content = typeof fact.content === "string" ? fact.content.trim() : "";
    if (!FACT_CATEGORIES.includes(category) || !subject || !content) {
      continue;
    }
    clean.push({
      category,
      subject: subject.slice(0, 80),
      content: content.slice(0, 300),
      sensitive: fact.sensitive === true,
    });
  }
  return clean;
}

function sanitizeForget(targets) {
  if (!Array.isArray(targets)) {
    return [];
  }
  const clean = [];
  for (const target of targets) {
    if (!isRecord(target)) {
      continue;
    }
    const category = typeof target.category === "string" ? target.category.trim() : "";
    const subject = typeof target.subject === "string" ? target.subject.trim() : "";
    if (!FACT_CATEGORIES.includes(category) || !subject) {
      continue;
    }
    clean.push({ category, subject: subject.slice(0, 80) });
  }
  return clean;
}

function sanitizeLogs(logs) {
  if (!Array.isArray(logs)) {
    return [];
  }
  const clean = [];
  for (const entry of logs) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed) {
      clean.push(trimmed.slice(0, 400));
    }
  }
  return clean;
}

function normalizeTranscript(transcript) {
  if (!Array.isArray(transcript)) {
    return [];
  }
  return transcript
    .filter((turn) => isRecord(turn) && typeof turn.text === "string" && turn.text.trim())
    .map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      text: turn.text.trim(),
    }));
}

function formatTranscript(turns, userName) {
  const speaker = userName?.trim() ? userName.trim() : "User";
  return turns
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : speaker}: ${turn.text}`)
    .join("\n");
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
