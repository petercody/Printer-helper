# raw-print

A tiny local print agent. Your Next.js app sends it any number of files; it
prints each one to its matching printer, silently, no dialog.

It runs on the machine that the printers are installed on. Works with USB
or network printers — anything that shows up in the OS printer list.

- **Windows** — prints via the bundled `pdf-to-printer`.
- **macOS / Linux** — prints via CUPS (`lp`), which ships with the OS.

---

## 1. Install

Copy this folder onto the machine connected to the printers, then:

```bash
cd raw-print
npm install
```

## 2. Find your printer names

```bash
npm run printers
```

Copy the exact names it prints — you'll pass these per request (see Endpoints).
The agent auto-detects installed printers; you don't configure them anywhere.

## 3. Configure (optional)

```bash
cp .env.example .env
```

The only settings are `PORT` and `ALLOWED_ORIGIN`. Printers are **not** set here —
your app picks which file goes to which printer on each `/print` request.

## 4. Run

```bash
npm start
```

You should see: `raw-print agent listening on http://localhost:9100`.

To keep it running permanently in the background, use a process manager such
as [pm2](https://pm2.keymetrics.io/) (`npm i -g pm2 && pm2 start src/server.js --name raw-print && pm2 save`).
On Windows you can instead register it as a service with
[nssm](https://nssm.cc/) so it starts on boot.

---

## Endpoints

| Method | Path         | Purpose                                                                   |
| ------ | ------------ | ------------------------------------------------------------------------- |
| GET    | `/health`    | Check the agent is up.                                                     |
| GET    | `/printers`  | List installed printer names (auto-detected).                             |
| POST   | `/print`     | Multipart upload of any number of `files` (PDFs); renders and prints each. |
| POST   | `/print-raw` | JSON — sends ZPL / SBPL / EPL / ESC-POS bytes to the printer verbatim.     |

`POST /print` (multipart/form-data) takes:

- `files` — one or more file fields (repeat the same field name for each file).
- `jobs` *(recommended)* — a JSON array of `{ file, printer }` objects, where
  `file` matches an uploaded filename, e.g.
  `[{"file":"order.pdf","printer":"Front Desk Printer"}]`. Each file is routed
  to its printer by filename, so array order doesn't matter.
- `printers` *(alternative)* — a JSON array of printer names, positional (same
  order as the files), e.g. `["Front Desk Printer","Kitchen Printer"]`.

Send one printer per file — one, two, or ten. Printer names must match what
`/printers` reports. There is no default printer; every request specifies its own.

### Raw printing — `POST /print-raw` (ZPL / SBPL / EPL / ESC-POS)

Use this for label printers (Zebra = ZPL, SATO = SBPL) that expect command
bytes rather than a rendered PDF. The bytes are sent to the printer **verbatim**
— this is the drop-in for QZ Tray's `{ type: 'raw' }` jobs. See
[`qz-tray-migration.md`](./qz-tray-migration.md) for swapping QZ out.

Body is `application/json`, either a single job or a `jobs` array. Each job needs
a payload and a target:

- **payload** — `data` (a raw string, e.g. `"^XA...^XZ"` or SBPL) **or**
  `dataBase64` (base64, for binary payloads).
- **target** — `printer` (an OS printer name, sent through the spooler with the
  RAW datatype — QZ Tray's default path) **or** `host` + optional `port`
  (default `9100`, a direct TCP socket to the printer, no driver needed).

```jsonc
// by printer name (QZ-style)
{ "data": "^XA^FO50,50^A0N,40,40^FDHello^FS^XZ", "printer": "Zebra ZTC 105" }

// several labels to one printer
{ "jobs": [ { "data": "^XA...^XZ", "printer": "Zebra ZTC 105" },
            { "data": "^XA...^XZ", "printer": "Zebra ZTC 105" } ] }

// direct to a networked printer, no driver installed
{ "data": "^XA...^XZ", "host": "192.168.1.50", "port": 9100 }
```

Returns `{ ok: true, printed: [{ target, bytes }] }`. Jobs run sequentially and
the whole batch is validated before any of it prints.

### Quick manual test

Open `test-client.html` in a browser **on the printer machine**. Add a row per
file, pick PDFs, and click Print. If the pages come out, you're done — wire it
into your app next.

---

## Notes

- **PDFs work best.** Make sure the files your app generates are PDFs.
- **`localhost` + HTTPS is fine.** If your app is served over HTTPS, calls to
  `http://localhost:9100` are *not* blocked as mixed content — browsers treat
  localhost as secure.
- **The call must happen in the browser** on the machine with the printers, so
  that `localhost` resolves to that machine. Don't call the agent from your
  Next.js server (its `localhost` is a different computer).
- See `nextjs-integration.md` for the exact client-side code.
