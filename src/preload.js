const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aeloria", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setRam: (ram) => ipcRenderer.invoke("set-ram", ram),
  login: () => ipcRenderer.invoke("login"),
  logout: () => ipcRenderer.invoke("logout"),
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status"),
  updateGame: () => ipcRenderer.invoke("update-game"),
  installLauncherUpdate: () => ipcRenderer.invoke("install-launcher-update"),
  onUpdateStatus: (cb) => ipcRenderer.on("update-status", (_e, d) => cb(d)),
  play: () => ipcRenderer.invoke("play"),
  openLink: (url) => ipcRenderer.invoke("open-link", url),
  installShaders: () => ipcRenderer.invoke("install-shaders"),
  openShadersFolder: () => ipcRenderer.invoke("open-shaders-folder"),
  getLogs: () => ipcRenderer.invoke("get-logs"),
  copyLogs: () => ipcRenderer.invoke("copy-logs"),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),
  onLogLine: (cb) => ipcRenderer.on("log-line", (_e, d) => cb(d)),
  openFolder: () => ipcRenderer.invoke("open-folder"),
  serverStatus: () => ipcRenderer.invoke("server-status"),
  minimize: () => ipcRenderer.invoke("win-minimize"),
  maximize: () => ipcRenderer.invoke("win-maximize"),
  close: () => ipcRenderer.invoke("win-close"),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, d) => cb(d)),
  onState: (cb) => ipcRenderer.on("state", (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on("error", (_e, d) => cb(d))
});
