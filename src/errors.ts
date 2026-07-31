// Typed error hierarchy. Any error thrown with an HTTP status is turned into a
// clean JSON response by the error middleware in server.ts; everything else is
// treated as a 500 so internal details never leak to clients.

export class AppError extends Error {
  /** HTTP status code to send to the client. */
  readonly status: number;
  /** Machine-readable error code for programmatic handling. */
  readonly code: string;
  /** Optional structured details (e.g. zod issues). */
  readonly details?: unknown;

  constructor(
    message: string,
    options: { status: number; code: string; details?: unknown }
  ) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400 — the request was malformed or failed validation. */
export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 400, code: "bad_request", details });
  }
}

/** 500 — something failed while carrying out the request (e.g. a print job). */
export class PrintError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 500, code: "print_failed", details });
  }
}

/** Narrow an unknown thrown value to a readable message. */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}
