import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendToDailyLog,
  DAILY_LOGS_CHAR_BUDGET,
  deleteDailyLog,
  getAllDailyLogs,
  getDailyLog,
  getDailyLogsContext,
  getTodayDate,
  pruneOldDailyLogs,
} from "../src/realtime/tools/daily-logs-store.js";
import { closeDatabase, getDatabase } from "../src/realtime/tools/database.js";

async function withDailyLogs(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-daily-"));
  const filePath = path.join(directory, "memory", "daily.db");
  try {
    await callback(filePath);
  } finally {
    closeDatabase(filePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("appendToDailyLog creates today's log then appends timestamped entries", async () => {
  await withDailyLogs((filePath) => {
    const first = appendToDailyLog("Started the daily logs feature", filePath);
    assert.equal(first.date, getTodayDate());
    assert.match(first.content, /^\[\d{1,2}:\d{2}\s?(AM|PM)?\]/i);

    appendToDailyLog("Wired the panel tab", filePath);
    const log = getDailyLog(undefined, filePath);
    const lines = log.content.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /Wired the panel tab/);
  });
});

test("getAllDailyLogs returns one row per day, most recent first", async () => {
  await withDailyLogs((filePath) => {
    const db = getDatabase(filePath);
    db.prepare("INSERT INTO daily_logs (date, content) VALUES (?, ?)").run(
      "2026-06-01",
      "[09:00 AM] Older day",
    );
    appendToDailyLog("Today entry", filePath);

    const logs = getAllDailyLogs(filePath);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].date, getTodayDate());
    assert.equal(logs[1].date, "2026-06-01");
  });
});

test("deleteDailyLog removes a row by id", async () => {
  await withDailyLogs((filePath) => {
    const log = appendToDailyLog("Delete me", filePath);
    assert.equal(deleteDailyLog(log.id, filePath), true);
    assert.equal(deleteDailyLog(log.id, filePath), false);
    assert.equal(getAllDailyLogs(filePath).length, 0);
  });
});

test("pruneOldDailyLogs drops logs older than the retention window", async () => {
  await withDailyLogs((filePath) => {
    const db = getDatabase(filePath);
    db.prepare("INSERT INTO daily_logs (date, content) VALUES (?, ?)").run(
      "2020-01-01",
      "[09:00 AM] Ancient",
    );
    appendToDailyLog("Fresh", filePath);

    assert.equal(pruneOldDailyLogs(3, filePath), 1);
    const logs = getAllDailyLogs(filePath);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].date, getTodayDate());
  });
});

test("getDailyLogsContext formats recent logs under a Recent Daily Logs header", async () => {
  await withDailyLogs((filePath) => {
    assert.equal(getDailyLogsContext(3, filePath), "");
    appendToDailyLog("Talked through the memory split", filePath);
    const context = getDailyLogsContext(3, filePath);
    assert.match(context, /^## Recent Daily Logs/);
    assert.match(context, /### Today/);
    assert.match(context, /Talked through the memory split/);
  });
});

test("getDailyLogsContext stays within the char budget", async () => {
  await withDailyLogs((filePath) => {
    for (let index = 0; index < 80; index += 1) {
      appendToDailyLog(`Entry number ${index} with some descriptive padding text here`, filePath);
    }
    const context = getDailyLogsContext(3, filePath);
    assert.ok(context.length <= DAILY_LOGS_CHAR_BUDGET);
  });
});
