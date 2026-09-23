import assert from "node:assert/strict";
import test from "node:test";
import { acquireCallResources } from "../src/renderer/realtime-call-resources.js";

test("releases microphone when secret request fails after microphone acquisition", async () => {
  let rejectSecret;
  let stops = 0;
  const secret = new Promise((_resolve, reject) => {
    rejectSecret = reject;
  });
  const stream = { getTracks: () => [{ stop: () => stops++ }] };
  const result = acquireCallResources(
    () => secret,
    async () => stream,
  );
  rejectSecret(new Error("secret unavailable"));
  await assert.rejects(result, /secret unavailable/);
  assert.equal(stops, 1);
});

test("waits for late microphone acquisition before releasing it", async () => {
  let releaseMicrophone;
  let stops = 0;
  const microphone = new Promise((resolve) => {
    releaseMicrophone = resolve;
  });
  const result = acquireCallResources(
    async () => {
      throw new Error("secret unavailable");
    },
    () => microphone,
  );
  releaseMicrophone({ getTracks: () => [{ stop: () => stops++ }] });
  await assert.rejects(result, /secret unavailable/);
  assert.equal(stops, 1);
});

test("secret failure does not wait for microphone permission, but closes a late stream", async () => {
  let releaseMicrophone;
  let stops = 0;
  const microphone = new Promise((resolve) => {
    releaseMicrophone = resolve;
  });
  const result = acquireCallResources(
    async () => {
      throw new Error("secret unavailable");
    },
    () => microphone,
  );
  await assert.rejects(result, /secret unavailable/);
  releaseMicrophone({ getTracks: () => [{ stop: () => stops++ }] });
  await microphone.then(() => new Promise((resolve) => queueMicrotask(resolve)));
  assert.equal(stops, 1);
});

test("returns both resources when setup succeeds", async () => {
  const stream = { getTracks: () => [] };
  assert.deepEqual(
    await acquireCallResources(
      async () => ({ value: "secret" }),
      async () => stream,
    ),
    { secret: { value: "secret" }, stream },
  );
});
