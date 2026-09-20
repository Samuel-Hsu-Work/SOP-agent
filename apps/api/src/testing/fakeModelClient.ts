import type {
  ModelClient,
  ModelStepRequest,
  ModelStepResult,
  ModelToolCall,
} from "../model/modelClient.ts";

/** One scripted model call. It may stream text, return tool calls, or throw. */
export type ScriptedStep = (
  request: ModelStepRequest,
) => Promise<ModelStepResult> | ModelStepResult;

export interface ScriptedModelClient extends ModelClient {
  /** Every request the code under test sent, in order. */
  readonly requests: ModelStepRequest[];
}

/** Steps are consumed in order across every call, including retries on a fallback model. */
export function createScriptedModelClient(steps: ScriptedStep[]): ScriptedModelClient {
  const requests: ModelStepRequest[] = [];
  let nextStep = 0;
  return {
    requests,
    async runStep(request) {
      requests.push(request);
      const step = steps[nextStep];
      nextStep += 1;
      if (step === undefined) throw new Error("The scripted model ran out of steps.");
      return step(request);
    },
  };
}

function result(toolCalls: ModelToolCall[]): ModelStepResult {
  return {
    toolCalls,
    providerItems: toolCalls.map((call) => ({ type: "function_call", ...call })),
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 5,
  };
}

/** A step that streams the given text in pieces and calls no tool. */
export function textStep(...deltas: string[]): ScriptedStep {
  return (request) => {
    for (const delta of deltas) request.onTextDelta(delta);
    return result([]);
  };
}

/** A step that optionally streams some text, then asks for the given tool calls. */
export function toolCallStep(calls: ModelToolCall[], ...deltas: string[]): ScriptedStep {
  return (request) => {
    for (const delta of deltas) request.onTextDelta(delta);
    return result(calls);
  };
}

/** A step that streams some text and then fails. */
export function failingStep(error: Error, ...deltasBeforeFailure: string[]): ScriptedStep {
  return (request) => {
    for (const delta of deltasBeforeFailure) request.onTextDelta(delta);
    throw error;
  };
}

let callCounter = 0;

function toolCall(name: string, args: Record<string, unknown>): ModelToolCall {
  callCounter += 1;
  return { callId: `call_${callCounter}`, name, argumentsJson: JSON.stringify(args) };
}

export function recordClaimCall(
  overrides: Partial<{
    field: string;
    status: string;
    statement: string;
    effectiveDate: string | null;
    note: string | null;
    insertBeforeClaimId: string | null;
  }> = {},
): ModelToolCall {
  return toolCall("record_claim", {
    field: "purpose",
    status: "observed",
    statement: "Handle customer refunds.",
    effectiveDate: null,
    note: null,
    insertBeforeClaimId: null,
    ...overrides,
  });
}

export function correctClaimCall(
  claimId: string,
  overrides: Partial<{ statement: string; effectiveDate: string | null; note: string | null }> = {},
): ModelToolCall {
  return toolCall("correct_claim", {
    claimId,
    statement: "Handle refunds and exchanges.",
    effectiveDate: null,
    note: null,
    ...overrides,
  });
}

export function markClaimUnknownCall(
  field: string,
  claimId: string | null,
  note = "The user does not know.",
): ModelToolCall {
  return toolCall("mark_claim_unknown", { field, claimId, note });
}

export function withdrawClaimCall(
  claimId: string,
  note = "The user said it does not apply.",
): ModelToolCall {
  return toolCall("withdraw_claim", { claimId, note });
}
