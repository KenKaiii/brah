// Decides when the waiting ambience should start and stop around tool calls.
// DOM-free so it can be unit tested; the renderer feeds it tool lifecycle and
// Realtime server events and applies the returned "start" / "stop" / null.
//
// The wait runs from a tool starting until the agent's reply begins. Two things
// make "reply began" harder than one event:
// - The agent often speaks a sentence ("Opening Brave") in the same response as
//   the tool call. Starting the sound then would play it over speech, so the
//   start is deferred until that audio actually stops.
// - When the reply is generated while that sentence is still playing, WebRTC
//   plays it straight on in the same buffer: there is no second
//   output_audio_buffer.started. The reply's first content part is the signal.

const REPLY_CONTENT_EVENTS = new Set([
  "response.content_part.added",
  "response.output_audio.delta",
  "response.output_audio_transcript.delta",
  "output_audio_buffer.started",
]);

export function createWaitingSoundPolicy() {
  let awaitingReply = false;
  let activeTools = 0;

  function endWait() {
    if (!awaitingReply) return null;
    awaitingReply = false;
    return "stop";
  }

  return {
    // A silence-filling tool began. Start now unless the agent is still talking.
    toolStarted({ isAudioPlaying }) {
      activeTools++;
      awaitingReply = true;
      return isAudioPlaying ? null : "start";
    },

    // The tool finished; the wait continues until the reply arrives.
    toolEnded() {
      activeTools = Math.max(0, activeTools - 1);
      return null;
    },

    observe(event) {
      const type = event?.type;
      if (type === "input_audio_buffer.speech_started") return endWait();
      if (!awaitingReply) return null;
      if (type === "output_audio_buffer.stopped") return "start";
      if (activeTools > 0) {
        // The agent talking while a tool still runs pauses the sound; it resumes
        // on the next output_audio_buffer.stopped if the wait is not over.
        return type === "output_audio_buffer.started" ? "stop" : null;
      }
      if (REPLY_CONTENT_EVENTS.has(type)) return endWait();
      // A reply with no audio at all still ends the wait. The tool call's own
      // response.done (which carries the function_call) does not.
      if (type === "response.done" && !containsFunctionCall(event.response)) return endWait();
      return null;
    },

    reset() {
      awaitingReply = false;
      activeTools = 0;
    },
  };
}

function containsFunctionCall(response) {
  return (
    Array.isArray(response?.output) &&
    response.output.some((item) => item?.type === "function_call")
  );
}
