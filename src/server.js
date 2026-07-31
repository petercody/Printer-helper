import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  listPrinters,
  printFile,
  printRawToPrinter,
  printRawTcp,
} from "./printer.js";

// Read config from the environment. These are read lazily inside startServer so
// that the Electron main process can set/refresh them before booting.
function readConfig() {
  const port = Number(process.env.PORT) || 9100;
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  return { port, allowedOrigin };
}

// Build the Express app. Exposed separately so it can be tested or mounted.
export function createApp({ allowedOrigin = "*" } = {}) {
  const app = express();
  const upload = multer({ dest: os.tmpdir() });

  // Raw jobs arrive as JSON. Generous limit: label payloads with embedded
  // graphics (e.g. ~GF fields in ZPL) can be large. Only application/json is
  // parsed here, so multipart uploads to /print are unaffected.
  app.use(express.json({ limit: "25mb" }));

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

    // Resolve `printers[]` (one printer per uploaded file, in order) from one
    // of two inputs, in priority order:
    //   1. `jobs`     — a JSON array of { file, printer } objects. Each entry's
    //                   printer is matched to the uploaded file with the same
    //                   originalname. This is the recommended shape.
    //   2. `printers` — a JSON array of printer names, positional (file order).
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
    }

    if (!Array.isArray(printers) || printers.length !== files.length) {
      await cleanup(files);
      return res.status(400).json({
        error: `Got ${files.length} file(s) but ${
          Array.isArray(printers) ? printers.length : 0
        } printer(s). Send one printer per file via 'jobs' (recommended) or 'printers'.`,
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

  // --- Print raw command payloads (ZPL / SBPL / EPL / ESC-POS) ---------------
  // Sends bytes to the printer verbatim — no PDF rendering. This is the
  // drop-in for QZ Tray's `{ type: 'raw' }` jobs.
  //
  // Body (application/json), either a single job at the top level or a `jobs`
  // array. Each job needs a payload and a target:
  //   payload — `data` (a raw string, e.g. "^XA...^XZ") OR
  //             `dataBase64` (base64, for binary payloads).
  //   target  — `printer` (OS printer name, via the spooler) OR
  //             `host` + optional `port` (default 9100, direct TCP).
  //
  // Examples:
  //   { "data": "^XA^FO50,50^A0N,40^FDHello^FS^XZ", "printer": "Zebra ZTC" }
  //   { "jobs": [ { "data": "...", "host": "192.168.1.50", "port": 9100 } ] }
  app.post("/print-raw", async (req, res) => {
    const body = req.body || {};
    const rawJobs = Array.isArray(body.jobs) ? body.jobs : [body];

    if (!rawJobs.length || rawJobs.every((j) => !j || typeof j !== "object")) {
      return res.status(400).json({
        error:
          "Send a job as { data|dataBase64, printer|host } or a 'jobs' array of them.",
      });
    }

    // Validate everything up front so we never half-print a batch.
    const jobs = [];
    for (let i = 0; i < rawJobs.length; i++) {
      const j = rawJobs[i] || {};
      const where = rawJobs.length > 1 ? ` (job ${i})` : "";

      let bytes;
      if (typeof j.data === "string" && j.data.length) {
        bytes = Buffer.from(j.data, "utf8");
      } else if (typeof j.dataBase64 === "string" && j.dataBase64.length) {
        bytes = Buffer.from(j.dataBase64, "base64");
        if (!bytes.length) {
          return res
            .status(400)
            .json({ error: `'dataBase64' is not valid base64${where}.` });
        }
      } else {
        return res.status(400).json({
          error: `Each job needs a non-empty 'data' (string) or 'dataBase64'${where}.`,
        });
      }

      const hasPrinter = j.printer && String(j.printer).trim();
      const hasHost = j.host && String(j.host).trim();
      if (!hasPrinter && !hasHost) {
        return res.status(400).json({
          error: `Each job needs a 'printer' name or a 'host'${where}.`,
        });
      }

      if (hasHost) {
        const port = j.port === undefined ? 9100 : Number(j.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return res
            .status(400)
            .json({ error: `'port' must be 1–65535${where}.` });
        }
        jobs.push({ bytes, host: String(j.host).trim(), port });
      } else {
        jobs.push({ bytes, printer: String(j.printer).trim() });
      }
    }

    try {
      // Sequential on purpose: avoids driver/socket contention between jobs.
      const printed = [];
      for (const job of jobs) {
        if (job.host) {
          await printRawTcp(job.bytes, job.host, job.port);
          printed.push({ target: `${job.host}:${job.port}`, bytes: job.bytes.length });
        } else {
          await printRawToPrinter(job.bytes, job.printer);
          printed.push({ target: job.printer, bytes: job.bytes.length });
        }
      }
      res.json({ ok: true, printed });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
 * @returns {Promise<{ server: import('http').Server, port: number }>}
 */
export function startServer(log = console.log) {
  const { port, allowedOrigin } = readConfig();
  const app = createApp({ allowedOrigin });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      log(`raw-print agent listening on http://localhost:${port}`);
      log(
        `  open http://localhost:${port}/printers to see available printer names; send one printer per file via the 'jobs' field on each request`
      );
      log(
        `  POST /print for PDFs (rendered) — POST /print-raw for ZPL/SBPL/raw command payloads (sent verbatim)`
      );
      resolve({ server, port });
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
