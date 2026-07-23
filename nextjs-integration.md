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
  printer?: string; // optional per-call override; otherwise uses .env default at that position
};

export async function printToAgent(jobs: PrintJob[]) {
  const fd = new FormData();
  jobs.forEach((job) => fd.append("files", job.file, job.filename));

  // Only send "printers" if you're overriding — otherwise the agent falls
  // back to the PRINTERS list configured in its .env, matched by position.
  if (jobs.every((j) => j.printer)) {
    fd.append("printers", JSON.stringify(jobs.map((j) => j.printer)));
  }

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

Leaving off `printer` on every job lets the agent use its `.env` `PRINTERS`
default list instead:

```ts
await printToAgent([
  { file: file1, filename: "receipt.pdf" },
  { file: file2, filename: "label.pdf" },
]);
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
  { file: file1, filename: "file1.pdf" },
  { file: file2, filename: "file2.pdf" },
  { file: file3, filename: "file3.pdf" },
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
