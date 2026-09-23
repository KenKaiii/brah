import assert from "node:assert/strict";
import test from "node:test";
import {
  canFinishHangup,
  createHangupCompletion,
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

test("response.done leaves buffered audio interruptible until playback stops", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.created" });
  tracker.observe({ type: "output_audio_buffer.started" });
  tracker.observe({ type: "response.done" });

  assert.deepEqual(tracker.state, { hasActiveResponse: false, isAudioPlaying: true });
  assert.deepEqual(tracker.interrupt(), [{ type: "output_audio_buffer.clear" }]);
  tracker.observe({ type: "output_audio_buffer.stopped" });
  assert.deepEqual(tracker.interrupt(), []);
});

test("hang-up waits for buffered goodbye audio but not for an already-finished response", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.created" });
  tracker.observe({ type: "output_audio_buffer.started" });
  assert.equal(canFinishHangup("end_call", tracker.state), false);
  tracker.observe({ type: "response.done" });
  assert.equal(canFinishHangup("response.done", tracker.state), false);
  tracker.observe({ type: "output_audio_buffer.stopped" });
  assert.equal(canFinishHangup("output_audio_buffer.stopped", tracker.state), true);
  assert.equal(canFinishHangup("end_call", tracker.state), true);
});

test("response.done with generated audio waits for playback even before started", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.created" });
  tracker.observe({
    type: "response.done",
    response: { output: [{ type: "message", content: [{ type: "audio" }] }] },
  });
  assert.equal(tracker.state.isAudioPlaying, true);
  assert.equal(canFinishHangup("end_call", tracker.state), false);
  tracker.observe({ type: "output_audio_buffer.started" });
  tracker.observe({ type: "output_audio_buffer.stopped" });
  assert.equal(canFinishHangup("output_audio_buffer.stopped", tracker.state), true);
});

test("a playback gap never ends an active response", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.created" });
  tracker.observe({ type: "output_audio_buffer.started" });
  tracker.observe({ type: "output_audio_buffer.stopped" });
  assert.equal(canFinishHangup("output_audio_buffer.stopped", tracker.state), false);
  tracker.observe({ type: "response.done" });
  assert.equal(canFinishHangup("response.done", tracker.state), true);
});

test("a cleared buffer can finish hang-up once generation is done", () => {
  const tracker = createRealtimePlaybackTracker();
  tracker.observe({ type: "response.created" });
  tracker.observe({ type: "output_audio_buffer.started" });
  tracker.observe({ type: "output_audio_buffer.cleared" });
  assert.equal(canFinishHangup("output_audio_buffer.cleared", tracker.state), false);
  tracker.observe({ type: "response.done" });
  assert.equal(canFinishHangup("output_audio_buffer.cleared", tracker.state), true);
});

test("hang-up settle window is cancelled when goodbye playback starts late", () => {
  const tracker = createRealtimePlaybackTracker();
  let pending;
  let finished = 0;
  const completion = createHangupCompletion(
    () => tracker.state,
    () => finished++,
    {
      schedule: (callback, ms) => {
        assert.equal(ms, 500);
        pending = callback;
        return 1;
      },
      cancel: () => {
        pending = null;
      },
    },
  );
  completion.observe("end_call");
  assert.equal(finished, 0);
  assert.equal(typeof pending, "function");
  tracker.observe({ type: "output_audio_buffer.started" });
  completion.observe("output_audio_buffer.started");
  assert.equal(pending, null);
  tracker.observe({ type: "output_audio_buffer.stopped" });
  completion.observe("output_audio_buffer.stopped");
  assert.equal(finished, 1);
});

test("a silent goodbye ends after the short settle window", () => {
  const tracker = createRealtimePlaybackTracker();
  let pending;
  let finished = 0;
  const completion = createHangupCompletion(
    () => tracker.state,
    () => finished++,
    {
      schedule: (callback) => {
        pending = callback;
        return 1;
      },
      cancel: () => {
        pending = null;
      },
    },
  );
  completion.observe("end_call");
  assert.equal(finished, 0);
  pending();
  assert.equal(finished, 1);
  completion.stop();
});

test("hang-up after interrupted goodbye closes on clear, not on a playback gap", () => {
  const tracker = createRealtimePlaybackTracker();
  let finished = 0;
  const completion = createHangupCompletion(
    () => tracker.state,
    () => finished++,
  );
  tracker.observe({ type: "response.created" });
  tracker.observe({ type: "output_audio_buffer.started" });
  completion.observe("end_call");
  tracker.observe({ type: "output_audio_buffer.stopped" });
  completion.observe("output_audio_buffer.stopped");
  assert.equal(finished, 0);
  tracker.observe({ type: "output_audio_buffer.started" });
  completion.observe("output_audio_buffer.started");
  tracker.observe({ type: "response.done" });
  completion.observe("response.done");
  tracker.observe({ type: "output_audio_buffer.cleared" });
  completion.observe("output_audio_buffer.cleared");
  assert.equal(finished, 1);
  completion.stop();
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
