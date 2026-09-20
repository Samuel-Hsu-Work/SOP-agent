import { httpErrorSchema, SOP_PDF_MEDIA_TYPE, type SopSession } from "@sop-agent/sop-core";

export type SopPdfResult =
  /** The server returned a PDF. Nothing has been saved yet. */
  { kind: "received"; pdf: Blob } | { kind: "failed"; message: string };

export interface RequestSopPdfInput {
  apiBaseUrl: string;
  session: SopSession;
  signal?: AbortSignal;
  fetchImplementation?: typeof fetch;
}

const UNREACHABLE_MESSAGE =
  "Could not reach the server. Check that the API is running, then try again.";
const UNEXPECTED_MESSAGE = "The server sent a response this app does not understand.";

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const parsed = httpErrorSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error.message;
  } catch {
    // Fall through to the generic message.
  }
  return `The server answered with an error (${response.status}).`;
}

/**
 * Asks the API for the approved SOP as a PDF. It only fetches: saving the file and recording the
 * download are the caller's job, and the session is never changed here.
 */
export async function requestSopPdf(input: RequestSopPdfInput): Promise<SopPdfResult> {
  const fetchImplementation = input.fetchImplementation ?? fetch;

  let response: Response;
  try {
    response = await fetchImplementation(`${input.apiBaseUrl}/sops/pdf`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: SOP_PDF_MEDIA_TYPE },
      body: JSON.stringify({ session: input.session }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return { kind: "failed", message: UNREACHABLE_MESSAGE };
  }

  if (!response.ok) return { kind: "failed", message: await readErrorMessage(response) };
  if (!(response.headers.get("content-type") ?? "").startsWith(SOP_PDF_MEDIA_TYPE)) {
    return { kind: "failed", message: UNEXPECTED_MESSAGE };
  }
  try {
    return { kind: "received", pdf: await response.blob() };
  } catch {
    return { kind: "failed", message: UNREACHABLE_MESSAGE };
  }
}
