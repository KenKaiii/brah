import { getDatabase, getDatabasePath, migrateLegacyStores } from "./database.js";

const maxEntriesPerKind = 50;
const maxTextExcerpt = 600;
const activityKinds = Object.freeze(["web_search", "web_fetch", "computer_use"]);

export function getActivityStorePath() {
  return getDatabasePath();
}

export function recordActivity(entry, storePath = getActivityStorePath()) {
  const normalized = normalizeEntry(entry);
  if (!normalized) {
    return null;
  }
  const db = getDatabase(storePath);
  const { id, kind, time, ...rest } = normalized;
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR REPLACE INTO activity (id, kind, time, data) VALUES (?, ?, ?, ?)").run(
      id,
      kind,
      time,
      JSON.stringify(rest),
    );
    db.prepare(
      `DELETE FROM activity
       WHERE kind = ?
         AND seq NOT IN (
           SELECT seq FROM activity WHERE kind = ? ORDER BY time DESC, seq DESC LIMIT ?
         )`,
    ).run(kind, kind, maxEntriesPerKind);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return normalized;
}

export function listActivity(kind, storePath = getActivityStorePath()) {
  const db = getDatabase(storePath);
  const trimmedKind = typeof kind === "string" && kind.trim() ? kind.trim() : null;
  const rows = trimmedKind
    ? db
        .prepare(
          "SELECT id, kind, time, data FROM activity WHERE kind = ? ORDER BY time DESC, seq DESC",
        )
        .all(trimmedKind)
    : db.prepare("SELECT id, kind, time, data FROM activity ORDER BY time DESC, seq DESC").all();
  return rows.map(rowToEntry).filter(Boolean);
}

export function loadActivityState(storePath = getActivityStorePath()) {
  return { entries: listActivity(undefined, storePath) };
}

export function saveActivityState(state, storePath = getActivityStorePath()) {
  const db = getDatabase(storePath);
  const entries = capByKind((state.entries ?? []).map(normalizeEntry).filter(Boolean));
  const insert = db.prepare(
    "INSERT OR REPLACE INTO activity (id, kind, time, data) VALUES (?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM activity");
    for (const entry of entries) {
      const { id, kind, time, ...rest } = entry;
      insert.run(id, kind, time, JSON.stringify(rest));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function emptyActivityState() {
  return { entries: [] };
}

// Imports the legacy activity/log.json file (from userData or the old tmp dir)
// into SQLite, skipping ids that already exist and re-capping per kind.
export function migrateLegacyActivityStore(dbPath = getActivityStorePath()) {
  migrateLegacyStores(
    [
      {
        relativePath: "activity/log.json",
        apply(db, parsed) {
          if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
            return;
          }
          const insert = db.prepare(
            "INSERT OR IGNORE INTO activity (id, kind, time, data) VALUES (?, ?, ?, ?)",
          );
          for (const raw of parsed.entries) {
            const entry = normalizeEntry(raw);
            if (!entry) {
              continue;
            }
            const { id, kind, time, ...rest } = entry;
            insert.run(id, kind, time, JSON.stringify(rest));
          }
          for (const kind of activityKinds) {
            db.prepare(
              `DELETE FROM activity
               WHERE kind = ?
                 AND seq NOT IN (
                   SELECT seq FROM activity WHERE kind = ? ORDER BY time DESC, seq DESC LIMIT ?
                 )`,
            ).run(kind, kind, maxEntriesPerKind);
          }
        },
      },
    ],
    dbPath,
  );
}

function rowToEntry(row) {
  if (!isRecord(row)) {
    return null;
  }
  let rest = {};
  try {
    const parsed = JSON.parse(row.data);
    if (isRecord(parsed)) {
      rest = parsed;
    }
  } catch {
    rest = {};
  }
  return { id: row.id, kind: row.kind, time: row.time, ...rest };
}

function capByKind(entries) {
  const counts = new Map();
  const kept = [];
  for (const entry of entries) {
    const used = counts.get(entry.kind) ?? 0;
    if (used >= maxEntriesPerKind) {
      continue;
    }
    counts.set(entry.kind, used + 1);
    kept.push(entry);
  }
  return kept;
}

function normalizeEntry(value) {
  if (!isRecord(value) || !activityKinds.includes(value.kind)) {
    return null;
  }
  const base = {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : createActivityId(),
    kind: value.kind,
    time:
      typeof value.time === "string" && value.time.trim() ? value.time : new Date().toISOString(),
  };
  if (value.kind === "web_search") {
    return {
      ...base,
      query: clampText(value.query, 300),
      resultCount: Number.isInteger(value.resultCount) ? value.resultCount : 0,
      results: normalizeSearchResults(value.results),
    };
  }
  if (value.kind === "web_fetch") {
    return {
      ...base,
      url: clampText(value.url, 600),
      title: clampText(value.title, 300),
      text: clampText(value.text, maxTextExcerpt),
    };
  }
  return {
    ...base,
    task: clampText(value.task, 600),
    statusText: clampText(value.statusText, 60),
    steps: Number.isInteger(value.steps) ? value.steps : 0,
    finalText: clampText(value.finalText, maxTextExcerpt),
  };
}

function normalizeSearchResults(results) {
  if (!Array.isArray(results)) {
    return [];
  }
  return results.slice(0, 10).map((result) => ({
    title: clampText(result?.title, 300),
    url: clampText(result?.url, 600),
    snippet: clampText(result?.snippet, 400),
  }));
}

function clampText(value, max) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, max);
}

function createActivityId() {
  return `activity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
