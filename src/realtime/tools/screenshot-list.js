import { promises as fs } from "node:fs";
import path from "node:path";

const maxListedScreenshots = 30;
const maxConcurrentStats = 32;

export async function listSavedScreenshots(screenshotsDir, fileSystem = fs) {
  let names;
  try {
    names = (await fileSystem.readdir(screenshotsDir)).filter((name) =>
      name.toLowerCase().endsWith(".png"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const candidates = [];
  for (let offset = 0; offset < names.length; offset += maxConcurrentStats) {
    const batch = await Promise.all(
      names.slice(offset, offset + maxConcurrentStats).map(async (name) => {
        try {
          const stats = await fileSystem.stat(path.join(screenshotsDir, name));
          return stats.isFile() ? { name, createdAt: stats.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
    );
    candidates.push(...batch.filter(Boolean));
  }

  candidates.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
  const entries = [];
  for (let offset = 0; offset < candidates.length && entries.length < maxListedScreenshots; ) {
    const batch = candidates.slice(offset, offset + maxListedScreenshots - entries.length);
    offset += batch.length;
    const loaded = await Promise.all(
      batch.map(async (entry) => {
        try {
          const bytes = await fileSystem.readFile(path.join(screenshotsDir, entry.name));
          return { ...entry, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
        } catch {
          return null;
        }
      }),
    );
    entries.push(...loaded.filter(Boolean));
  }
  return entries;
}
