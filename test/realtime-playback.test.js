import assert from "node:assert/strict";
import test from "node:test";
import {
  createRealtimePlaybackTracker,
  isBenignCancelError,
} from "../src/renderer/realtime-playback.js";

test("interrupt is a no-op before the assistant responds", () => {
  const tracker = createRealtimePlaybackTracker();
  assert.deepEqual(tracker.interrupt(), []);
});

test("barge-in cancels the response then clears buffered audio in order", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.created" });
  tracker.observe({ type: "response.output_audio.delta" });

  assert.deepEqual(tracker.interrupt(), [
    { type: "response.cancel" },
    { type: "output_audio_buffer.clear" },
  ]);
});

test("interrupt does not repeat once consumed", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.created" });
  tracker.observe({ type: "output_audio_buffer.started" });

  assert.equal(tracker.interrupt().length, 2);
  assert.deepEqual(tracker.interrupt(), []);
  assert.deepEqual(tracker.state, { hasActiveResponse: false, isAudioPlaying: false });
});

test("only the audio buffer is cleared when no response is active", () => {
  const tracker = createRealtimePlaybackTracker();
  // Server-side VAD already ended the response, but audio is still buffered.
  tracker.observe({ type: "output_audio_buffer.started" });

  assert.deepEqual(tracker.interrupt(), [{ type: "output_audio_buffer.clear" }]);
});

test("response.done resets playback state so later interrupts are no-ops", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.created" });
  tracker.observe({ type: "response.output_audio.delta" });
  tracker.observe({ type: "response.done" });

  assert.deepEqual(tracker.state, { hasActiveResponse: false, isAudioPlaying: false });
  assert.deepEqual(tracker.interrupt(), []);
});

test("server clear and stop events end audio playback", () => {
  for (const type of ["output_audio_buffer.cleared", "output_audio_buffer.stopped"]) {
    const tracker = createRealtimePlaybackTracker();
    tracker.observe({ type: "output_audio_buffer.started" });
    tracker.observe({ type });
    assert.equal(tracker.state.isAudioPlaying, false, `${type} should stop playback`);
  }
});

test("reset clears all playback state", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.created" });
  tracker.observe({ type: "output_audio_buffer.started" });
  tracker.reset();
  assert.deepEqual(tracker.state, { hasActiveResponse: false, isAudioPlaying: false });
});

test("unknown events leave state untouched", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.output_text.delta" });
  tracker.observe(undefined);
  assert.deepEqual(tracker.state, { hasActiveResponse: false, isAudioPlaying: false });
});

test("isBenignCancelError matches the racing-cancel case only", () => {
  assert.equal(
    isBenignCancelError({
      code: "response_cancel_not_active",
      message: "Cancellation failed: no active response.",
    }),
    true,
  );
  assert.equal(isBenignCancelError({ message: "There is no active response to cancel." }), true);
  assert.equal(isBenignCancelError({ code: "rate_limit_exceeded", message: "Slow down." }), false);
  assert.equal(isBenignCancelError(undefined), false);
});
