import { promises as fs } from "node:fs";
import path from "node:path";

const maxSavedScreenshots = 100;
const maxConcurrentStats = 32;
const captureName =
  /^screenshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?\.png$/;

export async function pruneSavedScreenshots(
  screenshotsDir,
  { fileSystem = fs, protectedName } = {},
) {
  const names = (await fileSystem.readdir(screenshotsDir)).filter((name) => captureName.test(name));
  const captures = [];
  for (let offset = 0; offset < names.length; offset += maxConcurrentStats) {
    const batch = await Promise.all(
      names.slice(offset, offset + maxConcurrentStats).map(async (name) => {
        try {
          const stats = await fileSystem.lstat(path.join(screenshotsDir, name));
          return stats.isFile() ? { name, modifiedAt: stats.mtimeMs } : null;
        } catch (error) {
          if (error?.code === "ENOENT") return null;
          throw error;
        }
      }),
    );
    captures.push(...batch.filter(Boolean));
  }

  captures.sort(
    (a, b) =>
      Number(b.name === protectedName) - Number(a.name === protectedName) ||
      b.modifiedAt - a.modifiedAt ||
      b.name.localeCompare(a.name),
  );
  const surplus = captures.slice(maxSavedScreenshots);
  let deleted = 0;
  for (const { name } of surplus.reverse()) {
    try {
      await fileSystem.unlink(path.join(screenshotsDir, name));
      deleted += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { found: captures.length, deleted };
}
