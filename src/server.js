import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { listPrinters, printFile } from "./printer.js";

// Read config from the environment. These are read lazily inside startServer so
// that the Electron main process can set/refresh them before booting.
function readConfig() {
  const port = Number(process.env.PORT) || 9100;
  const defaultPrinters = (process.env.PRINTERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  return { port, defaultPrinters, allowedOrigin };
}

// Build the Express app. Exposed separately so it can be tested or mounted.
export function createApp({ defaultPrinters = [], allowedOrigin = "*" } = {}) {
  const app = express();
  const upload = multer({ dest: os.tmpdir() });

  app.use(
    cors({
      origin:
        allowedOrigin === "*"
          ? true
          : allowedOrigin.split(",").map((s) => s.trim()),
    })
  );

  // --- Health check ---------------------------------------------------------
  app.get("/health", (_req, res) => res.json({ ok: true, service: "raw-print" }));

  // --- Discover printer names -----------------------------------------------
  app.get("/printers", async (_req, res) => {
    try {
      const printers = await listPrinters();
      res.json({ printers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Print any number of files, one per printer ---------------------------
  app.post("/print", upload.array("files"), async (req, res) => {
    const files = req.files || [];
    const body = req.body || {};

    if (!files.length) {
      return res
        .status(400)
        .json({ error: "At least one file is required under the 'files' field." });
    }

    // Resolve `printers[]` (one printer per uploaded file, in order) from any
    // of three inputs, in priority order:
    //   1. `jobs`     — a JSON array of { file, printer } objects. Each entry's
    //                   printer is matched to the uploaded file with the same
    //                   originalname. This is the recommended shape.
    //   2. `printers` — a JSON array of printer names, positional (file order).
    //   3. defaults   — the PRINTERS config, sliced to the number of files.
    let printers;

    if (body.jobs) {
      let jobs;
      try {
        jobs = JSON.parse(body.jobs);
      } catch {
        await cleanup(files);
        return res.status(400).json({
          error: `'jobs' must be a JSON array of { "file": "name.pdf", "printer": "Printer A" } objects.`,
        });
      }
      if (!Array.isArray(jobs) || jobs.length !== files.length) {
        await cleanup(files);
        return res.status(400).json({
          error: `Got ${files.length} file(s) but ${
            Array.isArray(jobs) ? jobs.length : 0
          } job(s). Send one { file, printer } entry per uploaded file.`,
        });
      }
      // Match each uploaded file to its job by filename. Consume matches so
      // duplicate filenames pair up left-to-right instead of colliding.
      const remaining = [...jobs];
      printers = [];
      for (const f of files) {
        const idx = remaining.findIndex(
          (j) => j && j.file === f.originalname
        );
        if (idx === -1) {
          await cleanup(files);
          return res.status(400).json({
            error: `No job entry found for uploaded file '${f.originalname}'. Each 'jobs' entry's "file" must match an uploaded filename.`,
          });
        }
        printers.push(remaining[idx].printer);
        remaining.splice(idx, 1);
      }
    } else if (body.printers) {
      try {
        printers = JSON.parse(body.printers);
      } catch {
        await cleanup(files);
        return res.status(400).json({
          error: `'printers' must be a JSON array of printer names, e.g. ["Printer A","Printer B"].`,
        });
      }
    } else {
      printers = defaultPrinters.slice(0, files.length);
    }

    if (!Array.isArray(printers) || printers.length !== files.length) {
      await cleanup(files);
      return res.status(400).json({
        error: `Got ${files.length} file(s) but ${
          Array.isArray(printers) ? printers.length : 0
        } printer(s). Send one printer per file via 'jobs' or 'printers', or configure enough defaults in the PRINTERS env var.`,
      });
    }
    if (printers.some((p) => !p || !String(p).trim())) {
      await cleanup(files);
      return res
        .status(400)
        .json({ error: "Every printer name must be non-empty." });
    }

    try {
      // Sequential on purpose: avoids driver contention between jobs.
      const printed = [];
      for (let i = 0; i < files.length; i++) {
        const printer = String(printers[i]).trim();
        await printFile(files[i].path, printer);
        printed.push({ file: files[i].originalname, printer });
      }
      res.json({ ok: true, printed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      await cleanup(files);
    }
  });

  return app;
}

async function cleanup(files) {
  await Promise.all(
    files.filter(Boolean).map((f) => fs.unlink(f.path).catch(() => {}))
  );
}

/**
 * Start the print agent HTTP server.
 * @param {(msg: string) => void} [log] optional log sink (defaults to console.log)
 * @returns {Promise<{ server: import('http').Server, port: number, defaultPrinters: string[] }>}
 */
export function startServer(log = console.log) {
  const { port, defaultPrinters, allowedOrigin } = readConfig();
  const app = createApp({ defaultPrinters, allowedOrigin });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      log(`raw-print agent listening on http://localhost:${port}`);
      if (defaultPrinters.length) {
        log(`  default printers (in order): ${defaultPrinters.join(", ")}`);
      } else {
        log(
          `  (no default printers configured — open http://localhost:${port}/printers to see available names, then set PRINTERS, or send a 'printers' field with each request)`
        );
      }
      resolve({ server, port, defaultPrinters });
    });
    server.on("error", reject);
  });
}

// Run directly (`node src/server.js` / `npm start`) — keep CLI behavior.
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startServer().catch((err) => {
    console.error("Failed to start raw-print agent:", err.message);
    process.exit(1);
  });
}
