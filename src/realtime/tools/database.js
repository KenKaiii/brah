import { mkdirSync, readFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Built-in SQLite (node:sqlite) backs the planner and activity stores. It is
// available in the Electron runtime (Node 24) with no native dependency, and
// its synchronous, transactional writes remove the read-modify-write races and
// file-corruption class of bugs the previous JSON files suffered from.

let userDataPathOverride = null;
const connections = new Map();

export function setDatabaseUserDataPath(userDataPath) {
  userDataPathOverride =
    typeof userDataPath === "string" && userDataPath.trim() ? userDataPath : null;
}

export function getDatabasePath() {
  return path.join(getUserDataPath(), "brah.db");
}

export function getDatabase(dbPath = getDatabasePath()) {
  const existing = connections.get(dbPath);
  if (existing) {
    return existing;
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySchema(db);
  applyAdditiveMigrations(db);
  connections.set(dbPath, db);
  return db;
}

// Exposed for tests so connections do not leak across temp databases.
export function closeDatabase(dbPath = getDatabasePath()) {
  const db = connections.get(dbPath);
  if (db) {
    db.close();
    connections.delete(dbPath);
  }
}

function applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'todo'
    );
    CREATE TABLE IF NOT EXISTS calendar_items (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      time TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS activity (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      time TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_kind_time ON activity (kind, time);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 50,
      sensitive INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
      updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
    );
    CREATE TABLE IF NOT EXISTS soul (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aspect TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ'))),
      updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
    );
    CREATE TABLE IF NOT EXISTS daily_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
    );
  `);
  applyMemoryHistory(db);
}

// Change history for long-term memory (the mem0 pattern: old value, new value,
// event). Memory is replayed into every call, so if a poisoned or mistaken
// write overwrites or deletes something, the previous value must be traceable
// and recoverable. Triggers capture every write path, including future ones.
// Bounded to the most recent MEMORY_HISTORY_LIMIT rows. Deletions the user
// makes in the Memory panel also purge that item's history (see
// purgeMemoryHistory), so deleting really erases.
export const MEMORY_HISTORY_LIMIT = 1000;

function applyMemoryHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      old_content TEXT,
      new_content TEXT,
      created_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_history_item ON memory_history (kind, item_id);
    CREATE TRIGGER IF NOT EXISTS memory_history_bound AFTER INSERT ON memory_history BEGIN
      DELETE FROM memory_history WHERE id <= new.id - ${MEMORY_HISTORY_LIMIT};
    END;
  `);
  const tracked = [
    { table: "facts", kind: "fact", label: "category || '/' || subject" },
    { table: "soul", kind: "soul", label: "aspect" },
    { table: "daily_logs", kind: "daily", label: "date" },
  ];
  for (const { table, kind, label } of tracked) {
    const newLabel = label.replace(/\b(category|subject|aspect|date)\b/g, "new.$1");
    const oldLabel = label.replace(/\b(category|subject|aspect|date)\b/g, "old.$1");
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_history_insert AFTER INSERT ON ${table} BEGIN
        INSERT INTO memory_history (kind, item_id, event, label, new_content)
        VALUES ('${kind}', new.id, 'add', ${newLabel}, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_history_update AFTER UPDATE OF content ON ${table}
      WHEN old.content IS NOT new.content BEGIN
        INSERT INTO memory_history (kind, item_id, event, label, old_content, new_content)
        VALUES ('${kind}', new.id, 'update', ${newLabel}, old.content, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_history_delete AFTER DELETE ON ${table} BEGIN
        INSERT INTO memory_history (kind, item_id, event, label, old_content)
        VALUES ('${kind}', old.id, 'delete', ${oldLabel}, old.content);
      END;
    `);
  }
}

/** Recent memory changes, newest first. */
export function getMemoryHistory({ kind, itemId, limit = 100 } = {}, dbPath = getDatabasePath()) {
  const clauses = [];
  const values = [];
  if (kind) {
    clauses.push("kind = ?");
    values.push(kind);
  }
  if (Number.isInteger(itemId)) {
    clauses.push("item_id = ?");
    values.push(itemId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return getDatabase(dbPath)
    .prepare(
      `SELECT id, kind, item_id, event, label, old_content, new_content, created_at
       FROM memory_history ${where} ORDER BY id DESC LIMIT ?`,
    )
    .all(...values, Math.max(1, Math.min(1000, Math.trunc(limit) || 100)));
}

/** Erase all history for one memory item (used when the user deletes it). */
export function purgeMemoryHistory(kind, itemId, dbPath = getDatabasePath()) {
  getDatabase(dbPath)
    .prepare("DELETE FROM memory_history WHERE kind = ? AND item_id = ?")
    .run(kind, itemId);
}

// Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS never
// alters an existing table, so each is added here only when missing. Additive
// only (nullable or defaulted), so existing rows are never rewritten or lost.
const ADDITIVE_COLUMNS = Object.freeze([
  // Provenance for each fact: "conversation" (background extractor, the only
  // writer before this column existed), "voice" (remember tool), "you" (edited
  // in the Memory panel).
  { table: "facts", column: "source", definition: "TEXT NOT NULL DEFAULT 'conversation'" },
]);

function applyAdditiveMigrations(db) {
  for (const { table, column, definition } of ADDITIVE_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((info) => info.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function getUserDataPath() {
  if (userDataPathOverride) {
    return userDataPathOverride;
  }
  return path.join(os.tmpdir(), "brah-user-data");
}

// One-time import of the legacy JSON stores into SQLite. Because an earlier bug
// wrote data to the OS temp dir instead of userData, we look in both locations,
// import any valid rows the DB does not already have, and rename the source
// files so the import never repeats.
export function migrateLegacyStores(importers, dbPath = getDatabasePath()) {
  const db = getDatabase(dbPath);
  const legacyDirs = [getUserDataPath(), path.join(os.tmpdir(), "brah-user-data")];
  for (const { relativePath, apply } of importers) {
    for (const dir of legacyDirs) {
      const filePath = path.join(dir, relativePath);
      const parsed = readJsonFile(filePath);
      if (parsed === null) {
        continue;
      }
      try {
        apply(db, parsed);
        renameSync(filePath, `${filePath}.migrated-${Date.now()}`);
      } catch (error) {
        console.warn(`Failed to migrate legacy store ${filePath}`, error);
      }
    }
  }
}

function readJsonFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
