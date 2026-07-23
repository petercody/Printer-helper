// CommonJS preload (.cjs so it is never treated as ESM). Exposes a small,
// safe bridge to the renderer — no direct Node access in the window.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rawPrint", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  listPrinters: () => ipcRenderer.invoke("list-printers"),
  openConfig: () => ipcRenderer.invoke("open-config"),
  restartAgent: () => ipcRenderer.invoke("restart-agent"),
  onStatus: (cb) => ipcRenderer.on("status", (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),
});
