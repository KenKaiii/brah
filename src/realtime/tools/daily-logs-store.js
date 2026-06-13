import { getDatabase, getDatabasePath } from "./database.js";

// Daily logs store, ported from pocket-agent's daily-logs.ts. The agent journals
// what the user worked on, talked about, decided, or how they seemed via the daily_log
// tool. Recent logs are injected into the session for continuity and pruned to a
// rolling window. Rollups/embeddings from pocket-agent are intentionally omitted
// (they need an LLM summarizer + embedding pipeline Brah doesn't have).

/** Hard character budget for daily logs injected into the session (~700 tokens) */
export const DAILY_LOGS_CHAR_BUDGET = 2000;

/** Raw daily logs are kept for this many days before being pruned. */
export const DAILY_LOGS_RETENTION_DAYS = 3;

export function getDailyLogsStorePath() {
  return getDatabasePath();
}

/** Today's date as YYYY-MM-DD in local time. */
export function getTodayDate(now = new Date()) {
  return formatLocalDate(now);
}

/** Get a daily log by date (defaults to today), or null. */
export function getDailyLog(date, storePath = getDailyLogsStorePath()) {
  const db = getDatabase(storePath);
  const targetDate = date || getTodayDate();
  const row = db
    .prepare("SELECT id, date, content, updated_at FROM daily_logs WHERE date = ?")
    .get(targetDate);
  return row ? normalizeLogRow(row) : null;
}

/**
 * Append a timestamped entry to today's log, creating it if needed. Returns the
 * updated log row.
 */
export function appendToDailyLog(entry, storePath = getDailyLogsStorePath(), now = new Date()) {
  const db = getDatabase(storePath);
  const today = getTodayDate(now);
  const timestamp = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const formattedEntry = `[${timestamp}] ${entry}`;

  const existing = getDailyLog(today, storePath);
  if (existing) {
    const newContent = `${existing.content}\n${formattedEntry}`;
    db.prepare(
      "UPDATE daily_logs SET content = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE date = ?",
    ).run(newContent, today);
  } else {
    db.prepare(
      "INSERT INTO daily_logs (date, content, updated_at) VALUES (?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ')))",
    ).run(today, formattedEntry);
  }
  return getDailyLog(today, storePath);
}

/** Get daily logs from the last N calendar days, most recent first. */
export function getDailyLogsSince(
  days = DAILY_LOGS_RETENTION_DAYS,
  storePath = getDailyLogsStorePath(),
) {
  const db = getDatabase(storePath);
  return db
    .prepare(
      "SELECT id, date, content, updated_at FROM daily_logs WHERE date >= ? ORDER BY date DESC",
    )
    .all(cutoffDateString(days))
    .map(normalizeLogRow);
}

/** Get every daily log, most recent first (for the UI). */
export function getAllDailyLogs(storePath = getDailyLogsStorePath()) {
  const db = getDatabase(storePath);
  return db
    .prepare("SELECT id, date, content, updated_at FROM daily_logs ORDER BY date DESC")
    .all()
    .map(normalizeLogRow);
}

/** Delete a daily log by id. Returns true when a row was deleted. */
export function deleteDailyLog(id, storePath = getDailyLogsStorePath()) {
  const db = getDatabase(storePath);
  return db.prepare("DELETE FROM daily_logs WHERE id = ?").run(id).changes > 0;
}

/**
 * Prune daily logs older than the retention window. Run on startup to keep only
 * the rolling window. Returns the number of rows deleted.
 */
export function pruneOldDailyLogs(
  days = DAILY_LOGS_RETENTION_DAYS,
  storePath = getDailyLogsStorePath(),
) {
  const db = getDatabase(storePath);
  const result = db.prepare("DELETE FROM daily_logs WHERE date < ?").run(cutoffDateString(days));
  return result.changes;
}

/**
 * Get recent daily logs formatted for context injection, oldest first, truncated
 * at DAILY_LOGS_CHAR_BUDGET. Returns "" when there are no recent logs.
 */
export function getDailyLogsContext(
  days = DAILY_LOGS_RETENTION_DAYS,
  storePath = getDailyLogsStorePath(),
) {
  const logs = getDailyLogsSince(days, storePath);
  if (logs.length === 0) {
    return "";
  }

  const headerReserve = 90;
  const contentBudget = DAILY_LOGS_CHAR_BUDGET - headerReserve;

  // Show oldest first (reverse of the DESC order from the DB)
  const orderedLogs = [...logs].reverse();
  const today = getTodayDate();

  const includedLines = [];
  let usedChars = 0;
  for (const log of orderedLogs) {
    const dateLabel = log.date === today ? "Today" : log.date;
    const logHeader = `\n### ${dateLabel}`;
    const additionalChars = logHeader.length + 1 + log.content.length;
    if (usedChars + additionalChars > contentBudget) {
      const remaining = contentBudget - usedChars - logHeader.length - 1;
      if (remaining > 50) {
        includedLines.push(logHeader);
        includedLines.push(`${log.content.slice(0, remaining)}...`);
      }
      break;
    }
    usedChars += additionalChars;
    includedLines.push(logHeader);
    includedLines.push(log.content);
  }

  return ["## Recent Daily Logs", ...includedLines].join("\n");
}

function normalizeLogRow(row) {
  return {
    id: Number(row.id),
    date: row.date,
    content: row.content,
    updated_at: row.updated_at,
  };
}

/** Format a Date as a local YYYY-MM-DD string. */
function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The cutoff date string N days before today, in local time. */
function cutoffDateString(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return formatLocalDate(cutoff);
}
