import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Electron's desktopCapturer can hand back a 0x0 thumbnail for one specific
// external display on macOS even though Screen Recording is granted (seen with a
// DELL S3221QS on a 3-display setup), while the system `screencapture` tool
// captures the same display fine. This module recovers that case and, when it
// cannot, reports an accurate reason instead of always blaming permissions.

const SCREENCAPTURE_PATH = "/usr/sbin/screencapture";
const SCREENCAPTURE_TIMEOUT_MS = 15_000;
// Backing-pixel sizes can differ from size * scaleFactor by rounding.
const SIZE_TOLERANCE_PX = 4;

export const PERMISSION_HINT =
  "On macOS, grant Screen Recording permission to Brah/Electron and try again.";

/**
 * Resolve a usable image for a selected desktopCapturer source. Returns the
 * Electron thumbnail when it has pixels; otherwise tries the macOS
 * `screencapture` fallback for screen sources.
 *
 * @param {object} source desktopCapturer source ({ id, display_id, thumbnail }).
 * @param {object} options Injected Electron modules and helpers.
 * @returns {Promise<{ ok: true, image: object, via: string } | { ok: false, message: string, details: object }>}
 */
export async function resolveSourceImage(source, options = {}) {
  if (!source.thumbnail.isEmpty()) {
    return { ok: true, image: source.thumbnail, via: "desktopCapturer" };
  }

  const platform = options.platform ?? process.platform;
  const isScreen = typeof source.id === "string" && source.id.startsWith("screen:");
  const screenAccess = getScreenAccessStatus(options);
  if (platform !== "darwin" || !isScreen) {
    return emptyImageFailure(screenAccess, {
      reason: isScreen ? "unsupported_platform" : "window",
    });
  }

  const fallback = await captureDisplayWithScreencapture(source.display_id, options);
  if (fallback.ok) {
    return { ok: true, image: fallback.image, via: "screencapture" };
  }
  return emptyImageFailure(screenAccess, fallback.details);
}

/**
 * Capture one display with macOS `screencapture -D <n>`. The display number is
 * the 1-based position of the Electron display in screen.getAllDisplays(); the
 * captured size is checked against that display so a different ordering can
 * never silently return the wrong monitor.
 */
export async function captureDisplayWithScreencapture(displayId, options = {}) {
  const displays = options.screen?.getAllDisplays?.() ?? [];
  const index = displays.findIndex((display) => String(display.id) === String(displayId));
  if (index < 0) {
    return { ok: false, details: { reason: "display_not_found", displayId } };
  }
  const nativeImage = options.nativeImage;
  if (!nativeImage?.createFromBuffer) {
    return { ok: false, details: { reason: "native_image_unavailable" } };
  }

  const run = options.runScreencapture ?? runScreencapture;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "brah-screencapture-"));
  const filePath = path.join(tempDir, "capture.png");
  const displayNumber = index + 1;
  const startedAt = Date.now();
  try {
    await run(["-x", "-D", String(displayNumber), "-t", "png", filePath]);
    const png = await fs.readFile(filePath);
    const image = nativeImage.createFromBuffer(png);
    const elapsedMs = Date.now() - startedAt;
    if (!image || image.isEmpty()) {
      return { ok: false, details: { reason: "screencapture_empty", displayNumber, elapsedMs } };
    }
    const actual = image.getSize();
    const expected = expectedPixelSize(displays[index]);
    if (!sizesMatch(actual, expected)) {
      return {
        ok: false,
        details: { reason: "display_mismatch", displayNumber, actual, expected, elapsedMs },
      };
    }
    return {
      ok: true,
      image: fitWithin(image, options.maxSize),
      details: { displayNumber, elapsedMs },
    };
  } catch (error) {
    return {
      ok: false,
      details: {
        reason: "screencapture_failed",
        displayNumber,
        elapsedMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** Current macOS Screen Recording status, or "unknown" when it cannot be read. */
export function getScreenAccessStatus(options = {}) {
  try {
    return options.systemPreferences?.getMediaAccessStatus?.("screen") ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Error text for a failed capture: only mentions permissions when they are missing. */
export function describeCaptureFailure(baseMessage, screenAccess) {
  if (screenAccess === "granted") {
    return `${baseMessage} Screen Recording permission is already granted, so this is a display capture problem, not a permission one. Try another display or window.`;
  }
  return `${baseMessage} ${PERMISSION_HINT}`;
}

function emptyImageFailure(screenAccess, details) {
  return {
    ok: false,
    message: describeCaptureFailure("Screenshot capture returned an empty image.", screenAccess),
    details: { ...details, screenAccess },
  };
}

function expectedPixelSize(display) {
  const scale = Number(display.scaleFactor) || 1;
  return {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };
}

function sizesMatch(actual, expected) {
  return (
    Math.abs(actual.width - expected.width) <= SIZE_TOLERANCE_PX &&
    Math.abs(actual.height - expected.height) <= SIZE_TOLERANCE_PX
  );
}

// Match desktopCapturer's thumbnail behaviour: fit inside maxSize, keep aspect.
function fitWithin(image, maxSize) {
  if (!maxSize?.width || !maxSize?.height) {
    return image;
  }
  const size = image.getSize();
  const scale = Math.min(maxSize.width / size.width, maxSize.height / size.height, 1);
  if (scale >= 1) {
    return image;
  }
  return image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "best",
  });
}

function runScreencapture(args) {
  return new Promise((resolve, reject) => {
    execFile(SCREENCAPTURE_PATH, args, { timeout: SCREENCAPTURE_TIMEOUT_MS }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
