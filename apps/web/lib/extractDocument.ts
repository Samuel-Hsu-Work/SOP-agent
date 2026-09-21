import {
  DOCUMENT_EXTENSIONS,
  type DocumentExtractResponse,
  documentExtractResponseSchema,
  httpErrorSchema,
  MAX_UPLOAD_BYTES,
} from "@sop-agent/sop-core";

export type ExtractDocumentResult =
  | { kind: "received"; response: DocumentExtractResponse }
  | { kind: "failed"; message: string };

export interface RequestDocumentExtractionInput {
  apiBaseUrl: string;
  file: File;
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
 * Sends one document for reading and returns the claim drafts. It only asks: the session is never
 * touched here, and what comes back is validated before anyone uses it. Turning a draft into a
 * claim is `applyClaim`'s job.
 */
export async function requestDocumentExtraction(
  input: RequestDocumentExtractionInput,
): Promise<ExtractDocumentResult> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const form = new FormData();
  form.append("file", input.file, input.file.name);

  let response: Response;
  try {
    response = await fetchImplementation(`${input.apiBaseUrl}/documents/extract`, {
      method: "POST",
      body: form,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return { kind: "failed", message: UNREACHABLE_MESSAGE };
  }

  if (!response.ok) return { kind: "failed", message: await readErrorMessage(response) };
  try {
    const parsed = documentExtractResponseSchema.safeParse(await response.json());
    return parsed.success
      ? { kind: "received", response: parsed.data }
      : { kind: "failed", message: UNEXPECTED_MESSAGE };
  } catch {
    return { kind: "failed", message: UNEXPECTED_MESSAGE };
  }
}
