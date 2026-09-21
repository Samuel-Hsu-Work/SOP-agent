import { describe, expect, it } from "vitest";
import {
  documentExtractResponseSchema,
  MAX_EXTRACTED_CLAIMS_PER_DOCUMENT,
} from "./documentWire.ts";

const draft = {
  field: "authorization",
  statement: "Payments above $10,000 need the CFO.",
  effectiveDate: "2024-01-01",
  citation: {
    documentName: "policy.md",
    location: "§ Approval",
    quote: "Every payment above $10,000 needs the CFO.",
  },
};
const response = (overrides: object = {}) => ({
  document: { fileName: "policy.md", fileKind: "markdown", sectionCount: 2, characterCount: 373 },
  claims: [draft],
  rejected: { count: 0, reasons: {} },
  truncatedCount: 0,
  ...overrides,
});

describe("documentExtractResponseSchema", () => {
  it("accepts drafts, and an empty list for a document with no rules in it", () => {
    expect(documentExtractResponseSchema.safeParse(response()).success).toBe(true);
    expect(documentExtractResponseSchema.safeParse(response({ claims: [] })).success).toBe(true);
  });

  it("rejects a draft with an unknown field, a short quote, or a bad date", () => {
    const parse = (claim: object) =>
      documentExtractResponseSchema.safeParse(response({ claims: [claim] })).success;
    expect(parse({ ...draft, field: "everything" })).toBe(false);
    expect(parse({ ...draft, citation: { ...draft.citation, quote: "short" } })).toBe(false);
    expect(parse({ ...draft, effectiveDate: "last year" })).toBe(false);
  });

  it("carries no status, authority, id or source for a draft to smuggle in", () => {
    const parsed = documentExtractResponseSchema.parse(
      response({
        claims: [{ ...draft, status: "confirmed", authority: "official_policy", claimId: "x" }],
      }),
    );
    expect(Object.keys(parsed.claims[0] ?? {}).sort()).toEqual([
      "citation",
      "effectiveDate",
      "field",
      "statement",
    ]);
  });

  it("caps the number of drafts", () => {
    const tooMany = Array.from({ length: MAX_EXTRACTED_CLAIMS_PER_DOCUMENT + 1 }, () => draft);
    expect(documentExtractResponseSchema.safeParse(response({ claims: tooMany })).success).toBe(
      false,
    );
  });
});
