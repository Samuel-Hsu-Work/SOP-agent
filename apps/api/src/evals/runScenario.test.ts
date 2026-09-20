import { createDeterministicContext } from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import { ModelOutputError } from "../model/modelFallback.ts";
import {
  createScriptedModelClient,
  failingStep,
  markClaimUnknownCall,
  recordClaimCall,
  textStep,
  toolCallStep,
} from "../testing/fakeModelClient.ts";
import type { EvalScenario } from "./evalTypes.ts";
import { runScenario } from "./runScenario.ts";

function scenario(overrides: Partial<EvalScenario> = {}): EvalScenario {
  return {
    id: "test-scenario",
    description: "A scenario for the runner test.",
    seed: [],
    expertLines: ["First line.", "Second line."],
    assertions: [],
    ...overrides,
  };
}

describe("runScenario", () => {
  it("plays each expert line as a turn and records replies, tool calls and the session after each", async () => {
    const client = createScriptedModelClient([
      toolCallStep([recordClaimCall({ field: "purpose" })]),
      textStep("Who does it?"),
      toolCallStep([markClaimUnknownCall("roles", null)]),
      textStep("Noted."),
    ]);
    const transcript = await runScenario({
      client,
      model: "test-model",
      scenario: scenario(),
      trial: 2,
      context: createDeterministicContext(),
    });

    expect(transcript).toMatchObject({
      scenarioId: "test-scenario",
      model: "test-model",
      trial: 2,
    });
    expect(transcript.turns.map((turn) => turn.expertLine)).toEqual([
      "First line.",
      "Second line.",
    ]);
    expect(transcript.turns.map((turn) => turn.assistantText)).toEqual(["Who does it?", "Noted."]);
    expect(transcript.turns.map((turn) => turn.sessionAfter.claims.length)).toEqual([1, 2]);
    expect(transcript.turns[0]?.toolCalls).toHaveLength(1);
    expect(transcript.turns.every((turn) => turn.failure === null)).toBe(true);
    expect(transcript.seedSession.claims).toEqual([]);
  });

  it("carries the session from one turn into the next, so later turns see earlier claims", async () => {
    const client = createScriptedModelClient([
      toolCallStep([recordClaimCall({ field: "purpose" })]),
      textStep("One."),
      textStep("Two."),
    ]);
    await runScenario({
      client,
      model: "test-model",
      scenario: scenario(),
      trial: 1,
      context: createDeterministicContext(),
    });
    const laterState = client.requests.at(-1)?.stateItem ?? "";
    expect(laterState).toContain("Handle customer refunds.");
  });

  it("starts from the seeded session", async () => {
    const client = createScriptedModelClient([textStep("Ok.")]);
    const transcript = await runScenario({
      client,
      model: "test-model",
      scenario: scenario({
        seed: [
          { kind: "record", field: "scope", statement: "Online orders." },
          { kind: "unknown", field: "roles", note: "Who approves." },
        ],
        expertLines: ["Hello."],
      }),
      trial: 1,
      context: createDeterministicContext(),
    });
    expect(transcript.seedSession.claims.map((claim) => claim.status)).toEqual([
      "observed",
      "unknown",
    ]);
    expect(transcript.turns[0]?.sessionAfter.claims).toHaveLength(2);
  });

  it("ends the trial at a failed turn and records only the error class", async () => {
    const client = createScriptedModelClient([
      failingStep(new ModelOutputError("SENTINEL detail")),
    ]);
    const transcript = await runScenario({
      client,
      model: "test-model",
      scenario: scenario(),
      trial: 1,
      context: createDeterministicContext(),
    });

    expect(transcript.turns).toHaveLength(1);
    expect(transcript.turns[0]).toMatchObject({
      assistantText: null,
      failure: "ModelOutputError",
      stats: null,
    });
    expect(JSON.stringify(transcript)).not.toContain("SENTINEL detail");
  });
});
