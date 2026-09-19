import type { ExtractedClaim } from "./extractionSchema.ts";
import type { DocumentSection } from "./parseDocument.ts";

const MINIMUM_QUOTE_LENGTH = 15;

export type QuoteVerification =
  | { isVerified: true }
  | {
      isVerified: false;
      reason: "empty_or_too_short_quote" | "unknown_location" | "quote_not_found_at_location";
    };

/**
 * Makes quote comparison tolerant of typography and line wrapping only:
 * curly quotes, dash variants, and runs of whitespace. Wording must still match exactly.
 */
export function normalizeForQuoteMatching(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** A claim is trusted only if its quote appears verbatim in the section it cites. */
export function verifyExtractedClaimQuote(
  claim: Pick<ExtractedClaim, "quote" | "location">,
  sections: DocumentSection[],
): QuoteVerification {
  const normalizedQuote = normalizeForQuoteMatching(claim.quote);
  if (normalizedQuote.length < MINIMUM_QUOTE_LENGTH) {
    return { isVerified: false, reason: "empty_or_too_short_quote" };
  }

  const citedSection = sections.find((section) => section.location === claim.location.trim());
  if (!citedSection) return { isVerified: false, reason: "unknown_location" };

  return normalizeForQuoteMatching(citedSection.text).includes(normalizedQuote)
    ? { isVerified: true }
    : { isVerified: false, reason: "quote_not_found_at_location" };
}
