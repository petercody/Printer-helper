// Request validation schemas (zod). These replace the hand-rolled checks in the
// route handlers with declarative schemas that produce typed, ready-to-use data
// and precise error messages.

import { z } from "zod";
import { BadRequestError } from "./errors.js";
import type { RawJob } from "./types.js";

const nonEmpty = z
  .string()
  .trim()
  .min(1, "must be a non-empty string");

// --- /print ---------------------------------------------------------------

/** `jobs` field: one { file, printer } entry per uploaded file. */
export const jobsSchema = z
  .array(
    z.object({
      file: nonEmpty,
      printer: nonEmpty,
    })
  )
  .min(1, "must contain at least one job");

/** `printers` field: positional printer names, one per uploaded file. */
export const printersSchema = z.array(nonEmpty).min(1);

// --- /print-raw -----------------------------------------------------------

const rawJobInputSchema = z
  .object({
    data: z.string().optional(),
    dataBase64: z.string().optional(),
    printer: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strip();

export type RawJobInput = z.infer<typeof rawJobInputSchema>;

/** Body of /print-raw: a single job, or `{ jobs: [...] }`. */
export const rawBodySchema = z.union([
  z.object({ jobs: z.array(rawJobInputSchema).min(1) }),
  rawJobInputSchema,
]);

export type RawBody = z.infer<typeof rawBodySchema>;

/**
 * Turn a validated raw-job input into a dispatchable job (payload as Buffer,
 * target resolved). Throws BadRequestError with a job-scoped message on any
 * problem so the whole batch is rejected before we print anything.
 */
export function resolveRawJob(input: RawJobInput, index: number, total: number): RawJob {
  const where = total > 1 ? ` (job ${index})` : "";

  let bytes: Buffer;
  if (typeof input.data === "string" && input.data.length) {
    bytes = Buffer.from(input.data, "utf8");
  } else if (typeof input.dataBase64 === "string" && input.dataBase64.length) {
    bytes = Buffer.from(input.dataBase64, "base64");
    if (!bytes.length) {
      throw new BadRequestError(`'dataBase64' is not valid base64${where}.`);
    }
  } else {
    throw new BadRequestError(
      `Each job needs a non-empty 'data' (string) or 'dataBase64'${where}.`
    );
  }

  const printer = input.printer?.trim();
  const host = input.host?.trim();

  if (!printer && !host) {
    throw new BadRequestError(`Each job needs a 'printer' name or a 'host'${where}.`);
  }

  if (host) {
    const port = input.port ?? 9100;
    return { bytes, host, port };
  }
  return { bytes, printer: printer as string };
}

/** Normalize the /print-raw body into a flat list of job inputs. */
export function rawJobsFromBody(body: RawBody): RawJobInput[] {
  return "jobs" in body ? body.jobs : [body];
}
