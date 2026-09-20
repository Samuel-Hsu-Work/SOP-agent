import {
  type AssistantMessage,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  MAX_TOOL_CALLS_PER_MESSAGE,
  type RecordedToolCall,
  type SopSession,
  sopSessionSchema,
  type ToolOutcomeErrorCode,
  type WriteContext,
} from "@sop-agent/sop-core";
import type { ModelClient, ModelConversationItem } from "../model/modelClient.ts";
import { ModelOutputError } from "../model/modelFallback.ts";
import {
  buildStateItem,
  INSTRUCTIONS,
  MAX_STATE_ITEM_LENGTH,
  measureStateItem,
  STATE_ITEM_WRITE_MARGIN,
} from "./prompt.ts";
import { AGENT_TOOLS, executeToolCall, type ToolCallOutcome } from "./tools.ts";

/**
 * How many of the latest messages the model sees. The recorded claims are the real memory of the
 * interview and travel in the state item, so older messages add little and cost more every turn.
 */
export const MAX_CONVERSATION_MESSAGES = 16;

/** Rounds in which the model may call tools. A closing call without tools follows the last one. */
export const MAX_TOOL_ROUNDS = 6;

export interface TurnStats {
  modelSteps: number;
  toolRounds: number;
  toolRoundCapHit: boolean;
  toolCallsAttempted: number;
  toolCallsApplied: number;
  toolCallsRejected: number;
  toolCallsDropped: number;
  rejectionCodes: ToolOutcomeErrorCode[];
  claimsRecorded: number;
  claimsCorrected: number;
  claimsMarkedUnknown: number;
  claimsWithdrawn: number;
  /** Writes that found the same claim already there. */
  claimsUnchanged: number;
  historyEntriesWritten: number;
  withdrawLimitHits: number;
  /** The size of the state item on the last step. */
  stateItemChars: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function createEmptyTurnStats(): TurnStats {
  return {
    modelSteps: 0,
    toolRounds: 0,
    toolRoundCapHit: false,
    toolCallsAttempted: 0,
    toolCallsApplied: 0,
    toolCallsRejected: 0,
    toolCallsDropped: 0,
    rejectionCodes: [],
    claimsRecorded: 0,
    claimsCorrected: 0,
    claimsMarkedUnknown: 0,
    claimsWithdrawn: 0,
    claimsUnchanged: 0,
    historyEntriesWritten: 0,
    withdrawLimitHits: 0,
    stateItemChars: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

export interface RunAgentTurnInput {
  client: ModelClient;
  model: string;
  /** The session before the turn, with the new user message already appended. */
  session: SopSession;
  userMessageId: string;
  context: WriteContext;
  signal: AbortSignal;
  onTextDelta(text: string): void;
}

export interface RunAgentTurnResult {
  /** The session with the assistant reply and every applied claim. Valid against the schema. */
  session: SopSession;
  assistantMessage: AssistantMessage;
  stats: TurnStats;
}

function countChange(stats: TurnStats, outcome: ToolCallOutcome): void {
  switch (outcome.change) {
    case "unchanged":
      stats.claimsUnchanged += 1;
      return;
    case "withdrawn":
      stats.claimsWithdrawn += 1;
      return;
    case "created":
    case "updated":
      if (outcome.toolName === "record_claim") stats.claimsRecorded += 1;
      else if (outcome.toolName === "correct_claim") stats.claimsCorrected += 1;
      else stats.claimsMarkedUnknown += 1;
      return;
    case null:
      return;
  }
}

function buildConversation(session: SopSession): ModelConversationItem[] {
  return session.messages
    .slice(-MAX_CONVERSATION_MESSAGES)
    .filter((message) => message.role === "user" || message.text.length > 0)
    .map((message) => ({ kind: "message", role: message.role, text: message.text }));
}

/**
 * Runs one complete agent turn as a transaction over a working copy of the session. Nothing here
 * touches the caller's session: on any failure the caller simply discards the result, and a retry
 * starts again from the same starting session. That is what makes falling back to another model
 * safe when tool calls have side effects and part of the reply has already been streamed.
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const { client, model, userMessageId, context, signal, onTextDelta } = input;

  let working = input.session;
  const conversation = buildConversation(input.session);
  const recordedCalls: RecordedToolCall[] = [];
  let assistantText = "";
  let separatorPending = false;

  const stats = createEmptyTurnStats();
  let withdrawalsSoFar = 0;
  let workingStateSize = measureStateItem(working);

  const forwardTextDelta = (delta: string) => {
    if (delta.length === 0) return;
    if (separatorPending) {
      assistantText += "\n\n";
      onTextDelta("\n\n");
      separatorPending = false;
    }
    assistantText += delta;
    onTextDelta(delta);
  };

  for (let step = 1; ; step += 1) {
    const allowToolCalls = step <= MAX_TOOL_ROUNDS;
    separatorPending = assistantText.length > 0;

    const stateItem = buildStateItem({ session: working, allowToolCalls });
    stats.stateItemChars = stateItem.length;

    const result = await client.runStep({
      model,
      instructions: INSTRUCTIONS,
      conversation,
      stateItem,
      tools: AGENT_TOOLS,
      allowToolCalls,
      onTextDelta: forwardTextDelta,
      signal,
    });

    stats.modelSteps += 1;
    stats.inputTokens += result.inputTokens;
    stats.cachedInputTokens += result.cachedInputTokens;
    stats.outputTokens += result.outputTokens;

    if (result.toolCalls.length === 0 || !allowToolCalls) break;

    stats.toolRounds += 1;
    for (const item of result.providerItems) {
      conversation.push({ kind: "provider_item", item });
    }

    for (const call of result.toolCalls) {
      stats.toolCallsAttempted += 1;
      if (recordedCalls.length >= MAX_TOOL_CALLS_PER_MESSAGE) {
        stats.toolCallsDropped += 1;
        conversation.push({
          kind: "tool_result",
          callId: call.callId,
          output: JSON.stringify({ ok: false, error: "tool_call_limit_reached" }),
        });
        continue;
      }

      const outcome = executeToolCall({
        session: working,
        call,
        sourceMessageId: userMessageId,
        withdrawalsSoFar,
        context,
      });

      // A write that would push the state past its limit is refused, so the committed session can
      // always take another turn. Writes that shrink the state, such as a withdrawal, always pass.
      const grownStateSize = outcome.applied ? measureStateItem(outcome.session) : workingStateSize;
      const isTooLarge =
        grownStateSize > workingStateSize &&
        grownStateSize > MAX_STATE_ITEM_LENGTH - STATE_ITEM_WRITE_MARGIN;
      if (isTooLarge) {
        stats.toolCallsRejected += 1;
        stats.rejectionCodes.push("session_limit_reached");
        recordedCalls.push({
          ...outcome.record,
          outcome: { ok: false, code: "session_limit_reached" },
        });
        conversation.push({
          kind: "tool_result",
          callId: call.callId,
          output: JSON.stringify({
            ok: false,
            error: "session_limit_reached",
            message:
              "The SOP has reached its size limit, so nothing more can be added. Tell the user, and suggest removing something or starting a new chat.",
          }),
        });
        continue;
      }

      working = outcome.session;
      workingStateSize = grownStateSize;
      recordedCalls.push(outcome.record);
      if (outcome.applied) {
        stats.toolCallsApplied += 1;
        countChange(stats, outcome);
        if (outcome.change === "withdrawn") withdrawalsSoFar += 1;
      } else {
        stats.toolCallsRejected += 1;
        if (outcome.rejectionCode !== null) stats.rejectionCodes.push(outcome.rejectionCode);
        if (outcome.rejectionCode === "withdraw_limit_reached") stats.withdrawLimitHits += 1;
      }
      conversation.push({ kind: "tool_result", callId: call.callId, output: outcome.modelResult });
    }

    if (step === MAX_TOOL_ROUNDS) stats.toolRoundCapHit = true;
  }

  const replyText = assistantText.trim();
  if (replyText.length === 0) {
    throw new ModelOutputError("The model produced no reply.");
  }
  if (replyText.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
    throw new ModelOutputError("The model reply is too long.");
  }

  const assistantMessage: AssistantMessage = {
    id: context.newId(),
    role: "assistant",
    createdAt: context.now(),
    text: replyText,
    model,
    toolCalls: recordedCalls,
  };
  const finalSession: SopSession = {
    ...working,
    updatedAt: assistantMessage.createdAt,
    messages: [...working.messages, assistantMessage],
  };

  stats.historyEntriesWritten =
    finalSession.claimHistory.length - input.session.claimHistory.length;

  // A last line of defense: never hand the caller a session that the schema would reject.
  const validated = sopSessionSchema.safeParse(finalSession);
  if (!validated.success) {
    throw new Error("The agent turn produced an invalid session.");
  }

  return { session: validated.data, assistantMessage, stats };
}
