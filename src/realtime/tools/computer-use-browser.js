import net from "node:net";
import { isBlockedHostname, isBlockedIp } from "./net-guard.js";

const defaultViewport = Object.freeze({ width: 1280, height: 720 });
const safeChromiumArgs = Object.freeze([
  "--disable-extensions",
  "--disable-file-system",
  "--disable-background-networking",
  "--disable-default-apps",
  "--no-first-run",
]);

export async function createBrowserComputerTarget(options = {}) {
  const viewport = normalizeViewport(options.viewport);
  const playwright = options.playwright ?? (await import("playwright"));
  const chromium = playwright.chromium;
  if (!chromium?.launch) {
    throw new Error("Playwright Chromium is unavailable. Run `npx playwright install chromium`.");
  }

  const browser = await chromium.launch({
    headless: options.headless ?? false,
    args: [...safeChromiumArgs, ...(Array.isArray(options.launchArgs) ? options.launchArgs : [])],
  });
  let page;
  try {
    const context = await browser.newContext({ viewport });
    page = await context.newPage();
    if (typeof options.url === "string" && options.url.trim()) {
      await navigatePage(page, options.url.trim());
    }
  } catch (error) {
    try {
      await browser.close();
    } catch {
      // Keep the setup error as the reason this target could not be created.
    }
    throw error;
  }

  return {
    // Playwright page coordinates match the viewport-sized screenshot 1:1.
    displaySize: { width: viewport.width, height: viewport.height },
    actionTarget: {
      mouse: page.mouse,
      keyboard: page.keyboard,
      wait: async (ms) => page.waitForTimeout(ms),
    },
    async captureScreenshot() {
      return page.screenshot({ type: "png", fullPage: false });
    },
    async navigateTo(url) {
      await navigatePage(page, url);
    },
    async goBack() {
      await page.goBack({ waitUntil: "domcontentloaded" });
    },
    async goForward() {
      await page.goForward({ waitUntil: "domcontentloaded" });
    },
    async close() {
      await browser.close();
    },
  };
}

async function navigatePage(page, rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Computer use browser URL must be http or https.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) ? isBlockedIp(host) : isBlockedHostname(host)) {
    throw new Error("Navigation to local, loopback, or private addresses is not allowed.");
  }
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
}

function normalizeViewport(viewport) {
  if (!isRecord(viewport)) {
    return defaultViewport;
  }
  const width = Number.isFinite(viewport.width) ? viewport.width : defaultViewport.width;
  const height = Number.isFinite(viewport.height) ? viewport.height : defaultViewport.height;
  return {
    width: Math.max(320, Math.min(3840, Math.round(width))),
    height: Math.max(240, Math.min(2160, Math.round(height))),
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
