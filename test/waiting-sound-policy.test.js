import assert from "node:assert/strict";
import test from "node:test";
import { createWaitingSoundPolicy } from "../src/renderer/waiting-sound-policy.js";

const toolCallDone = {
  type: "response.done",
  response: { output: [{ type: "message" }, { type: "function_call" }] },
};
const replyDone = { type: "response.done", response: { output: [{ type: "message" }] } };

test("a tool called in silence starts the sound; the spoken reply stops it", () => {
  const policy = createWaitingSoundPolicy();

  assert.equal(policy.toolStarted({ isAudioPlaying: false }), "start");
  assert.equal(policy.observe(toolCallDone), null);
  assert.equal(policy.toolEnded(), null);
  assert.equal(policy.observe({ type: "response.created" }), null);
  assert.equal(policy.observe({ type: "output_audio_buffer.started" }), "stop");
});

test("a tool called mid-sentence waits for silence, and the reply stops it", () => {
  // Real order from an open_app call: the agent says "Opening Brave" and calls
  // the tool in one response, and the reply runs on in the same audio buffer.
  const policy = createWaitingSoundPolicy();

  assert.equal(policy.toolStarted({ isAudioPlaying: true }), null);
  assert.equal(policy.observe(toolCallDone), null);
  assert.equal(policy.toolEnded(), null);
  assert.equal(policy.observe({ type: "response.created" }), null);
  assert.equal(policy.observe({ type: "response.content_part.added" }), "stop");
  assert.equal(policy.observe({ type: "output_audio_buffer.stopped" }), null);
});

test("silence after the pre-tool sentence starts the sound while the tool still runs", () => {
  const policy = createWaitingSoundPolicy();

  assert.equal(policy.toolStarted({ isAudioPlaying: true }), null);
  assert.equal(policy.observe({ type: "output_audio_buffer.stopped" }), "start");
  assert.equal(policy.toolEnded(), null);
  assert.equal(policy.observe({ type: "response.content_part.added" }), "stop");
});

test("the agent talking during a long tool pauses the sound until it goes quiet", () => {
  const policy = createWaitingSoundPolicy();

  assert.equal(policy.toolStarted({ isAudioPlaying: false }), "start");
  assert.equal(policy.observe({ type: "output_audio_buffer.started" }), "stop");
  assert.equal(policy.observe({ type: "output_audio_buffer.stopped" }), "start");
  policy.toolEnded();
  assert.equal(policy.observe({ type: "output_audio_buffer.started" }), "stop");
});

test("a reply that finishes without any audio still stops the sound", () => {
  const policy = createWaitingSoundPolicy();

  policy.toolStarted({ isAudioPlaying: false });
  policy.toolEnded();
  assert.equal(policy.observe(replyDone), "stop");
});

test("the tool call's own response.done does not stop the sound", () => {
  const policy = createWaitingSoundPolicy();

  policy.toolStarted({ isAudioPlaying: false });
  policy.toolEnded();
  assert.equal(policy.observe(toolCallDone), null);
});

test("no reply is awaited while a tool is still running", () => {
  const policy = createWaitingSoundPolicy();

  policy.toolStarted({ isAudioPlaying: false });
  assert.equal(policy.observe(replyDone), null);
});

test("the user talking stops the sound and ends the wait", () => {
  const policy = createWaitingSoundPolicy();

  policy.toolStarted({ isAudioPlaying: false });
  assert.equal(policy.observe({ type: "input_audio_buffer.speech_started" }), "stop");
  assert.equal(policy.observe({ type: "output_audio_buffer.stopped" }), null);
});

test("without a tool call, speech events never touch the sound", () => {
  const policy = createWaitingSoundPolicy();

  assert.equal(policy.observe({ type: "response.content_part.added" }), null);
  assert.equal(policy.observe({ type: "output_audio_buffer.stopped" }), null);
  assert.equal(policy.observe(replyDone), null);
});

test("reset forgets any wait in progress", () => {
  const policy = createWaitingSoundPolicy();

  policy.toolStarted({ isAudioPlaying: true });
  policy.reset();
  assert.equal(policy.observe({ type: "output_audio_buffer.stopped" }), null);
});
