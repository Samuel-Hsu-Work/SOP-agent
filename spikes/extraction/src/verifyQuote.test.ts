import { describe, expect, it } from "vitest";
import type { DocumentSection } from "./parseDocument.ts";
import { verifyExtractedClaimQuote } from "./verifyQuote.ts";

const sections: DocumentSection[] = [
  {
    location: "p.2",
    text: "Support agents may approve refunds of up to $200 on their own\nauthority. Refunds above $200 need the Team Lead.",
  },
  { location: "p.3", text: "The agent records the ticket ID within 24 hours." },
];

describe("verifyExtractedClaimQuote", () => {
  it("accepts a verbatim quote at the cited location", () => {
    const result = verifyExtractedClaimQuote(
      { quote: "Support agents may approve refunds of up to $200", location: "p.2" },
      sections,
    );
    expect(result).toEqual({ isVerified: true });
  });

  it("tolerates line wrapping and curly quotes but not different wording", () => {
    const wrapped = verifyExtractedClaimQuote(
      { quote: "up to $200 on their own authority.", location: "p.2" },
      sections,
    );
    expect(wrapped).toEqual({ isVerified: true });

    const curly = verifyExtractedClaimQuote({ quote: "The agent’s record", location: "p.3" }, [
      { location: "p.3", text: "The agent's record must be complete." },
    ]);
    expect(curly).toEqual({ isVerified: true });
  });

  it("rejects a paraphrase", () => {
    const result = verifyExtractedClaimQuote(
      { quote: "Agents can approve refunds under two hundred dollars", location: "p.2" },
      sections,
    );
    expect(result).toEqual({ isVerified: false, reason: "quote_not_found_at_location" });
  });

  it("rejects a real quote attributed to the wrong location", () => {
    const result = verifyExtractedClaimQuote(
      { quote: "The agent records the ticket ID within 24 hours.", location: "p.2" },
      sections,
    );
    expect(result).toEqual({ isVerified: false, reason: "quote_not_found_at_location" });
  });

  it("rejects a location that does not exist", () => {
    const result = verifyExtractedClaimQuote(
      { quote: "Support agents may approve refunds of up to $200", location: "p.9" },
      sections,
    );
    expect(result).toEqual({ isVerified: false, reason: "unknown_location" });
  });

  it("rejects empty and trivially short quotes", () => {
    expect(verifyExtractedClaimQuote({ quote: "", location: "p.2" }, sections)).toEqual({
      isVerified: false,
      reason: "empty_or_too_short_quote",
    });
    expect(verifyExtractedClaimQuote({ quote: "$200", location: "p.2" }, sections)).toEqual({
      isVerified: false,
      reason: "empty_or_too_short_quote",
    });
  });
});
