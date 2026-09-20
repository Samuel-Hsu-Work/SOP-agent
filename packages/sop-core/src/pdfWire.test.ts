import { describe, expect, it } from "vitest";
import { httpErrorSchema } from "./httpWire.ts";
import { sopPdfFileName, sopPdfRequestSchema } from "./pdfWire.ts";
import { createEmptySession } from "./session.ts";
import { createDeterministicContext } from "./testing.ts";

describe("sopPdfFileName", () => {
  it("is built from the approval time alone, in plain ASCII", () => {
    const name = sopPdfFileName("2026-09-20T14:32:07.123Z");
    expect(name).toBe("standard-operating-procedure-2026-09-20-1432.pdf");
    expect(name).toMatch(/^[a-z0-9.-]+$/);
  });

  it("is the same every time it is asked, so every download of one SOP has one name", () => {
    expect(sopPdfFileName("2026-01-02T03:04:05.000Z")).toBe(
      sopPdfFileName("2026-01-02T03:04:05.000Z"),
    );
  });
});

describe("sopPdfRequestSchema", () => {
  const session = createEmptySession(createDeterministicContext());

  it("takes a session and nothing else", () => {
    expect(sopPdfRequestSchema.safeParse({ session }).success).toBe(true);
    expect(sopPdfRequestSchema.safeParse({}).success).toBe(false);
    expect(sopPdfRequestSchema.safeParse({ session: { ...session, status: "nope" } }).success).toBe(
      false,
    );
  });
});

describe("httpErrorSchema", () => {
  it("knows the code for a session that cannot be exported", () => {
    expect(
      httpErrorSchema.safeParse({ error: { code: "sop_not_approved", message: "No." } }).success,
    ).toBe(true);
    expect(httpErrorSchema.safeParse({ error: { code: "nope", message: "No." } }).success).toBe(
      false,
    );
  });
});
