import type OpenAI from "openai";
import { zodResponsesFunction } from "openai/helpers/zod";
import type {
  ModelClient,
  ModelConversationItem,
  ModelStepRequest,
  ModelStepResult,
  ModelToolCall,
} from "./modelClient.ts";
import { ModelOutputError, ModelRefusalError } from "./modelFallback.ts";

/** Room for one interview turn: a question, a short reply, and a few tool calls. */
const MAX_OUTPUT_TOKENS = 2_000;

/**
 * Asks the provider to return encrypted reasoning items, which a multi-step turn must echo back
 * under `store: false`. To be confirmed against both models by the live smoke test.
 */
const INCLUDE_ENCRYPTED_REASONING = true;

type ResponsesInputItem = OpenAI.Responses.ResponseInputItem;

function toInputItem(item: ModelConversationItem): ResponsesInputItem {
  switch (item.kind) {
    case "message":
      return { role: item.role, content: item.text };
    case "provider_item":
      return item.item as ResponsesInputItem;
    case "tool_result":
      return { type: "function_call_output", call_id: item.callId, output: item.output };
  }
}

/**
 * Builds the request for one model step. It is a plain function so a test can assert what is sent,
 * in particular that `store` is false: nothing here may be kept by the provider.
 */
export function buildResponsesRequest(request: ModelStepRequest) {
  return {
    model: request.model,
    instructions: request.instructions,
    input: [
      ...request.conversation.map(toInputItem),
      { role: "user" as const, content: request.stateItem },
    ],
    tools: request.tools.map((tool) =>
      zodResponsesFunction({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }),
    ),
    tool_choice: request.allowToolCalls ? ("auto" as const) : ("none" as const),
    store: false as const,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    ...(INCLUDE_ENCRYPTED_REASONING ? { include: ["reasoning.encrypted_content" as const] } : {}),
  };
}

/**
 * The SDK adds client-side fields to what it returns, such as `parsed_arguments` on a function call.
 * The API rejects them as unknown parameters if they are echoed back, which the first live run
 * found. Everything that continues a turn must be stripped of them first.
 */
const CLIENT_ONLY_KEYS: ReadonlySet<string> = new Set(["parsed_arguments", "parsed"]);

export function stripClientOnlyFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripClientOnlyFields);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !CLIENT_ONLY_KEYS.has(key))
        .map(([key, child]) => [key, stripClientOnlyFields(child)]),
    );
  }
  return value;
}

/** The only place that talks to the OpenAI SDK. */
export function createOpenAiModelClient(client: OpenAI): ModelClient {
  return {
    async runStep(request: ModelStepRequest): Promise<ModelStepResult> {
      const stream = client.responses.stream(buildResponsesRequest(request), {
        signal: request.signal,
      });

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") request.onTextDelta(event.delta);
      }
      const response = await stream.finalResponse();

      for (const item of response.output) {
        if (item.type !== "message") continue;
        for (const content of item.content) {
          if (content.type === "refusal") throw new ModelRefusalError(content.refusal);
        }
      }
      // Only a completed response may be used. A stream that ends early can still return a snapshot
      // whose status is `in_progress`, `failed`, or `cancelled`, and committing that would defeat
      // both the fallback and the all-or-nothing turn.
      if (response.status !== "completed") {
        const detail =
          response.status === "incomplete"
            ? `, ${response.incomplete_details?.reason ?? "unknown reason"}`
            : "";
        throw new ModelOutputError(`Response did not complete (${response.status}${detail}).`);
      }

      const toolCalls: ModelToolCall[] = [];
      for (const item of response.output) {
        if (item.type === "function_call") {
          toolCalls.push({ callId: item.call_id, name: item.name, argumentsJson: item.arguments });
        }
      }

      return {
        toolCalls,
        providerItems: response.output.map(stripClientOnlyFields),
        inputTokens: response.usage?.input_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    },
  };
}
