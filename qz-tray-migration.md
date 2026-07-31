# Replacing QZ Tray with Printer Connect

Your app already does the hard part: `usePrintFormat` generates finished **SBPL
strings**, and every print flow ends in the same two calls —

```ts
import { startQZ, printSBPL } from '@/components/custom/print-component';

await startQZ();
await printSBPL(printerName, [sbpl]);      // single
await printSBPL(printerName, sbplBatch);   // bulk (array of labels)
```

So the migration is contained to **one file**: `@/components/custom/print-component`.
Reimplement `startQZ` and `printSBPL` to call Printer Connect's `/print-raw` endpoint.
Nothing in `use-print.ts`, `use-table.tsx`, or your SBPL generators changes.

`printerName` stays exactly what it is today: the **OS printer name**. That's the
same value QZ Tray used (`qz.configs.create(printerName)`), and Printer Connect sends
your bytes to that named printer through the OS spooler using the RAW datatype.

---

## The mapping

| QZ Tray                                                   | Printer Connect                                              |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `qz.websocket.connect()`                                  | `GET /health` (or nothing — no handshake needed)       |
| `qz.printers.find()`                                       | `GET /printers`                                        |
| `qz.configs.create(printerName)`                          | just pass `printer: printerName` in the request        |
| `qz.print(cfg, [{type:'raw', format:'command', data}])`   | `POST /print-raw` with `{ jobs:[{ data, printer }] }`  |
| Code signing / certificate / private key                  | none — nothing to sign                                 |

Because SBPL here is built only from `STX` (`\x02`), `ESC` (`\x1B`), `ETX`
(`\x03`) and hex-encoded graphics — all ASCII bytes under `0x80` — the label can
travel as a plain JSON `data` string with no corruption. (If you ever embed raw
binary bytes ≥ `0x80`, send `dataBase64` instead of `data`.)

---

## Drop-in replacement for `print-component`

```ts
// components/custom/print-component.ts
// Printer Connect replacement for QZ Tray. Same exports, same signatures — callers
// (use-print.ts / use-table.tsx) don't change.

const AGENT_URL =
  process.env.NEXT_PUBLIC_PRINT_AGENT_URL ?? 'http://localhost:9100';

/**
 * QZ Tray needed a websocket handshake before printing. Printer Connect doesn't —
 * we just confirm the local agent is running so "agent not installed / not
 * started" fails early and clearly, the way a failed qz.websocket.connect() did.
 */
export async function startQZ(): Promise<void> {
  try {
    const res = await fetch(`${AGENT_URL}/health`);
    if (!res.ok) throw new Error(`agent responded ${res.status}`);
  } catch (err) {
    throw new Error(
      `Print agent not reachable at ${AGENT_URL}. Is Printer Connect running on this machine? (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
}

/**
 * Send one or more raw SBPL labels to a named OS printer.
 * Returns `true` on success and throws on failure — mirroring qz.print(), which
 * rejects on error. Every caller already wraps this in try/catch, so a failed
 * send is surfaced as a toast and never marks the request "Fulfilled".
 */
export async function printSBPL(
  printerName: string,
  data: string[]
): Promise<true> {
  if (!printerName) throw new Error('No printer selected.');
  if (!data?.length) throw new Error('Nothing to print.');

  let res: Response;
  try {
    res = await fetch(`${AGENT_URL}/print-raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // one job per label, all routed to the same printer by name
      body: JSON.stringify({
        jobs: data.map(sbpl => ({ data: sbpl, printer: printerName })),
      }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach print agent at ${AGENT_URL}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(body.error || `Print failed (${res.status}).`);
  }
  return true;
}

/**
 * Optional — if your printer picker was populated via qz.printers.find(),
 * use this instead. Returns OS printer names.
 */
export async function listPrinters(): Promise<string[]> {
  const res = await fetch(`${AGENT_URL}/printers`);
  const body = await res.json();
  return (body.printers ?? []).map((p: { name: string }) => p.name);
}
```

> **Return-value note.** Your bulk handler reads `if (res === true) { … } else { res.message }`.
> This version returns `true` on success and **throws** on failure, which your
> bulk `try/catch` already handles (it toasts `error.message`) — so the `else`
> branch simply becomes belt-and-suspenders. The upside over returning an error
> object: your **single**-print flows (`handlePrintSticker`, `handlePrintCaseMark`)
> don't inspect the return value, so throwing is what stops them from marking a
> failed job `Fulfilled`.

---

## Direct-to-IP (optional)

If some label printers have no driver installed on the machine, target them by
socket instead of by name — same endpoint, swap `printer` for `host`/`port`:

```ts
body: JSON.stringify({
  jobs: data.map(sbpl => ({ data: sbpl, host: '192.168.1.50', port: 9100 })),
}),
```

---

## Env

```bash
# .env.local — only if the agent isn't on localhost:9100
NEXT_PUBLIC_PRINT_AGENT_URL=http://localhost:9100
```

## Checklist

1. Install and run Printer Connect on the machine the SATO printer is attached to
   (`npm start`, or the tray app — see `README.md` / `windows-app.md`).
2. Confirm the printer name: open `http://localhost:9100/printers`. It must match
   the `printerName` your store sends.
3. Replace `components/custom/print-component` with the file above.
4. Remove the QZ Tray dependency and its certificate/signing setup.
5. Print a test sticker. If it comes out, you're done.
