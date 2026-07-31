// Cross-platform printing.
//  - Windows: uses the `pdf-to-printer` package (bundles a silent PDF printer).
//  - macOS / Linux: shells out to CUPS (`lp` / `lpstat`), which ship with the OS.
//
// The Windows-only dependency is imported lazily so it is never loaded on unix.

import { platform, tmpdir } from "node:os";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import path from "node:path";
import { writeFile, unlink } from "node:fs/promises";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const isWindows = platform() === "win32";

let winMod = null;
async function getWin() {
  if (!winMod) {
    const m = await import("pdf-to-printer");
    winMod = m.default ?? m;
  }
  return winMod;
}

// Wrap a value in single quotes, safely, for a unix shell command.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Return the list of printers the OS knows about: [{ name, id }, ...].
 * Run this once to discover the EXACT names to put in your .env file.
 */
export async function listPrinters() {
  if (isWindows) {
    const w = await getWin();
    const printers = await w.getPrinters();
    return printers.map((p) => ({ name: p.name, id: p.deviceId ?? p.name }));
  }

  // CUPS: `lpstat -e` prints one destination name per line.
  try {
    const { stdout } = await execAsync("lpstat -e");
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((name) => ({ name, id: name }));
  } catch (err) {
    throw new Error(
      `Could not list printers via CUPS. Is 'lpstat' installed and are printers configured? (${err.message})`
    );
  }
}

/**
 * Send a single file to a single named printer.
 * @param {string} filePath   Absolute path to the file (PDF recommended).
 * @param {string} printerName Exact printer name as the OS reports it.
 */
export async function printFile(filePath, printerName) {
  if (!printerName) throw new Error("No printer name provided");

  if (isWindows) {
    const w = await getWin();
    await w.print(filePath, { printer: printerName });
    return;
  }

  // CUPS: -d selects the destination printer.
  await execAsync(`lp -d ${shellQuote(printerName)} ${shellQuote(filePath)}`);
}

// ---------------------------------------------------------------------------
// Raw printing (ZPL / SBPL / EPL / ESC-POS — any printer command language)
//
// Unlike printFile, which hands a PDF to the OS driver to render, these send
// bytes to the printer *verbatim*. That's what label printers (Zebra = ZPL,
// SATO = SBPL) expect, and it's exactly what QZ Tray's `{ type: 'raw' }` jobs
// do. Two ways to reach the printer, matching QZ Tray:
//   1. By printer name — through the OS spooler using the RAW datatype
//      (Windows) or `lp -o raw` (CUPS). This is QZ Tray's default path and the
//      drop-in replacement for it.
//   2. By host:port — a direct TCP socket to the printer (label printers listen
//      on port 9100 by default). No driver needs to be installed.
// ---------------------------------------------------------------------------

/**
 * Send raw bytes to a named OS printer through the spooler (RAW datatype).
 * @param {Buffer|string} data  The raw command payload (e.g. a ZPL/SBPL string).
 * @param {string} printerName  Exact printer name as `listPrinters()` reports it.
 */
export async function printRawToPrinter(data, printerName) {
  if (!printerName || !String(printerName).trim()) {
    throw new Error("No printer name provided");
  }
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");

  if (isWindows) return printRawWindows(bytes, String(printerName).trim());

  // CUPS: `-o raw` tells CUPS to pass the file through untouched (no filter).
  const tmp = tmpFile();
  await writeFile(tmp, bytes);
  try {
    await execAsync(
      `lp -o raw -d ${shellQuote(printerName)} ${shellQuote(tmp)}`
    );
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Stream raw bytes straight to a printer over TCP (default port 9100).
 * @param {Buffer|string} data  The raw command payload.
 * @param {string} host         Printer IP or hostname.
 * @param {number} [port=9100]  TCP port (Zebra/SATO/most label printers: 9100).
 * @param {number} [timeoutMs=10000]
 */
export function printRawTcp(data, host, port = 9100, timeoutMs = 10000) {
  if (!host || !String(host).trim()) throw new Error("No host provided");
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () =>
      done(new Error(`Timed out talking to ${host}:${port} after ${timeoutMs}ms`))
    );
    socket.on("error", (err) =>
      done(new Error(`TCP print to ${host}:${port} failed: ${err.message}`))
    );
    // Resolve once the bytes are flushed and the connection closes cleanly.
    socket.on("close", (hadError) => {
      if (!hadError) done();
    });

    socket.connect(port, String(host).trim(), () => {
      socket.end(bytes); // write, then half-close so the printer sees EOF
    });
  });
}

// Send raw bytes to a Windows printer by name using the spooler's RAW
// datatype. pdf-to-printer can't do this, so we P/Invoke winspool.drv
// (OpenPrinter → StartDocPrinter(RAW) → WritePrinter) via a short PowerShell
// snippet. Payload and printer name are passed through env vars and a temp
// file to sidestep any command-line quoting issues.
async function printRawWindows(bytes, printerName) {
  const tmp = tmpFile();
  await writeFile(tmp, bytes);

  const ps = `
$ErrorActionPreference = 'Stop'
$code = @"
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, IntPtr buf, int count, out int written);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    DOCINFO di = new DOCINFO();
    di.pDocName = "raw-print";
    di.pDataType = "RAW";
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("OpenPrinter failed for '" + printer + "' (" + Marshal.GetLastWin32Error() + ")");
    try {
      if (!StartDocPrinter(h, 1, ref di))
        throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        IntPtr p = Marshal.AllocHGlobal(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, p, bytes.Length);
          int written;
          if (!WritePrinter(h, p, bytes.Length, out written))
            throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        } finally { Marshal.FreeHGlobal(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
Add-Type -TypeDefinition $code -Language CSharp
$bytes = [System.IO.File]::ReadAllBytes($env:RAWPRINT_FILE)
[RawPrinterHelper]::Send($env:RAWPRINT_PRINTER, $bytes)
`;

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { env: { ...process.env, RAWPRINT_FILE: tmp, RAWPRINT_PRINTER: printerName } }
    );
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

function tmpFile() {
  return path.join(
    tmpdir(),
    `rawprint-${Date.now()}-${Math.random().toString(36).slice(2)}.prn`
  );
}
