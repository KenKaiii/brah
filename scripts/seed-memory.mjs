// Dev-only: seed mock facts + daily logs into the app's SQLite DB so the
// Memory panel (Facts / Daily tabs) can be verified in the UI. Safe to re-run —
// facts upsert by category+subject and logs upsert by date.
//
//   node scripts/seed-memory.mjs
//
// Stop the app first (or restart it after) so the panel reloads the new rows.

import os from "node:os";
import path from "node:path";
import { getDatabase, setDatabaseUserDataPath } from "../src/realtime/tools/database.js";
import { saveFact } from "../src/realtime/tools/memory-store.js";

// The running app stores data under Electron's userData dir. On macOS (dev run,
// app name "brah") that is ~/Library/Application Support/brah.
const userDataPath =
  process.env.BRAH_USER_DATA_PATH ??
  (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "brah")
    : path.join(os.tmpdir(), "brah-user-data"));

setDatabaseUserDataPath(userDataPath);

const facts = [
  { category: "user_info", subject: "name", content: "Ken Kai" },
  { category: "user_info", subject: "location", content: "Lives in Kuala Lumpur, Malaysia" },
  { category: "user_info", subject: "timezone", content: "Works on Malaysia time (GMT+8)" },
  { category: "people", subject: "partner", content: "Partner Sarah, works in marketing" },
  { category: "people", subject: "pet", content: "Golden retriever named Max" },
  {
    category: "preferences",
    subject: "coffee",
    content: "Drinks oat flat whites, usually two a day",
  },
  {
    category: "preferences",
    subject: "communication",
    content: "Prefers direct, no-fluff answers and short replies",
  },
  {
    category: "work",
    subject: "role",
    content: "Founder building desktop AI assistants at UnstableMind",
  },
  {
    category: "projects",
    subject: "current_project",
    content: "Building Brah, a realtime voice desktop assistant",
  },
  {
    category: "decisions",
    subject: "memory_system",
    content: "Decided to mirror pocket-agent's facts + daily logs memory model in Brah",
  },
  { category: "notes", subject: "side_interest", content: "Into mechanical keyboards and synths" },
  {
    category: "people",
    subject: "therapist",
    content: "Sees a therapist on Thursdays for work stress",
    sensitive: true,
  },
];

for (const fact of facts) {
  saveFact(fact, undefined);
}

// Seed daily logs for the last three days (the rolling retention window). We
// insert dated rows directly so the entries land on past days; the running app
// prunes anything older than three days on startup.
const db = getDatabase();

function localDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const dailyLogs = [
  {
    daysAgo: 2,
    content: [
      "[09:14 AM] Kicked off the memory system rework, reviewed pocket-agent's facts model",
      "[11:40 AM] Decided to keep facts + daily logs but skip the embeddings layer for now",
      "[04:02 PM] Felt good about progress; wrapped up early to walk Max",
    ].join("\n"),
  },
  {
    daysAgo: 1,
    content: [
      "[10:05 AM] Wired the remember/forget/recall tools and the Facts tab",
      "[02:30 PM] Debugged mid-call session refresh so saved facts inject right away",
      "[06:15 PM] Sarah came by; talked through the demo plan for the week",
    ].join("\n"),
  },
  {
    daysAgo: 0,
    content: [
      "[09:48 AM] Added the daily_log tool and split the panel into Facts and Daily",
      "[01:12 PM] Seeded mock data to verify the UI renders both tabs",
    ].join("\n"),
  },
];

const upsertLog = db.prepare(
  `INSERT INTO daily_logs (date, content, updated_at)
   VALUES (?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ')))
   ON CONFLICT(date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
);
for (const log of dailyLogs) {
  upsertLog.run(localDate(log.daysAgo), log.content);
}

console.log(
  `Seeded ${facts.length} facts and ${dailyLogs.length} daily logs into ${path.join(userDataPath, "brah.db")}`,
);
