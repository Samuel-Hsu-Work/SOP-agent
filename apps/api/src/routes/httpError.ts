import type { HttpError, HttpErrorCode } from "@sop-agent/sop-core";

/** The body of an ordinary HTTP error. One helper, so no route builds its own shape. */
export function httpError(
  code: HttpErrorCode,
  message: string,
  issues?: { path: string; code: string }[],
): HttpError {
  return { error: { code, message, ...(issues === undefined ? {} : { issues }) } };
}
