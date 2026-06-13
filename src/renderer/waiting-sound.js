const SOUND_URL = "./assets/waiting.mp3";
const TARGET_GAIN = 0.45;
const FADE_IN_SECONDS = 0.4;
const FADE_OUT_SECONDS = 0.5;
// Near-instant tools (e.g. add_task) shouldn't blip the sound on/off, so wait a
// beat before starting; if the tool finishes first the start is cancelled.
const START_DELAY_MS = 250;

/**
 * Looping "thinking" ambience that fills the silence while the agent is busy
 * between turns — from when a tool starts until the agent resumes speaking. Its
 * lifetime is intentionally NOT tied to tool execution duration: local tools
 * (memory, tasks) finish in ~20ms but the model still needs ~1s to formulate
 * and speak its reply, and that whole gap is the silence we fill. Uses the Web
 * Audio API with a GainNode for smooth fades; `start()` is debounced so genuinely
 * instant turnarounds never blip the sound on and off.
 */
export function createWaitingSound() {
  let audioContext = null;
  let buffer = null;
  let decodePromise = null;
  let source = null;
  let gainNode = null;
  let wantPlaying = false;
  let startTimer = null;

  function getContext() {
    if (!audioContext) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) {
        return null;
      }
      audioContext = new Ctor();
    }
    return audioContext;
  }

  async function ensureBuffer(context) {
    if (buffer) {
      return buffer;
    }
    if (!decodePromise) {
      decodePromise = (async () => {
        const response = await fetch(SOUND_URL);
        const arrayBuffer = await response.arrayBuffer();
        buffer = await context.decodeAudioData(arrayBuffer);
        return buffer;
      })();
    }
    return decodePromise;
  }

  async function beginPlayback() {
    const context = getContext();
    if (!context) {
      return;
    }
    try {
      if (context.state === "suspended") {
        await context.resume();
      }
      const decoded = await ensureBuffer(context);
      // The busy stretch may have ended (or playback already started) while we
      // were awaiting context resume/decode.
      if (!wantPlaying || source) {
        return;
      }
      gainNode = context.createGain();
      gainNode.gain.setValueAtTime(0, context.currentTime);
      gainNode.gain.linearRampToValueAtTime(TARGET_GAIN, context.currentTime + FADE_IN_SECONDS);
      source = context.createBufferSource();
      source.buffer = decoded;
      source.loop = true;
      source.connect(gainNode).connect(context.destination);
      source.start(0);
    } catch {
      // Audio is best-effort; never let playback failures break the call.
    }
  }

  function stopPlayback() {
    const context = audioContext;
    const endingSource = source;
    const endingGain = gainNode;
    source = null;
    gainNode = null;
    if (!context || !endingSource || !endingGain) {
      return;
    }
    try {
      const now = context.currentTime;
      endingGain.gain.cancelScheduledValues(now);
      endingGain.gain.setValueAtTime(endingGain.gain.value, now);
      endingGain.gain.linearRampToValueAtTime(0, now + FADE_OUT_SECONDS);
      endingSource.stop(now + FADE_OUT_SECONDS + 0.05);
      endingSource.onended = () => {
        try {
          endingSource.disconnect();
          endingGain.disconnect();
        } catch {
          // Already torn down.
        }
      };
    } catch {
      try {
        endingSource.stop();
      } catch {
        // Already stopped.
      }
    }
  }

  return {
    // The agent has gone quiet to work (a tool started). Begin the waiting
    // ambience after a short debounce; idempotent while already requested.
    start() {
      if (wantPlaying) {
        return;
      }
      wantPlaying = true;
      if (source || startTimer) {
        return;
      }
      startTimer = setTimeout(() => {
        startTimer = null;
        void beginPlayback();
      }, START_DELAY_MS);
    },

    // The wait is over (agent resumed speaking, user barged in, or the turn
    // ended). Fade out, or cancel a pending start if it never began.
    stop() {
      if (!wantPlaying) {
        return;
      }
      wantPlaying = false;
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
        return;
      }
      stopPlayback();
    },

    // Hard reset (e.g. the call ended); cancels pending start and fades out.
    reset() {
      wantPlaying = false;
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      stopPlayback();
    },
  };
}
