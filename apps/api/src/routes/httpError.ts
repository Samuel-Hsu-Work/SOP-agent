import type { HttpError, HttpErrorCode } from "@sop-agent/sop-core";

/** The wording of each HTTP error, so a route that refuses directly says what the error handler says. */
export const HTTP_ERROR_MESSAGES: Record<HttpErrorCode, string> = {
  invalid_request: "The request is not valid.",
  session_approved: "The SOP is approved, so the chat is read-only.",
  sop_not_approved:
    "This SOP cannot be exported. It must be approved, with every gap and suggestion resolved.",
  payload_too_large: "The request is too large.",
  unsupported_media_type: "The request body is not in a format this endpoint accepts.",
  unsupported_document_type:
    "That file is not a PDF, Word (.docx), Markdown or plain-text document, or it is not what its name says.",
  document_has_no_text:
    "That PDF has no text to read. It may be a scan or an image, and scanned documents are not supported.",
  document_unreadable:
    "That document could not be read. It may be encrypted, damaged, or too complex.",
  model_unavailable: "The document reader is unavailable right now. Try again in a moment.",
  extraction_busy: "Another document is being read. Try again in a moment.",
  internal_error: "Something went wrong on the server.",
};

/** The body of an ordinary HTTP error. One helper, so no route builds its own shape. */
export function httpError(
  code: HttpErrorCode,
  message: string,
  issues?: { path: string; code: string }[],
): HttpError {
  return { error: { code, message, ...(issues === undefined ? {} : { issues }) } };
}
