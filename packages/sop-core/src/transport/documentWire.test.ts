import { describe, expect, it } from "vitest";
import { MAX_PASSAGE_STATEMENT_LENGTH, MAX_PASSAGES_PER_UPLOAD } from "../limits.ts";
import { documentReferencesResponseSchema } from "./documentWire.ts";

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
  passages: [draft],
  rejected: { count: 0, reasons: {} },
  alreadyKnownCount: 0,
  truncatedCount: 0,
  ...overrides,
});

describe("documentReferencesResponseSchema", () => {
  it("accepts passages, and an empty list for a document with nothing this SOP needs", () => {
    expect(documentReferencesResponseSchema.safeParse(response()).success).toBe(true);
    expect(documentReferencesResponseSchema.safeParse(response({ passages: [] })).success).toBe(
      true,
    );
  });

  it("rejects a passage with an unknown field, a short quote, a long statement or a bad date", () => {
    const parse = (passage: object) =>
      documentReferencesResponseSchema.safeParse(response({ passages: [passage] })).success;
    expect(parse({ ...draft, field: "everything" })).toBe(false);
    expect(parse({ ...draft, citation: { ...draft.citation, quote: "short" } })).toBe(false);
    expect(parse({ ...draft, statement: "x".repeat(MAX_PASSAGE_STATEMENT_LENGTH + 1) })).toBe(
      false,
    );
    expect(parse({ ...draft, effectiveDate: "last year" })).toBe(false);
  });

  it("carries no status, state, id or source for a passage to smuggle in", () => {
    const parsed = documentReferencesResponseSchema.parse(
      response({
        passages: [{ ...draft, status: "confirmed", state: "used", passageId: "x" }],
      }),
    );
    expect(Object.keys(parsed.passages[0] ?? {}).sort()).toEqual([
      "citation",
      "effectiveDate",
      "field",
      "statement",
    ]);
  });

  it("caps the number of passages one upload returns", () => {
    const tooMany = Array.from({ length: MAX_PASSAGES_PER_UPLOAD + 1 }, () => draft);
    expect(
      documentReferencesResponseSchema.safeParse(response({ passages: tooMany })).success,
    ).toBe(false);
  });
});
