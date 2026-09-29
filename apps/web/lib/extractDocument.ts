import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_REFERENCES_PATH,
  DOCUMENT_UPLOAD_FILE_FIELD,
  DOCUMENT_UPLOAD_SESSION_FIELD,
  type DocumentReferencesResponse,
  documentReferencesResponseSchema,
  httpErrorSchema,
  MAX_UPLOAD_BYTES,
  type SopSession,
} from "@sop-agent/sop-core";

export type ReadDocumentResult =
  | { kind: "received"; response: DocumentReferencesResponse }
  | { kind: "failed"; message: string };

export interface RequestDocumentReferencesInput {
  apiBaseUrl: string;
  file: File;
  /** The session the document is read for: it says what the SOP covers and what it already says. */
  session: SopSession;
  signal?: AbortSignal;
  fetchImplementation?: typeof fetch;
}

const UNREACHABLE_MESSAGE =
  "Could not reach the server. Check that the API is running, then try again.";
const UNEXPECTED_MESSAGE = "The server sent a response this app does not understand.";

export const SUPPORTED_FILE_HINT = "PDF, Word (.docx), Markdown (.md) or text (.txt)";
/** The `accept` value for a file input. It only hints to the browser; the API checks the bytes. */
export const FILE_INPUT_ACCEPT = Object.keys(DOCUMENT_EXTENSIONS).join(",");

/**
 * Checks a file in the browser before anything is sent, so a wrong type or a file that is too big
 * is refused at once and costs no upload. Returns a sentence, or null when the file may be sent.
 */
export function checkFileBeforeUpload(file: { name: string; size: number }): string | null {
  const dot = file.name.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  if (!(extension in DOCUMENT_EXTENSIONS)) {
    return `That file type is not supported. Upload a ${SUPPORTED_FILE_HINT} file.`;
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB, which is the most the reader accepts.`;
  }
  return null;
}

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
 * Sends one document, with the session it is read for, and returns the passages that SOP needs.
 * It only asks: the session is never changed here, and what comes back is validated before anyone
 * uses it. Keeping the passages as reference material is `addReferenceDocument`'s job.
 */
export async function requestDocumentReferences(
  input: RequestDocumentReferencesInput,
): Promise<ReadDocumentResult> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const form = new FormData();
  // The session goes first, so the API can refuse a request it cannot read for before the file.
  form.append(DOCUMENT_UPLOAD_SESSION_FIELD, JSON.stringify(input.session));
  form.append(DOCUMENT_UPLOAD_FILE_FIELD, input.file, input.file.name);

  let response: Response;
  try {
    response = await fetchImplementation(`${input.apiBaseUrl}${DOCUMENT_REFERENCES_PATH}`, {
      method: "POST",
      body: form,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return { kind: "failed", message: UNREACHABLE_MESSAGE };
  }

  if (!response.ok) return { kind: "failed", message: await readErrorMessage(response) };
  try {
    const parsed = documentReferencesResponseSchema.safeParse(await response.json());
    return parsed.success
      ? { kind: "received", response: parsed.data }
      : { kind: "failed", message: UNEXPECTED_MESSAGE };
  } catch {
    return { kind: "failed", message: UNEXPECTED_MESSAGE };
  }
}
