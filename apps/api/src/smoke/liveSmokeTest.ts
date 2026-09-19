/**
 * Live smoke test: does strict function calling work end to end on each configured model?
 *
 *   pnpm smoke:api
 *
 * Needs OPENAI_API_KEY (read from the repository root .env). It calls each model directly, without
 * the fallback wrapper, so a problem with one model cannot hide behind the other. It spends a few
 * cents of model usage. The output is for you to read; nothing is stored.
 */
import {
  computeGaps,
  createEmptySession,
  type SopSession,
  systemWriteContext,
  type UserMessage,
} from "@sop-agent/sop-core";
import OpenAI from "openai";
import { runAgentTurn } from "../agent/runTurn.ts";
import { readModelsFromEnvironment } from "../model/modelFallback.ts";
import { createOpenAiModelClient } from "../model/openaiModelClient.ts";

interface Scenario {
  name: string;
  message: string;
  /** What a healthy run looks like, checked automatically where it can be. */
  check: (session: SopSession) => string | null;
}

const SCENARIOS: Scenario[] = [
  {
    name: "states a fact",
    message:
      "We handle customer refunds so that every customer gets a consistent outcome. Any support agent can approve a refund up to $200.",
    check: (session) =>
      session.claims.some((claim) => claim.status === "observed")
        ? null
        : "expected at least one observed claim",
  },
  {
    name: "does not know",
    message: "I honestly do not know who approves refunds above $1000.",
    check: (session) =>
      session.claims.some((claim) => claim.status === "unknown")
        ? null
        : "expected an unknown claim",
  },
  {
    // Test input for the rule that replies stay in English whatever language the user writes in.
    name: "writes in another language",
    message: "Nuestro proceso de reembolso empieza cuando el cliente envía una solicitud.",
    check: () => null,
  },
];

function startingSession(message: string): { session: SopSession; userMessage: UserMessage } {
  const empty = createEmptySession(systemWriteContext);
  const userMessage: UserMessage = {
    id: systemWriteContext.newId(),
    role: "user",
    createdAt: systemWriteContext.now(),
    text: message,
  };
  return { session: { ...empty, messages: [userMessage] }, userMessage };
}

const client = createOpenAiModelClient(new OpenAI());
const models = readModelsFromEnvironment();
let failures = 0;

for (const model of models) {
  for (const scenario of SCENARIOS) {
    const label = `${model} | ${scenario.name}`;
    const { session, userMessage } = startingSession(scenario.message);
    try {
      const result = await runAgentTurn({
        client,
        model,
        session,
        userMessageId: userMessage.id,
        context: systemWriteContext,
        signal: new AbortController().signal,
        onTextDelta: () => {},
      });
      const problem = scenario.check(result.session);
      if (problem !== null) failures += 1;
      console.log(`\n${problem === null ? "PASS" : "CHECK"}  ${label}`);
      if (problem !== null) console.log(`  problem: ${problem}`);
      console.log(`  reply: ${result.assistantMessage.text}`);
      for (const call of result.assistantMessage.toolCalls) {
        const outcome = call.outcome.ok ? "recorded" : `rejected (${call.outcome.code})`;
        console.log(
          `  tool call: ${call.field ?? "?"} / ${call.requestedStatus ?? "?"} -> ${outcome}`,
        );
      }
      const gaps = computeGaps(result.session);
      console.log(
        `  gaps: ${gaps.blockingGapCount} blocking, ${gaps.advisoryGapCount} advisory | steps ${result.stats.modelSteps} | tokens ${result.stats.inputTokens} in, ${result.stats.outputTokens} out`,
      );
    } catch (error) {
      failures += 1;
      const detail =
        error instanceof OpenAI.APIError
          ? `${error.name} (${error.status}): ${error.message}`
          : error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
      console.log(`\nFAIL  ${label}\n  ${detail}`);
    }
  }
}

console.log(
  `\n${failures === 0 ? "All scenarios passed." : `${failures} scenario(s) need a look.`}`,
);
process.exitCode = failures === 0 ? 0 : 1;
