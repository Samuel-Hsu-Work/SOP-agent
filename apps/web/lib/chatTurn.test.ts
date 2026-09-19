import {
  type ChatStreamEvent,
  createEmptySession,
  encodeChatStreamEvent,
  type SopSession,
} from "@sop-agent/sop-core";
import { createDeterministicContext } from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import { runChatTurn } from "./chatTurn.ts";

const startingSession: SopSession = createEmptySession(createDeterministicContext());
const committedSession: SopSession = { ...startingSession, updatedAt: "2026-02-02T00:00:00.000Z" };

/** A streaming response whose text is cut into the given chunks. */
function streamingResponse(chunks: string[], init: ResponseInit = { status: 200 }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, init);
}

function eventsToChunks(events: ChatStreamEvent[], chunkSize = 7): string[] {
  const text = events.map(encodeChatStreamEvent).join("");
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks;
}

function run(response: Response | Error) {
  const deltas: string[] = [];
  let resets = 0;
  const result = runChatTurn({
    apiBaseUrl: "http://api.test",
    session: startingSession,
    message: "Hello",
    signal: new AbortController().signal,
    onTextDelta: (text) => deltas.push(text),
    onReset: () => {
      resets += 1;
    },
    fetchImplementation: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { result, deltas, resets: () => resets };
}

describe("runChatTurn", () => {
  it("streams the reply and returns the committed session, whatever the chunk boundaries", async () => {
    const events: ChatStreamEvent[] = [
      { type: "turn_started", turnId: "t-1" },
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "there." },
      { type: "commit", session: committedSession },
    ];
    for (const chunkSize of [1, 3, 7, 1000]) {
      const { result, deltas } = run(streamingResponse(eventsToChunks(events, chunkSize)));
      expect(await result).toEqual({ kind: "committed", session: committedSession });
      expect(deltas.join("")).toBe("Hello there.");
    }
  });

  it("tells the caller to drop the partial reply when the server retries", async () => {
    const { result, deltas, resets } = run(
      streamingResponse(
        eventsToChunks([
          { type: "text_delta", text: "Partial " },
          { type: "turn_reset" },
          { type: "text_delta", text: "Clean." },
          { type: "commit", session: committedSession },
        ]),
      ),
    );
    await result;
    expect(resets()).toBe(1);
    expect(deltas).toEqual(["Partial ", "Clean."]);
  });

  it("does not commit on an error event", async () => {
    const { result } = run(
      streamingResponse(
        eventsToChunks([
          { type: "text_delta", text: "Partial" },
          {
            type: "error",
            code: "model_unavailable",
            retryable: true,
            message: "The agent could not complete this turn.",
          },
        ]),
      ),
    );
    expect(await result).toEqual({
      kind: "failed",
      message: "The agent could not complete this turn.",
      retryable: true,
    });
  });

  it("does not commit when the stream ends without a commit", async () => {
    const { result } = run(
      streamingResponse(eventsToChunks([{ type: "text_delta", text: "Cut off" }])),
    );
    expect(await result).toMatchObject({ kind: "failed", retryable: true });
  });

  it("does not commit when the connection drops in the middle of the stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(encodeChatStreamEvent({ type: "text_delta", text: "Hi" })),
        );
        controller.error(new Error("connection reset"));
      },
    });
    const { result } = run(new Response(stream, { status: 200 }));
    expect(await result).toMatchObject({ kind: "failed" });
  });

  it("does not trust a commit that carries an invalid session", async () => {
    const { result } = run(
      streamingResponse([`${JSON.stringify({ type: "commit", session: { nope: true } })}\n`]),
    );
    expect(await result).toMatchObject({ kind: "failed", retryable: false });
  });

  it("reports the server's message for an HTTP error", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          code: "session_approved",
          message: "The SOP is approved, so the chat is read-only.",
        },
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
    const { result } = run(response);
    expect(await result).toEqual({
      kind: "failed",
      message: "The SOP is approved, so the chat is read-only.",
      retryable: false,
    });
  });

  it("reports an unreachable server", async () => {
    const { result } = run(new TypeError("fetch failed"));
    expect(await result).toMatchObject({ kind: "failed", retryable: true });
  });
});
