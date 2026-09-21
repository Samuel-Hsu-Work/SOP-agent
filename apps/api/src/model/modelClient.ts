import type { z } from "zod";

/**
 * The boundary between the agent loop and the model provider. Only `openaiModelClient.ts` knows the
 * provider's types; everything else talks to this interface, so the loop is testable without a
 * network or an SDK.
 */

export type ModelConversationItem =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  /** An item the provider returned that must be echoed back verbatim to continue the turn. */
  | { kind: "provider_item"; item: unknown }
  | { kind: "tool_result"; callId: string; output: string };

export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: z.ZodType;
}

export interface ModelToolCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface ModelStepRequest {
  model: string;
  /** Fixed for the whole session. Nothing that changes between steps may go here. */
  instructions: string;
  /** The conversation window and this turn's tool traffic. Only ever appended to within a turn. */
  conversation: readonly ModelConversationItem[];
  /**
   * The current SOP state, sent as the very last input item, after the conversation. Everything
   * before it is the same from one step to the next, so the provider can reuse that prefix.
   */
  stateItem: string;
  tools: readonly ModelToolSpec[];
  /** False for a closing call that must answer in text only. */
  allowToolCalls: boolean;
  /** Reply text arrives here as it is generated, and only here. */
  onTextDelta(text: string): void;
  signal: AbortSignal;
}

export interface ModelStepResult {
  toolCalls: ModelToolCall[];
  /** Everything the model returned, to be echoed back if the turn continues. */
  providerItems: unknown[];
  inputTokens: number;
  /** The part of `inputTokens` the provider served from its prompt cache. */
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * One call that returns a single structured answer, with no tools and no conversation. Document
 * extraction and the consistency review use it: the untrusted text travels in `input` as a
 * user-role item, so it is never part of `instructions`.
 */
export interface StructuredOutputRequest<T> {
  model: string;
  /** Fixed. Nothing that comes from a document may go here. */
  instructions: string;
  /** The untrusted text to read (a document, or the recorded claims), already encoded by the caller. */
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface StructuredOutputResult<T> {
  output: T;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Runs one model call. It throws `ModelRefusalError` if the model declines and `ModelOutputError`
 * if the output is cut off or unusable; other provider errors propagate as they are.
 */
export interface ModelClient {
  runStep(request: ModelStepRequest): Promise<ModelStepResult>;
  /** Same error rules as `runStep`: a refusal or unusable output throws, so the fallback can try another model. */
  runStructuredOutput<T>(request: StructuredOutputRequest<T>): Promise<StructuredOutputResult<T>>;
}
