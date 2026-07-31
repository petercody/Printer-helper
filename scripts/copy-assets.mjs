// Copy non-TypeScript Electron resources into the compiled output tree so the
// packaged app finds them next to main.js. Cross-platform (used on Windows CI
// and macOS), so it relies only on Node's fs APIs — no shell tools.

import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcElectron = path.join(root, "electron");
const outElectron = path.join(root, "dist", "electron");

const items = ["preload.cjs", "window.html", "assets"];

await mkdir(outElectron, { recursive: true });
for (const item of items) {
  await cp(path.join(srcElectron, item), path.join(outElectron, item), {
    recursive: true,
  });
}

console.log(`Copied Electron assets -> ${path.relative(root, outElectron)}`);
