import { describe, expect, it } from "vitest";
import { chatRequestSchema, chatStreamEventSchema, encodeChatStreamEvent } from "./chatWire.ts";
import { MAX_USER_MESSAGE_LENGTH } from "./limits.ts";
import { createEmptySession } from "./session.ts";
import { createDeterministicContext } from "./testing.ts";

const session = createEmptySession(createDeterministicContext());

describe("chatRequestSchema", () => {
  it("accepts a session and a message, and trims the message", () => {
    const parsed = chatRequestSchema.parse({ session, message: "  Hello  " });
    expect(parsed.message).toBe("Hello");
  });

  it("rejects an empty or over-long message", () => {
    expect(chatRequestSchema.safeParse({ session, message: "   " }).success).toBe(false);
    expect(
      chatRequestSchema.safeParse({ session, message: "x".repeat(MAX_USER_MESSAGE_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it("rejects an invalid session", () => {
    expect(
      chatRequestSchema.safeParse({ session: { ...session, status: "nope" }, message: "Hi" })
        .success,
    ).toBe(false);
  });
});

describe("chat stream events", () => {
  it("encodes one event as one line of JSON", () => {
    const line = encodeChatStreamEvent({ type: "text_delta", text: "line one\nline two" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(chatStreamEventSchema.parse(JSON.parse(line))).toEqual({
      type: "text_delta",
      text: "line one\nline two",
    });
  });

  it("only accepts a commit that carries a valid session", () => {
    expect(chatStreamEventSchema.safeParse({ type: "commit", session }).success).toBe(true);
    expect(
      chatStreamEventSchema.safeParse({ type: "commit", session: { nope: true } }).success,
    ).toBe(false);
  });

  it("accepts the other event types and rejects unknown ones", () => {
    expect(chatStreamEventSchema.safeParse({ type: "turn_started", turnId: "t-1" }).success).toBe(
      true,
    );
    expect(chatStreamEventSchema.safeParse({ type: "turn_reset" }).success).toBe(true);
    expect(
      chatStreamEventSchema.safeParse({
        type: "error",
        code: "model_unavailable",
        retryable: true,
        message: "The agent could not complete this turn.",
      }).success,
    ).toBe(true);
    expect(chatStreamEventSchema.safeParse({ type: "something_else" }).success).toBe(false);
  });
});
