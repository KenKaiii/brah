// Renders build/icon.html to build/icon.png (1024px) and build/icon.icns.
// electron-builder picks both up from build/ automatically.
// Usage: node scripts/make-icon.mjs   (macOS only for the .icns step)
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const buildDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
const pngPath = path.join(buildDir, "icon.png");
const iconsetDir = path.join(buildDir, "icon.iconset");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.goto(pathToFileURL(path.join(buildDir, "icon.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: pngPath, omitBackground: true });
} finally {
  await browser.close();
}

if (process.platform === "darwin") {
  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("sips", ["-z", px, px, pngPath, "--out", path.join(iconsetDir, name)], {
        stdio: "ignore",
      });
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", path.join(buildDir, "icon.icns")]);
  rmSync(iconsetDir, { recursive: true, force: true });
}

console.log(`Wrote ${pngPath}`);
