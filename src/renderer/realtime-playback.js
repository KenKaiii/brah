// Pure state machine for assistant audio playback + barge-in decisions.
// Kept DOM-free so it can be unit tested independently of the renderer.

export function createRealtimePlaybackTracker() {
  let hasActiveResponse = false;
  let isAudioPlaying = false;
  let audioOutputEnded = false;

  return {
    // Update playback state from a Realtime server event.
    observe(event) {
      switch (event?.type) {
        case "response.created":
          hasActiveResponse = true;
          audioOutputEnded = false;
          break;
        case "output_audio_buffer.started":
        case "response.output_audio.delta":
          isAudioPlaying = true;
          audioOutputEnded = false;
          break;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          isAudioPlaying = false;
          audioOutputEnded = true;
          break;
        case "response.done":
          // Generation can finish while WebRTC still plays buffered audio.
          // Only the output buffer stop/clear event ends playback.
          hasActiveResponse = false;
          // Generation may finish before the first playback-start event. The
          // finalized response tells us whether audio is still due to play.
          if (!audioOutputEnded && responseContainsAudio(event.response)) isAudioPlaying = true;
          break;
        default:
          break;
      }
    },

    // Returns the client events needed to cut off the assistant immediately,
    // in the order the OpenAI Realtime WebRTC contract requires (cancel the
    // response first, then clear already-buffered output audio). Returns an
    // empty array when there is nothing to interrupt, so callers never emit a
    // spurious "no active response to cancel".
    interrupt() {
      const events = [];
      if (hasActiveResponse) {
        events.push({ type: "response.cancel" });
        hasActiveResponse = false;
      }
      if (isAudioPlaying) {
        events.push({ type: "output_audio_buffer.clear" });
        isAudioPlaying = false;
        audioOutputEnded = true;
      }
      return events;
    },

    reset() {
      hasActiveResponse = false;
      isAudioPlaying = false;
      audioOutputEnded = false;
    },

    get state() {
      return { hasActiveResponse, isAudioPlaying };
    },
  };
}

function responseContainsAudio(response) {
  return (
    Array.isArray(response?.output) &&
    response.output.some(
      (item) =>
        Array.isArray(item?.content) &&
        item.content.some((part) => part?.type === "audio" || part?.type === "output_audio"),
    )
  );
}

export function canFinishHangup(eventType, playbackState) {
  return (
    [
      "end_call",
      "response.done",
      "output_audio_buffer.stopped",
      "output_audio_buffer.cleared",
    ].includes(eventType) &&
    !playbackState.hasActiveResponse &&
    !playbackState.isAudioPlaying
  );
}

export function createHangupCompletion(getPlaybackState, onFinish, options = {}) {
  const { settleMs = 500, schedule = setTimeout, cancel = clearTimeout } = options;
  let timer = null;
  const stop = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  return {
    observe(eventType) {
      if (
        ["response.created", "output_audio_buffer.started", "response.output_audio.delta"].includes(
          eventType,
        )
      ) {
        stop();
        return;
      }
      if (!canFinishHangup(eventType, getPlaybackState())) return;
      stop();
      if (
        eventType === "output_audio_buffer.stopped" ||
        eventType === "output_audio_buffer.cleared"
      ) {
        onFinish();
        return;
      }
      // An audio start can trail response.done. Wait briefly before deciding a
      // response is silent; the hard fallback in the renderer bounds the rest.
      timer = schedule(() => {
        timer = null;
        if (canFinishHangup("response.done", getPlaybackState())) onFinish();
      }, settleMs);
    },
    stop,
  };
}

// A benign "no active response to cancel" can occur when our manual barge-in
// races the server VAD's own interrupt; callers should not surface it.
export function isBenignCancelError(error) {
  const haystack = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return haystack.includes("cancel") && haystack.includes("active response");
}
