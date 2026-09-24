import { getDatabase, getDatabasePath } from "./database.js";

// "Soul" notes: lessons about the working relationship with the user (how they
// like to be spoken to, boundaries, things to do differently), kept apart from
// facts about who the user is. One note per aspect; setting an existing aspect
// replaces it, so the store stays small and non-contradictory.

/** Max characters of soul notes injected into the realtime instructions. */
export const SOUL_CONTEXT_BUDGET = 1500;
export const SOUL_ASPECT_MAX_LENGTH = 60;
export const SOUL_CONTENT_MAX_LENGTH = 300;
/** Hard cap on stored notes, so the store (and the prompt) cannot be flooded. */
export const SOUL_NOTE_LIMIT = 30;

export function getSoulStorePath() {
  return getDatabasePath();
}

/**
 * Normalize an aspect into a stable snake_case key ("Communication Style" →
 * "communication_style"). Returns "" when nothing usable remains.
 */
export function normalizeSoulAspect(aspect) {
  if (typeof aspect !== "string") {
    return "";
  }
  return aspect
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SOUL_ASPECT_MAX_LENGTH);
}

/**
 * Create or replace the note for an aspect.
 * @returns {{ ok: true, value: object, replaced: boolean } | { ok: false, error: string }}
 */
export function setSoulNote(aspect, content, storePath = getSoulStorePath()) {
  const key = normalizeSoulAspect(aspect);
  const text = typeof content === "string" ? content.trim().slice(0, SOUL_CONTENT_MAX_LENGTH) : "";
  if (!key) {
    return { ok: false, error: "aspect is required" };
  }
  if (!text) {
    return { ok: false, error: "content is required" };
  }
  const db = getDatabase(storePath);
  const replaced = Boolean(db.prepare("SELECT id FROM soul WHERE aspect = ?").get(key));
  if (
    !replaced &&
    Number(db.prepare("SELECT COUNT(*) AS n FROM soul").get().n) >= SOUL_NOTE_LIMIT
  ) {
    return {
      ok: false,
      error: `there are already ${SOUL_NOTE_LIMIT} working notes; update or remove one first`,
    };
  }
  db.prepare(
    `INSERT INTO soul (aspect, content) VALUES (?, ?)
     ON CONFLICT(aspect) DO UPDATE SET content = excluded.content,
       updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))`,
  ).run(key, text);
  return { ok: true, value: getSoulNote(key, storePath), replaced };
}

/** Get one note by aspect, or null. */
export function getSoulNote(aspect, storePath = getSoulStorePath()) {
  const key = normalizeSoulAspect(aspect);
  if (!key) {
    return null;
  }
  const row = getDatabase(storePath)
    .prepare("SELECT id, aspect, content, created_at, updated_at FROM soul WHERE aspect = ?")
    .get(key);
  return row ? normalizeSoulRow(row) : null;
}

/** All notes, sorted by aspect so the prompt and UI are deterministic. */
export function getAllSoulNotes(storePath = getSoulStorePath()) {
  return getDatabase(storePath)
    .prepare("SELECT id, aspect, content, created_at, updated_at FROM soul ORDER BY aspect, id")
    .all()
    .map(normalizeSoulRow);
}

/** Update a note's text by id (UI edit). Returns true when a row changed. */
export function updateSoulNoteContent(id, content, storePath = getSoulStorePath()) {
  const text = typeof content === "string" ? content.trim().slice(0, SOUL_CONTENT_MAX_LENGTH) : "";
  if (!Number.isInteger(id) || !text) {
    return false;
  }
  const result = getDatabase(storePath)
    .prepare(
      "UPDATE soul SET content = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE id = ?",
    )
    .run(text, id);
  return result.changes > 0;
}

/** Delete a note by aspect. Returns true when one was removed. */
export function deleteSoulNoteByAspect(aspect, storePath = getSoulStorePath()) {
  const key = normalizeSoulAspect(aspect);
  if (!key) {
    return false;
  }
  const result = getDatabase(storePath).prepare("DELETE FROM soul WHERE aspect = ?").run(key);
  return result.changes > 0;
}

/** Delete a note by id (UI). Returns true when one was removed. */
export function deleteSoulNote(id, storePath = getSoulStorePath()) {
  const result = getDatabase(storePath).prepare("DELETE FROM soul WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Soul notes formatted for the realtime instructions, capped at
 * SOUL_CONTEXT_BUDGET characters, most recently updated first (so the newest
 * correction wins the budget and a flood of old or oddly named notes cannot
 * crowd it out). Returns "" when there are none.
 */
export function getSoulContext(storePath = getSoulStorePath()) {
  const notes = getDatabase(storePath)
    .prepare("SELECT aspect, content FROM soul ORDER BY updated_at DESC, id DESC")
    .all();
  const lines = [];
  let used = 0;
  for (const note of notes) {
    const line = `- ${note.aspect}: ${note.content}`;
    if (used + line.length + 1 > SOUL_CONTEXT_BUDGET) {
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

function normalizeSoulRow(row) {
  return {
    id: row.id,
    aspect: row.aspect,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
