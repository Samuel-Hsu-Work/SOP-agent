/**
 * Live smoke test: do the four claim tools work end to end on each configured model, with the state
 * item sent last?
 *
 *   pnpm smoke:api
 *
 * Needs OPENAI_API_KEY (read from the repository root .env). It calls each model directly, without
 * the fallback wrapper, so a problem with one model cannot hide behind the other. It spends a few
 * cents of model usage. The output is for you to read; nothing is stored.
 */
import {
  applyClaim,
  computeGaps,
  createEmptySession,
  type SopFieldName,
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
  /** Claims recorded from an earlier message, before the scenario's message arrives. */
  priorClaims?: { field: SopFieldName; statement: string }[];
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
    name: "corrects a claim",
    priorClaims: [
      { field: "authorization", statement: "Any support agent can approve a refund up to $200." },
    ],
    message: "Actually the limit is $300, not $200.",
    check: (session) =>
      session.claimHistory.some((entry) => entry.reason === "corrected") &&
      session.claims.filter((claim) => claim.field === "authorization").length === 1
        ? null
        : "expected the authorization claim to be corrected in place, with the old version in the history",
  },
  {
    name: "withdraws a claim",
    priorClaims: [{ field: "scope", statement: "Refunds for in-store purchases are included." }],
    message: "Forget that. In-store purchases are handled by a different team, so remove it.",
    check: (session) =>
      session.claimHistory.some((entry) => entry.reason === "withdrawn") &&
      session.claims.every((claim) => claim.field !== "scope")
        ? null
        : "expected the scope claim to be withdrawn, with the old version in the history",
  },
  {
    name: "states an ordered procedure",
    message:
      "First the customer submits a request. Then support checks the order date. Then finance issues the refund.",
    check: (session) =>
      // The first event may be recorded as the trigger instead of as a step, which is reasonable.
      session.procedureOrder.length >= 2 ? null : "expected at least two ordered procedure steps",
  },
  {
    // Test input for the rule that replies stay in English whatever language the user writes in.
    name: "writes in another language",
    message: "Nuestro proceso de reembolso empieza cuando el cliente envía una solicitud.",
    check: () => null,
  },
];

function startingSession(scenario: Scenario): { session: SopSession; userMessage: UserMessage } {
  const context = systemWriteContext;
  const empty = createEmptySession(context);
  const earlierMessage: UserMessage = {
    id: context.newId(),
    role: "user",
    createdAt: context.now(),
    text: "Earlier statements.",
  };
  const userMessage: UserMessage = {
    id: context.newId(),
    role: "user",
    createdAt: context.now(),
    text: scenario.message,
  };

  let session: SopSession = { ...empty, messages: [earlierMessage] };
  for (const prior of scenario.priorClaims ?? []) {
    const result = applyClaim(
      session,
      {
        kind: "record",
        createdByType: "agent",
        field: prior.field,
        status: "observed",
        statement: prior.statement,
        note: null,
        effectiveDate: null,
        sourceMessageId: earlierMessage.id,
        insertBeforeClaimId: null,
      },
      context,
    );
    if (!result.ok) throw new Error(`Could not seed the scenario: ${result.error.code}`);
    session = result.session;
  }
  return { session: { ...session, messages: [...session.messages, userMessage] }, userMessage };
}

const client = createOpenAiModelClient(new OpenAI());
const models = readModelsFromEnvironment();
let failures = 0;

for (const model of models) {
  for (const scenario of SCENARIOS) {
    const label = `${model} | ${scenario.name}`;
    const { session, userMessage } = startingSession(scenario);
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
        const outcome = call.outcome.ok
          ? `${call.outcome.change}`
          : `rejected (${call.outcome.code})`;
        console.log(
          `  tool call: ${call.toolName} ${call.field ?? "?"} / ${call.requestedStatus ?? "-"} -> ${outcome}`,
        );
      }
      const gaps = computeGaps(result.session);
      console.log(
        `  gaps: ${gaps.blockingGapCount} blocking, ${gaps.advisoryGapCount} advisory | steps ${result.stats.modelSteps} | tokens ${result.stats.inputTokens} in (${result.stats.cachedInputTokens} cached), ${result.stats.outputTokens} out`,
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
