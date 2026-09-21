import {
  type ClaimDraft,
  calendarDateSchema,
  MAX_QUOTE_LENGTH,
  MAX_STATEMENT_LENGTH,
  MIN_QUOTE_LENGTH,
  QUOTE_REJECTION_REASONS,
  type QuoteRejectionReason,
  type SopFieldName,
} from "@sop-agent/sop-core";
import type { ParsedSection } from "./parseDocument.ts";

/**
 * The gate that makes a citation real. The model returns a quote and the id of the section it says
 * the quote is in; code checks that the quote is in that section's text. A quote the model made up,
 * moved to the wrong section, or bent into a paraphrase does not pass. It proves the quote exists,
 * not that the summary is right or the field is the right one: a person reviews every claim.
 */

/** What the model proposes for one rule. It carries no status, authority or creator. */
export interface ExtractionCandidate {
  field: SopFieldName;
  summary: string;
  quote: string;
  sectionId: string;
  effectiveDate: string | null;
}

export type QuoteVerification =
  | { isVerified: true; quote: string; location: string }
  | { isVerified: false; reason: QuoteRejectionReason };

/**
 * Typography and whitespace differ between a document and a model's copy of it, and none of that
 * changes what the words say. Case stays significant.
 */
export function normalizeForQuoteMatching(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const LINE_BREAK_AFTER_HYPHEN = /(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu;

/**
 * The section as a reader could see it, in three spellings, because a line that ends in a hyphen
 * is either a word split in two ("pay-" / "ment") or a real hyphen ("lost-" / "receipt"), and text
 * alone cannot say which. A quote passes if it matches any of them.
 */
function spellingsOf(text: string): string[] {
  const kept = normalizeForQuoteMatching(text);
  const joined = normalizeForQuoteMatching(text.replace(LINE_BREAK_AFTER_HYPHEN, "$1$2"));
  const hyphenKept = normalizeForQuoteMatching(text.replace(LINE_BREAK_AFTER_HYPHEN, "$1-$2"));
  return [...new Set([kept, joined, hyphenKept])];
}

export function verifyQuote(
  candidate: Pick<ExtractionCandidate, "quote" | "sectionId">,
  sections: readonly ParsedSection[],
): QuoteVerification {
  const quote = normalizeForQuoteMatching(candidate.quote);
  if (quote.length < MIN_QUOTE_LENGTH) {
    return { isVerified: false, reason: "empty_or_too_short_quote" };
  }
  if (quote.length > MAX_QUOTE_LENGTH) return { isVerified: false, reason: "quote_too_long" };

  const section = sections.find((entry) => entry.sectionId === candidate.sectionId);
  if (section === undefined) return { isVerified: false, reason: "unknown_location" };

  const isFound = spellingsOf(section.text).some((spelling) => spelling.includes(quote));
  return isFound
    ? { isVerified: true, quote, location: section.location }
    : { isVerified: false, reason: "quote_not_found_at_location" };
}

export interface VerifiedExtraction {
  drafts: ClaimDraft[];
  rejected: { count: number; reasons: Partial<Record<QuoteRejectionReason, number>> };
}

/**
 * Turns the model's candidates into claim drafts, keeping only those whose quote is proven. The
 * location and the quote in a draft come from the document (through the matched section), never
 * from what the model said about them. Repeats are dropped, and so is a summary that is empty or
 * too long for a claim. A date the model read is kept only if it is a real calendar date.
 */
export function verifyCandidates(
  candidates: readonly ExtractionCandidate[],
  sections: readonly ParsedSection[],
  documentName: string,
): VerifiedExtraction {
  const drafts: ClaimDraft[] = [];
  const reasons: Partial<Record<QuoteRejectionReason, number>> = {};
  const seen = new Set<string>();
  const reject = (reason: QuoteRejectionReason) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };

  for (const candidate of candidates) {
    const statement = candidate.summary.trim();
    if (statement === "" || statement.length > MAX_STATEMENT_LENGTH) {
      reject("invalid_statement");
      continue;
    }
    const verification = verifyQuote(candidate, sections);
    if (!verification.isVerified) {
      reject(verification.reason);
      continue;
    }
    const key = [candidate.field, verification.location, verification.quote].join("|");
    if (seen.has(key)) {
      reject("duplicate");
      continue;
    }
    seen.add(key);

    const hasValidDate =
      candidate.effectiveDate !== null &&
      calendarDateSchema.safeParse(candidate.effectiveDate).success;
    drafts.push({
      field: candidate.field,
      statement,
      effectiveDate: hasValidDate ? candidate.effectiveDate : null,
      citation: { documentName, location: verification.location, quote: verification.quote },
    });
  }

  const count = QUOTE_REJECTION_REASONS.reduce(
    (total, reason) => total + (reasons[reason] ?? 0),
    0,
  );
  return { drafts, rejected: { count, reasons } };
}
