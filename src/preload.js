const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gfrpg", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setRam: (ram) => ipcRenderer.invoke("set-ram", ram),
  login: () => ipcRenderer.invoke("login"),
  logout: () => ipcRenderer.invoke("logout"),
  play: () => ipcRenderer.invoke("play"),
  openLink: (url) => ipcRenderer.invoke("open-link", url),
  onProgress: (cb) => ipcRenderer.on("progress", (_e, d) => cb(d)),
  onState: (cb) => ipcRenderer.on("state", (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on("error", (_e, d) => cb(d))
});
