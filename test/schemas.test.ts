import { describe, it, expect } from "vitest";
import {
  jobsSchema,
  printersSchema,
  rawBodySchema,
  rawJobsFromBody,
  resolveRawJob,
} from "../src/schemas.js";
import { BadRequestError } from "../src/errors.js";

describe("jobsSchema", () => {
  it("accepts well-formed jobs", () => {
    const r = jobsSchema.safeParse([{ file: "a.pdf", printer: "Zebra" }]);
    expect(r.success).toBe(true);
  });

  it("rejects empty printer names", () => {
    const r = jobsSchema.safeParse([{ file: "a.pdf", printer: "  " }]);
    expect(r.success).toBe(false);
  });

  it("rejects an empty array", () => {
    expect(jobsSchema.safeParse([]).success).toBe(false);
  });
});

describe("printersSchema", () => {
  it("accepts a list of names", () => {
    expect(printersSchema.safeParse(["A", "B"]).success).toBe(true);
  });
  it("rejects non-string entries", () => {
    expect(printersSchema.safeParse(["A", 3]).success).toBe(false);
  });
});

describe("rawBodySchema + rawJobsFromBody", () => {
  it("normalizes a single top-level job", () => {
    const parsed = rawBodySchema.parse({ data: "^XA^XZ", printer: "Zebra" });
    expect(rawJobsFromBody(parsed)).toHaveLength(1);
  });

  it("normalizes a jobs array", () => {
    const parsed = rawBodySchema.parse({
      jobs: [
        { data: "a", printer: "P" },
        { data: "b", host: "1.2.3.4" },
      ],
    });
    expect(rawJobsFromBody(parsed)).toHaveLength(2);
  });

  it("rejects an out-of-range port", () => {
    expect(rawBodySchema.safeParse({ data: "a", host: "x", port: 70000 }).success).toBe(false);
  });
});

describe("resolveRawJob", () => {
  it("builds a printer job from string data", () => {
    const job = resolveRawJob({ data: "hello", printer: "Zebra" }, 0, 1);
    expect("printer" in job && job.printer).toBe("Zebra");
    expect(job.bytes.toString("utf8")).toBe("hello");
  });

  it("decodes base64 payloads", () => {
    const b64 = Buffer.from("world").toString("base64");
    const job = resolveRawJob({ dataBase64: b64, host: "1.2.3.4" }, 0, 1);
    expect(job.bytes.toString("utf8")).toBe("world");
    expect("host" in job && job.port).toBe(9100);
  });

  it("requires a payload", () => {
    expect(() => resolveRawJob({ printer: "P" }, 0, 1)).toThrow(BadRequestError);
  });

  it("requires a target", () => {
    expect(() => resolveRawJob({ data: "x" }, 0, 1)).toThrow(BadRequestError);
  });

  it("honors a custom TCP port", () => {
    const job = resolveRawJob({ data: "x", host: "h", port: 6101 }, 0, 1);
    expect("host" in job && job.port).toBe(6101);
  });
});
