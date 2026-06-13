import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("brah", {
  getOpenAIStatus: () => ipcRenderer.invoke("openai:get-status"),
  loginOpenAI: () => ipcRenderer.invoke("openai:login"),
  logoutOpenAI: () => ipcRenderer.invoke("openai:logout"),
  setOpenAIApiKey: (key) => ipcRenderer.invoke("openai:set-api-key", key),
  clearOpenAIApiKey: () => ipcRenderer.invoke("openai:clear-api-key"),
  createRealtimeSecret: (options) => ipcRenderer.invoke("openai:create-realtime-secret", options),
  getAgentProfile: () => ipcRenderer.invoke("agent:get-profile"),
  setAgentProfile: (profile) => ipcRenderer.invoke("agent:set-profile", profile),
  getMicrophoneDevice: () => ipcRenderer.invoke("audio:get-microphone"),
  setMicrophoneDevice: (deviceId) => ipcRenderer.invoke("audio:set-microphone", deviceId),
  getOsPermissions: () => ipcRenderer.invoke("permissions:get-status"),
  requestOsPermission: (id) => ipcRenderer.invoke("permissions:request", id),
  openOsPermissionSettings: (id) => ipcRenderer.invoke("permissions:open-settings", id),
  getDiagnosticLogPath: () => ipcRenderer.invoke("diagnostics:get-log-path"),
  openDiagnosticLog: () => ipcRenderer.invoke("diagnostics:open-log"),
  writeDiagnosticLog: (event, details) => ipcRenderer.invoke("diagnostics:write", event, details),
  getPrivacyDiagnostics: () => ipcRenderer.invoke("diagnostics:privacy"),
  getRealtimeTools: () => ipcRenderer.invoke("tools:get-definitions"),
  executeRealtimeTool: (name, args) => ipcRenderer.invoke("tools:execute", name, args),
  cancelComputerUse: () => ipcRenderer.invoke("tools:cancel-computer-use"),
  getPlannerTasks: () => ipcRenderer.invoke("planner:list-tasks"),
  getCalendarItems: () => ipcRenderer.invoke("planner:list-calendar"),
  deletePlannerTasks: (ids) => ipcRenderer.invoke("planner:delete-tasks", ids),
  completePlannerTasks: (ids) => ipcRenderer.invoke("planner:complete-tasks", ids),
  deleteCalendarItems: (ids) => ipcRenderer.invoke("planner:delete-calendar-items", ids),
  listScreenshots: () => ipcRenderer.invoke("screenshots:list"),
  revealScreenshot: (name) => ipcRenderer.invoke("screenshots:reveal", name),
  deleteScreenshots: (names) => ipcRenderer.invoke("screenshots:delete", names),
  getActivity: (kind) => ipcRenderer.invoke("activity:list", kind),
  setWindowMode: (mode, options) => ipcRenderer.invoke("window:set-mode", mode, options),
  setWindowFocusable: (focusable) => ipcRenderer.invoke("window:set-focusable", focusable),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  onDataChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("data:changed", listener);
    return listener;
  },
  offDataChanged: (listener) => {
    ipcRenderer.removeListener("data:changed", listener);
  },
});
