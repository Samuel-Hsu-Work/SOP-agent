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

  it("offers exactly one tool, record_claim, as a strict function", () => {
    const { tools } = buildResponsesRequest(stepRequest());
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "function", name: "record_claim", strict: true });
  });

  it("offers no status the agent may not write", () => {
    const [tool] = buildResponsesRequest(stepRequest()).tools;
    const serialized = JSON.stringify(tool);
    for (const allowed of ["observed", "proposed", "unknown"])
      expect(serialized).toContain(allowed);
    for (const forbidden of ["confirmed", "extracted", "conflict"]) {
      expect(serialized).not.toContain(forbidden);
    }
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
        usage: { input_tokens: 12, output_tokens: 7 },
      },
      ["Hel", "lo"],
    );

    expect(received).toEqual(["Hel", "lo"]);
    expect(result.toolCalls).toEqual([
      { callId: "call_1", name: "record_claim", argumentsJson: '{"field":"purpose"}' },
    ]);
    expect(JSON.stringify(result.providerItems)).not.toContain("parsed_arguments");
    expect(result).toMatchObject({ inputTokens: 12, outputTokens: 7 });
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
