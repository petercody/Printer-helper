// Shared domain types used across the print agent.

/** A printer as reported by the OS. */
export interface Printer {
  name: string;
  id: string;
}

/** Result of a completed file print, echoed back to the client. */
export interface PrintedFile {
  file: string;
  printer: string;
}

/** Result of a completed raw print, echoed back to the client. */
export interface PrintedRaw {
  target: string;
  bytes: number;
}

/** A validated raw-print job, ready to dispatch. */
export type RawJob =
  | { bytes: Buffer; printer: string }
  | { bytes: Buffer; host: string; port: number };

/** Runtime configuration read from the environment. */
export interface AgentConfig {
  port: number;
  allowedOrigin: string;
}
