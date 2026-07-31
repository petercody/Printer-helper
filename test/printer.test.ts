import { describe, it, expect } from "vitest";
import net from "node:net";
import { printRawTcp } from "../src/printer.js";

/** Spin up a throwaway TCP server that records the first payload it receives. */
function captureServer(): Promise<{ port: number; received: Promise<Buffer>; close: () => void }> {
  return new Promise((resolve) => {
    let resolveData: (b: Buffer) => void;
    const received = new Promise<Buffer>((r) => (resolveData = r));
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (c) => chunks.push(c));
      socket.on("end", () => resolveData(Buffer.concat(chunks)));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ port: addr.port, received, close: () => server.close() });
    });
  });
}

describe("printRawTcp", () => {
  it("streams bytes verbatim to a listening socket", async () => {
    const srv = await captureServer();
    try {
      await printRawTcp("^XA^FDhi^FS^XZ", "127.0.0.1", srv.port);
      const got = await srv.received;
      expect(got.toString("utf8")).toBe("^XA^FDhi^FS^XZ");
    } finally {
      srv.close();
    }
  });

  it("rejects when the host is empty", async () => {
    await expect(printRawTcp("x", "")).rejects.toThrow(/No host/);
  });

  it("times out against an unroutable host quickly", async () => {
    // Port 1 on the discard/blackhole address should never connect.
    await expect(printRawTcp("x", "192.0.2.1", 9, 200)).rejects.toThrow();
  });
});
