import { z } from "zod";
import { calendarDateSchema, documentCitationSchema } from "../claims/claim.ts";
import { MAX_PASSAGE_STATEMENT_LENGTH, MAX_PASSAGES_PER_UPLOAD } from "../limits.ts";
import { DOCUMENT_FILE_KINDS, type DocumentFileKind } from "../references/documentFile.ts";
import { SOP_FIELD_NAMES } from "../sopFields.ts";

/**
 * The contract for `POST /documents/references`, shared so the browser checks exactly what the API
 * promises. The request is `multipart/form-data` with the file and the session: the session tells
 * the reader which SOP is being written, and nothing in the document can change it, because the
 * route returns data and writes nothing. What comes back is passage drafts, plain data with no id,
 * status or state. The browser keeps them as reference material, outside the SOP.
 */
export const DOCUMENT_REFERENCES_PATH = "/documents/references";

/**
 * The multipart field names. The browser sends the session first, but the API takes the two parts
 * in either order: both are bounded, and nothing is parsed or sent to a model until both are read
 * and the session has been checked.
 */
export const DOCUMENT_UPLOAD_SESSION_FIELD = "session";
export const DOCUMENT_UPLOAD_FILE_FIELD = "file";

/** The largest file the API accepts. The browser refuses a bigger one before sending it. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export const DOCUMENT_EXTENSIONS: Readonly<Record<string, DocumentFileKind>> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".md": "markdown",
  ".txt": "text",
};

/** Why a candidate passage was dropped, counted in the response and the log. */
export const QUOTE_REJECTION_REASONS = [
  "invalid_statement",
  "empty_or_too_short_quote",
  "quote_too_long",
  "unknown_location",
  "quote_not_found_at_location",
  "statement_not_supported_by_quote",
  "duplicate",
] as const;
export type QuoteRejectionReason = (typeof QUOTE_REJECTION_REASONS)[number];

/**
 * A passage read from the document for this SOP: one short sentence in the SOP's words, and the
 * verbatim quote that proves where it came from. Every number in the statement is in the quote.
 */
export const passageDraftSchema = z.object({
  field: z.enum(SOP_FIELD_NAMES),
  statement: z.string().min(1).max(MAX_PASSAGE_STATEMENT_LENGTH),
  /** Read from the document by the model: format-checked, never quote-verified. */
  effectiveDate: calendarDateSchema.nullable(),
  citation: documentCitationSchema,
});

export type PassageDraft = z.infer<typeof passageDraftSchema>;

export const documentReferencesResponseSchema = z.object({
  document: z.object({
    /** The sanitized name, the same as in every citation. */
    fileName: z.string().min(1).max(200),
    fileKind: z.enum(DOCUMENT_FILE_KINDS),
    sectionCount: z.number().int().min(0),
    characterCount: z.number().int().min(0),
  }),
  /** May be empty: a document with nothing this SOP needs is a result, not an error. */
  passages: z.array(passageDraftSchema).max(MAX_PASSAGES_PER_UPLOAD),
  rejected: z.object({
    count: z.number().int().min(0),
    reasons: z.partialRecord(z.enum(QUOTE_REJECTION_REASONS), z.number().int().min(0)),
  }),
  /** Verified passages left out because the SOP already says the same thing. */
  alreadyKnownCount: z.number().int().min(0),
  /** Verified passages left out because one upload keeps at most `MAX_PASSAGES_PER_UPLOAD`. */
  truncatedCount: z.number().int().min(0),
});

export type DocumentReferencesResponse = z.infer<typeof documentReferencesResponseSchema>;
