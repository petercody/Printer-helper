import { app, Tray, Menu, BrowserWindow, ipcMain, shell, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Single instance: a background agent should only ever run once ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// User-editable config lives next to the user's data, not inside the app
// bundle (which is read-only once installed). PORT / ALLOWED_ORIGIN.
const CONFIG_PATH = path.join(app.getPath("userData"), "config.env");

// The rolling in-memory log shown in the window.
const logLines = [];
function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  console.log(line);
  if (win && !win.isDestroyed()) win.webContents.send("log", line);
}

let tray = null;
let win = null;
let serverInfo = null; // { port }
let startError = null;
let startServer = null;
let listPrinters = null;

function loadConfig() {
  // Seed a template config file on first run so users know where to edit.
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(
      CONFIG_PATH,
      [
        "# raw-print configuration",
        "# Port the local agent listens on.",
        "PORT=9100",
        "# Allowed browser origins, or * for any.",
        "ALLOWED_ORIGIN=*",
        "# Printers are auto-detected and chosen per request — none set here.",
        "",
      ].join("\n"),
      "utf8"
    );
  }
  const parsed = dotenv.config({ path: CONFIG_PATH });
  if (parsed.parsed) Object.assign(process.env, parsed.parsed);
}

async function boot() {
  loadConfig();
  try {
    // Import the existing server + printer modules (untouched business logic).
    ({ startServer } = await import("../src/server.js"));
    ({ listPrinters } = await import("../src/printer.js"));
    serverInfo = await startServer(log);
    startError = null;
  } catch (err) {
    startError = err.message;
    log(`ERROR: could not start agent — ${err.message}`);
  }
  refreshTray();
  if (win && !win.isDestroyed()) win.webContents.send("status", getStatus());
}

function getStatus() {
  return {
    running: !!serverInfo && !startError,
    port: serverInfo?.port ?? (Number(process.env.PORT) || 9100),
    error: startError,
    configPath: CONFIG_PATH,
    version: app.getVersion(),
  };
}

function trayIconPath() {
  // A template/PNG icon works for the Windows tray via nativeImage.
  const png = path.join(__dirname, "assets", "tray.png");
  const ico = path.join(__dirname, "assets", "icon.ico");
  return fs.existsSync(ico) ? ico : png;
}

function refreshTray() {
  if (!tray) return;
  const status = getStatus();
  const state = status.running
    ? `Running on http://localhost:${status.port}`
    : startError
    ? `Stopped — ${startError}`
    : "Starting…";
  tray.setToolTip(`raw-print — ${state}`);

  const menu = Menu.buildFromTemplate([
    { label: `raw-print ${status.running ? "● running" : "○ stopped"}`, enabled: false },
    { label: state, enabled: false },
    { type: "separator" },
    { label: "Open window", click: showWindow },
    {
      label: "Start on login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        log(`Start on login: ${item.checked ? "enabled" : "disabled"}`);
      },
    },
    { label: "Edit configuration…", click: () => shell.openPath(CONFIG_PATH) },
    { label: "Restart agent", click: restartAgent },
    { type: "separator" },
    { label: "Quit raw-print", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

async function restartAgent() {
  log("Restarting agent…");
  try {
    if (serverInfo?.server) await new Promise((r) => serverInfo.server.close(r));
  } catch {}
  serverInfo = null;
  await boot();
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    win.webContents.send("status", getStatus());
    return;
  }
  win = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: "raw-print",
    autoHideMenuBar: true,
    icon: trayIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "window.html"));
  win.on("close", (e) => {
    // Closing the window just hides it — the agent keeps running in the tray.
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("status", getStatus());
    logLines.forEach((l) => win.webContents.send("log", l));
  });
}

// --- IPC handlers -----------------------------------------------------------
ipcMain.handle("get-status", () => getStatus());
ipcMain.handle("list-printers", async () => {
  try {
    if (!listPrinters) ({ listPrinters } = await import("../src/printer.js"));
    return { printers: await listPrinters() };
  } catch (err) {
    return { printers: [], error: err.message };
  }
});
ipcMain.handle("open-config", () => shell.openPath(CONFIG_PATH));
ipcMain.handle("restart-agent", async () => {
  await restartAgent();
  return getStatus();
});

// --- App lifecycle ----------------------------------------------------------
app.on("second-instance", showWindow);
app.on("window-all-closed", (e) => {
  // Do NOT quit when the window closes — this is a tray-resident agent.
});
app.on("before-quit", () => {
  app.isQuitting = true;
});

app.whenReady().then(async () => {
  const img = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip("raw-print — starting…");
  tray.on("click", showWindow);
  refreshTray();

  // Enable auto-start on login by default (first run). Users can toggle it off.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  await boot();
});
