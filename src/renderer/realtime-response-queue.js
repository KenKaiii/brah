// Pure coordinator for `response.create` sends on the Realtime data channel.
//
// The OpenAI Realtime API allows only one in-progress response per conversation;
// sending `response.create` while another response is active fails with
// `conversation_already_has_active_response`. Semantic VAD can also auto-create
// a response the instant the user speaks, which races our own tool-output and
// welcome creates. This tracks whether a response is active and queues pending
// creates in order, flushing one each time the active response ends.
//
// Kept DOM-free so it can be unit tested independently of the renderer.

export function createRealtimeResponseCoordinator() {
  let activeResponse = false;
  const pendingCreates = [];
  let lastSentCreate = null;
  let endingCall = false;

  return {
    // Decide whether a `response.create` event can be sent now. Returns the
    // event to send, or null when queued or suppressed during hang-up.
    requestCreate(event) {
      if (endingCall) return null;
      if (activeResponse) {
        pendingCreates.push(event);
        return null;
      }
      activeResponse = true;
      lastSentCreate = event;
      return event;
    },

    // Observe a Realtime server event. Returns a queued `response.create` to
    // flush now (because the active response just ended), or null.
    observe(event) {
      switch (event?.type) {
        case "response.created":
          activeResponse = true;
          return null;
        case "response.done": {
          activeResponse = false;
          return pendingCreates.shift() ?? null;
        }
        default:
          return null;
      }
    },

    // Recover from a `conversation_already_has_active_response` error: a create
    // we sent was rejected, so mark a response active and re-queue that create
    // to retry once the active response ends.
    noteActiveResponseConflict() {
      activeResponse = true;
      if (lastSentCreate && pendingCreates[0] !== lastSentCreate) {
        pendingCreates.unshift(lastSentCreate);
      }
    },

    beginHangup() {
      endingCall = true;
      pendingCreates.length = 0;
      lastSentCreate = null;
    },

    reset() {
      activeResponse = false;
      pendingCreates.length = 0;
      lastSentCreate = null;
      endingCall = false;
    },

    get state() {
      return { activeResponse, hasPending: pendingCreates.length > 0 };
    },
  };
}

// True when an error means a response is already in progress, which is a
// recoverable race rather than a fatal session error.
export function isActiveResponseConflictError(error) {
  const code = error?.code ?? "";
  const message = (error?.message ?? "").toLowerCase();
  return (
    code === "conversation_already_has_active_response" ||
    /already has an? active response/.test(message)
  );
}
