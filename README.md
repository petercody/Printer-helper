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

Copy the exact names it prints.

## 3. Configure

```bash
cp .env.example .env
```

Edit `.env` and set `PRINTERS` to a comma-separated list of the exact names
from step 2, in the order you want files matched to them, e.g.:

```
PRINTERS=Front Desk Printer,Kitchen Printer,Receipt Printer
```

This list can be any length — one printer, two, five, however many you have.

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

| Method | Path        | Purpose                                                        |
| ------ | ----------- | --------------------------------------------------------------- |
| GET    | `/health`   | Check the agent is up.                                          |
| GET    | `/printers` | List installed printer names.                                   |
| POST   | `/print`    | Multipart upload of any number of `files`; prints each in order. |

`POST /print` takes:

- `files` — one or more file fields (repeat the same field name for each file).
- `printers` *(optional)* — a JSON array of printer names, in the same order
  as the files, e.g. `["Front Desk Printer","Kitchen Printer"]`. If omitted,
  the `PRINTERS` list from `.env` is used, sliced to the number of files sent.

The number of files/printers is dynamic — send one, two, or ten; the agent
just pairs each file with the printer at the same position.

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
