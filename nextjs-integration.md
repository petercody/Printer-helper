# Wiring raw-print into your Next.js app

Your Print button currently generates one or more files and downloads them.
Replace the download step with a call to the agent. This code runs in the
**browser** (a Client Component), on the machine connected to the printers.

## The helper

```ts
// lib/printToAgent.ts
const AGENT_URL =
  process.env.NEXT_PUBLIC_PRINT_AGENT_URL ?? "http://localhost:9100";

type PrintJob = {
  file: Blob;
  filename: string;
  printer: string; // which printer this file prints to (required)
};

export async function printToAgent(jobs: PrintJob[]) {
  const fd = new FormData();
  jobs.forEach((job) => fd.append("files", job.file, job.filename));

  // Route each file to its printer by filename via the "jobs" field.
  fd.append(
    "jobs",
    JSON.stringify(jobs.map((j) => ({ file: j.filename, printer: j.printer })))
  );

  const res = await fetch(`${AGENT_URL}/print`, {
    method: "POST",
    body: fd, // don't set Content-Type; the browser adds the multipart boundary
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Print failed");
  return data; // { ok: true, printed: [...] }
}
```

## Using it in your Print handler

The number of files is dynamic — one, two, five, however many you generate:

```ts
"use client";
import { printToAgent } from "@/lib/printToAgent";

async function handlePrint() {
  try {
    // however you build them today — example with three files:
    await printToAgent([
      { file: file1, filename: "receipt.pdf", printer: "Front Desk Printer" },
      { file: file2, filename: "label.pdf", printer: "Kitchen Printer" },
      { file: file3, filename: "copy.pdf", printer: "Receipt Printer" },
    ]);
    // optionally show a success toast
  } catch (err) {
    console.error(err);
    // optionally: fall back to your old download behavior here
  }
}
```

Populate the printer choices from the agent's auto-detected list
(`GET /printers`) so users pick real printer names:

```ts
const { printers } = await fetch(`${AGENT_URL}/printers`).then((r) => r.json());
// printers: [{ name, id }, ...] — use `name` values in your UI dropdown
```

## If your PDFs are generated on the Next.js server

Fetch them into the browser first, then hand the blobs to `printToAgent`:

```ts
const [file1, file2, file3] = await Promise.all([
  fetch("/api/print/file1").then((r) => r.blob()),
  fetch("/api/print/file2").then((r) => r.blob()),
  fetch("/api/print/file3").then((r) => r.blob()),
]);
await printToAgent([
  { file: file1, filename: "file1.pdf", printer: "Front Desk Printer" },
  { file: file2, filename: "file2.pdf", printer: "Kitchen Printer" },
  { file: file3, filename: "file3.pdf", printer: "Receipt Printer" },
]);
```

## Optional env var

```bash
# .env.local  (only needed if the agent isn't on localhost:9100)
NEXT_PUBLIC_PRINT_AGENT_URL=http://localhost:9100
```

## Graceful check before printing

If you want to detect whether the agent is running (e.g. to disable the button):

```ts
async function agentIsUp() {
  try {
    const r = await fetch(`${AGENT_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}
```
