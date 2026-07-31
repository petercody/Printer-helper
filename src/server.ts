import "dotenv/config";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import cors from "cors";
import multer from "multer";
import os from "node:os";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  listPrinters,
  printFile,
  printRawToPrinter,
  printRawTcp,
} from "./printer.js";
import { AppError, BadRequestError, toMessage } from "./errors.js";
import {
  jobsSchema,
  printersSchema,
  rawBodySchema,
  rawJobsFromBody,
  resolveRawJob,
} from "./schemas.js";
import type { AgentConfig, PrintedFile, PrintedRaw } from "./types.js";

// Read config from the environment. These are read lazily inside startServer so
// that the Electron main process can set/refresh them before booting.
function readConfig(): AgentConfig {
  const port = Number(process.env["PORT"]) || 9100;
  const allowedOrigin = process.env["ALLOWED_ORIGIN"] || "*";
  return { port, allowedOrigin };
}

/** Wrap an async route so thrown/rejected errors flow to the error middleware. */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Parse a multipart string field as JSON, with a field-specific error. */
function parseJsonField(raw: string, field: string, example: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError(`'${field}' must be ${example}`);
  }
}

// Build the Express app. Exposed separately so it can be tested or mounted.
export function createApp({ allowedOrigin = "*" }: { allowedOrigin?: string } = {}): Express {
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
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "raw-print" });
  });

  // --- Discover printer names -----------------------------------------------
  app.get(
    "/printers",
    asyncHandler(async (_req, res) => {
      const printers = await listPrinters();
      res.json({ printers });
    })
  );

  // --- Print any number of files, one per printer ---------------------------
  app.post(
    "/print",
    upload.array("files"),
    asyncHandler(async (req, res) => {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const body = (req.body ?? {}) as Record<string, unknown>;

      try {
        if (!files.length) {
          throw new BadRequestError(
            "At least one file is required under the 'files' field."
          );
        }

        const printers = resolvePrinters(body, files);

        // Sequential on purpose: avoids driver contention between jobs.
        const printed: PrintedFile[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i]!;
          const printer = printers[i]!;
          await printFile(file.path, printer);
          printed.push({ file: file.originalname, printer });
        }
        res.json({ ok: true, printed });
      } finally {
        await cleanup(files);
      }
    })
  );

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
  app.post(
    "/print-raw",
    asyncHandler(async (req, res) => {
      const parsed = rawBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(
          "Send a job as { data|dataBase64, printer|host } or a 'jobs' array of them.",
          parsed.error.issues
        );
      }

      const inputs = rawJobsFromBody(parsed.data);
      // Validate/resolve everything up front so we never half-print a batch.
      const jobs = inputs.map((input, i) => resolveRawJob(input, i, inputs.length));

      // Sequential on purpose: avoids driver/socket contention between jobs.
      const printed: PrintedRaw[] = [];
      for (const job of jobs) {
        if ("host" in job) {
          await printRawTcp(job.bytes, job.host, job.port);
          printed.push({ target: `${job.host}:${job.port}`, bytes: job.bytes.length });
        } else {
          await printRawToPrinter(job.bytes, job.printer);
          printed.push({ target: job.printer, bytes: job.bytes.length });
        }
      }
      res.json({ ok: true, printed });
    })
  );

  // --- Central error handling ----------------------------------------------
  app.use(errorMiddleware);

  return app;
}

/**
 * Resolve `printers` (one printer per uploaded file, in order) from the request
 * body. Priority: `jobs` (recommended, matched by filename) then `printers`
 * (positional). Throws BadRequestError on any mismatch.
 */
function resolvePrinters(
  body: Record<string, unknown>,
  files: Express.Multer.File[]
): string[] {
  if (typeof body["jobs"] === "string") {
    const raw = parseJsonField(
      body["jobs"],
      "jobs",
      `a JSON array of { "file": "name.pdf", "printer": "Printer A" } objects.`
    );
    const jobs = jobsSchema.safeParse(raw);
    if (!jobs.success) {
      throw new BadRequestError(
        `'jobs' must be a JSON array of { "file": "name.pdf", "printer": "Printer A" } objects.`,
        jobs.error.issues
      );
    }
    if (jobs.data.length !== files.length) {
      throw new BadRequestError(
        `Got ${files.length} file(s) but ${jobs.data.length} job(s). ` +
          `Send one { file, printer } entry per uploaded file.`
      );
    }
    // Match each uploaded file to its job by filename. Consume matches so
    // duplicate filenames pair up left-to-right instead of colliding.
    const remaining = [...jobs.data];
    const printers: string[] = [];
    for (const f of files) {
      const idx = remaining.findIndex((j) => j.file === f.originalname);
      if (idx === -1) {
        throw new BadRequestError(
          `No job entry found for uploaded file '${f.originalname}'. ` +
            `Each 'jobs' entry's "file" must match an uploaded filename.`
        );
      }
      printers.push(remaining[idx]!.printer);
      remaining.splice(idx, 1);
    }
    return printers;
  }

  if (typeof body["printers"] === "string") {
    const raw = parseJsonField(
      body["printers"],
      "printers",
      `a JSON array of printer names, e.g. ["Printer A","Printer B"].`
    );
    const printers = printersSchema.safeParse(raw);
    if (!printers.success) {
      throw new BadRequestError(
        `'printers' must be a JSON array of printer names, e.g. ["Printer A","Printer B"].`,
        printers.error.issues
      );
    }
    if (printers.data.length !== files.length) {
      throw new BadRequestError(
        `Got ${files.length} file(s) but ${printers.data.length} printer(s). ` +
          `Send one printer per file via 'jobs' (recommended) or 'printers'.`
      );
    }
    return printers.data;
  }

  throw new BadRequestError(
    `Got ${files.length} file(s) but 0 printer(s). ` +
      `Send one printer per file via 'jobs' (recommended) or 'printers'.`
  );
}

/** Turn any error into a consistent JSON response. */
function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", code: "bad_request", details: err.issues });
    return;
  }
  res.status(500).json({ error: toMessage(err), code: "internal_error" });
}

async function cleanup(files: Express.Multer.File[]): Promise<void> {
  await Promise.all(
    files.filter(Boolean).map((f) => fs.unlink(f.path).catch(() => {}))
  );
}

/**
 * Start the print agent HTTP server.
 * @param log optional log sink (defaults to console.log)
 */
export function startServer(
  log: (msg: string) => void = console.log
): Promise<{ server: Server; port: number }> {
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

// Run directly (`node dist/src/server.js` / `npm start`) — keep CLI behavior.
const isDirectRun =
  !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startServer().catch((err: unknown) => {
    console.error("Failed to start raw-print agent:", toMessage(err));
    process.exit(1);
  });
}
