import {
  app,
  Tray,
  Menu,
  BrowserWindow,
  ipcMain,
  shell,
  nativeImage,
  type MenuItemConstructorOptions,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { Server } from "node:http";
import type { Printer } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Electron's `app` gains a custom `isQuitting` flag we set before quit.
declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean;
    }
  }
}

// Types for the lazily-imported server/printer modules.
type StartServer = (log: (msg: string) => void) => Promise<{ server: Server; port: number }>;
type ListPrinters = () => Promise<Printer[]>;

interface Status {
  running: boolean;
  port: number;
  error: string | null;
  configPath: string;
  version: string;
}

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
const logLines: string[] = [];
function log(msg: string): void {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  console.log(line);
  if (win && !win.isDestroyed()) win.webContents.send("log", line);
}

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let serverInfo: { server: Server; port: number } | null = null;
let startError: string | null = null;
let startServer: StartServer | null = null;
let listPrinters: ListPrinters | null = null;

function loadConfig(): void {
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

async function boot(): Promise<void> {
  loadConfig();
  try {
    // Import the compiled server + printer modules (business logic).
    ({ startServer } = (await import("../src/server.js")) as { startServer: StartServer });
    ({ listPrinters } = (await import("../src/printer.js")) as { listPrinters: ListPrinters });
    serverInfo = await startServer(log);
    startError = null;
  } catch (err) {
    startError = err instanceof Error ? err.message : String(err);
    log(`ERROR: could not start agent — ${startError}`);
  }
  refreshTray();
  if (win && !win.isDestroyed()) win.webContents.send("status", getStatus());
}

function getStatus(): Status {
  return {
    running: !!serverInfo && !startError,
    port: serverInfo?.port ?? (Number(process.env["PORT"]) || 9100),
    error: startError,
    configPath: CONFIG_PATH,
    version: app.getVersion(),
  };
}

function trayIconPath(): string {
  // Windows uses the .ico; macOS/Linux must use a PNG because nativeImage
  // cannot decode .ico on macOS (an empty image => invisible menu-bar icon).
  if (process.platform === "win32") {
    const ico = path.join(__dirname, "assets", "icon.ico");
    if (fs.existsSync(ico)) return ico;
  }
  return path.join(__dirname, "assets", "tray.png");
}

function refreshTray(): void {
  if (!tray) return;
  const status = getStatus();
  const state = status.running
    ? `Running on http://localhost:${status.port}`
    : startError
    ? `Stopped — ${startError}`
    : "Starting…";
  tray.setToolTip(`raw-print — ${state}`);

  const template: MenuItemConstructorOptions[] = [
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
    { label: "Edit configuration…", click: () => void shell.openPath(CONFIG_PATH) },
    { label: "Restart agent", click: () => void restartAgent() },
    { type: "separator" },
    { label: "Quit raw-print", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function restartAgent(): Promise<void> {
  log("Restarting agent…");
  try {
    if (serverInfo?.server) {
      await new Promise<void>((resolve) => serverInfo!.server.close(() => resolve()));
    }
  } catch {
    /* ignore close errors */
  }
  serverInfo = null;
  await boot();
}

function showWindow(): void {
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
      win?.hide();
    }
  });
  win.webContents.on("did-finish-load", () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("status", getStatus());
    logLines.forEach((l) => win?.webContents.send("log", l));
  });
}

// --- IPC handlers -----------------------------------------------------------
ipcMain.handle("get-status", () => getStatus());
ipcMain.handle("list-printers", async () => {
  try {
    if (!listPrinters) {
      ({ listPrinters } = (await import("../src/printer.js")) as { listPrinters: ListPrinters });
    }
    return { printers: await listPrinters() };
  } catch (err) {
    return { printers: [], error: err instanceof Error ? err.message : String(err) };
  }
});
ipcMain.handle("open-config", () => shell.openPath(CONFIG_PATH));
ipcMain.handle("restart-agent", async () => {
  await restartAgent();
  return getStatus();
});

// --- App lifecycle ----------------------------------------------------------
app.on("second-instance", showWindow);
app.on("window-all-closed", () => {
  // Do NOT quit when the window closes — this is a tray-resident agent.
});
app.on("before-quit", () => {
  app.isQuitting = true;
});

void app.whenReady().then(async () => {
  let img = nativeImage.createFromPath(trayIconPath());
  if (!img.isEmpty() && process.platform === "darwin") {
    // macOS menu-bar icons render at ~16pt and should be template images
    // so they adapt to light/dark menu bars.
    img = img.resize({ width: 16, height: 16 });
    img.setTemplateImage(true);
  }
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
