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
  instructions: string;
  conversation: readonly ModelConversationItem[];
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
  outputTokens: number;
}

/**
 * Runs one model call. It throws `ModelRefusalError` if the model declines and `ModelOutputError`
 * if the output is cut off or unusable; other provider errors propagate as they are.
 */
export interface ModelClient {
  runStep(request: ModelStepRequest): Promise<ModelStepResult>;
}
