/**
 * Live smoke test: do the five claim tools work end to end on each configured model, with the state
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
  consistencyAnalysisOutputSchema,
  createEmptySession,
  mergeConsistencyAnalysis,
  type SopFieldName,
  type SopSession,
  systemWriteContext,
  type UserMessage,
} from "@sop-agent/sop-core";
import OpenAI from "openai";
import {
  CONSISTENCY_REVIEW_INSTRUCTIONS,
  CONSISTENCY_REVIEW_MAX_OUTPUT_TOKENS,
  CONSISTENCY_REVIEW_TIMEOUT_MS,
  renderConsistencyReviewInput,
} from "../agent/consistencyReview.ts";
import { runAgentTurn } from "../agent/runTurn.ts";
import { extractClaimDrafts } from "../documents/extractClaimDrafts.ts";
import { parseDocument } from "../documents/parseDocument.ts";
import type { ModelFailureKind } from "../logging.ts";
import { readModelsFromEnvironment } from "../model/modelFallback.ts";
import { createOpenAiModelClient } from "../model/openaiModelClient.ts";

interface Scenario {
  name: string;
  message: string;
  /** Claims recorded from an earlier message, before the scenario's message arrives. */
  priorClaims?: { field: SopFieldName; statement: string; isConfirmed?: boolean }[];
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
    name: "does not remove a confirmed claim",
    priorClaims: [
      {
        field: "authorization",
        statement: "A manager approves refunds above $200.",
        isConfirmed: true,
      },
    ],
    message: "Remove the rule about managers approving refunds. It does not exist.",
    check: (session) =>
      session.claims.some(
        (claim) => claim.field === "authorization" && claim.status === "confirmed",
      )
        ? null
        : "expected the confirmed claim to stay, with the reply pointing to the review panel",
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
    if (prior.isConfirmed === true) {
      // A person's review action, the only thing that produces a confirmed claim.
      const confirmed = applyClaim(
        session,
        { kind: "confirm", createdByType: "user", claimId: result.claim.claimId },
        context,
      );
      if (!confirmed.ok) throw new Error(`Could not confirm the seed: ${confirmed.error.code}`);
      session = confirmed.session;
    }
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

/**
 * One document extraction per model: the structured-output call the upload route uses, on a tiny
 * document, with the quote check applied to whatever comes back.
 */
const SMOKE_DOCUMENT =
  "# Vendor Payment Policy\n\n## Approval authority\n\nEvery vendor payment above $10,000 requires the written approval of two people: the budget owner and the CFO.\n\n## Records\n\nFinance stores the invoice, the purchase order and both approvals for seven years.\n";

for (const model of models) {
  const label = `${model} | reads a document`;
  try {
    const parsed = await parseDocument({
      bytes: Buffer.from(SMOKE_DOCUMENT, "utf8"),
      fileName: "vendor-payment-policy.md",
    });
    const failedAttempts: { model: string; kind: ModelFailureKind }[] = [];
    const outcome = await extractClaimDrafts({
      client,
      models: [model],
      sections: parsed.sections,
      documentName: "vendor-payment-policy.md",
      signal: new AbortController().signal,
      failedAttempts,
    });
    if (outcome.drafts.length === 0) throw new Error("expected at least one verified claim");
    console.log(`\nPASS  ${label}`);
    for (const draft of outcome.drafts) {
      console.log(`  ${draft.field}: ${draft.statement}`);
    }
    console.log(
      `  proposed ${outcome.proposedCount}, verified ${outcome.drafts.length}, rejected ${outcome.rejected.count} | tokens ${outcome.inputTokens} in, ${outcome.outputTokens} out`,
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

/**
 * One consistency review per model, called directly (not through the fail-open wrapper) so that a
 * schema the provider refuses, or output that does not hold up against the session, shows here
 * instead of quietly turning the feature off.
 */
const REVIEW_SEED: [SopFieldName, string][] = [
  ["purpose", "Make every refund fair, consistent and traceable."],
  ["scope", "All refund requests for online orders placed in the last 30 days."],
  ["trigger", "A customer emails support or submits the refund form."],
  ["roles", "The Support Manager approves refunds above $200."],
  ["roles", "The Finance Director approves refunds above $2,000."],
  ["procedure", "Log the request in the ticketing system."],
  ["procedure", "Approve refunds up to $200, or send larger ones to the Support Manager."],
  ["procedure", "Finance issues the refund to the original payment method."],
  [
    "authorization",
    "Agents up to $200, managers up to $2,000, and above that the Finance Director.",
  ],
  ["completionCriteria", "The customer has been told the outcome and the ticket is closed."],
  ["governance", "The Support Lead owns this procedure and reviews it every six months."],
];

for (const model of models) {
  const label = `${model} | reviews a finished SOP for what it leaves unsaid`;
  try {
    const context = systemWriteContext;
    const messageId = context.newId();
    let session: SopSession = {
      ...createEmptySession(context),
      messages: [
        {
          id: messageId,
          role: "user",
          createdAt: context.now(),
          text: "Here is the whole process.",
        },
      ],
    };
    for (const [field, statement] of REVIEW_SEED) {
      const written = applyClaim(
        session,
        {
          kind: "record",
          createdByType: "agent",
          field,
          status: "observed",
          statement,
          note: null,
          effectiveDate: null,
          sourceMessageId: messageId,
          insertBeforeClaimId: null,
        },
        context,
      );
      if (!written.ok) throw new Error(`seed failed: ${written.error.code}`);
      session = written.session;
    }
    const result = await client.runStructuredOutput({
      model,
      instructions: CONSISTENCY_REVIEW_INSTRUCTIONS,
      input: renderConsistencyReviewInput(session),
      schema: consistencyAnalysisOutputSchema,
      schemaName: "consistency_review",
      maxOutputTokens: CONSISTENCY_REVIEW_MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(CONSISTENCY_REVIEW_TIMEOUT_MS),
    });
    const merged = mergeConsistencyAnalysis(session, result.output, context);
    if (!merged.ok) throw new Error(`the review did not hold up: ${merged.reason}`);
    console.log(`\nPASS  ${label}`);
    for (const finding of merged.session.consistencyReview?.findings ?? []) {
      console.log(`  ${finding.category} -> ${finding.targetField}: ${finding.question}`);
    }
    console.log(
      `  ${merged.session.consistencyReview?.findings.length ?? 0} finding(s) | tokens ${result.inputTokens} in, ${result.outputTokens} out`,
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

console.log(
  `\n${failures === 0 ? "All scenarios passed." : `${failures} scenario(s) need a look.`}`,
);
process.exitCode = failures === 0 ? 0 : 1;
