// A brief ICE disconnect can recover without renegotiation. Keep the call
// alive for a bounded grace period, but release it if recovery never arrives.
export function createRealtimeConnectionGuard(onFailure, options = {}) {
  const { graceMs = 8_000, schedule = setTimeout, cancel = clearTimeout } = options;
  let timer = null;

  return {
    observe(state) {
      if (state === "disconnected") {
        if (timer === null) {
          timer = schedule(() => {
            timer = null;
            onFailure();
          }, graceMs);
        }
        return;
      }
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (state === "closed" || state === "failed") onFailure();
    },
    stop() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
  };
}
