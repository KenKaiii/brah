import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeCaptureFailure,
  getScreenAccessStatus,
  resolveSourceImage,
} from "./screen-capture-fallback.js";
import { pruneSavedScreenshots } from "./screenshot-retention.js";

const sourceAliasTtlMs = 5 * 60 * 1000;
const maxSources = 25;
const thumbnailSize = Object.freeze({ width: 1920, height: 1080 });
const realtimeImageMaxWidth = 1024;
const visionPrompt = `Analyze this screenshot for a voice assistant. Describe the visible app/window, important visible text, actionable UI elements, warnings/errors, and one suggested next action if obvious. Keep it concise and factual; do not invent hidden content.`;

const sourceAliasState = {
  expiresAt: 0,
  aliases: new Map(),
};

export async function capturePrimaryScreenPng(options = {}) {
  const sources = await getCapturerSources({ withThumbnails: true }, options);
  const selected = selectPrimaryScreenSource(sources, options);
  if (!selected) {
    throw new Error("No primary screen source was found for capture.");
  }
  const resolved = await resolveSourceImage(selected, { ...options, maxSize: thumbnailSize });
  await logScreenshotEvent(options, "screenshot.primary.resolved", {
    id: selected.id,
    displayId: selected.display_id,
    via: resolved.ok ? resolved.via : null,
    ...(resolved.ok ? {} : resolved.details),
  });
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
  let image = resolved.image;
  const resizeTo = options.resizeTo;
  if (
    isRecord(resizeTo) &&
    Number.isFinite(resizeTo.width) &&
    Number.isFinite(resizeTo.height) &&
    resizeTo.width > 0 &&
    resizeTo.height > 0 &&
    typeof image.resize === "function"
  ) {
    image = image.resize({
      width: Math.round(resizeTo.width),
      height: Math.round(resizeTo.height),
      quality: "good",
    });
  }
  const size = image.getSize();
  return { png: image.toPNG(), width: size.width, height: size.height };
}

export async function executeScreenshotTool(name, args, options = {}) {
  switch (name) {
    case "list_screenshot_sources":
      return listScreenshotSources(args, options);
    case "take_screenshot":
      return takeScreenshot(args, options);
    case "analyze_screen":
      return analyzeScreen(args, options);
    default:
      return null;
  }
}

async function listScreenshotSources(args = {}, options = {}) {
  const includeScreens = !isRecord(args) || args.includeScreens !== false;
  const includeWindows = !isRecord(args) || args.includeWindows !== false;
  await logScreenshotEvent(options, "screenshot.sources.start", { includeScreens, includeWindows });
  if (!includeScreens && !includeWindows) {
    return invalidArguments("At least one of includeScreens or includeWindows must be true.");
  }

  try {
    const sources = await getCapturerSources({ withThumbnails: false }, options);
    await logScreenshotEvent(options, "screenshot.sources.raw", summarizeSources(sources));
    const filtered = sources.filter((source) => {
      const type = source.id.startsWith("screen:") ? "screen" : "window";
      return (type === "screen" && includeScreens) || (type === "window" && includeWindows);
    });
    const result = createSourceListResult(filtered, getScreenAccessStatus(options));
    await logScreenshotEvent(options, "screenshot.sources.finish", {
      returnedCount: result.sources.length,
      aliases: result.sources,
    });
    return result;
  } catch (error) {
    await logScreenshotEvent(options, "screenshot.sources.error", { error: formatError(error) });
    return screenshotErrorResult(error, options);
  }
}

async function takeScreenshot(args = {}, options = {}) {
  await logScreenshotEvent(options, "screenshot.take.start", { args: sanitizeArgs(args) });
  if (!isRecord(args)) {
    return invalidArguments("Arguments must be an object.");
  }
  const target = typeof args.target === "string" ? args.target : "primary_screen";
  if (!isValidScreenshotTarget(target)) {
    return invalidArguments("target must be primary_screen, source, or window.");
  }

  try {
    const capture = await captureScreenshot(args, options);
    if (!capture.ok) {
      await logScreenshotEvent(options, "screenshot.take.capture_error", capture.error);
      return capture.error;
    }

    await logScreenshotEvent(options, "screenshot.take.finish", {
      path: capture.path,
      dimensions: capture.dimensions,
      source: capture.source,
      bytes: capture.imagePng.length,
    });
    return {
      status: "captured",
      message:
        "Screenshot saved locally. The voice model receives this path and metadata, not the image pixels.",
      path: capture.path,
      dimensions: capture.dimensions,
      source: capture.source,
      reason: typeof args.reason === "string" ? args.reason.trim().slice(0, 160) : undefined,
    };
  } catch (error) {
    await logScreenshotEvent(options, "screenshot.take.error", { error: formatError(error) });
    return screenshotErrorResult(error, options);
  }
}

async function analyzeScreen(args = {}, options = {}) {
  await logScreenshotEvent(options, "screenshot.analyze.start", { args: sanitizeArgs(args) });
  if (!isRecord(args)) {
    return invalidArguments("Arguments must be an object.");
  }
  try {
    const capture = await captureScreenshot(args, options);
    if (!capture.ok) {
      await logScreenshotEvent(options, "screenshot.analyze.capture_error", capture.error);
      return capture.error;
    }
    await logScreenshotEvent(options, "screenshot.analyze.captured", {
      path: capture.path,
      dimensions: capture.dimensions,
      source: capture.source,
      bytes: capture.imagePng.length,
    });
    const realtimeInput = createRealtimeScreenshotInput(capture, args);
    await logScreenshotEvent(options, "screenshot.analyze.ready_for_realtime", {
      path: capture.path,
      dimensions: capture.dimensions,
      source: capture.source,
      imageBytes: capture.imagePng.length,
      realtimeImage: {
        mimeType: capture.realtimeImage.mimeType,
        width: capture.realtimeImage.width,
        height: capture.realtimeImage.height,
        bytes: capture.realtimeImage.bytes,
      },
    });
    return {
      status: "captured_for_realtime_analysis",
      message:
        "Screenshot captured. The app will send the image to the active Realtime session for vision analysis.",
      path: capture.path,
      dimensions: capture.dimensions,
      source: capture.source,
      realtimeInput,
    };
  } catch (error) {
    await logScreenshotEvent(options, "screenshot.analyze.error", { error: formatError(error) });
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Screen analysis failed.",
    };
  }
}

async function captureScreenshot(args, options) {
  const target = typeof args.target === "string" ? args.target : "primary_screen";
  await logScreenshotEvent(options, "screenshot.capture.start", { target });
  const sources = await getCapturerSources({ withThumbnails: true }, options);
  await logScreenshotEvent(options, "screenshot.capture.sources", summarizeSources(sources));
  let selected = null;
  let sourceName = "Primary screen";

  if (target === "source") {
    if (typeof args.source_id !== "string" || !args.source_id.trim()) {
      return { ok: false, error: invalidArguments("source_id is required when target is source.") };
    }
    const rawSourceId = getRawSourceId(args.source_id.trim());
    if (!rawSourceId) {
      return {
        ok: false,
        error: {
          status: "not_found",
          message:
            "Screenshot source id is unknown or expired. Call list_screenshot_sources again.",
        },
      };
    }
    selected = sources.find((source) => source.id === rawSourceId) ?? null;
    sourceName = getAliasName(args.source_id.trim()) ?? "Selected source";
  } else if (target === "window") {
    if (typeof args.window_query !== "string" || !args.window_query.trim()) {
      return {
        ok: false,
        error: invalidArguments("window_query is required when target is window."),
      };
    }
    const match = selectWindowSource(sources, args.window_query);
    selected = match?.source ?? null;
    sourceName = match?.name ?? "Matched window";
    await logScreenshotEvent(options, "screenshot.capture.window_match", {
      query: args.window_query,
      selected: match ? { id: match.source.id, name: match.name, score: match.score } : null,
      candidates: getWindowCandidates(sources)
        .slice(0, 12)
        .map((source) => ({
          id: source.id,
          name: sanitizeSourceName(source.name),
        })),
    });
  } else {
    selected = selectPrimaryScreenSource(sources, options);
  }

  if (!selected) {
    await logScreenshotEvent(options, "screenshot.capture.no_source", {
      target,
      sourceId: args.source_id,
      windowQuery: args.window_query,
    });
    return {
      ok: false,
      error: {
        status: "not_found",
        message: "No matching screenshot source was found.",
      },
    };
  }

  await logScreenshotEvent(options, "screenshot.capture.selected", {
    id: selected.id,
    name: sanitizeSourceName(sourceName),
    displayId: selected.display_id,
    thumbnailEmpty: selected.thumbnail.isEmpty(),
    thumbnailSize: selected.thumbnail.getSize?.(),
  });

  const resolved = await resolveSourceImage(selected, { ...options, maxSize: thumbnailSize });
  if (!resolved.ok) {
    await logScreenshotEvent(options, "screenshot.capture.empty_image", resolved.details);
    return { ok: false, error: { status: "error", message: resolved.message } };
  }
  if (resolved.via !== "desktopCapturer") {
    await logScreenshotEvent(options, "screenshot.capture.fallback", {
      via: resolved.via,
      displayId: selected.display_id,
    });
  }

  const image = resolved.image;
  const size = image.getSize();
  const imagePng = image.toPNG();
  const realtimeImage = createRealtimeImage(image);
  const screenshotsDir = path.join(getUserDataPath(options), "screenshots");
  await fs.mkdir(screenshotsDir, { recursive: true });
  const filePath = path.join(
    screenshotsDir,
    `screenshot-${new Date(options.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.png`,
  );
  await fs.writeFile(filePath, imagePng, { flag: "wx" });
  await logScreenshotEvent(options, "screenshot.capture.written", {
    path: filePath,
    dimensions: size,
    bytes: imagePng.length,
  });
  try {
    const retention = await pruneSavedScreenshots(screenshotsDir, {
      protectedName: path.basename(filePath),
    });
    await logScreenshotEvent(options, "screenshot.capture.pruned", retention);
  } catch (error) {
    await logScreenshotEvent(options, "screenshot.capture.prune_failed", {
      error: formatError(error),
    });
  }

  return {
    ok: true,
    path: filePath,
    imagePng,
    realtimeImage,
    dimensions: size,
    source: {
      name: sanitizeSourceName(sourceName),
      type: selected.id.startsWith("screen:") ? "screen" : "window",
    },
  };
}

function createRealtimeScreenshotInput(capture, args) {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: buildVisionPrompt(args),
      },
      {
        type: "input_image",
        image_url: `data:image/jpeg;base64,${capture.realtimeImage.jpegBase64}`,
      },
    ],
  };
}

function createRealtimeImage(image) {
  const size = image.getSize();
  const scale = size.width > realtimeImageMaxWidth ? realtimeImageMaxWidth / size.width : 1;
  const resized =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: "best",
        })
      : image;
  const resizedSize = resized.getSize();
  const jpeg = resized.toJPEG(78);
  return {
    mimeType: "image/jpeg",
    width: resizedSize.width,
    height: resizedSize.height,
    bytes: jpeg.length,
    jpegBase64: jpeg.toString("base64"),
  };
}

async function getCapturerSources({ withThumbnails }, options) {
  const capturer = options.desktopCapturer ?? getElectronModule()?.desktopCapturer;
  if (!capturer?.getSources) {
    throw new Error("Electron desktopCapturer is unavailable.");
  }
  const startedAt = Date.now();
  await logScreenshotEvent(options, "screenshot.desktopCapturer.getSources.start", {
    withThumbnails,
  });
  let sources;
  try {
    sources = await capturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: withThumbnails ? thumbnailSize : { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  } catch (error) {
    await logScreenshotEvent(options, "screenshot.desktopCapturer.getSources.error", {
      withThumbnails,
      elapsedMs: Date.now() - startedAt,
      error: formatError(error),
    });
    throw error;
  }
  await logScreenshotEvent(options, "screenshot.desktopCapturer.getSources.finish", {
    withThumbnails,
    elapsedMs: Date.now() - startedAt,
    ...summarizeSources(sources),
  });
  return sources;
}

function createSourceListResult(sources, screenAccess) {
  const aliases = new Map();
  const sanitizedSources = [];
  let nextAlias = 1;

  for (const source of sources) {
    const type = source.id.startsWith("screen:") ? "screen" : "window";
    const name = sanitizeSourceName(source.name);
    if (!name || isNoiseSource(name)) {
      continue;
    }
    const alias = `source-${nextAlias}`;
    nextAlias += 1;
    aliases.set(alias, {
      rawId: source.id,
      name,
      type,
    });
    sanitizedSources.push({ id: alias, name, type });
    if (sanitizedSources.length >= maxSources) {
      break;
    }
  }

  sourceAliasState.expiresAt = Date.now() + sourceAliasTtlMs;
  sourceAliasState.aliases = aliases;

  return {
    status: "listed",
    message:
      sanitizedSources.length > 0
        ? "Use one of these session-local source ids with take_screenshot."
        : screenAccess === "granted"
          ? "No screenshot sources were available."
          : "No screenshot sources were available. macOS Screen Recording permission may be required.",
    sources: sanitizedSources,
    expiresInSeconds: Math.round(sourceAliasTtlMs / 1000),
  };
}

function selectPrimaryScreenSource(sources, options) {
  const electronScreen = options.screen ?? getElectronModule()?.screen;
  const primaryDisplayId = String(electronScreen?.getPrimaryDisplay?.().id ?? "");
  return (
    sources.find(
      (source) => source.id.startsWith("screen:") && source.display_id === primaryDisplayId,
    ) ??
    sources.find((source) => source.id.startsWith("screen:")) ??
    null
  );
}

function selectWindowSource(sources, query) {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(normalizedQuery);
  const candidates = getWindowCandidates(sources)
    .map((source) => {
      const name = sanitizeSourceName(source.name);
      return { source, name, score: scoreWindowMatch(name, normalizedQuery, queryTokens) };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return candidates[0] ?? null;
}

function getWindowCandidates(sources) {
  return sources.filter(
    (source) => !source.id.startsWith("screen:") && !isNoiseSource(source.name),
  );
}

function scoreWindowMatch(name, normalizedQuery, queryTokens) {
  const normalizedName = normalizeSearchText(name);
  if (!normalizedName || !normalizedQuery) {
    return 0;
  }

  let score = 0;
  if (normalizedName === normalizedQuery) {
    score += 100;
  }
  if (normalizedName.includes(normalizedQuery)) {
    score += 60;
  }

  for (const alias of expandWindowQueryAliases(normalizedQuery)) {
    if (normalizedName.includes(alias)) {
      score += 45;
    }
  }

  const nameTokens = new Set(tokenizeSearchText(normalizedName));
  for (const token of queryTokens) {
    if (nameTokens.has(token)) {
      score += token.length > 3 ? 12 : 5;
    }
  }

  return score;
}

function expandWindowQueryAliases(normalizedQuery) {
  const aliases = [];
  if (/\b(browser|web|chrome|chromium)\b/.test(normalizedQuery)) {
    aliases.push(
      "chrome",
      "chromium",
      "brave",
      "safari",
      "firefox",
      "edge",
      "arc",
      "youtube",
      "google search",
    );
  }
  if (/\b(tab|youtube)\b/.test(normalizedQuery)) {
    aliases.push("youtube");
  }
  if (/\b(coder|gg)\b/.test(normalizedQuery)) {
    aliases.push("gg coder");
  }
  return aliases;
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter(
      (token) => token.length > 1 && !["the", "my", "a", "an", "window", "tab"].includes(token),
    );
}

function isValidScreenshotTarget(target) {
  return target === "primary_screen" || target === "source" || target === "window";
}

function getRawSourceId(alias) {
  if (sourceAliasState.expiresAt < Date.now()) {
    sourceAliasState.aliases = new Map();
    return null;
  }
  return sourceAliasState.aliases.get(alias)?.rawId ?? null;
}

function getAliasName(alias) {
  if (sourceAliasState.expiresAt < Date.now()) {
    return null;
  }
  return sourceAliasState.aliases.get(alias)?.name ?? null;
}

function sanitizeSourceName(name) {
  return String(name ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function isNoiseSource(name) {
  const normalized = name.toLowerCase();
  if (normalized === "brah" || normalized.includes("brah")) {
    return true;
  }
  return ["", "window server", "desktop", "dock", "menubar", "menu bar"].includes(normalized);
}

function getUserDataPath(options) {
  if (typeof options.userDataPath === "string" && options.userDataPath) {
    return options.userDataPath;
  }
  const electronApp = getElectronModule()?.app;
  if (electronApp?.getPath) {
    return electronApp.getPath("userData");
  }
  return path.join(os.tmpdir(), "brah-user-data");
}

function getElectronModule() {
  if (!globalThis.process?.type) {
    return null;
  }
  try {
    return globalThis.require?.("electron") ?? null;
  } catch {
    return null;
  }
}

function buildVisionPrompt(args) {
  const userQuestion = typeof args.question === "string" ? args.question.trim().slice(0, 500) : "";
  return userQuestion ? `${visionPrompt}\n\nUser question: ${userQuestion}` : visionPrompt;
}

async function logScreenshotEvent(options, event, details = {}) {
  if (typeof options.logger !== "function") {
    return;
  }
  try {
    await options.logger(event, details);
  } catch {
    // Diagnostics must never break tool execution.
  }
}

function summarizeSources(sources) {
  return {
    count: Array.isArray(sources) ? sources.length : 0,
    sources: Array.isArray(sources)
      ? sources.slice(0, 25).map((source) => ({
          id: source.id,
          name: sanitizeSourceName(source.name),
          displayId: source.display_id,
          type: source.id?.startsWith("screen:") ? "screen" : "window",
          thumbnailEmpty: source.thumbnail?.isEmpty?.(),
          thumbnailSize: source.thumbnail?.getSize?.(),
        }))
      : [],
  };
}

function sanitizeArgs(args) {
  if (!isRecord(args)) {
    return args;
  }
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, 500) : value,
    ]),
  );
}

function formatError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

function screenshotErrorResult(error, options = {}) {
  const message = error instanceof Error ? error.message : "Screenshot operation failed.";
  return {
    status: "error",
    message: describeCaptureFailure(message, getScreenAccessStatus(options)),
  };
}

function invalidArguments(message) {
  return {
    status: "invalid_arguments",
    message,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
