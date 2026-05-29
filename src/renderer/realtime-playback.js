// Pure state machine for assistant audio playback + barge-in decisions.
// Kept DOM-free so it can be unit tested independently of the renderer.

export function createRealtimePlaybackTracker() {
  let hasActiveResponse = false;
  let isAudioPlaying = false;

  return {
    // Update playback state from a Realtime server event.
    observe(event) {
      switch (event?.type) {
        case "response.created":
          hasActiveResponse = true;
          break;
        case "output_audio_buffer.started":
        case "response.output_audio.delta":
          isAudioPlaying = true;
          break;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          isAudioPlaying = false;
          break;
        case "response.done":
          hasActiveResponse = false;
          isAudioPlaying = false;
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
      }
      return events;
    },

    reset() {
      hasActiveResponse = false;
      isAudioPlaying = false;
    },

    get state() {
      return { hasActiveResponse, isAudioPlaying };
    },
  };
}

// A benign "no active response to cancel" can occur when our manual barge-in
// races the server VAD's own interrupt; callers should not surface it.
export function isBenignCancelError(error) {
  const haystack = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return haystack.includes("cancel") && haystack.includes("active response");
}
