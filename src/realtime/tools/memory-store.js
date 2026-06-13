import { getDatabase, getDatabasePath } from "./database.js";

// Long-term memory facts store, ported from pocket-agent's facts.ts. Facts are
// atomic (category, subject, content) rows in SQLite with an importance score
// that decays when a fact is not accessed, plus a sensitive flag for private
// facts the agent remembers but never proactively brings up.

/** Hard character budget for facts injected into the session instructions (~1,000 tokens) */
export const FACTS_CHAR_BUDGET = 3000;

/**
 * Character budget for the facts *store* (all facts in SQLite). The agent is
 * told to consolidate at 80% of this. Deliberately much larger than the
 * injection budget: injection is importance-ranked top-down, so store size
 * doesn't affect per-session context cost. ~15,000 chars ≈ 150–200 atomic facts.
 */
export const FACTS_STORE_BUDGET = 15000;

const FACT_COLUMNS =
  "id, category, subject, content, importance, sensitive, last_accessed_at, created_at, updated_at";

export function getMemoryStorePath() {
  return getDatabasePath();
}

/**
 * Save a fact to long-term memory. Upserts by category + subject so updated
 * info replaces the old fact instead of duplicating it. Returns the fact id.
 */
export function saveFact(
  { category, subject, content, sensitive },
  storePath = getMemoryStorePath(),
) {
  const db = getDatabase(storePath);
  const existing = db
    .prepare("SELECT id FROM facts WHERE category = ? AND subject = ?")
    .get(category, subject);

  if (existing) {
    db.prepare(
      "UPDATE facts SET content = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE id = ?",
    ).run(content, existing.id);
    // Only touch the flag when explicitly provided — preserve manual settings otherwise
    if (sensitive !== undefined) {
      db.prepare("UPDATE facts SET sensitive = ? WHERE id = ?").run(sensitive ? 1 : 0, existing.id);
    }
    return Number(existing.id);
  }

  const result = db
    .prepare("INSERT INTO facts (category, subject, content, sensitive) VALUES (?, ?, ?, ?)")
    .run(category, subject, content, sensitive ? 1 : 0);
  return Number(result.lastInsertRowid);
}

/**
 * Update a fact's editable fields by id. Returns true when a row was changed.
 */
export function updateFact(id, fields, storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  const sets = [];
  const values = [];
  if (fields.category !== undefined) {
    sets.push("category = ?");
    values.push(fields.category);
  }
  if (fields.subject !== undefined) {
    sets.push("subject = ?");
    values.push(fields.subject);
  }
  if (fields.content !== undefined) {
    sets.push("content = ?");
    values.push(fields.content);
  }
  if (fields.sensitive !== undefined) {
    sets.push("sensitive = ?");
    values.push(fields.sensitive ? 1 : 0);
  }
  if (sets.length === 0) {
    return false;
  }
  sets.push("updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ'))");
  values.push(id);
  const result = db.prepare(`UPDATE facts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

/**
 * Delete a fact by id. Returns true if a row was deleted.
 */
export function deleteFact(id, storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  return db.prepare("DELETE FROM facts WHERE id = ?").run(id).changes > 0;
}

/**
 * Delete a fact by category + subject. Returns true if a row was deleted.
 */
export function deleteFactBySubject(category, subject, storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  return (
    db.prepare("DELETE FROM facts WHERE category = ? AND subject = ?").run(category, subject)
      .changes > 0
  );
}

/**
 * Get all facts ordered by category and subject.
 */
export function getAllFacts(storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  return db
    .prepare(`SELECT ${FACT_COLUMNS} FROM facts ORDER BY category, subject`)
    .all()
    .map(normalizeFactRow);
}

/**
 * Get all facts for a given category.
 */
export function getFactsByCategory(category, storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  return db
    .prepare(
      `SELECT ${FACT_COLUMNS} FROM facts WHERE category = ? ORDER BY subject, updated_at DESC`,
    )
    .all(category)
    .map(normalizeFactRow);
}

/**
 * Simple LIKE-based fact search by content, subject, or category.
 */
export function searchFacts(query, category, storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  const pattern = `%${query}%`;
  if (category) {
    return db
      .prepare(
        `SELECT ${FACT_COLUMNS} FROM facts
         WHERE category = ? AND (content LIKE ? OR subject LIKE ?)
         ORDER BY updated_at DESC
         LIMIT 6`,
      )
      .all(category, pattern, pattern)
      .map(normalizeFactRow);
  }
  return db
    .prepare(
      `SELECT ${FACT_COLUMNS} FROM facts
       WHERE content LIKE ? OR subject LIKE ? OR category LIKE ?
       ORDER BY updated_at DESC
       LIMIT 6`,
    )
    .all(pattern, pattern, pattern)
    .map(normalizeFactRow);
}

/**
 * Format a single fact line for context injection. Includes an "as of" date so
 * the model can resolve conflicts with dated sources by recency — a fact's
 * truth can go stale even though it was true when saved.
 */
function formatFactLine(fact) {
  const date = fact.updated_at?.slice(0, 10) ?? "";
  const suffix = date ? ` _(as of ${date})_` : "";
  return fact.subject
    ? `- **${fact.subject}**: ${fact.content}${suffix}`
    : `- ${fact.content}${suffix}`;
}

/**
 * Get facts formatted for context injection, grouped under "## Known Facts".
 * Sorts by importance DESC, truncates at FACTS_CHAR_BUDGET, and marks every
 * included fact as accessed (which feeds importance decay).
 */
export function getFactsForContext(storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  const facts = db
    .prepare(`SELECT ${FACT_COLUMNS} FROM facts ORDER BY importance DESC, updated_at DESC`)
    .all()
    .map(normalizeFactRow);

  if (facts.length === 0) {
    return "";
  }

  // Reserve space for the header line
  const headerReserve = 100;
  const contentBudget = FACTS_CHAR_BUDGET - headerReserve;

  const includedFacts = [];
  const byCategory = new Map();
  let usedChars = 0;

  for (const fact of facts) {
    const line = formatFactLine(fact);
    const categoryHeader = byCategory.has(fact.category) ? "" : `\n### ${fact.category}\n`;
    const additionalChars = categoryHeader.length + line.length + 1;
    if (usedChars + additionalChars > contentBudget) {
      break;
    }
    usedChars += additionalChars;
    includedFacts.push(fact);
    const list = byCategory.get(fact.category) ?? [];
    list.push(fact);
    byCategory.set(fact.category, list);
  }

  if (includedFacts.length > 0) {
    const placeholders = includedFacts.map(() => "?").join(",");
    db.prepare(
      `UPDATE facts SET last_accessed_at = (strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE id IN (${placeholders})`,
    ).run(...includedFacts.map((fact) => fact.id));
  }

  const lines = ["## Known Facts"];
  for (const [category, categoryFacts] of byCategory) {
    lines.push(`\n### ${category}`);
    for (const fact of categoryFacts) {
      lines.push(formatFactLine(fact));
    }
  }
  return lines.join("\n");
}

/**
 * Get memory usage stats for the facts *store* budget (the curation trigger).
 * Measures all stored facts — unlike context injection, nothing is truncated
 * here; pct can exceed 100 until the agent consolidates the store.
 */
export function getFactsMemoryUsage(storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  const facts = db.prepare("SELECT category, subject, content FROM facts").all();

  const seenCategories = new Set();
  let usedChars = 0;

  for (const fact of facts) {
    const line = fact.subject ? `- **${fact.subject}**: ${fact.content}` : `- ${fact.content}`;
    const categoryHeader = seenCategories.has(fact.category) ? "" : `\n### ${fact.category}\n`;
    usedChars += categoryHeader.length + line.length + 1;
    seenCategories.add(fact.category);
  }

  const pct = Math.round((usedChars / FACTS_STORE_BUDGET) * 100);
  return { usedChars, budgetChars: FACTS_STORE_BUDGET, pct };
}

/**
 * Decay importance for facts not accessed recently. Run at app startup to
 * gradually demote stale facts.
 *
 * - Facts not accessed in 30+ days: importance -= 10 (min 10)
 * - Facts not accessed in 90+ days: importance -= 20 (min 5)
 */
export function decayFactImportance(storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  const decayed90 = db
    .prepare(
      `UPDATE facts
       SET importance = MAX(5, importance - 20)
       WHERE last_accessed_at IS NOT NULL
         AND last_accessed_at < datetime('now', '-90 days')
         AND importance > 5`,
    )
    .run();
  const decayed30 = db
    .prepare(
      `UPDATE facts
       SET importance = MAX(10, importance - 10)
       WHERE last_accessed_at IS NOT NULL
         AND last_accessed_at < datetime('now', '-30 days')
         AND last_accessed_at >= datetime('now', '-90 days')
         AND importance > 10`,
    )
    .run();
  return Number(decayed90.changes ?? 0) + Number(decayed30.changes ?? 0);
}

function normalizeFactRow(row) {
  return {
    id: Number(row.id),
    category: row.category,
    subject: row.subject,
    content: row.content,
    importance: Number(row.importance ?? 50),
    sensitive: Boolean(row.sensitive),
    last_accessed_at: row.last_accessed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
