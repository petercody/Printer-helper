import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the printer layer so route tests never touch real hardware.
vi.mock("../src/printer.js", () => ({
  listPrinters: vi.fn(async () => [{ name: "Zebra", id: "Zebra" }]),
  printFile: vi.fn(async () => {}),
  printRawToPrinter: vi.fn(async () => {}),
  printRawTcp: vi.fn(async () => {}),
}));

import request from "supertest";
import { createApp } from "../src/server.js";
import * as printer from "../src/printer.js";

const app = createApp({ allowedOrigin: "*" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /health", () => {
  it("reports ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: "printer-connect" });
  });
});

describe("GET /printers", () => {
  it("returns discovered printers", async () => {
    const res = await request(app).get("/printers");
    expect(res.status).toBe(200);
    expect(res.body.printers).toEqual([{ name: "Zebra", id: "Zebra" }]);
  });

  it("surfaces printer errors as 500", async () => {
    vi.mocked(printer.listPrinters).mockRejectedValueOnce(new Error("no CUPS"));
    const res = await request(app).get("/printers");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("no CUPS");
  });
});

describe("POST /print", () => {
  it("rejects when no files are attached", async () => {
    const res = await request(app).post("/print").field("printers", JSON.stringify(["A"]));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");
  });

  it("prints one file per positional printer", async () => {
    const res = await request(app)
      .post("/print")
      .field("printers", JSON.stringify(["Zebra"]))
      .attach("files", Buffer.from("%PDF-1.4"), "label.pdf");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, printed: [{ file: "label.pdf", printer: "Zebra" }] });
    expect(printer.printFile).toHaveBeenCalledTimes(1);
  });

  it("matches jobs to files by filename", async () => {
    const res = await request(app)
      .post("/print")
      .field("jobs", JSON.stringify([{ file: "b.pdf", printer: "B" }, { file: "a.pdf", printer: "A" }]))
      .attach("files", Buffer.from("%PDF"), "a.pdf")
      .attach("files", Buffer.from("%PDF"), "b.pdf");
    expect(res.status).toBe(200);
    expect(res.body.printed).toEqual([
      { file: "a.pdf", printer: "A" },
      { file: "b.pdf", printer: "B" },
    ]);
  });

  it("rejects a file/printer count mismatch", async () => {
    const res = await request(app)
      .post("/print")
      .field("printers", JSON.stringify(["A", "B"]))
      .attach("files", Buffer.from("%PDF"), "a.pdf");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("1 file(s) but 2 printer(s)");
  });

  it("rejects a job whose filename does not match", async () => {
    const res = await request(app)
      .post("/print")
      .field("jobs", JSON.stringify([{ file: "missing.pdf", printer: "A" }]))
      .attach("files", Buffer.from("%PDF"), "a.pdf");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No job entry found");
  });
});

describe("POST /print-raw", () => {
  it("prints a single raw job to a named printer", async () => {
    const res = await request(app)
      .post("/print-raw")
      .send({ data: "^XA^XZ", printer: "Zebra" });
    expect(res.status).toBe(200);
    expect(res.body.printed).toEqual([{ target: "Zebra", bytes: 6 }]);
    expect(printer.printRawToPrinter).toHaveBeenCalledTimes(1);
  });

  it("routes host jobs over TCP", async () => {
    const res = await request(app)
      .post("/print-raw")
      .send({ jobs: [{ data: "x", host: "192.168.1.5", port: 9100 }] });
    expect(res.status).toBe(200);
    expect(res.body.printed).toEqual([{ target: "192.168.1.5:9100", bytes: 1 }]);
    expect(printer.printRawTcp).toHaveBeenCalledTimes(1);
  });

  it("rejects a job with no target", async () => {
    const res = await request(app).post("/print-raw").send({ data: "x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");
  });

  it("rejects a job with no payload", async () => {
    const res = await request(app).post("/print-raw").send({ printer: "Zebra" });
    expect(res.status).toBe(400);
  });

  it("does not print any job if one in the batch is invalid", async () => {
    const res = await request(app)
      .post("/print-raw")
      .send({ jobs: [{ data: "ok", printer: "Zebra" }, { data: "bad" }] });
    expect(res.status).toBe(400);
    expect(printer.printRawToPrinter).not.toHaveBeenCalled();
  });
});
