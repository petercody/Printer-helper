# raw-print — Windows tray app

The same local print agent, wrapped in a small Electron app so it lives in the
Windows **system tray** (the icons at the bottom-right of the taskbar) instead
of a terminal window. It:

- starts the HTTP agent (`http://localhost:9100`) in the background,
- shows a tray icon with a right-click menu (open window, start-on-login,
  edit config, restart, quit),
- opens a small window on click that lists the detected printers and status,
- starts automatically when Windows logs in.

Your existing server logic in `src/` is untouched — the Electron shell just
runs it in-process.

---

## Build the installer (`.exe`)

The installer must be built **on a Windows machine** (electron-builder packages
native Windows binaries and the NSIS installer). Node 18+ required.

```powershell
cd raw-print
npm install
npm run dist
```

The signed-less installer appears in `dist\`:

```
dist\raw-print Setup 1.0.0.exe
```

Double-click it to install. It creates Start-menu and desktop shortcuts, and
the app registers itself to start on login the first time it runs.

> Prefer a portable build with no installer? Run `npm run pack` — the ready-to-run
> app lands in `dist\win-unpacked\raw-print.exe`.

---

## Run it in development (no packaging)

On any OS with Node installed:

```bash
npm install
npm run app
```

This launches the tray app directly via Electron so you can test before building.

---

## Configuration

On first launch the app writes a config file to your Windows user profile:

```
%APPDATA%\raw-print\config.env
```

Right-click the tray icon → **Edit configuration…** to open it. The only
settings are the port and allowed origins:

```
PORT=9100
ALLOWED_ORIGIN=*
```

Printers are auto-detected — you don't configure them here. Your app chooses
which file goes to which printer per request (see `README.md`). Use **Restart
agent** from the tray menu (or the Restart button in the window) to apply
changes. The window lists all detected printers.

---

## Notes

- **Start on login** is enabled on first run and can be toggled from the tray
  menu — this replaces the need for pm2 / nssm.
- Closing the window only hides it; the agent keeps running in the tray. Use
  **Quit raw-print** to stop it fully.
- `pdf-to-printer`'s bundled silent-print helper is unpacked from the app
  archive (`asarUnpack`) so printing works from the installed build.
- The HTTP API (`/health`, `/printers`, `/print`) is unchanged — see
  `README.md` and `nextjs-integration.md` for wiring it into your app.
