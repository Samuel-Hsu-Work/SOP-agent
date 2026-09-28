import {
  applyClaim,
  type ClaimWriteCommand,
  CONSISTENCY_CATEGORIES,
  type ConsistencyAnalysisOutput,
  type SopFieldName,
  type SopSession,
  sopSessionSchema,
} from "@sop-agent/sop-core";
import {
  createDeterministicContext,
  createSessionWithUserMessage,
} from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import { ModelRefusalError } from "../model/modelFallback.ts";
import {
  createScriptedModelClient,
  recordClaimCall,
  type ScriptedExtractionStep,
  type ScriptedStep,
  textStep,
  toolCallStep,
} from "../testing/fakeModelClient.ts";
import {
  CONSISTENCY_REVIEW_INSTRUCTIONS,
  renderConsistencyReviewInput,
} from "./consistencyReview.ts";
import { INSTRUCTIONS } from "./prompt.ts";
import { runAgentTurn } from "./runTurn.ts";

const BLOCKING: [SopFieldName, string][] = [
  ["purpose", "Make every refund fair and traceable."],
  ["scope", "All refund requests for online orders in the last 30 days."],
  ["trigger", "A customer emails support or submits the refund form."],
  ["roles", "The Finance Director approves refunds above $2,000."],
  ["procedure", "Log the request in the ticketing system."],
  ["procedure", "Send refunds above $200 to the Support Manager."],
  ["authorization", "Managers up to $2,000, and above that the Finance Director."],
  ["completionCriteria", "The customer has been told and the ticket is closed."],
  ["governance", "The Support Lead owns this and reviews it every six months."],
];

const QUESTION =
  "What happens to a refund above $2,000, which no step sends to the Finance Director?";

function setup() {
  const context = createDeterministicContext();
  const created = createSessionWithUserMessage(context, "Here is the whole process.");
  const messageId = created.messageId;
  const apply = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result.session;
  };
  const record = (current: SopSession, field: SopFieldName, statement: string) =>
    apply(current, {
      kind: "record",
      createdByType: "agent",
      field,
      status: "observed",
      statement,
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    });
  const fullSession = () => {
    const session = BLOCKING.reduce(
      (current, [field, statement]) => record(current, field, statement),
      created.session,
    );
    // This file exercises the consistency review only; the claim-depth review is a separate
    // mechanism with its own test file, so its procedure candidates are pre-marked "already asked"
    // here, keeping it from making a call of its own that would otherwise consume a scripted
    // extraction step meant for the consistency review.
    const askedClaimIds = session.claims
      .filter((claim) => claim.field === "procedure")
      .map((claim) => claim.claimId);
    return {
      ...session,
      claimDepthReview: {
        basis: "not under test",
        checkedAt: session.updatedAt,
        findings: [],
        offeredTotal: askedClaimIds.length,
        askedClaimIds,
        lastOfferedClaimId: null,
        lastOfferedClaimTextHash: null,
      },
    };
  };

  const run = (
    steps: ScriptedStep[],
    extractionSteps: ScriptedExtractionStep[],
    startingSession: SopSession,
    signal: AbortSignal = new AbortController().signal,
  ) => {
    const client = createScriptedModelClient(steps, extractionSteps);
    const promise = runAgentTurn({
      client,
      model: "test-model",
      session: startingSession,
      userMessageId: messageId,
      context,
      signal,
      onTextDelta: () => {},
    });
    return { client, promise };
  };
  return { context, messageId, emptySession: created.session, apply, record, fullSession, run };
}

/** A review that cites the claim the input calls "roles", worded as the model would. */
const findingAboutRoles: ScriptedExtractionStep = (request) => {
  const input = JSON.parse(request.input) as { claims: { id: string; field: string }[] };
  const roles = input.claims.find((claim) => claim.field === "roles");
  const output: ConsistencyAnalysisOutput = {
    findings: [
      {
        priorFindingId: null,
        category: "unreached_role_or_tier",
        targetField: "procedure",
        relatedClaimIds: roles === undefined ? [] : [roles.id],
        question: QUESTION,
      },
    ],
    resolvedPriorFindingIds: [],
  };
  return output;
};

/** A claim-depth review that reports nothing, so a test can prove it ran without it interfering. */
const NO_DEPTH_FINDINGS: ScriptedExtractionStep = () => ({
  findings: [],
  resolvedPriorFindingIds: [],
});

const MISMATCH_QUESTION =
  "The roles and authorization fields disagree about the $2,000 boundary. Which is right?";

/** A review that cites the "roles" and "authorization" claims as a restatement_mismatch. */
const findingAboutRolesAndAuthorization: ScriptedExtractionStep = (request) => {
  const input = JSON.parse(request.input) as { claims: { id: string; field: string }[] };
  const roles = input.claims.find((claim) => claim.field === "roles");
  const authorization = input.claims.find((claim) => claim.field === "authorization");
  const output: ConsistencyAnalysisOutput = {
    findings: [
      {
        priorFindingId: null,
        category: "restatement_mismatch",
        targetField: "authorization",
        relatedClaimIds: [roles?.id, authorization?.id].filter(
          (id): id is string => id !== undefined,
        ),
        question: MISMATCH_QUESTION,
      },
    ],
    resolvedPriorFindingIds: [],
  };
  return output;
};

function stateOf(stateItem: string | undefined): Record<string, unknown> {
  const match = /<sop_state>(.*)<\/sop_state>/s.exec(stateItem ?? "");
  if (match?.[1] === undefined) throw new Error("no state block");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("the consistency review inside a turn", () => {
  it("reviews the finished SOP, hands the agent one question, and records nothing because of it", async () => {
    const { fullSession, run } = setup();
    const before = fullSession();
    const { client, promise } = run([textStep("Anything else?")], [findingAboutRoles], before);
    const result = await promise;

    expect(client.extractionRequests).toHaveLength(1);
    const question = stateOf(client.requests[0]?.stateItem).consistencyQuestion as {
      question: string;
      category: string;
    };
    expect(question).toMatchObject({ question: QUESTION, category: "unreached_role_or_tier" });

    // A finding is not a claim: the claims are exactly what they were.
    expect(result.session.claims).toEqual(before.claims);
    expect(result.session.consistencyReview?.offeredTotal).toBe(1);
    expect(result.session.consistencyReview?.findings[0]?.wasOffered).toBe(true);
    // The turn's stats reach the log, so they carry counts and a category and never the question.
    expect(JSON.stringify(result.stats)).not.toContain("Finance Director");
    expect(result.stats).toMatchObject({
      consistencyReview: "ran",
      consistencyFindingsRaised: 1,
      consistencyFindingsWaiting: 0,
      consistencyQuestionCategory: "unreached_role_or_tier",
    });
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("waits for the claims this turn writes, and reviews them once", async () => {
    const { emptySession, run } = setup();
    const { client, promise } = run(
      [
        toolCallStep(BLOCKING.map(([field, statement]) => recordClaimCall({ field, statement }))),
        textStep("Recorded."),
      ],
      // The claim-depth review becomes eligible in the same step (its own procedure candidates
      // now exist) and runs first, so its own call comes before the consistency review's.
      [NO_DEPTH_FINDINGS, findingAboutRoles],
      emptySession,
    );
    const result = await promise;

    // The first step ran while blocking gaps remained, so there was nothing to review yet.
    expect(client.extractionRequests).toHaveLength(2);
    const reviewed = JSON.parse(client.extractionRequests[1]?.input ?? "{}") as {
      claims: { text: string }[];
    };
    expect(reviewed.claims.map((claim) => claim.text)).toContain(
      "The Finance Director approves refunds above $2,000.",
    );
    expect(stateOf(client.requests[1]?.stateItem).consistencyQuestion).not.toBeNull();
    expect(result.stats.consistencyReview).toBe("ran");
  });

  it("does not review a sparse interview", async () => {
    const { record, run, fullSession } = setup();
    const sparse = record(
      { ...fullSession(), claims: [], procedureOrder: [] },
      "purpose",
      "Make every refund fair.",
    );
    const { client, promise } = run([textStep("Who is covered?")], [], sparse);
    const result = await promise;
    expect(client.extractionRequests).toHaveLength(0);
    expect(result.stats.consistencyReview).toBe("not_needed");
    expect(stateOf(client.requests[0]?.stateItem).consistencyQuestion).toBeNull();
  });

  it("does not review while a document rule waits for the person's review", async () => {
    const { apply, fullSession, run } = setup();
    const withDocument = apply(fullSession(), {
      kind: "ingestExtracted",
      createdByType: "extraction",
      field: "evidence",
      statement: "Invoices are kept for seven years.",
      citation: {
        documentName: "policy.md",
        location: "§ Records",
        quote: "Invoices are kept for seven years.",
      },
      effectiveDate: null,
      note: null,
    });
    const { client, promise } = run([textStep("Noted.")], [], withDocument);
    await promise;
    expect(client.extractionRequests).toHaveLength(0);
  });

  it("does not review, or ask, once the person says they are out of time", async () => {
    const { fullSession, run } = setup();
    const session = fullSession();
    const tired: SopSession = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: "later-1",
          role: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
          text: "I'm out of time, that's everything.",
        },
      ],
    };
    const { client, promise } = run([textStep("Understood.")], [], tired);
    const result = await promise;
    expect(client.extractionRequests).toHaveLength(0);
    expect(stateOf(client.requests[0]?.stateItem).consistencyQuestion).toBeNull();
    expect(result.stats.consistencyQuestionCategory).toBeNull();
  });

  it("does not ask the same question twice, and does not review the same claims again", async () => {
    const { fullSession, run } = setup();
    const first = run([textStep("Anything else?")], [findingAboutRoles], fullSession());
    const afterFirst = (await first.promise).session;

    const secondStart: SopSession = {
      ...afterFirst,
      messages: [
        ...afterFirst.messages,
        { id: "later-2", role: "user", createdAt: "2026-01-01T00:00:00.000Z", text: "Not sure." },
      ],
    };
    const second = run([textStep("That is fine.")], [], secondStart);
    const result = await second.promise;

    expect(second.client.extractionRequests).toHaveLength(0);
    expect(stateOf(second.client.requests[0]?.stateItem).consistencyQuestion).toBeNull();
    expect(result.session.consistencyReview?.offeredTotal).toBe(1);
  });

  it("carries on when the review fails, and does not try again for the same claims", async () => {
    const { fullSession, run } = setup();
    const failing: ScriptedExtractionStep = () => {
      throw new ModelRefusalError("no");
    };
    const first = run([textStep("Anything else?")], [failing], fullSession());
    const result = await first.promise;
    expect(result.stats.consistencyReview).toBe("failed");
    expect(result.session.messages.at(-1)?.text).toBe("Anything else?");
    expect(stateOf(first.client.requests[0]?.stateItem).consistencyQuestion).toBeNull();

    const next = run([textStep("Ok.")], [], {
      ...result.session,
      messages: [
        ...result.session.messages,
        { id: "later-3", role: "user", createdAt: "2026-01-01T00:00:00.000Z", text: "Thanks." },
      ],
    });
    await next.promise;
    expect(next.client.extractionRequests).toHaveLength(0);
  });

  it("treats a review that cites a claim it was not given as a failed review", async () => {
    const { fullSession, run } = setup();
    const invented: ScriptedExtractionStep = () =>
      ({
        findings: [
          {
            priorFindingId: null,
            category: "missing_outcome_path",
            targetField: "procedure",
            relatedClaimIds: ["a-claim-nobody-recorded"],
            question: "What happens when a request is denied?",
          },
        ],
        resolvedPriorFindingIds: [],
      }) satisfies ConsistencyAnalysisOutput;
    const { promise } = run([textStep("Anything else?")], [invented], fullSession());
    const result = await promise;
    expect(result.stats.consistencyReview).toBe("failed");
    expect(result.session.consistencyReview?.findings).toEqual([]);
    // The call was made and billed even though its answer was refused.
    expect(result.stats.inputTokens).toBeGreaterThanOrEqual(100);
  });

  it("hands the agent a restatement_mismatch with each related claim's field and wording", async () => {
    const { fullSession, run } = setup();
    const before = fullSession();
    const { client, promise } = run(
      [textStep("Anything else?")],
      [findingAboutRolesAndAuthorization],
      before,
    );
    const result = await promise;

    const question = stateOf(client.requests[0]?.stateItem).consistencyQuestion as {
      category: string;
      aboutClaims: { id: string; field: string; statement: string }[];
    };
    expect(question.category).toBe("restatement_mismatch");
    expect(question.aboutClaims.map((claim) => claim.field).sort()).toEqual([
      "authorization",
      "roles",
    ]);
    expect(question.aboutClaims.map((claim) => claim.statement)).toEqual([
      "The Finance Director approves refunds above $2,000.",
      "Managers up to $2,000, and above that the Finance Director.",
    ]);

    // A finding is not a claim: the claims are exactly what they were, before the user answers.
    expect(result.session.claims).toEqual(before.claims);
    expect(result.stats.consistencyQuestionCategory).toBe("restatement_mismatch");
    expect(JSON.stringify(result.stats)).not.toContain("Finance Director");
  });

  it("passes on an abort instead of treating it as a failed review", async () => {
    const { fullSession, run } = setup();
    const controller = new AbortController();
    const abortingStep: ScriptedExtractionStep = () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    };
    const { promise } = run([textStep("x")], [abortingStep], fullSession(), controller.signal);
    await expect(promise).rejects.toThrow();
  });
});

describe("what the review model is given", () => {
  it("holds the person's stated claims only, in reading order, and no conversation", () => {
    const { fullSession, apply, messageId } = setup();
    const withSuggestion = apply(fullSession(), {
      kind: "record",
      createdByType: "agent",
      field: "controls",
      status: "proposed",
      statement: "SUGGESTION-TEXT audit a sample monthly.",
      note: "Suggested by the assistant.",
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    });
    const input = renderConsistencyReviewInput(withSuggestion);
    expect(input).not.toContain("SUGGESTION-TEXT");
    expect(input).not.toContain("Here is the whole process.");
    const parsed = JSON.parse(input) as { claims: { text: string }[] };
    expect(parsed.claims.slice(0, 2).map((claim) => claim.text)).toEqual([
      "Log the request in the ticketing system.",
      "Send refunds above $200 to the Support Manager.",
    ]);
  });

  it("keeps claim text out of both sets of fixed instructions", () => {
    for (const [, statement] of BLOCKING) {
      expect(CONSISTENCY_REVIEW_INSTRUCTIONS).not.toContain(statement);
      expect(INSTRUCTIONS).not.toContain(statement);
    }
  });

  it("tells the agent a consistency question is a question, and never to answer it itself", () => {
    expect(INSTRUCTIONS).toContain("consistencyQuestion");
    expect(INSTRUCTIONS).toContain("Never record your own answer to either");
    expect(INSTRUCTIONS).toContain("do not mark a field or a step unknown because of one");
  });

  it("gives every category a bullet, and no longer claims a contradiction is handled elsewhere", () => {
    for (const category of CONSISTENCY_CATEGORIES) {
      expect(CONSISTENCY_REVIEW_INSTRUCTIONS).toContain(`${category}:`);
    }
    expect(CONSISTENCY_REVIEW_INSTRUCTIONS).not.toContain("handled elsewhere");
  });

  it("tells the agent how to read a restatement_mismatch and what to do once it is answered", () => {
    expect(INSTRUCTIONS).toContain("aboutClaims");
    expect(INSTRUCTIONS).not.toContain("aboutClaimIds");
    expect(INSTRUCTIONS).toContain("restatement_mismatch");
    expect(INSTRUCTIONS).toContain("pendingMismatchClaims");
    expect(INSTRUCTIONS).toContain("call correct_claim on each claim there");
  });
});
