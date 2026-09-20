import OpenAI from "openai";
import { ModelOutputError, ModelRefusalError } from "./model/modelFallback.ts";

/**
 * The kind of a failed model attempt, for logs. It is only a category: never the provider's error
 * text, which can quote the conversation.
 */
export type ModelFailureKind = "refusal" | "unusable_output" | "api_error" | "aborted" | "internal";

export function classifyModelError(error: unknown): ModelFailureKind {
  if (error instanceof ModelRefusalError) return "refusal";
  if (error instanceof ModelOutputError) return "unusable_output";
  if (error instanceof OpenAI.APIUserAbortError) return "aborted";
  if (error instanceof OpenAI.APIError) return "api_error";
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return "internal";
}

/**
 * The single log line written per chat turn. It carries counts, timings, and categories only.
 * Never message text, claim text, tool arguments, refusal text, or validation error values.
 */
export interface ChatTurnLog {
  event: "chat_turn";
  outcome: "committed" | "failed" | "aborted";
  turnId: string;
  /** Null unless the browser sent a UUID: any other value could carry user text. */
  sessionId: string | null;
  durationMs: number;
  servedByModel: string | null;
  failedAttempts: { model: string; kind: ModelFailureKind }[];
  modelSteps: number;
  toolRounds: number;
  toolRoundCapHit: boolean;
  toolCallsAttempted: number;
  toolCallsApplied: number;
  toolCallsRejected: number;
  toolCallsDropped: number;
  rejectionCodes: string[];
  claimsRecorded: number;
  claimsCorrected: number;
  claimsMarkedUnknown: number;
  claimsWithdrawn: number;
  claimsUnchanged: number;
  historyEntriesWritten: number;
  withdrawLimitHits: number;
  stateItemChars: number;
  /** The first field the interview agenda proposed at the start of the turn: one of 13 names. */
  agendaTopField: string | null;
  /** Null when the turn did not commit. */
  readyToReview: boolean | null;
  blockingGapsBefore: number;
  blockingGapsAfter: number | null;
  advisoryGapsBefore: number;
  advisoryGapsAfter: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  messageCount: number;
  claimCount: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session id comes from the browser, and the schema accepts any short string as an id, so a
 * tampered request could put text in it. Only a value shaped like a UUID is safe to log.
 */
export function sessionIdForLog(sessionId: string): string | null {
  return UUID_PATTERN.test(sessionId) ? sessionId : null;
}
