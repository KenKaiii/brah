import assert from "node:assert/strict";
import test from "node:test";
import { createRealtimeConnectionGuard } from "../src/renderer/realtime-connection-guard.js";

function createHarness() {
  const timers = new Map();
  let nextId = 0;
  let failures = 0;
  const guard = createRealtimeConnectionGuard(() => failures++, {
    schedule: (callback, delay) => {
      assert.equal(delay, 8_000);
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  return {
    guard,
    timers,
    get failures() {
      return failures;
    },
  };
}

test("a transient disconnect recovers without ending the call", () => {
  const harness = createHarness();
  harness.guard.observe("disconnected");
  harness.guard.observe("disconnected");
  assert.equal(harness.timers.size, 1);
  harness.guard.observe("connected");
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.failures, 0);
});

test("a lasting disconnect ends the call once", () => {
  const harness = createHarness();
  harness.guard.observe("disconnected");
  const [expire] = harness.timers.values();
  expire();
  assert.equal(harness.failures, 1);
  harness.guard.stop();
});

test("failed and closed states end immediately; stopping cancels a pending timeout", () => {
  const harness = createHarness();
  harness.guard.observe("disconnected");
  harness.guard.stop();
  assert.equal(harness.timers.size, 0);
  harness.guard.observe("failed");
  assert.equal(harness.failures, 1);
  const closed = createHarness();
  closed.guard.observe("closed");
  assert.equal(closed.failures, 1);
});
