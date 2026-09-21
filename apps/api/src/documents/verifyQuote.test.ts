import { describe, expect, it } from "vitest";
import type { ParsedSection } from "./parseDocument.ts";
import {
  type ExtractionCandidate,
  normalizeForQuoteMatching,
  verifyCandidates,
  verifyQuote,
} from "./verifyQuote.ts";

const sections: ParsedSection[] = [
  {
    sectionId: "s1",
    location: "§ Approval authority",
    text: "Every vendor payment above $10,000 requires the written approval of two people:\nthe budget owner and the CFO. It’s “final” — no exceptions.",
  },
  {
    sectionId: "s2",
    location: "p.2",
    text: "Every vendor pay-\nment must be logged, and a lost-\nreceipt statement must be signed by the manager.",
  },
];

const candidate = (overrides: Partial<ExtractionCandidate> = {}): ExtractionCandidate => ({
  field: "authorization",
  summary: "Payments above $10,000 need two approvals.",
  quote: "Every vendor payment above $10,000 requires the written approval of two people",
  sectionId: "s1",
  effectiveDate: null,
  ...overrides,
});

describe("verifyQuote", () => {
  it("accepts an exact quote and reports the section's own location", () => {
    expect(verifyQuote(candidate(), sections)).toEqual({
      isVerified: true,
      quote: "Every vendor payment above $10,000 requires the written approval of two people",
      location: "§ Approval authority",
    });
  });

  it.each([
    ["a line-wrapped quote", "written approval of two people: the budget owner and the CFO."],
    ["curly quotes and a long dash", 'It\'s "final" - no exceptions.'],
    ["extra whitespace", "  the   budget owner   and the CFO.  "],
  ])("accepts %s", (_name, quote) => {
    expect(verifyQuote(candidate({ quote }), sections)).toMatchObject({ isVerified: true });
  });

  it("accepts a quote across a hyphenated line break, whether the hyphen is part of the word or not", () => {
    // "pay-" "ment": the word is split. "lost-" "receipt": the hyphen is real.
    expect(
      verifyQuote(
        candidate({ sectionId: "s2", quote: "Every vendor payment must be logged" }),
        sections,
      ),
    ).toMatchObject({ isVerified: true, location: "p.2" });
    expect(
      verifyQuote(
        candidate({ sectionId: "s2", quote: "a lost-receipt statement must be signed" }),
        sections,
      ),
    ).toMatchObject({ isVerified: true });
    expect(
      verifyQuote(
        candidate({ sectionId: "s2", quote: "a lostreceipt statement must be signed" }),
        sections,
      ),
    ).toMatchObject({ isVerified: true });
  });

  it("rejects a paraphrase, a wrong case, and a quote made up entirely", () => {
    const reasonFor = (quote: string) => {
      const result = verifyQuote(candidate({ quote }), sections);
      return result.isVerified ? "verified" : result.reason;
    };
    expect(
      reasonFor("Payments over ten thousand dollars need two approvals from leadership."),
    ).toBe("quote_not_found_at_location");
    expect(reasonFor("EVERY VENDOR PAYMENT ABOVE $10,000 REQUIRES THE WRITTEN APPROVAL")).toBe(
      "quote_not_found_at_location",
    );
    expect(reasonFor("The board of directors must approve every payment in advance.")).toBe(
      "quote_not_found_at_location",
    );
  });

  it("rejects a real quote cited in the wrong section, and an unknown section", () => {
    const wrongSection = verifyQuote(candidate({ sectionId: "s2" }), sections);
    expect(wrongSection).toEqual({ isVerified: false, reason: "quote_not_found_at_location" });
    expect(verifyQuote(candidate({ sectionId: "s99" }), sections)).toEqual({
      isVerified: false,
      reason: "unknown_location",
    });
  });

  it("rejects a quote that is too short, empty, or too long", () => {
    const reasonFor = (quote: string) => {
      const result = verifyQuote(candidate({ quote }), sections);
      return result.isVerified ? "verified" : result.reason;
    };
    expect(reasonFor("")).toBe("empty_or_too_short_quote");
    expect(reasonFor("the CFO.")).toBe("empty_or_too_short_quote");
    expect(reasonFor("Every vendor payment ".repeat(20))).toBe("quote_too_long");
  });
});

describe("normalizeForQuoteMatching", () => {
  it("folds typography and whitespace but keeps case", () => {
    expect(normalizeForQuoteMatching("  “A”  ‘b’ – c\n d ")).toBe("\"A\" 'b' - c d");
    expect(normalizeForQuoteMatching("ABC")).toBe("ABC");
  });
});

describe("verifyCandidates", () => {
  it("keeps proven candidates as drafts whose location and quote come from the document", () => {
    const result = verifyCandidates(
      [
        candidate({ effectiveDate: "2024-01-01" }),
        candidate({ quote: "It’s “final” — no exceptions." }),
      ],
      sections,
      "policy.md",
    );
    expect(result.rejected).toEqual({ count: 0, reasons: {} });
    expect(result.drafts[0]).toEqual({
      field: "authorization",
      statement: "Payments above $10,000 need two approvals.",
      effectiveDate: "2024-01-01",
      citation: {
        documentName: "policy.md",
        location: "§ Approval authority",
        quote: "Every vendor payment above $10,000 requires the written approval of two people",
      },
    });
    // The stored quote is the normalized text, not the model's typography.
    expect(result.drafts[1]?.citation.quote).toBe('It\'s "final" - no exceptions.');
  });

  it("drops what cannot be proven, counts why, and rejects a fabricated quote even when the summary is right", () => {
    const result = verifyCandidates(
      [
        candidate({
          quote: "Every payment above ten thousand dollars needs the CFO and a budget owner.",
        }),
        candidate({ sectionId: "s99" }),
        candidate({ quote: "too short" }),
        candidate({ summary: "   " }),
        candidate(),
      ],
      sections,
      "policy.md",
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.rejected).toEqual({
      count: 4,
      reasons: {
        quote_not_found_at_location: 1,
        unknown_location: 1,
        empty_or_too_short_quote: 1,
        invalid_statement: 1,
      },
    });
  });

  it("drops a repeat of the same rule from the same place, and keeps a valid date only", () => {
    const result = verifyCandidates(
      [candidate({ effectiveDate: "next Tuesday" }), candidate()],
      sections,
      "policy.md",
    );
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.effectiveDate).toBeNull();
    expect(result.rejected).toEqual({ count: 1, reasons: { duplicate: 1 } });
  });
});
