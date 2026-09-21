import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { AGENT_TOOLS } from "../agent/tools.ts";
import type { ModelStepRequest } from "./modelClient.ts";
import { ModelOutputError, ModelRefusalError } from "./modelFallback.ts";
import {
  buildResponsesRequest,
  createOpenAiModelClient,
  stripClientOnlyFields,
} from "./openaiModelClient.ts";

describe("stripClientOnlyFields", () => {
  it("removes the SDK's client-side fields so a returned item can be sent back", () => {
    const functionCall = {
      type: "function_call",
      call_id: "call_1",
      name: "record_claim",
      arguments: '{"field":"purpose"}',
      parsed_arguments: { field: "purpose" },
    };
    const message = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello", parsed: null }],
    };

    expect(stripClientOnlyFields([functionCall, message])).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "record_claim",
        arguments: '{"field":"purpose"}',
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
    ]);
  });

  it("leaves items without those fields unchanged, and does not modify its input", () => {
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "abc", summary: [] };
    const before = JSON.stringify(reasoning);
    expect(stripClientOnlyFields(reasoning)).toEqual(reasoning);
    expect(JSON.stringify(reasoning)).toBe(before);
  });
});

function stepRequest(overrides: Partial<ModelStepRequest> = {}): ModelStepRequest {
  return {
    model: "test-model",
    instructions: "Be helpful.",
    conversation: [{ kind: "message", role: "user", text: "Hello" }],
    stateItem: "STATE",
    tools: AGENT_TOOLS,
    allowToolCalls: true,
    onTextDelta: () => {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("buildResponsesRequest", () => {
  it("never lets the provider store the response", () => {
    expect(buildResponsesRequest(stepRequest()).store).toBe(false);
    expect(buildResponsesRequest(stepRequest({ allowToolCalls: false })).store).toBe(false);
  });

  it("offers the five claim tools, each as a strict function", () => {
    const { tools } = buildResponsesRequest(stepRequest());
    expect(tools.map((tool) => ("name" in tool ? tool.name : null))).toEqual([
      "record_claim",
      "correct_claim",
      "mark_claim_unknown",
      "withdraw_claim",
      "resolve_conflict",
    ]);
    for (const tool of tools) expect(tool).toMatchObject({ type: "function", strict: true });
  });

  it("offers no status the agent may not write", () => {
    // Look at the status options a tool offers, not at the words in its descriptions: a description
    // may say that a confirmed claim cannot be changed, but no tool may offer "confirmed" as a value.
    const { tools } = buildResponsesRequest(stepRequest());
    const offered = tools.flatMap((tool) => {
      const properties = (
        tool as { parameters?: { properties?: Record<string, { enum?: string[] }> } }
      ).parameters?.properties;
      return properties?.status?.enum ?? [];
    });
    expect(new Set(offered)).toEqual(new Set(["observed", "proposed"]));
  });

  it("sends the state item last, after the conversation and the tool traffic", () => {
    const { input } = buildResponsesRequest(
      stepRequest({
        conversation: [
          { kind: "message", role: "user", text: "Hi" },
          { kind: "tool_result", callId: "call_1", output: '{"ok":true}' },
        ],
        stateItem: "THE STATE",
      }),
    );
    expect(input.at(-1)).toEqual({ role: "user", content: "THE STATE" });
    expect(input).toHaveLength(3);
  });

  it("keeps the instructions free of the state, so the start of the prompt can be cached", () => {
    const first = buildResponsesRequest(stepRequest({ stateItem: "STATE ONE" }));
    const second = buildResponsesRequest(stepRequest({ stateItem: "STATE TWO" }));
    expect(first.instructions).toBe(second.instructions);
    expect(first.instructions).not.toContain("STATE");
  });

  it("switches tool choice off for the closing call", () => {
    expect(buildResponsesRequest(stepRequest()).tool_choice).toBe("auto");
    expect(buildResponsesRequest(stepRequest({ allowToolCalls: false })).tool_choice).toBe("none");
  });

  it("maps messages, echoed provider items, and tool results to input items", () => {
    const providerItem = {
      type: "function_call",
      call_id: "call_1",
      name: "record_claim",
      arguments: "{}",
    };
    const { input } = buildResponsesRequest(
      stepRequest({
        conversation: [
          { kind: "message", role: "user", text: "Hi" },
          { kind: "message", role: "assistant", text: "Hello" },
          { kind: "provider_item", item: providerItem },
          { kind: "tool_result", callId: "call_1", output: '{"ok":true}' },
        ],
      }),
    );
    expect(input).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      providerItem,
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
      { role: "user", content: "STATE" },
    ]);
  });
});

/** A stand-in for the SDK's stream: some events, then a final response snapshot. */
function fakeOpenAiClient(events: unknown[], finalResponse: unknown): OpenAI {
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalResponse: async () => finalResponse,
  };
  return { responses: { stream: () => stream } } as unknown as OpenAI;
}

const functionCall = {
  type: "function_call",
  call_id: "call_1",
  name: "record_claim",
  arguments: '{"field":"purpose"}',
  parsed_arguments: { field: "purpose" },
};

async function runWith(finalResponse: unknown, deltas: string[] = []) {
  const client = createOpenAiModelClient(
    fakeOpenAiClient(
      deltas.map((delta) => ({ type: "response.output_text.delta", delta })),
      finalResponse,
    ),
  );
  const received: string[] = [];
  const result = await client.runStep({
    ...stepRequest(),
    onTextDelta: (text) => received.push(text),
  });
  return { result, received };
}

describe("createOpenAiModelClient", () => {
  it("forwards text deltas, reads tool calls, and strips client-only fields from the items", async () => {
    const { result, received } = await runWith(
      {
        status: "completed",
        output: [functionCall],
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 8 },
          output_tokens: 7,
        },
      },
      ["Hel", "lo"],
    );

    expect(received).toEqual(["Hel", "lo"]);
    expect(result.toolCalls).toEqual([
      { callId: "call_1", name: "record_claim", argumentsJson: '{"field":"purpose"}' },
    ]);
    expect(JSON.stringify(result.providerItems)).not.toContain("parsed_arguments");
    expect(result).toMatchObject({ inputTokens: 12, cachedInputTokens: 8, outputTokens: 7 });
  });

  it.each(["in_progress", "queued", "failed", "cancelled", "incomplete"])(
    "refuses to use a response whose status is %s, so the turn falls back instead of committing it",
    async (status) => {
      await expect(
        runWith({ status, output: [functionCall], incomplete_details: null }, ["Partial"]),
      ).rejects.toBeInstanceOf(ModelOutputError);
    },
  );

  it("treats a refusal as a refusal", async () => {
    const refusal = {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "refusal", refusal: "I cannot help with that." }] },
      ],
    };
    await expect(runWith(refusal)).rejects.toBeInstanceOf(ModelRefusalError);
  });
});
