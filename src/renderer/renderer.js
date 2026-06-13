import {
  AGENT_PERSONAS,
  buildWelcomeInstructions,
  normalizeAgentProfile,
  REALTIME_MODELS,
  REALTIME_VOICES,
} from "../realtime/prompts.js";
import { initClickSound } from "./click-sound.js";
import { createPanelController } from "./panel.js";
import { createRealtimePlaybackTracker, isBenignCancelError } from "./realtime-playback.js";
import {
  createRealtimeResponseCoordinator,
  isActiveResponseConflictError,
} from "./realtime-response-queue.js";
import { createRealtimeToolHandler } from "./realtime-tool-handler.js";
import { createWaitingSound } from "./waiting-sound.js";

const appShellElement = document.querySelector("#app-shell");
const statusElement = document.querySelector("#status");
const connectOpenAIButton = document.querySelector("#connect-openai");
const menuToggleButton = document.querySelector("#menu-toggle");
const appMenuElement = document.querySelector("#app-menu");
const openAIIndicatorElement = document.querySelector("#openai-indicator");
const micSelectElement = document.querySelector("#mic-select");
const permissionsToggleButton = document.querySelector("#permissions-toggle");
const windowMinimizeButton = document.querySelector("#window-minimize");
const appQuitButton = document.querySelector("#app-quit");
const permissionsPanelElement = document.querySelector("#permissions-panel");
const permissionsBackButton = document.querySelector("#permissions-back");
const permissionsRefreshButton = document.querySelector("#permissions-refresh");
const diagnosticsOpenButton = document.querySelector("#diagnostics-open");
const permissionsListElement = document.querySelector("#permissions-list");
const agentToggleButton = document.querySelector("#agent-toggle");
const agentPanelElement = document.querySelector("#agent-panel");
const agentBackButton = document.querySelector("#agent-back");
const agentFormElement = document.querySelector("#agent-form");
const agentNameInput = document.querySelector("#agent-name");
const agentAboutInput = document.querySelector("#agent-about");
const agentGoalsInput = document.querySelector("#agent-goals");
const agentVoiceSelect = document.querySelector("#agent-voice");
const agentPersonaSelect = document.querySelector("#agent-persona");
const settingsToggleButton = document.querySelector("#settings-toggle");
const settingsPanelElement = document.querySelector("#settings-panel");
const settingsBackButton = document.querySelector("#settings-back");
const settingsModelSelect = document.querySelector("#settings-model");
const apiKeyInput = document.querySelector("#api-key-input");
const apiKeySaveButton = document.querySelector("#api-key-save");
const apiKeyClearButton = document.querySelector("#api-key-clear");
const apiKeyHintElement = document.querySelector("#api-key-hint");
const apiKeyStatusElement = document.querySelector("#api-key-status");
const agentStatusElement = document.querySelector("#agent-status");
const callToggleButton = document.querySelector("#call-toggle");
const headerCallButton = document.querySelector("#header-call");
const headerCallLabelElement = document.querySelector("#header-call-label");
const callLabelElement = document.querySelector("#call-label");
const callEndButton = document.querySelector("#call-end");
const callTimerElement = document.querySelector("#call-timer");
const callModelElement = document.querySelector("#call-model");
const callWaveCanvas = document.querySelector("#call-wave");
const remoteAudioElement = document.querySelector("#remote-audio");
const toolActivityElement = document.querySelector("#tool-activity");
const toolActivityLabelElement = document.querySelector("#tool-activity-label");
const callToastsElement = document.querySelector("#call-toasts");

const stoppableTools = new Set(["computer_use_task"]);
const toolActivityLabels = {
  computer_use_task: "Computer use running",
};

let isOpenAIConnected = false;
// Latest `openai:get-status` payload (authMethod + masked API key state); used
// for the footer indicator and the API key form, never holds the key itself.
let openAIStatus = null;
let peerConnection = null;
let dataChannel = null;
let localStream = null;
// Ephemeral realtime secrets are short-lived; we prefetch one as soon as OpenAI
// connects (and re-prime after each call) so call-start never blocks on the
// client_secret round-trip. The cache holds the last resolved secret, while
// `secretPrefetchPromise` tracks an in-flight request so concurrent callers
// share it instead of minting duplicates.
let prefetchedSecret = null;
let secretPrefetchPromise = null;
// Timestamp of the last background prefetch failure; used to back off automatic
// re-prime attempts so a failing endpoint isn't hammered by repeated triggers.
let lastSecretPrefetchFailureAt = 0;
const SECRET_EXPIRY_MARGIN_MS = 10_000;
const SECRET_PREFETCH_COOLDOWN_MS = 5_000;
// Must match the `.app-shell` opacity transition in styles.css.
const SHELL_FADE_MS = 130;
let audioLevelMonitor = null;
let pendingHangup = false;
let hangupFallbackTimer = null;
const playbackTracker = createRealtimePlaybackTracker();
const responseCoordinator = createRealtimeResponseCoordinator();
const waitingSound = createWaitingSound();
let callTimerInterval = null;
let callStartedAt = 0;
let isCallActive = false;
let agentProfile = normalizeAgentProfile(null);
// Preferred microphone deviceId, or null to follow the system default.
let selectedMicId = null;
// While the welcome greeting plays we mute the mic so laptop speakers can't
// echo it back and trigger a self-reply; this holds the safety-unmute timer.
let welcomeMicGuardTimer = null;
const realtimeToolHandler = createRealtimeToolHandler({
  executeTool: (name, args) => window.brah.executeRealtimeTool(name, args),
  sendEvent: sendRealtimeDataChannelEvent,
  setMode,
  setStatus,
  onEndCall: requestHangup,
  onToolStart: handleToolStart,
  onToolEnd: handleToolEnd,
});

// While the agent is busy in a tool call it produces no audio, so fill the
// silence with the looping waiting ambience (fading in/out via waiting-sound).
function handleToolStart(name) {
  showToolActivity(name);
  // Computer use has its own on-screen indicator (and can run for a long time),
  // so only fill silence with the waiting ambience for normal quick tool calls.
  if (!stoppableTools.has(name)) {
    waitingSound.start();
  }
}

function handleToolEnd(name, result) {
  hideToolActivity(name);
  // The waiting sound is intentionally NOT stopped here: tool execution finishes
  // long before the agent speaks again (local tools run in ~20ms), so the sound
  // keeps filling the silence until an audio/turn-end event stops it.
  const toast = formatToolToast(name, result);
  if (toast) {
    showCallToast(toast);
  }
}

// Map a finished tool + its result to a short toast, or null to stay silent.
// Read-only tools (lists, reads), computer use (own card), and end_call are
// intentionally omitted so the lane only flashes for meaningful actions.
function formatToolToast(name, result) {
  const status = result?.status;
  switch (name) {
    case "add_task":
      return status === "created" ? "Task added" : null;
    case "delete_task":
      return status === "deleted" ? "Task deleted" : null;
    case "update_task_status":
      return status === "updated" ? "Task updated" : null;
    case "add_calendar_item":
      return status === "created" ? "Event added" : null;
    case "delete_calendar_item":
      return status === "deleted" ? "Event deleted" : null;
    case "web_search":
      return status === "searched" ? "Searched the web" : null;
    case "web_fetch":
      return typeof status === "number" && status < 400 ? "Read a page" : null;
    case "take_screenshot":
      return status === "captured" ? "Screenshot taken" : null;
    case "write_file":
      return status === "created" ? "Wrote a file" : null;
    case "edit_file":
      return status === "edited" ? "Edited a file" : null;
    default:
      return null;
  }
}

// ---------- Background memory extraction ----------
// Memory is no longer the voice agent's job. We buffer the call transcript and,
// after each completed user turn, hand the recent window to a cheap text model
// in the main process that writes durable facts + daily logs to SQLite. Once it
// persists anything, we re-inject the refreshed memory via session.update so the
// agent "knows" it for the rest of the call.
const MAX_TRANSCRIPT_TURNS = 16;
const EXTRACTION_DEBOUNCE_MS = 1500;
const transcriptBuffer = [];
let extractionTimer = null;

function recordTranscriptTurn(role, text) {
  if (typeof text !== "string" || !text.trim()) {
    return;
  }
  transcriptBuffer.push({ role, text: text.trim() });
  if (transcriptBuffer.length > MAX_TRANSCRIPT_TURNS) {
    transcriptBuffer.splice(0, transcriptBuffer.length - MAX_TRANSCRIPT_TURNS);
  }
}

function scheduleMemoryExtraction() {
  if (extractionTimer) {
    clearTimeout(extractionTimer);
  }
  extractionTimer = setTimeout(() => {
    extractionTimer = null;
    void runMemoryExtraction();
  }, EXTRACTION_DEBOUNCE_MS);
}

async function runMemoryExtraction() {
  if (transcriptBuffer.length === 0) {
    return;
  }
  try {
    const result = await window.brah.extractMemory(transcriptBuffer.slice());
    if (
      result?.status === "extracted" &&
      (result.savedFacts > 0 || result.forgotFacts > 0 || result.savedLogs > 0)
    ) {
      const toast = formatMemoryToast(result.savedFacts, result.forgotFacts, result.savedLogs);
      if (toast) {
        showCallToast(toast);
      }
      await refreshSessionMemory();
    }
  } catch (error) {
    void writeRendererDiagnostic("memory.extract.invoke_failed", formatRendererError(error));
  }
}

function formatMemoryToast(savedFacts, forgotFacts, savedLogs) {
  if (savedFacts > 0) {
    const base = savedFacts === 1 ? "New memory saved" : `${savedFacts} memories saved`;
    return savedLogs > 0 ? `${base} · journaled` : base;
  }
  if (savedLogs > 0) {
    return "Daily log updated";
  }
  if (forgotFacts > 0) {
    return "Memory tidied up";
  }
  return null;
}

// Transient feedback that slides up above the call pill and fades out on its own.
// Only meaningful during a call (that's when the lane is visible); the node
// removes itself on animationend so nothing accumulates.
function showCallToast(text) {
  // The toast lane only exists in call mode; skip when not on a call so a late
  // async result (e.g. end-of-call extraction) can't linger into panel mode.
  if (!callToastsElement || !text || !isCallActive) {
    return;
  }
  const toast = document.createElement("div");
  toast.className = "call-toast";
  const dot = document.createElement("span");
  dot.className = "call-toast-dot";
  const label = document.createElement("span");
  label.className = "call-toast-label";
  label.textContent = text;
  toast.append(dot, label);
  toast.addEventListener("animationend", () => toast.remove());
  callToastsElement.append(toast);
  // Safety net in case animationend never fires (e.g. tab hidden mid-animation).
  window.setTimeout(() => toast.remove(), 5000);
}

function clearCallToasts() {
  if (callToastsElement) {
    callToastsElement.replaceChildren();
  }
}

function resetTranscriptBuffer() {
  transcriptBuffer.length = 0;
  if (extractionTimer) {
    clearTimeout(extractionTimer);
    extractionTimer = null;
  }
}

async function refreshSessionMemory() {
  if (!isCallActive || dataChannel?.readyState !== "open") {
    return;
  }
  try {
    const instructions = await window.brah.getRealtimeInstructions();
    if (typeof instructions !== "string" || !instructions.trim()) {
      return;
    }
    sendRealtimeDataChannelEvent({
      type: "session.update",
      session: { type: "realtime", instructions },
    });
  } catch (error) {
    void writeRendererDiagnostic("realtime.memory_refresh_failed", formatRendererError(error));
  }
}

function showToolActivity(name) {
  if (!stoppableTools.has(name)) {
    return;
  }
  toolActivityLabelElement.textContent = toolActivityLabels[name] ?? "Working…";
  toolActivityElement.hidden = false;
  appShellElement.dataset.toolActivity = "active";
  if (panelController.isOpen()) {
    // Hide the panel synchronously before the window shrinks to the pill so the
    // 440-wide panel content isn't squished into the 226x52 frame mid-resize
    // (which made the computer-use container look deformed).
    void panelController.close({ immediate: true, windowMode: "call" });
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
  toolActivityLabelElement.textContent = "Stopping…";
  try {
    await window.brah.cancelComputerUse();
  } catch (error) {
    await writeRendererDiagnostic("computer_use.cancel.error", formatRendererError(error));
  }
}

// ---------- Call model badge (truthful model indicator) ----------
// The badge never claims a model the server hasn't confirmed: it starts in a
// "pending" state showing the minted model, and only locks in (or flips to a
// mismatch warning) once `session.created` reports the actual server model.
// `selectedCallModel` is the *user's profile selection* at call start — the
// thing mismatches are judged against — not whatever the mint echoed back.
let selectedCallModel = null;

function modelTier(model) {
  // Prefix-match so server-side dated aliases ("gpt-realtime-mini-2025-10-06")
  // keep their real tier. Unknown models render with the loud "expensive"
  // styling on purpose: never show the cheap green for something unidentified.
  for (const [id, { tier }] of Object.entries(REALTIME_MODELS)) {
    if (model === id || model.startsWith(`${id}-`)) {
      return tier;
    }
  }
  return "full";
}

function modelBadgeText(model) {
  const name = shortModelName(model);
  return modelTier(model) === "full" ? `${name} $$` : name;
}

function showCallModelPending(mintedModel) {
  selectedCallModel = agentProfile.model;
  const display = typeof mintedModel === "string" && mintedModel ? mintedModel : selectedCallModel;
  callModelElement.hidden = false;
  callModelElement.dataset.state = "pending";
  callModelElement.dataset.tier = modelTier(display);
  callModelElement.textContent = `${modelBadgeText(display)}?`;
  callModelElement.title = "Model not yet confirmed by the server";
}

function confirmCallModel(serverModel) {
  if (typeof serverModel !== "string" || !serverModel) {
    // No model in the event: leave the badge pending rather than guessing.
    return;
  }
  callModelElement.hidden = false;
  callModelElement.dataset.tier = modelTier(serverModel);
  // Tolerate server-side dated aliases (e.g. "gpt-realtime-mini-2025-10-06")
  // resolving the requested model; anything else is a real mismatch.
  const matches = selectedCallModel !== null && serverModel.startsWith(selectedCallModel);
  if (matches) {
    callModelElement.dataset.state = "confirmed";
    callModelElement.textContent = modelBadgeText(serverModel);
    callModelElement.title = `Server confirmed model: ${serverModel}`;
    return;
  }
  callModelElement.dataset.state = "mismatch";
  callModelElement.textContent = `⚠ ${modelBadgeText(serverModel)}`;
  callModelElement.title = `Server is running ${serverModel}, not your selected ${selectedCallModel}`;
  setStatus(`Model mismatch: ${shortModelName(serverModel)}`);
  void writeRendererDiagnostic("realtime.model.mismatch", {
    selected: selectedCallModel,
    actual: serverModel,
  });
}

function hideCallModelBadge() {
  selectedCallModel = null;
  callModelElement.hidden = true;
  callModelElement.dataset.state = "pending";
  callModelElement.textContent = "";
  callModelElement.removeAttribute("title");
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
  // OAuth realtime is broken upstream (see CLAUDE.md); the button stays
  // disabled until that clears. API key is the working path.
  connectOpenAIButton.disabled = true;
  updateOpenAIIndicator();
  callToggleButton.disabled = !connected;
  headerCallButton.disabled = !connected;
  appShellElement.classList.toggle("is-authorized", connected);
  if (!connected) {
    invalidatePrefetchedSecret();
    setMode("idle");
    setStatus("Add an API key in Settings");
  }
}

function setCallActive(active, { inactiveWindowMode = "panel", onHidden } = {}) {
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
  // The `data-call` swap resizes the call bar to fill the window, so it must run
  // inside `switchShellLayout` (hidden during the async window resize) to avoid
  // flashing the call pill — or the large idle orb — at the wrong window size.
  // `onHidden` lets callers open/close the panel within that hidden phase too.
  if (active) {
    startCallTimer();
    void setWindowFocusable(false);
    return switchShellLayout(async () => {
      await onHidden?.();
      appShellElement.dataset.call = "active";
    }, "call");
  }
  stopCallTimer();
  clearWaveform();
  void setWindowFocusable(true);
  return switchShellLayout(async () => {
    appShellElement.dataset.call = "idle";
    await onHidden?.();
  }, inactiveWindowMode);
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

async function setWindowMode(mode, options) {
  try {
    await window.brah.setWindowMode(mode, options);
  } catch (error) {
    await writeRendererDiagnostic("window.set_mode.error", {
      mode,
      ...formatRendererError(error),
    });
  }
}

// Fade the shell out, swap its layout + resize the window while it is invisible,
// then fade back in. The window resize is async (IPC), so without this the new
// layout (e.g. the call pill) paints for a frame or two at the old window size —
// a stretched "oval" of the call bar across the panel footprint. Hiding the
// content across the swap makes the transition seamless.
async function switchShellLayout(applyLayout, mode) {
  appShellElement.classList.add("is-switching");
  await waitForShellFade();
  // applyLayout runs entirely while the shell is invisible — this is where the
  // panel is opened/closed so neither the large idle orb nor the panel ever
  // paints at the wrong window size during the swap.
  await applyLayout();
  await setWindowMode(mode, { animate: false });
  // Reveal on the next frame so the resized window has committed its new bounds
  // before the content fades back in.
  requestAnimationFrame(() => {
    appShellElement.classList.remove("is-switching");
  });
}

// Resolve once the shell's opacity transition has settled (or a safety timeout
// elapses, so a dropped `transitionend` can never wedge the UI invisible).
function waitForShellFade() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      appShellElement.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event) => {
      if (event.target === appShellElement && event.propertyName === "opacity") {
        finish();
      }
    };
    appShellElement.addEventListener("transitionend", onEnd);
    setTimeout(finish, SHELL_FADE_MS + 40);
  });
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
  openAIStatus = status;
  setOpenAIConnected(status.connected);
  renderApiKeyState();
  if (status.connected) {
    setStatus("Ready");
    prefetchRealtimeSecret();
  }
}

// Short, glanceable model name for the footer/badge ("mini", "realtime-2").
function shortModelName(model) {
  return typeof model === "string" ? model.replace(/^gpt-realtime-?/, "") || "realtime" : "?";
}

function updateOpenAIIndicator() {
  openAIIndicatorElement.textContent = isOpenAIConnected ? "Connected" : "Offline";
  openAIIndicatorElement.dataset.connected = String(isOpenAIConnected);
}

function renderApiKeyState() {
  const keyState = openAIStatus?.apiKey;
  const present = Boolean(keyState?.present);
  apiKeyHintElement.textContent = present ? `…${keyState.last4}` : "";
  apiKeyClearButton.disabled = !present;
  // The key is verified against the API before it's ever saved, so a saved key
  // is an authenticated one — "Connected" is truthful here.
  apiKeyStatusElement.textContent = present ? "Connected" : "Not set";
  apiKeyStatusElement.dataset.connected = String(present);
}

async function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) {
    return;
  }
  apiKeySaveButton.disabled = true;
  apiKeyHintElement.textContent = "Verifying…";
  try {
    await window.brah.setOpenAIApiKey(key);
    apiKeyInput.value = "";
    // The auth used to mint is baked into the prefetched secret; re-prime.
    invalidatePrefetchedSecret();
    await refreshOpenAIStatus();
  } catch (error) {
    apiKeyHintElement.textContent = error.message;
  } finally {
    apiKeySaveButton.disabled = false;
  }
}

async function clearApiKey() {
  apiKeyClearButton.disabled = true;
  try {
    await window.brah.clearOpenAIApiKey();
    invalidatePrefetchedSecret();
    await refreshOpenAIStatus();
  } catch (error) {
    apiKeyHintElement.textContent = error.message;
    apiKeyClearButton.disabled = false;
  }
}

// Settings model changes persist immediately (no Save button in Settings); the
// minted secret bakes the model in, so re-prime after a successful save.
async function handleModelSelection() {
  const previous = agentProfile.model;
  try {
    agentProfile = normalizeAgentProfile(
      await window.brah.setAgentProfile({ ...agentProfile, model: settingsModelSelect.value }),
    );
    invalidatePrefetchedSecret();
    prefetchRealtimeSecret();
  } catch (error) {
    settingsModelSelect.value = previous;
    await writeRendererDiagnostic("settings.model.save_failed", formatRendererError(error));
  }
}

async function refreshOsPermissions() {
  const permissions = await window.brah.getOsPermissions();
  renderOsPermissions(permissions);
}

async function loadAgentProfile() {
  agentProfile = normalizeAgentProfile(await window.brah.getAgentProfile());
  renderAgentProfile();
}

function populateAgentOptions() {
  agentVoiceSelect.replaceChildren(
    ...REALTIME_VOICES.map((voice) => {
      const option = document.createElement("option");
      option.value = voice;
      option.textContent = voice.charAt(0).toUpperCase() + voice.slice(1);
      return option;
    }),
  );
  agentPersonaSelect.replaceChildren(
    ...Object.entries(AGENT_PERSONAS).map(([key, { label }]) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      return option;
    }),
  );
  settingsModelSelect.replaceChildren(
    ...Object.entries(REALTIME_MODELS).map(([id, { label, costHint }]) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = `${label} (${costHint})`;
      return option;
    }),
  );
}

function renderAgentProfile() {
  agentNameInput.value = agentProfile.name;
  agentAboutInput.value = agentProfile.about;
  agentGoalsInput.value = agentProfile.goals.join("\n");
  agentVoiceSelect.value = agentProfile.voice;
  agentPersonaSelect.value = agentProfile.persona;
  settingsModelSelect.value = agentProfile.model;
}

async function saveAgentProfile() {
  const profile = {
    name: agentNameInput.value,
    about: agentAboutInput.value,
    goals: agentGoalsInput.value.split("\n"),
    voice: agentVoiceSelect.value,
    persona: agentPersonaSelect.value,
    // The model lives in Settings, not the Agent form; preserve it as-is.
    model: agentProfile.model,
  };
  agentStatusElement.textContent = "Saving\u2026";
  try {
    agentProfile = normalizeAgentProfile(await window.brah.setAgentProfile(profile));
    renderAgentProfile();
    agentStatusElement.textContent = "Saved";
    // Voice/instructions are baked into the minted secret, so drop the stale
    // prefetch and prime a fresh one reflecting the updated profile.
    invalidatePrefetchedSecret();
    prefetchRealtimeSecret();
  } catch (error) {
    agentStatusElement.textContent = `Save failed: ${error.message}`;
  }
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
    // Re-pull the full status so the indicator reflects authMethod (a saved API
    // key still wins over the fresh OAuth login for realtime calls).
    await refreshOpenAIStatus();
    setMode("idle");
  } catch (error) {
    setOpenAIConnected(false);
    setStatus(`Connect failed: ${error.message}`);
  } finally {
    callToggleButton.disabled = !isOpenAIConnected;
    headerCallButton.disabled = !isOpenAIConnected;
  }
}

// Build a human-readable error from a failed `/v1/realtime/calls` response.
// OpenAI returns a JSON `{ error: { message } }` body for client errors, but an
// opaque plaintext "Internal Server Error" for 5xx — which is the signature of an
// OAuth login whose underlying OpenAI org has no Platform billing/credits.
async function describeRealtimeCallFailure(response) {
  const body = await response.text();
  let detail = body.trim();
  try {
    const message = JSON.parse(body)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      detail = message.trim();
    }
  } catch {
    // Non-JSON body (e.g. plaintext "Internal Server Error"); keep the raw text.
  }
  return `Realtime call failed (${response.status}): ${detail || "no response body"}${realtimeCallFailureHint(response.status)}`;
}

function realtimeCallFailureHint(status) {
  switch (status) {
    case 401:
      return " — your OpenAI login token is missing, expired, or invalid; sign in again.";
    case 403:
      return " — this OpenAI account isn't authorized for the Realtime API.";
    case 429:
      return " — rate limited or out of Realtime quota/credits; check Platform billing.";
    default:
      if (status >= 500) {
        return " — OpenAI server error; this is on their side, try again shortly.";
      }
      return "";
  }
}

async function toggleCall() {
  if (peerConnection) {
    await stopCall();
    return;
  }

  await startCall();
}

function secretIsFresh(secret) {
  if (!secret?.value) {
    return false;
  }
  // A secret with no expiry hint is assumed usable; otherwise require it to
  // outlive the margin so we never hand `startCall` an about-to-expire token.
  if (typeof secret.expiresAt !== "number") {
    return true;
  }
  return secret.expiresAt - SECRET_EXPIRY_MARGIN_MS > Date.now();
}

// Best-effort: mint an ephemeral secret ahead of the next call so its network
// round-trip overlaps idle time rather than the call-start critical path.
function prefetchRealtimeSecret() {
  if (!isOpenAIConnected || secretPrefetchPromise || secretIsFresh(prefetchedSecret)) {
    return;
  }
  // Back off automatic re-primes after a recent failure; a user-initiated call
  // still fetches on demand via `consumeRealtimeSecret` (which surfaces errors).
  if (
    lastSecretPrefetchFailureAt &&
    Date.now() - lastSecretPrefetchFailureAt < SECRET_PREFETCH_COOLDOWN_MS
  ) {
    return;
  }
  const startedAt = performance.now();
  secretPrefetchPromise = window.brah
    .createRealtimeSecret()
    .then((secret) => {
      prefetchedSecret = secret;
      lastSecretPrefetchFailureAt = 0;
      void writeRendererDiagnostic("call.secret.prefetched", {
        elapsedMs: Math.round(performance.now() - startedAt),
        hasValue: Boolean(secret?.value),
      });
      return secret;
    })
    .catch((error) => {
      // A prefetch failure is non-fatal: `consumeRealtimeSecret` falls back to an
      // on-demand fetch, surfacing any real error there.
      prefetchedSecret = null;
      lastSecretPrefetchFailureAt = Date.now();
      void writeRendererDiagnostic("call.secret.prefetch_failed", formatRendererError(error));
      return null;
    })
    .finally(() => {
      secretPrefetchPromise = null;
    });
}

// Return a fresh secret for a call, preferring the prefetched one, then any
// in-flight prefetch, and falling back to an on-demand fetch. Ephemeral secrets
// are single-use per call, so the cache is cleared once a secret is taken.
async function consumeRealtimeSecret() {
  const startedAt = performance.now();
  if (secretIsFresh(prefetchedSecret)) {
    const secret = prefetchedSecret;
    prefetchedSecret = null;
    void writeRendererDiagnostic("call.secret.consumed", {
      source: "cache_hit",
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return secret;
  }
  if (secretPrefetchPromise) {
    const secret = await secretPrefetchPromise;
    if (secretIsFresh(secret)) {
      prefetchedSecret = null;
      void writeRendererDiagnostic("call.secret.consumed", {
        source: "awaited_prefetch",
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return secret;
    }
  }
  const secret = await window.brah.createRealtimeSecret();
  void writeRendererDiagnostic("call.secret.consumed", {
    source: "on_demand",
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  return secret;
}

// Drop any cached secret when it can no longer be valid (sign-out) or when the
// agent profile that shaped it changed (voice/instructions are baked in).
function invalidatePrefetchedSecret() {
  prefetchedSecret = null;
  // Clear the failure cooldown too, so an explicit invalidation (sign-out,
  // profile change) can re-prime immediately rather than waiting it out.
  lastSecretPrefetchFailureAt = 0;
}

async function startCall() {
  if (!isOpenAIConnected) {
    setStatus("Connect first");
    return;
  }

  callToggleButton.disabled = true;
  headerCallButton.disabled = true;
  resetTranscriptBuffer();
  // Close the panel inside the layout swap's hidden phase (not before it), so the
  // large idle orb never flashes at panel size between the panel hiding and the
  // call pill appearing. The panel fades out, then the call pill fades in.
  void setCallActive(true, {
    onHidden: async () => {
      if (panelController.isOpen()) {
        await panelController.close({ immediate: true, skipWindowMode: true });
      }
    },
  });
  setStatus("Starting…");
  setMode("connecting");
  await writeRendererDiagnostic("call.start", {
    mediaDevicesAvailable: Boolean(navigator.mediaDevices?.getUserMedia),
  });

  try {
    // The secret fetch (network) and mic acquisition (permission/device) are
    // independent, so run them concurrently to overlap their round-trips. The
    // secret is usually already prefetched, making this effectively just the
    // getUserMedia wait.
    const [secret, stream] = await Promise.all([
      consumeRealtimeSecret(),
      acquireMicrophoneStream(),
    ]);
    localStream = stream;
    showCallModelPending(secret?.model);
    await writeRendererDiagnostic("call.secret.created", {
      hasValue: Boolean(secret?.value),
      model: secret?.model,
      authMethod: secret?.authMethod,
    });
    await writeRendererDiagnostic("call.microphone.stream", describeMediaStream(localStream));
    startAudioLevelMonitor(localStream);
    void populateMicDevices();

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
      sendRealtimeWelcome();
    });
    dataChannel.addEventListener("message", (event) => {
      const realtimeEvent = JSON.parse(event.data);
      // Skip high-frequency streaming deltas so the diagnostic log stays a
      // readable, copy-pasteable record of meaningful events.
      if (!isNoisyRealtimeEvent(realtimeEvent?.type)) {
        void writeRendererDiagnostic("realtime.event", summarizeRealtimeEvent(realtimeEvent));
      }
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
      throw new Error(await describeRealtimeCallFailure(sdpResponse));
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
  if (welcomeMicGuardTimer !== null) {
    clearTimeout(welcomeMicGuardTimer);
    welcomeMicGuardTimer = null;
  }
  // Persist the final turn before teardown (the extractor writes to disk
  // regardless of call state), then clear the buffer for the next call.
  void runMemoryExtraction();
  resetTranscriptBuffer();
  clearCallToasts();
  playbackTracker.reset();
  responseCoordinator.reset();
  waitingSound.reset();

  realtimeToolHandler.reset();
  hideToolActivity();
  hideCallModelBadge();
  remoteAudioElement.srcObject = null;
  // Open the panel inside the swap's hidden phase so the call pill fades out
  // straight into the panel — the large idle orb never flashes at panel size.
  await setCallActive(false, {
    inactiveWindowMode: "panel",
    onHidden: async () => {
      await panelController.open({ skipWindowMode: true });
    },
  });
  // Defensive: if the call was already inactive (e.g. a second stopCall from the
  // connection-state handler), setCallActive no-ops and its onHidden never runs.
  // open() is idempotent, so this guarantees the panel is shown either way.
  await panelController.open();
  setMode("idle");
  setStatus(isOpenAIConnected ? "Ready" : "Connect OpenAI");
  // Re-prime a secret so the next call starts without the client_secret wait.
  prefetchRealtimeSecret();
}

async function handleRealtimeEvent(event) {
  playbackTracker.observe(event);
  // The welcome greeting finished playing through the speakers — safe to listen.
  if (welcomeMicGuardTimer !== null && event.type === "output_audio_buffer.stopped") {
    endWelcomeMicGuard();
  }
  if (event.type === "session.created") {
    // Ground truth for which model is actually running this call.
    confirmCallModel(event.session?.model);
  }
  const queuedCreate = responseCoordinator.observe(event);
  if (queuedCreate) {
    // The active response just ended; release the create we queued earlier.
    sendRealtimeDataChannelEvent(queuedCreate);
  }
  if (await realtimeToolHandler.handleEvent(event)) {
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    // The user's transcribed turn just finalized — buffer it and schedule extraction.
    recordTranscriptTurn("user", event.transcript);
    scheduleMemoryExtraction();
    return;
  }
  if (event.type === "response.output_audio_transcript.done") {
    // The assistant's spoken turn finalized — buffer it for transcript context.
    recordTranscriptTurn("assistant", event.transcript);
    return;
  }
  if (event.type === "input_audio_buffer.speech_started") {
    // The user started talking: cut off any assistant audio immediately rather than
    // waiting for the server VAD round-trip, then return to listening.
    interruptAssistantPlayback();
    waitingSound.stop();
    setStatus("Listening");
    setMode("listening");
    return;
  }
  if (
    event.type === "output_audio_buffer.started" ||
    event.type === "response.output_audio.delta"
  ) {
    // The agent resumed speaking — the post-tool wait is over. Brah is WebRTC, so
    // assistant audio rides the media track and response.output_audio.delta never
    // fires; output_audio_buffer.started is the real "now speaking" signal (the
    // delta is kept too for any WebSocket fallback). This is what actually stops
    // the waiting ambience after a tool call.
    waitingSound.stop();
    setStatus("Speaking");
    setMode("speaking");
    return;
  }
  if (event.type === "response.done") {
    // Deliberately do NOT stop the waiting sound here: a tool call's own response
    // completes (response.done) right after the tool runs but BEFORE the agent's
    // spoken reply is generated, so stopping here would cut the sound off mid-wait.
    // The sound is stopped when audio actually resumes (output_audio.delta) or the
    // user barges in (speech_started); call end calls reset().
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
    // A response.create that raced an already-active response is a recoverable
    // barge-in/VAD race, not a session failure: re-queue it to retry on the
    // next response.done rather than surfacing an error.
    if (isActiveResponseConflictError(event.error)) {
      responseCoordinator.noteActiveResponseConflict();
      void writeRendererDiagnostic("realtime.response_create.conflict", {
        code: event.error?.code,
      });
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

function buildAudioConstraints() {
  // Echo cancellation is essential on laptop speakers: without it the mic
  // captures the assistant's own audio (e.g. the welcome greeting), the
  // semantic VAD treats it as a user turn, and the model replies to itself.
  // Pinning the chosen input device re-runs this processing for that mic, so
  // switching devices adjusts the capture pipeline dynamically.
  const base = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  return selectedMicId ? { ...base, deviceId: { exact: selectedMicId } } : base;
}

async function loadMicPreference() {
  try {
    selectedMicId = (await window.brah.getMicrophoneDevice()) ?? null;
  } catch {
    selectedMicId = null;
  }
}

async function populateMicDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  // Windows lists "default"/"communications" pseudo-devices alongside the real
  // ones; drop them (and any unlabeled placeholders) so the list is the same
  // shape on macOS and Windows, with our own "Default microphone" entry on top.
  const inputs = devices.filter(
    (device) => device.kind === "audioinput" && isRealAudioInputId(device.deviceId),
  );
  const activeDeviceId = localStream?.getAudioTracks?.()[0]?.getSettings?.().deviceId ?? null;
  const options = [createMicOption("", "Default microphone")];
  inputs.forEach((device, index) => {
    options.push(createMicOption(device.deviceId, device.label || `Microphone ${index + 1}`));
  });
  micSelectElement.replaceChildren(...options);
  // Reflect the device actually in use during a call, else the saved choice.
  const desired = activeDeviceId ?? selectedMicId ?? "";
  micSelectElement.value = options.some((option) => option.value === desired) ? desired : "";
}

function createMicOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function isRealAudioInputId(deviceId) {
  return (
    typeof deviceId === "string" &&
    deviceId !== "" &&
    deviceId !== "default" &&
    deviceId !== "communications"
  );
}

// Acquires the mic with the chosen device + echo cancellation. If a pinned
// device is missing (unplugged, or saved on a different machine/OS), it falls
// back to the system default so calls still connect cross-platform.
async function acquireMicrophoneStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints() });
  } catch (error) {
    if (!selectedMicId) {
      throw error;
    }
    await writeRendererDiagnostic("audio.mic.fallback_default", {
      deviceId: selectedMicId,
      error: error instanceof Error ? error.name : String(error),
    });
    selectedMicId = null;
    try {
      await window.brah.setMicrophoneDevice(null);
    } catch {
      // Persisting the fallback is best-effort.
    }
    return navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints() });
  }
}

async function handleMicSelection() {
  selectedMicId = micSelectElement.value || null;
  try {
    await window.brah.setMicrophoneDevice(selectedMicId);
  } catch (error) {
    await writeRendererDiagnostic("audio.mic.persist_failed", formatRendererError(error));
  }
  // Apply live if a call is active; otherwise it takes effect on the next call.
  if (peerConnection && localStream) {
    await switchMicrophone();
  }
}

async function switchMicrophone() {
  try {
    const newStream = await acquireMicrophoneStream();
    const [newTrack] = newStream.getAudioTracks();
    if (!newTrack) {
      return;
    }
    const sender = peerConnection?.getSenders().find((entry) => entry.track?.kind === "audio");
    if (sender) {
      await sender.replaceTrack(newTrack);
    }
    for (const track of localStream.getTracks()) {
      track.stop();
    }
    localStream = newStream;
    startAudioLevelMonitor(localStream);
    await writeRendererDiagnostic("audio.mic.switched", describeMediaStream(localStream));
    void populateMicDevices();
  } catch (error) {
    await writeRendererDiagnostic("audio.mic.switch_failed", formatRendererError(error));
  }
}

function sendRealtimeWelcome() {
  // Laptop speakers echo the greeting into the mic and (even with echo
  // cancellation) the eager semantic VAD hears it as a user turn, making the
  // model reply to itself. Mute the mic for the greeting — no user input is
  // expected during it — and unmute once its audio finishes playing.
  beginWelcomeMicGuard();
  sendRealtimeDataChannelEvent({
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: buildWelcomeInstructions(agentProfile),
    },
  });
}

function beginWelcomeMicGuard() {
  setMicrophoneMuted(true);
  if (welcomeMicGuardTimer !== null) {
    clearTimeout(welcomeMicGuardTimer);
  }
  // Safety net: never leave the mic muted if the audio-stopped event is missed.
  welcomeMicGuardTimer = setTimeout(endWelcomeMicGuard, 12000);
}

function endWelcomeMicGuard() {
  if (welcomeMicGuardTimer === null) {
    return;
  }
  clearTimeout(welcomeMicGuardTimer);
  welcomeMicGuardTimer = null;
  setMicrophoneMuted(false);
}

function setMicrophoneMuted(muted) {
  if (!localStream) {
    return;
  }
  for (const track of localStream.getAudioTracks()) {
    track.enabled = !muted;
  }
}

function sendRealtimeDataChannelEvent(event) {
  if (event?.type === "response.create") {
    // Only one response may be in progress at a time. Gate creates through the
    // coordinator so a barge-in/VAD-initiated response doesn't collide with our
    // welcome or tool-output creates; queued creates flush on response.done.
    const allowed = responseCoordinator.requestCreate(event);
    if (!allowed) {
      void writeRendererDiagnostic("realtime.response_create.queued", {});
      return;
    }
  }
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

// Streaming/per-token events that fire dozens of times per turn and add no
// diagnostic value; everything else (lifecycle, errors, tool calls) is kept.
const NOISY_REALTIME_EVENTS = new Set([
  "response.function_call_arguments.delta",
  "response.output_audio_transcript.delta",
  "response.output_audio.delta",
  "response.output_text.delta",
  "response.audio_transcript.delta",
  "response.audio.delta",
  "response.text.delta",
  "conversation.item.input_audio_transcription.delta",
  "rate_limits.updated",
]);

function isNoisyRealtimeEvent(type) {
  return typeof type === "string" && NOISY_REALTIME_EVENTS.has(type);
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
  waveGradient.addColorStop(0, "#6b62f2");
  waveGradient.addColorStop(0.5, "#b855e7");
  waveGradient.addColorStop(1, "#60a5fa");
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
  void connectOpenAI();
});
settingsToggleButton.addEventListener("click", () => {
  setMenuOpen(false);
  settingsPanelElement.hidden = !settingsPanelElement.hidden;
  if (!settingsPanelElement.hidden) {
    apiKeyInput.value = "";
    void refreshOpenAIStatus();
    void loadAgentProfile();
  }
});
settingsBackButton.addEventListener("click", () => {
  settingsPanelElement.hidden = true;
});
settingsModelSelect.addEventListener("change", () => {
  void handleModelSelection();
});
permissionsToggleButton.addEventListener("click", () => {
  setMenuOpen(false);
  permissionsPanelElement.hidden = !permissionsPanelElement.hidden;
  if (!permissionsPanelElement.hidden) {
    void refreshOsPermissions();
  }
});
agentToggleButton.addEventListener("click", () => {
  setMenuOpen(false);
  agentPanelElement.hidden = !agentPanelElement.hidden;
  if (!agentPanelElement.hidden) {
    agentStatusElement.textContent = "";
    void loadAgentProfile();
  }
});
agentBackButton.addEventListener("click", () => {
  agentPanelElement.hidden = true;
});
agentFormElement.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAgentProfile();
});
apiKeySaveButton.addEventListener("click", () => {
  void saveApiKey();
});
apiKeyClearButton.addEventListener("click", () => {
  void clearApiKey();
});
windowMinimizeButton.addEventListener("click", () => {
  setMenuOpen(false);
  void window.brah.minimizeWindow();
});
appQuitButton.addEventListener("click", () => {
  setMenuOpen(false);
  void window.brah.quitApp();
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

initClickSound();

callToggleButton.addEventListener("click", toggleCall);
headerCallButton.addEventListener("click", toggleCall);
callEndButton.addEventListener("click", () => {
  // Same button, context-aware: during computer use it stops the task and keeps
  // the call going; otherwise it ends the call.
  if (appShellElement.dataset.toolActivity === "active") {
    void stopComputerUse();
  } else {
    void stopCall();
  }
});
micSelectElement.addEventListener("change", () => {
  void handleMicSelection();
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void populateMicDevices();
});
setOrbLevel(0);

refreshOpenAIStatus().catch((error) => {
  setOpenAIConnected(false);
  setStatus(`Status failed: ${error.message}`);
});
refreshOsPermissions().catch((error) => {
  setStatus(`Permissions failed: ${error.message}`);
});
populateAgentOptions();
loadAgentProfile().catch((error) => {
  setStatus(`Agent profile failed: ${error.message}`);
});
loadMicPreference()
  .then(() => populateMicDevices())
  .catch(() => {});
