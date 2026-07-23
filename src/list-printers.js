// Quick CLI: `npm run printers` prints the exact printer names to copy into .env.
import { listPrinters } from "./printer.js";

try {
  const printers = await listPrinters();
  if (!printers.length) {
    console.log("No printers found. Make sure both printers are installed in the OS.");
  } else {
    console.log("Available printers (copy the exact name into .env):\n");
    for (const p of printers) console.log(`  - ${p.name}`);
  }
} catch (err) {
  console.error("Error listing printers:", err.message);
  process.exit(1);
}
