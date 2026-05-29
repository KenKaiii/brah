import { createPanelController } from "./panel.js";
import { createRealtimePlaybackTracker, isBenignCancelError } from "./realtime-playback.js";
import { createRealtimeToolHandler } from "./realtime-tool-handler.js";

const appShellElement = document.querySelector("#app-shell");
const statusElement = document.querySelector("#status");
const connectOpenAIButton = document.querySelector("#connect-openai");
const menuToggleButton = document.querySelector("#menu-toggle");
const appMenuElement = document.querySelector("#app-menu");
const openAIIndicatorElement = document.querySelector("#openai-indicator");
const permissionsToggleButton = document.querySelector("#permissions-toggle");
const windowMinimizeButton = document.querySelector("#window-minimize");
const permissionsPanelElement = document.querySelector("#permissions-panel");
const permissionsBackButton = document.querySelector("#permissions-back");
const permissionsRefreshButton = document.querySelector("#permissions-refresh");
const diagnosticsOpenButton = document.querySelector("#diagnostics-open");
const permissionsListElement = document.querySelector("#permissions-list");
const callToggleButton = document.querySelector("#call-toggle");
const headerCallButton = document.querySelector("#header-call");
const headerCallLabelElement = document.querySelector("#header-call-label");
const callLabelElement = document.querySelector("#call-label");
const callEndButton = document.querySelector("#call-end");
const callTimerElement = document.querySelector("#call-timer");
const callWaveCanvas = document.querySelector("#call-wave");
const remoteAudioElement = document.querySelector("#remote-audio");
const toolActivityElement = document.querySelector("#tool-activity");
const toolActivityLabelElement = document.querySelector("#tool-activity-label");
const toolActivityTargetElement = document.querySelector("#tool-activity-target");
const toolActivityStopButton = document.querySelector("#tool-activity-stop");

const stoppableTools = new Set(["computer_use_task"]);
const toolActivityLabels = {
  computer_use_task: "Computer use running",
};
const toolActivityTargets = {
  computer_use_task: "Browser",
};

let isOpenAIConnected = false;
let peerConnection = null;
let dataChannel = null;
let localStream = null;
let audioLevelMonitor = null;
let pendingHangup = false;
let hangupFallbackTimer = null;
const playbackTracker = createRealtimePlaybackTracker();
let callTimerInterval = null;
let callStartedAt = 0;
let isCallActive = false;
const realtimeToolHandler = createRealtimeToolHandler({
  executeTool: (name, args) => window.brah.executeRealtimeTool(name, args),
  sendEvent: sendRealtimeDataChannelEvent,
  setMode,
  setStatus,
  onEndCall: requestHangup,
  onToolStart: showToolActivity,
  onToolEnd: hideToolActivity,
});

function showToolActivity(name) {
  if (!stoppableTools.has(name)) {
    return;
  }
  toolActivityLabelElement.textContent = toolActivityLabels[name] ?? "Working…";
  toolActivityTargetElement.textContent = toolActivityTargets[name] ?? "System";
  toolActivityStopButton.disabled = false;
  toolActivityStopButton.textContent = "End";
  toolActivityElement.hidden = false;
  appShellElement.dataset.toolActivity = "active";
  if (panelController.isOpen()) {
    void panelController.close({ windowMode: "call" });
  } else {
    void setWindowMode("call");
  }
}

function hideToolActivity(name) {
  if (name && !stoppableTools.has(name)) {
    return;
  }
  toolActivityElement.hidden = true;
  appShellElement.dataset.toolActivity = "idle";
  if (!isCallActive && !panelController.isOpen()) {
    void panelController.open();
  }
}

async function stopComputerUse() {
  toolActivityStopButton.disabled = true;
  toolActivityStopButton.textContent = "Ending…";
  toolActivityLabelElement.textContent = "Ending…";
  try {
    await window.brah.cancelComputerUse();
  } catch (error) {
    await writeRendererDiagnostic("computer_use.cancel.error", formatRendererError(error));
  }
}

function requestHangup() {
  if (pendingHangup || !peerConnection) {
    return;
  }
  pendingHangup = true;
  setStatus("Ending call…");
  // Prefer to let the model's goodbye response finish (handled on response.done),
  // but guarantee teardown if that event never arrives.
  hangupFallbackTimer = setTimeout(() => {
    void stopCall();
  }, 5000);
}

function setStatus(message) {
  statusElement.textContent = message;
}

function setMode(mode) {
  appShellElement.dataset.mode = mode;
}

function setMenuOpen(open) {
  appMenuElement.hidden = !open;
  menuToggleButton.setAttribute("aria-expanded", String(open));
}

function toggleMenu() {
  setMenuOpen(appMenuElement.hidden);
}

function setOrbLevel(level) {
  const normalized = Math.max(0, Math.min(level, 1));
  appShellElement.style.setProperty("--orb-level", normalized.toFixed(3));
}

function setOpenAIConnected(connected) {
  isOpenAIConnected = connected;
  connectOpenAIButton.textContent = connected ? "Reconnect OpenAI" : "Connect OpenAI";
  connectOpenAIButton.disabled = false;
  openAIIndicatorElement.textContent = connected ? "Connected" : "Offline";
  openAIIndicatorElement.dataset.connected = String(connected);
  callToggleButton.disabled = !connected;
  headerCallButton.disabled = !connected;
  appShellElement.classList.toggle("is-authorized", connected);
  if (!connected) {
    setMode("idle");
    setStatus("Connect OpenAI");
  }
}

function setCallActive(active, { inactiveWindowMode = "panel" } = {}) {
  if (isCallActive === active) {
    return;
  }
  isCallActive = active;
  callToggleButton.classList.toggle("is-active", active);
  callToggleButton.setAttribute("aria-pressed", String(active));
  headerCallButton.classList.toggle("is-active", active);
  headerCallButton.setAttribute("aria-pressed", String(active));
  headerCallLabelElement.textContent = active ? "End" : "Call";
  callLabelElement.textContent = active ? "End" : "Call";
  callEndButton.disabled = !active;
  callEndButton.tabIndex = active ? 0 : -1;
  appShellElement.dataset.call = active ? "active" : "idle";
  if (active) {
    startCallTimer();
    void setWindowMode("call");
    void setWindowFocusable(false);
  } else {
    stopCallTimer();
    clearWaveform();
    void setWindowFocusable(true);
    void setWindowMode(inactiveWindowMode);
  }
}

async function setWindowFocusable(focusable) {
  try {
    await window.brah.setWindowFocusable(focusable);
  } catch (error) {
    await writeRendererDiagnostic("window.set_focusable.error", {
      focusable,
      ...formatRendererError(error),
    });
  }
}

async function setWindowMode(mode) {
  try {
    await window.brah.setWindowMode(mode);
  } catch (error) {
    await writeRendererDiagnostic("window.set_mode.error", {
      mode,
      ...formatRendererError(error),
    });
  }
}

function startCallTimer() {
  callStartedAt = Date.now();
  updateCallTimer();
  if (callTimerInterval !== null) {
    clearInterval(callTimerInterval);
  }
  callTimerInterval = setInterval(updateCallTimer, 1000);
}

function stopCallTimer() {
  if (callTimerInterval !== null) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callTimerElement.textContent = "0:00";
}

function updateCallTimer() {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  callTimerElement.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function refreshOpenAIStatus() {
  const status = await window.brah.getOpenAIStatus();
  setOpenAIConnected(status.connected);
  if (status.connected) {
    setStatus("Ready");
  }
}

async function refreshOsPermissions() {
  const permissions = await window.brah.getOsPermissions();
  renderOsPermissions(permissions);
}

function renderOsPermissions(permissions) {
  permissionsListElement.replaceChildren(
    ...permissions.map((permission, index) => {
      const item = document.createElement("article");
      item.className = "permission-item";
      item.style.setProperty("--stagger", String(index));

      const title = document.createElement("div");
      title.className = "permission-title";
      const label = document.createElement("span");
      label.textContent = permission.label;
      const status = document.createElement("span");
      status.className = `permission-status${permission.status === "granted" ? " is-granted" : ""}`;
      status.textContent = permission.status;
      title.append(label, status);

      const description = document.createElement("p");
      description.className = "permission-description";
      description.textContent = permission.description;

      const activation = document.createElement("p");
      activation.className = "permission-activation";
      activation.textContent = permission.activation;

      const actions = document.createElement("div");
      actions.className = "permission-actions";
      const requestButton = document.createElement("button");
      requestButton.type = "button";
      requestButton.textContent = "Request";
      requestButton.disabled = permission.status === "unsupported";
      requestButton.addEventListener("click", () => requestOsPermission(permission.id));
      const settingsButton = document.createElement("button");
      settingsButton.type = "button";
      settingsButton.textContent = "Settings";
      settingsButton.addEventListener("click", () => openOsPermissionSettings(permission.id));
      actions.append(requestButton, settingsButton);

      item.append(title, description, activation, actions);
      return item;
    }),
  );
}

async function requestOsPermission(id) {
  setStatus("Requesting permission…");
  try {
    renderOsPermissions(await window.brah.requestOsPermission(id));
    setStatus("Permissions updated");
  } catch (error) {
    setStatus(`Permission failed: ${error.message}`);
  }
}

async function openOsPermissionSettings(id) {
  setStatus("Opening settings…");
  try {
    await window.brah.openOsPermissionSettings(id);
    setStatus("Settings opened");
  } catch (error) {
    setStatus(`Settings failed: ${error.message}`);
  }
}

async function connectOpenAI() {
  connectOpenAIButton.disabled = true;
  callToggleButton.disabled = true;
  headerCallButton.disabled = true;
  setStatus(isOpenAIConnected ? "Reconnecting…" : "Opening browser…");
  setMode("connecting");

  try {
    if (isOpenAIConnected) {
      await stopCall();
      await window.brah.logoutOpenAI();
      setOpenAIConnected(false);
    }
    await window.brah.loginOpenAI();
    setOpenAIConnected(true);
    setMode("idle");
    setStatus("Ready");
  } catch (error) {
    setOpenAIConnected(false);
    setStatus(`Connect failed: ${error.message}`);
  } finally {
    connectOpenAIButton.disabled = false;
    callToggleButton.disabled = !isOpenAIConnected;
    headerCallButton.disabled = !isOpenAIConnected;
  }
}

async function toggleCall() {
  if (peerConnection) {
    await stopCall();
    return;
  }

  await startCall();
}

async function startCall() {
  if (!isOpenAIConnected) {
    setStatus("Connect first");
    return;
  }

  callToggleButton.disabled = true;
  headerCallButton.disabled = true;
  // Hide the panel instantly (no fade) before resizing so the UI just
  // disappears rather than morphing through a circle into the call pill.
  if (panelController.isOpen()) {
    await panelController.close({ immediate: true, skipWindowMode: true });
  }
  setCallActive(true);
  setStatus("Starting…");
  setMode("connecting");
  await writeRendererDiagnostic("call.start", {
    mediaDevicesAvailable: Boolean(navigator.mediaDevices?.getUserMedia),
  });

  try {
    const secret = await window.brah.createRealtimeSecret();
    await writeRendererDiagnostic("call.secret.created", { hasValue: Boolean(secret?.value) });
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await writeRendererDiagnostic("call.microphone.stream", describeMediaStream(localStream));
    startAudioLevelMonitor(localStream);

    peerConnection = new RTCPeerConnection();
    dataChannel = peerConnection.createDataChannel("oai-events");
    await writeRendererDiagnostic("call.peer.created", {});

    peerConnection.ontrack = (event) => {
      const [stream] = event.streams;
      remoteAudioElement.srcObject = stream;
      audioLevelMonitor?.setRemoteStream(stream);
    };
    peerConnection.onconnectionstatechange = () => {
      if (!peerConnection) {
        return;
      }
      void writeRendererDiagnostic("call.connection_state", {
        state: peerConnection.connectionState,
      });
      setStatus(formatConnectionState(peerConnection.connectionState));
      if (peerConnection.connectionState === "connected") {
        setMode("listening");
      }
      if (["closed", "disconnected", "failed"].includes(peerConnection.connectionState)) {
        void stopCall();
      }
    };
    dataChannel.addEventListener("open", () => {
      void writeRendererDiagnostic("call.data_channel.open", {});
      setStatus("Listening");
      setMode("listening");
    });
    dataChannel.addEventListener("message", (event) => {
      const realtimeEvent = JSON.parse(event.data);
      void writeRendererDiagnostic("realtime.event", summarizeRealtimeEvent(realtimeEvent));
      void handleRealtimeEvent(realtimeEvent);
    });

    for (const track of localStream.getTracks()) {
      peerConnection.addTrack(track, localStream);
    }
    await writeRendererDiagnostic("call.microphone.tracks_added", describeMediaStream(localStream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${secret.value}`,
        "Content-Type": "application/sdp",
      },
    });

    if (!sdpResponse.ok) {
      throw new Error(`Realtime call failed (${sdpResponse.status}): ${await sdpResponse.text()}`);
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text(),
    });
    await writeRendererDiagnostic("call.remote_description.set", {
      connectionState: peerConnection.connectionState,
    });

    setStatus("Connecting");
  } catch (error) {
    await writeRendererDiagnostic("call.error", formatRendererError(error));
    setStatus(`Failed: ${error.message}`);
    await stopCall();
  } finally {
    callToggleButton.disabled = !isOpenAIConnected;
    headerCallButton.disabled = !isOpenAIConnected;
  }
}

async function stopCall() {
  audioLevelMonitor?.stop();
  audioLevelMonitor = null;
  setOrbLevel(0);

  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
    localStream = null;
  }

  if (hangupFallbackTimer) {
    clearTimeout(hangupFallbackTimer);
    hangupFallbackTimer = null;
  }
  pendingHangup = false;
  playbackTracker.reset();

  realtimeToolHandler.reset();
  hideToolActivity();
  remoteAudioElement.srcObject = null;
  setCallActive(false, { inactiveWindowMode: "panel" });
  await panelController.open();
  setMode("idle");
  setStatus(isOpenAIConnected ? "Ready" : "Connect OpenAI");
}

async function handleRealtimeEvent(event) {
  playbackTracker.observe(event);
  if (await realtimeToolHandler.handleEvent(event)) {
    return;
  }
  if (event.type === "input_audio_buffer.speech_started") {
    // Ken started talking: cut off any assistant audio immediately rather than
    // waiting for the server VAD round-trip, then return to listening.
    interruptAssistantPlayback();
    setStatus("Listening");
    setMode("listening");
    return;
  }
  if (event.type === "response.output_audio.delta") {
    setStatus("Speaking");
    setMode("speaking");
    return;
  }
  if (event.type === "response.done") {
    if (pendingHangup) {
      void stopCall();
      return;
    }
    setStatus("Listening");
    setMode("listening");
    return;
  }
  if (event.type === "error") {
    // A benign "no active response to cancel" can occur when our manual barge-in
    // races the server VAD's own interrupt; don't surface it as a call error.
    if (isBenignCancelError(event.error)) {
      void writeRendererDiagnostic("realtime.cancel.benign", { code: event.error?.code });
      return;
    }
    setStatus(event.error?.message ?? "Realtime error");
    setMode("idle");
  }
}

function interruptAssistantPlayback() {
  const events = playbackTracker.interrupt();
  if (events.length === 0) {
    return;
  }
  // Per the OpenAI Realtime WebRTC contract: cancel the in-progress response,
  // then clear the already-buffered output audio so playback stops at once.
  void writeRendererDiagnostic("realtime.barge_in", {
    events: events.map((event) => event.type),
  });
  for (const event of events) {
    sendRealtimeDataChannelEvent(event);
  }
}

async function writeRendererDiagnostic(event, details = {}) {
  try {
    await window.brah.writeDiagnosticLog(event, details);
  } catch {
    // Diagnostics must not break the call flow.
  }
}

function describeMediaStream(stream) {
  return {
    id: stream.id,
    active: stream.active,
    tracks: stream.getTracks().map((track) => ({
      id: track.id,
      kind: track.kind,
      label: track.label,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
      settings: track.getSettings?.(),
    })),
  };
}

function formatRendererError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

function sendRealtimeDataChannelEvent(event) {
  if (dataChannel?.readyState !== "open") {
    void writeRendererDiagnostic("realtime.send.skipped", {
      type: event?.type,
      readyState: dataChannel?.readyState ?? "missing",
    });
    return;
  }
  void writeRendererDiagnostic("realtime.send", summarizeRealtimeClientEvent(event));
  dataChannel.send(JSON.stringify(event));
}

function summarizeRealtimeClientEvent(event) {
  const summary = { type: event?.type };
  if (event?.item?.type) {
    summary.itemType = event.item.type;
  }
  if (event?.item?.call_id) {
    summary.callId = event.item.call_id;
  }
  if (event?.response?.input) {
    summary.responseInput = summarizeRealtimeInput(event.response.input);
  }
  if (event?.response?.output_modalities) {
    summary.outputModalities = event.response.output_modalities;
  }
  return summary;
}

function summarizeRealtimeEvent(event) {
  const summary = { type: event?.type };
  if (event?.error) {
    summary.error = event.error;
  }
  if (event?.response) {
    summary.response = {
      id: event.response.id,
      status: event.response.status,
      statusDetails: event.response.status_details,
    };
  }
  if (event?.item) {
    summary.item = {
      id: event.item.id,
      type: event.item.type,
      role: event.item.role,
      status: event.item.status,
    };
  }
  return summary;
}

function summarizeRealtimeInput(input) {
  return input.map((item) => ({
    type: item?.type,
    role: item?.role,
    content: Array.isArray(item?.content)
      ? item.content.map((content) => ({
          type: content?.type,
          textLength: typeof content?.text === "string" ? content.text.length : undefined,
          imageUrlLength:
            typeof content?.image_url === "string" ? content.image_url.length : undefined,
        }))
      : undefined,
  }));
}

function formatConnectionState(state) {
  switch (state) {
    case "connected":
      return "Listening";
    case "connecting":
      return "Connecting";
    case "failed":
      return "Failed";
    case "disconnected":
      return "Disconnected";
    default:
      return "Ready";
  }
}

function startAudioLevelMonitor(microphoneStream) {
  audioLevelMonitor?.stop();
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  const audioContext = new AudioContextClass();
  const micAnalyser = createAnalyser(audioContext, microphoneStream);
  let remoteAnalyser = null;
  let animationFrame = null;
  let smoothedLevel = 0;

  setupWaveCanvas();

  function read() {
    const micLevel = readAnalyserLevel(micAnalyser);
    const remoteLevel = remoteAnalyser ? readAnalyserLevel(remoteAnalyser) : 0;
    const level = Math.max(micLevel, remoteLevel * 1.15);
    smoothedLevel = smoothedLevel * 0.72 + level * 0.28;
    setOrbLevel(smoothedLevel);
    drawWaveform(micAnalyser, remoteAnalyser, smoothedLevel);
    animationFrame = requestAnimationFrame(read);
  }

  audioLevelMonitor = {
    setRemoteStream(stream) {
      remoteAnalyser = createAnalyser(audioContext, stream);
    },
    stop() {
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
      }
      clearWaveform();
      void audioContext.close();
    },
  };

  read();
}

function createAnalyser(audioContext, stream) {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.55;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  return {
    analyser,
    data: new Uint8Array(analyser.fftSize),
    freq: new Uint8Array(analyser.frequencyBinCount),
  };
}

function readAnalyserLevel({ analyser, data }) {
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / data.length);
  return Math.min(1, Math.max(0, (rms - 0.015) * 8));
}

/* ---------- Waveform visualizer ----------
 * Mirrored rounded frequency bars, grounded in wavesurfer.js' bar model
 * (center-aligned bars, barGap ≈ barWidth/2, roundRect with barRadius). */
const WAVE_BAR_COUNT = 18;
const WAVE_CSS_WIDTH = 122;
const WAVE_CSS_HEIGHT = 20;
const waveBarHeights = new Array(WAVE_BAR_COUNT).fill(0);
let waveContext = null;
let waveGradient = null;

function setupWaveCanvas() {
  if (!callWaveCanvas) {
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  callWaveCanvas.width = Math.round(WAVE_CSS_WIDTH * ratio);
  callWaveCanvas.height = Math.round(WAVE_CSS_HEIGHT * ratio);
  waveContext = callWaveCanvas.getContext("2d");
  if (!waveContext) {
    return;
  }
  waveContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  waveGradient = waveContext.createLinearGradient(0, 0, WAVE_CSS_WIDTH, 0);
  waveGradient.addColorStop(0, "#818cf8");
  waveGradient.addColorStop(0.5, "#a5b4fc");
  waveGradient.addColorStop(1, "#59d9c4");
}

function clearWaveform() {
  waveBarHeights.fill(0);
  if (waveContext) {
    waveContext.clearRect(0, 0, WAVE_CSS_WIDTH, WAVE_CSS_HEIGHT);
  }
}

function drawWaveform(micAnalyser, remoteAnalyser, level) {
  if (!waveContext) {
    return;
  }
  micAnalyser.analyser.getByteFrequencyData(micAnalyser.freq);
  if (remoteAnalyser) {
    remoteAnalyser.analyser.getByteFrequencyData(remoteAnalyser.freq);
  }
  // Voice energy lives in the lower spectrum; sample that band across the bars.
  const usableBins = Math.floor(micAnalyser.freq.length * 0.62);
  const binsPerBar = Math.max(1, Math.floor(usableBins / WAVE_BAR_COUNT));

  const half = WAVE_CSS_HEIGHT / 2;
  const spacing = WAVE_CSS_WIDTH / WAVE_BAR_COUNT;
  const barWidth = Math.max(2, spacing * 0.52);
  const barRadius = barWidth / 2;
  const minHeight = 2;

  waveContext.clearRect(0, 0, WAVE_CSS_WIDTH, WAVE_CSS_HEIGHT);
  waveContext.fillStyle = waveGradient;
  waveContext.globalAlpha = 0.55 + Math.min(0.45, level * 0.6);
  waveContext.beginPath();

  for (let i = 0; i < WAVE_BAR_COUNT; i += 1) {
    let sum = 0;
    const start = i * binsPerBar;
    for (let j = 0; j < binsPerBar; j += 1) {
      const micValue = micAnalyser.freq[start + j] ?? 0;
      const remoteValue = remoteAnalyser ? (remoteAnalyser.freq[start + j] ?? 0) : 0;
      sum += Math.max(micValue, remoteValue);
    }
    const target = Math.min(1, sum / binsPerBar / 255);
    // Ease toward the target for fluid, non-jittery motion.
    waveBarHeights[i] = waveBarHeights[i] * 0.6 + target * 0.4;

    const amplitude = Math.max(minHeight, waveBarHeights[i] * (half - 1));
    const x = i * spacing + (spacing - barWidth) / 2;
    const y = half - amplitude;
    const totalHeight = amplitude * 2;
    if (typeof waveContext.roundRect === "function") {
      waveContext.roundRect(x, y, barWidth, totalHeight, barRadius);
    } else {
      waveContext.rect(x, y, barWidth, totalHeight);
    }
  }

  waveContext.fill();
  waveContext.globalAlpha = 1;
}

menuToggleButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu();
});
document.addEventListener("click", (event) => {
  if (appMenuElement.hidden) {
    return;
  }
  if (!appMenuElement.contains(event.target) && event.target !== menuToggleButton) {
    setMenuOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !appMenuElement.hidden) {
    setMenuOpen(false);
  }
});
connectOpenAIButton.addEventListener("click", () => {
  setMenuOpen(false);
  void connectOpenAI();
});
permissionsToggleButton.addEventListener("click", () => {
  setMenuOpen(false);
  permissionsPanelElement.hidden = !permissionsPanelElement.hidden;
  if (!permissionsPanelElement.hidden) {
    void refreshOsPermissions();
  }
});
windowMinimizeButton.addEventListener("click", () => {
  setMenuOpen(false);
  void window.brah.minimizeWindow();
});
permissionsBackButton.addEventListener("click", () => {
  permissionsPanelElement.hidden = true;
});
permissionsRefreshButton.addEventListener("click", () => {
  void refreshOsPermissions();
});
diagnosticsOpenButton.addEventListener("click", () => {
  void window.brah.openDiagnosticLog();
});
const panelController = createPanelController({
  brah: window.brah,
  onModeChange: (mode) => {
    appShellElement.dataset.panel = mode === "panel" ? "open" : "closed";
  },
});
panelController.init({ openByDefault: true });

callToggleButton.addEventListener("click", toggleCall);
headerCallButton.addEventListener("click", toggleCall);
callEndButton.addEventListener("click", () => {
  void stopCall();
});
toolActivityStopButton.addEventListener("click", () => {
  void stopComputerUse();
});
setOrbLevel(0);

refreshOpenAIStatus().catch((error) => {
  setOpenAIConnected(false);
  setStatus(`Status failed: ${error.message}`);
});
refreshOsPermissions().catch((error) => {
  setStatus(`Permissions failed: ${error.message}`);
});
