import { chatStreamEventSchema, httpErrorSchema, type SopSession } from "@sop-agent/sop-core";
import { NdjsonLineSplitter } from "./ndjson.ts";

export type ChatTurnResult =
  /** The only outcome that changes the stored session. */
  | { kind: "committed"; session: SopSession }
  | { kind: "failed"; message: string; retryable: boolean };

export interface RunChatTurnInput {
  apiBaseUrl: string;
  session: SopSession;
  message: string;
  signal: AbortSignal;
  onTextDelta(text: string): void;
  /** The server is retrying on the fallback model: drop the partial reply shown so far. */
  onReset(): void;
  fetchImplementation?: typeof fetch;
}

const UNREACHABLE_MESSAGE =
  "Could not reach the server. Check that the API is running, then try again.";
const INCOMPLETE_MESSAGE = "The connection ended before the reply was complete. Try again.";
const UNEXPECTED_MESSAGE = "The server sent a response this app does not understand.";

function failed(message: string, retryable = true): ChatTurnResult {
  return { kind: "failed", message, retryable };
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
 * Sends one chat turn and reads the streamed reply. The stored session must change only when this
 * returns `committed`: on a failure, an error event, or a stream that ends early, the caller keeps
 * the session it had before.
 */
export async function runChatTurn(input: RunChatTurnInput): Promise<ChatTurnResult> {
  const fetchImplementation = input.fetchImplementation ?? fetch;

  let response: Response;
  try {
    response = await fetchImplementation(`${input.apiBaseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ session: input.session, message: input.message }),
      signal: input.signal,
    });
  } catch {
    return failed(UNREACHABLE_MESSAGE);
  }

  if (!response.ok) return failed(await readErrorMessage(response), response.status >= 500);
  if (response.body === null) return failed(UNEXPECTED_MESSAGE, false);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const splitter = new NdjsonLineSplitter();

  const handleLine = (line: string): ChatTurnResult | null => {
    let event: ReturnType<typeof chatStreamEventSchema.safeParse>;
    try {
      event = chatStreamEventSchema.safeParse(JSON.parse(line));
    } catch {
      return failed(UNEXPECTED_MESSAGE, false);
    }
    if (!event.success) return failed(UNEXPECTED_MESSAGE, false);

    switch (event.data.type) {
      case "text_delta":
        input.onTextDelta(event.data.text);
        return null;
      case "turn_reset":
        input.onReset();
        return null;
      case "commit":
        return { kind: "committed", session: event.data.session };
      case "error":
        return failed(event.data.message, event.data.retryable);
      case "turn_started":
        return null;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      const lines = done
        ? splitter.flush()
        : splitter.push(decoder.decode(value, { stream: true }));
      for (const line of lines) {
        const outcome = handleLine(line);
        if (outcome !== null) {
          await reader.cancel().catch(() => undefined);
          return outcome;
        }
      }
      if (done) break;
    }
  } catch {
    return failed(INCOMPLETE_MESSAGE);
  }

  return failed(INCOMPLETE_MESSAGE);
}
