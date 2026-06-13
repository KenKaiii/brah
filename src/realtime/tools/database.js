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
    CREATE TABLE IF NOT EXISTS daily_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      updated_at TEXT DEFAULT ((strftime('%Y-%m-%dT%H:%M:%fZ')))
    );
  `);
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
