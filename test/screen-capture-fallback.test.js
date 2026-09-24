import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import {
  captureDisplayWithScreencapture,
  describeCaptureFailure,
  resolveSourceImage,
} from "../src/realtime/tools/screen-capture-fallback.js";

const displays = [
  { id: 1088685634, size: { width: 1512, height: 982 }, scaleFactor: 2 },
  { id: 69734208, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
  { id: 724857621, size: { width: 3840, height: 2160 }, scaleFactor: 1 },
];

function fakeImage(width, height) {
  return {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: ({ width: w, height: h }) => fakeImage(w, h),
  };
}

function fakeNativeImage(width, height) {
  return { createFromBuffer: () => fakeImage(width, height) };
}

function recordingRunner(calls) {
  return async (args) => {
    calls.push(args);
    await fs.writeFile(args.at(-1), Buffer.from("png"));
  };
}

const emptyScreenSource = {
  id: "screen:724857621:0",
  display_id: "724857621",
  thumbnail: fakeImage(0, 0),
};

test("keeps the Electron thumbnail when it has pixels", async () => {
  const thumbnail = fakeImage(1920, 1080);
  const calls = [];
  const result = await resolveSourceImage(
    { id: "screen:1:0", display_id: "1", thumbnail },
    { platform: "darwin", runScreencapture: recordingRunner(calls) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.via, "desktopCapturer");
  assert.equal(result.image, thumbnail);
  assert.equal(calls.length, 0);
});

test("falls back to screencapture with the display's 1-based position", async () => {
  const calls = [];
  const result = await resolveSourceImage(emptyScreenSource, {
    platform: "darwin",
    screen: { getAllDisplays: () => displays },
    nativeImage: fakeNativeImage(3840, 2160),
    runScreencapture: recordingRunner(calls),
    maxSize: { width: 1920, height: 1080 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.via, "screencapture");
  assert.deepEqual(calls[0].slice(0, 5), ["-x", "-D", "3", "-t", "png"]);
  assert.deepEqual(result.image.getSize(), { width: 1920, height: 1080 });
});

test("rejects a fallback capture whose size belongs to another display", async () => {
  const result = await captureDisplayWithScreencapture("724857621", {
    screen: { getAllDisplays: () => displays },
    nativeImage: fakeNativeImage(3024, 1964),
    runScreencapture: recordingRunner([]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.details.reason, "display_mismatch");
});

test("does not blame permissions when Screen Recording is granted", async () => {
  const result = await resolveSourceImage(emptyScreenSource, {
    platform: "darwin",
    screen: { getAllDisplays: () => displays },
    nativeImage: fakeNativeImage(3840, 2160),
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    runScreencapture: async () => {
      throw new Error("screencapture exited 1");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.details.reason, "screencapture_failed");
  assert.match(result.message, /already granted/);
  assert.doesNotMatch(result.message, /grant Screen Recording/);
});

test("still points at permissions when access is not granted", () => {
  assert.match(describeCaptureFailure("Capture failed.", "denied"), /grant Screen Recording/);
});

test("does not run screencapture off macOS or for window sources", async () => {
  const calls = [];
  const options = {
    screen: { getAllDisplays: () => displays },
    nativeImage: fakeNativeImage(3840, 2160),
    runScreencapture: recordingRunner(calls),
  };
  const linux = await resolveSourceImage(emptyScreenSource, { ...options, platform: "linux" });
  const windowSource = await resolveSourceImage(
    { id: "window:42:0", thumbnail: fakeImage(0, 0) },
    { ...options, platform: "darwin" },
  );
  assert.equal(linux.ok, false);
  assert.equal(windowSource.ok, false);
  assert.equal(calls.length, 0);
});
