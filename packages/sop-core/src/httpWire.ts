import { z } from "zod";

/** Errors returned as ordinary HTTP, before any stream starts or instead of a file. */
export const HTTP_ERROR_CODES = [
  "invalid_request",
  "session_approved",
  "sop_not_approved",
  "payload_too_large",
  "unsupported_media_type",
  "unsupported_document_type",
  "document_has_no_text",
  "document_unreadable",
  "model_unavailable",
  "extraction_busy",
  "internal_error",
] as const;

export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];

/** The body of every ordinary HTTP error, whichever route sent it. */
export const httpErrorSchema = z.object({
  error: z.object({
    code: z.enum(HTTP_ERROR_CODES),
    message: z.string(),
    /** Where the request was invalid. Property paths and issue codes only, never the rejected values. */
    issues: z
      .array(z.object({ path: z.string(), code: z.string() }))
      .max(5)
      .optional(),
  }),
});

export type HttpError = z.infer<typeof httpErrorSchema>;
