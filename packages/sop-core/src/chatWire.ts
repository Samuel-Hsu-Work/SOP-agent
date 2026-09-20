import { z } from "zod";
import { identifierSchema } from "./claim.ts";
import { MAX_USER_MESSAGE_LENGTH } from "./limits.ts";
import { sopSessionSchema } from "./session.ts";

/**
 * The contract between the browser and the API. It lives here because both sides must agree on it
 * and it is the piece most likely to drift. It is framework-free, so sop-core stays independent of
 * the web app, the API, and the model SDK.
 */
export const chatRequestSchema = z.object({
  session: sopSessionSchema,
  message: z.string().trim().min(1).max(MAX_USER_MESSAGE_LENGTH),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const STREAM_ERROR_CODES = ["model_unavailable", "internal_error"] as const;
export type StreamErrorCode = (typeof STREAM_ERROR_CODES)[number];

/**
 * One event per line (NDJSON). `commit` and `error` are terminal, and neither is followed by any
 * bytes. Only `commit` changes what the browser stores: the browser keeps its previous session
 * on `error` or on a stream that ends without either.
 */
export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn_started"), turnId: identifierSchema }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  /** A retry on the fallback model begins: discard the partial reply shown so far. */
  z.object({ type: z.literal("turn_reset") }),
  z.object({ type: z.literal("commit"), session: sopSessionSchema }),
  z.object({
    type: z.literal("error"),
    code: z.enum(STREAM_ERROR_CODES),
    retryable: z.boolean(),
    message: z.string(),
  }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

export function encodeChatStreamEvent(event: ChatStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}
