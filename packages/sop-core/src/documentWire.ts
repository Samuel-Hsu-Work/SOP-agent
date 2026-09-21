import { z } from "zod";
import { calendarDateSchema, documentCitationSchema } from "./claim.ts";
import { MAX_STATEMENT_LENGTH } from "./limits.ts";
import { SOP_FIELD_NAMES } from "./sopFields.ts";

/**
 * The contract for `POST /documents/extract`, shared so the browser checks exactly what the API
 * promises. The request is `multipart/form-data` with one file and nothing else: no session goes up,
 * so a hostile document has no session to change. What comes back is claim drafts, plain data with
 * no status, id, source or authority. Only `applyClaim` turns a draft into a claim.
 */

/** The largest file the API accepts. The browser refuses a bigger one before sending it. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** What a document can be, by extension. The API also checks the bytes, never the extension alone. */
export const DOCUMENT_FILE_KINDS = ["pdf", "docx", "markdown", "text"] as const;
export type DocumentFileKind = (typeof DOCUMENT_FILE_KINDS)[number];

export const DOCUMENT_EXTENSIONS: Readonly<Record<string, DocumentFileKind>> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".md": "markdown",
  ".txt": "text",
};

/** The most claims one document may add. More are dropped by code and counted, never silently. */
export const MAX_EXTRACTED_CLAIMS_PER_DOCUMENT = 60;

/** Why a candidate claim was dropped, counted in the response and the log. */
export const QUOTE_REJECTION_REASONS = [
  "invalid_statement",
  "empty_or_too_short_quote",
  "quote_too_long",
  "unknown_location",
  "quote_not_found_at_location",
  "duplicate",
] as const;
export type QuoteRejectionReason = (typeof QUOTE_REJECTION_REASONS)[number];

/** A rule read from the document, with its proven citation. Not yet a claim. */
export const claimDraftSchema = z.object({
  field: z.enum(SOP_FIELD_NAMES),
  statement: z.string().min(1).max(MAX_STATEMENT_LENGTH),
  /** Read from the document by the model: format-checked, never quote-verified. */
  effectiveDate: calendarDateSchema.nullable(),
  citation: documentCitationSchema,
});

export type ClaimDraft = z.infer<typeof claimDraftSchema>;

export const documentExtractResponseSchema = z.object({
  document: z.object({
    /** The sanitized name, the same as in every citation. */
    fileName: z.string().min(1).max(200),
    fileKind: z.enum(DOCUMENT_FILE_KINDS),
    sectionCount: z.number().int().min(0),
    characterCount: z.number().int().min(0),
  }),
  /** May be empty: a document with no SOP rules in it is a result, not an error. */
  claims: z.array(claimDraftSchema).max(MAX_EXTRACTED_CLAIMS_PER_DOCUMENT),
  rejected: z.object({
    count: z.number().int().min(0),
    reasons: z.partialRecord(z.enum(QUOTE_REJECTION_REASONS), z.number().int().min(0)),
  }),
  /** Verified rules left out because the document already gave the most one document may add. */
  truncatedCount: z.number().int().min(0),
});

export type DocumentExtractResponse = z.infer<typeof documentExtractResponseSchema>;
