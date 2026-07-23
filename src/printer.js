// Cross-platform printing.
//  - Windows: uses the `pdf-to-printer` package (bundles a silent PDF printer).
//  - macOS / Linux: shells out to CUPS (`lp` / `lpstat`), which ship with the OS.
//
// The Windows-only dependency is imported lazily so it is never loaded on unix.

import { platform } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
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
