import {
  applyClaim,
  CLAIM_DEPTH_FOCUSES,
  type ClaimDepthAnalysisOutput,
  type ClaimWriteCommand,
  consistencyBasisOf,
  keepClaimDepthReviewForCurrentClaims,
  MAX_CLAIM_DEPTH_QUESTION_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  mergeClaimDepthAnalysis,
  type SopSession,
  sopSessionSchema,
} from "@sop-agent/sop-core";
import {
  buildClaim,
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
  CLAIM_DEPTH_REVIEW_INSTRUCTIONS,
  renderClaimDepthReviewInput,
} from "./claimDepthReview.ts";
import {
  INSTRUCTIONS,
  MAX_STATE_ITEM_LENGTH,
  measureStateItem,
  STATE_ITEM_WRITE_MARGIN,
} from "./prompt.ts";
import { runAgentTurn } from "./runTurn.ts";

const BLOCKING: [string, string][] = [
  ["purpose", "Keep every repair traceable."],
  ["scope", "All maintenance requests for line equipment."],
  ["trigger", "An operator notices a fault."],
  ["roles", "The maintenance supervisor assigns a technician."],
  ["procedure", "The requester submits an equipment fault report."],
  ["authorization", "The supervisor approves any repair over $1,000."],
  ["completionCriteria", "The technician confirms the machine runs normally."],
  ["governance", "The plant manager owns this and reviews it yearly."],
];

const QUESTION = "For the step where the operator submits a request, what must it include?";

function setup() {
  const context = createDeterministicContext();
  const created = createSessionWithUserMessage(context, "Here is the whole process.");
  const messageId = created.messageId;
  const apply = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result.session;
  };
  const record = (current: SopSession, field: string, statement: string) =>
    apply(current, {
      kind: "record",
      createdByType: "agent",
      field: field as never,
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
    // This file exercises the claim-depth review only; the consistency review is a separate
    // mechanism with its own test file, and becomes eligible the moment every blocking field is
    // filled (as it is here), so it is pre-marked "already reviewed, nothing found" here, keeping
    // it from making a call of its own that would otherwise consume an unscripted extraction step.
    return {
      ...session,
      consistencyReview: {
        basis: consistencyBasisOf(session),
        checkedAt: session.updatedAt,
        findings: [],
        offeredTotal: 0,
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

/** A review that flags the one procedure step as thin. */
const findingAboutTheStep: ScriptedExtractionStep = (request) => {
  const input = JSON.parse(request.input) as { candidates: { id: string }[] };
  const candidate = input.candidates[0];
  const output: ClaimDepthAnalysisOutput = {
    findings: [
      {
        priorFindingId: null,
        targetClaimId: candidate?.id ?? "",
        focus: "required_input",
        question: QUESTION,
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

describe("the claim-depth review inside a turn", () => {
  it("reviews the procedure steps, hands the agent one question, and records nothing because of it", async () => {
    const { fullSession, run } = setup();
    const before = fullSession();
    const { client, promise } = run([textStep("Anything else?")], [findingAboutTheStep], before);
    const result = await promise;

    expect(client.extractionRequests).toHaveLength(1);
    const question = stateOf(client.requests[0]?.stateItem).claimDepthQuestion as {
      question: string;
      focus: string;
      position: number;
    };
    expect(question).toMatchObject({ question: QUESTION, focus: "required_input", position: 1 });

    // A finding is not a claim: the claims are exactly what they were.
    expect(result.session.claims).toEqual(before.claims);
    expect(result.session.claimDepthReview?.offeredTotal).toBe(1);
    expect(result.session.claimDepthReview?.findings).toEqual([]);
    // The turn's stats reach the log, so they carry counts and a focus and never the question.
    expect(JSON.stringify(result.stats)).not.toContain("must it include");
    expect(result.stats).toMatchObject({
      claimDepthReview: "ran",
      claimDepthFindingsRaised: 1,
      claimDepthFindingsWaiting: 0,
      claimDepthQuestionFocus: "required_input",
    });
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("waits for the procedure step this turn writes, and reviews it once", async () => {
    const { emptySession, run } = setup();
    const { client, promise } = run(
      [
        toolCallStep(BLOCKING.map(([field, statement]) => recordClaimCall({ field, statement }))),
        textStep("Recorded."),
      ],
      [findingAboutTheStep],
      emptySession,
    );
    const result = await promise;

    expect(client.extractionRequests).toHaveLength(1);
    const reviewed = JSON.parse(client.extractionRequests[0]?.input ?? "{}") as {
      candidates: { statement: string }[];
    };
    expect(reviewed.candidates.map((candidate) => candidate.statement)).toContain(
      "The requester submits an equipment fault report.",
    );
    expect(stateOf(client.requests[1]?.stateItem).claimDepthQuestion).not.toBeNull();
    expect(result.stats.claimDepthReview).toBe("ran");
  });

  it("re-attempts within the same turn once a new candidate appears, for a session that already had an unasked one before this turn started", async () => {
    const { fullSession, run } = setup();
    // fullSession() already has one unasked procedure candidate from before this turn — the same
    // shape as a session that predates this feature, or one where an earlier turn's candidate was
    // never reviewed for some other reason (budget, a conflict since resolved, and so on).
    const before = fullSession();
    const { client, promise } = run(
      [
        toolCallStep([
          recordClaimCall({
            field: "procedure",
            statement: "The technician documents the repair in the log.",
          }),
        ]),
        textStep("Recorded."),
      ],
      // A third, no-op step absorbs an incidental consistency-review call this test does not care
      // about: adding a new procedure claim also changes that review's own basis (it, too, covers
      // every stated claim), which is unrelated to what this test checks.
      [
        findingAboutTheStep,
        findingAboutTheStep,
        () => ({ findings: [], resolvedPriorFindingIds: [] }),
      ],
      before,
    );
    await promise;

    // Two attempts specifically at the claim-depth review (identified by its own "candidates" input
    // shape, distinct from the consistency review's "claims"): one for the pre-existing candidate,
    // at the very first step before this turn's own tool call has even run, and a second once that
    // tool call adds a new candidate and changes the basis — the old once-per-turn flag would have
    // permanently blocked this second attempt, silently skipping the step this same message just
    // described until some later user turn.
    const claimDepthRequests = client.extractionRequests.filter((request) =>
      request.input.includes('"candidates"'),
    );
    expect(claimDepthRequests).toHaveLength(2);
  });

  it("accumulates findings raised, and keeps the review status ran, across repeated attempts within one turn", async () => {
    const { fullSession, run } = setup();
    const before = fullSession(); // one pre-existing, unasked candidate
    let callCount = 0;
    // Properly carries every earlier finding forward (as the model is instructed to) and raises one
    // new finding for whichever candidate isn't already covered by an earlier one, so both attempts
    // this test exercises actually succeed, rather than one failing on unaccounted-for accounting.
    const carryEarlierAndRaiseNew: ScriptedExtractionStep = (request) => {
      callCount += 1;
      const input = JSON.parse(request.input) as {
        candidates: { id: string }[];
        earlierFindings: {
          id: string;
          targetClaimId: string;
          focus: ClaimDepthAnalysisOutput["findings"][number]["focus"];
          question: string;
        }[];
      };
      const carried = input.earlierFindings.map((finding) => ({
        priorFindingId: finding.id,
        targetClaimId: finding.targetClaimId,
        focus: finding.focus,
        question: finding.question,
      }));
      const alreadyCovered = new Set(input.earlierFindings.map((finding) => finding.targetClaimId));
      const freshCandidate = input.candidates.find(
        (candidate) => !alreadyCovered.has(candidate.id),
      );
      const fresh =
        freshCandidate === undefined
          ? []
          : [
              {
                priorFindingId: null,
                targetClaimId: freshCandidate.id,
                focus: "required_input" as const,
                question: `What must this step include? (call ${callCount})`,
              },
            ];
      return {
        findings: [...carried, ...fresh],
        resolvedPriorFindingIds: [],
      } satisfies ClaimDepthAnalysisOutput;
    };

    const { promise } = run(
      [
        toolCallStep([
          recordClaimCall({
            field: "procedure",
            statement: "The technician documents the repair in the log.",
          }),
        ]),
        textStep("Recorded."),
      ],
      [carryEarlierAndRaiseNew, carryEarlierAndRaiseNew],
      before,
    );
    const result = await promise;

    // Each of the two successful attempts raises exactly one new finding (the first attempt's
    // finding is carried forward, not re-raised, by the second) — assigning instead of accumulating
    // would report only the second attempt's own count (1), losing the first attempt's contribution.
    expect(result.stats.claimDepthFindingsRaised).toBe(2);
    expect(result.stats.claimDepthReview).toBe("ran");
  });

  it("does not review with no procedure candidates", async () => {
    const { record, run, fullSession } = setup();
    const withoutProcedure = record(
      { ...fullSession(), claims: [], procedureOrder: [] },
      "purpose",
      "Keep every repair traceable.",
    );
    const { client, promise } = run([textStep("Who is covered?")], [], withoutProcedure);
    const result = await promise;
    expect(client.extractionRequests).toHaveLength(0);
    expect(result.stats.claimDepthReview).toBe("not_needed");
    expect(stateOf(client.requests[0]?.stateItem).claimDepthQuestion).toBeNull();
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
    expect(stateOf(client.requests[0]?.stateItem).claimDepthQuestion).toBeNull();
    expect(result.stats.claimDepthQuestionFocus).toBeNull();
  });

  it("does not ask the same question twice, and does not review the same candidates again", async () => {
    const { fullSession, run } = setup();
    const first = run([textStep("Anything else?")], [findingAboutTheStep], fullSession());
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
    expect(stateOf(second.client.requests[0]?.stateItem).claimDepthQuestion).toBeNull();
    expect(result.session.claimDepthReview?.offeredTotal).toBe(1);
  });

  it("carries on when the review fails, and does not try again for the same candidates", async () => {
    const { fullSession, run } = setup();
    const failing: ScriptedExtractionStep = () => {
      throw new ModelRefusalError("no");
    };
    const first = run([textStep("Anything else?")], [failing], fullSession());
    const result = await first.promise;
    expect(result.stats.claimDepthReview).toBe("failed");
    expect(result.session.messages.at(-1)?.text).toBe("Anything else?");
    expect(stateOf(first.client.requests[0]?.stateItem).claimDepthQuestion).toBeNull();

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

  it("does not rebase the claim-depth review when doing so would push a near-full state past the limit", async () => {
    const { fullSession, messageId, run } = setup();
    const before = fullSession(); // claimDepthReview starts null: nothing rebased yet this session.
    const source = {
      type: "employee_statement" as const,
      reference: { kind: "message" as const, messageId },
    };
    const failing: ScriptedExtractionStep = () => {
      throw new ModelRefusalError("no");
    };
    const deterministicContext = createDeterministicContext();
    const wouldOverflowOnRebase = (session: SopSession): boolean =>
      measureStateItem(keepClaimDepthReviewForCurrentClaims(session, deterministicContext)) >
      MAX_STATE_ITEM_LENGTH - STATE_ITEM_WRITE_MARGIN;

    // Bulk phase: many short claims get close to the point where even the rebase's own small
    // addition (a brand-new claimDepthReview object, where none existed before) would overflow.
    let bulkCount = 0;
    let sessionAtLimit: SopSession = before;
    for (; bulkCount <= 480; bulkCount += 1) {
      sessionAtLimit = {
        ...before,
        claims: [
          ...before.claims,
          ...Array.from({ length: bulkCount }, (_, index) =>
            buildClaim({
              claimId: `bulk-${index}`.padEnd(MAX_IDENTIFIER_LENGTH, "-"),
              field: "evidence",
              value: { kind: "statement", text: `${index}-`.padEnd(100, "x") },
              source,
            }),
          ),
        ],
      };
      if (wouldOverflowOnRebase(sessionAtLimit)) break;
    }
    expect(bulkCount).toBeLessThanOrEqual(480);
    bulkCount = Math.max(0, bulkCount - 1);
    // Fine phase: one more claim grown a character at a time finds the exact crossing point.
    let fillerLength = 0;
    for (; fillerLength <= 2_000; fillerLength += 1) {
      sessionAtLimit = {
        ...before,
        claims: [
          ...before.claims,
          ...Array.from({ length: bulkCount }, (_, index) =>
            buildClaim({
              claimId: `bulk-${index}`.padEnd(MAX_IDENTIFIER_LENGTH, "-"),
              field: "evidence",
              value: { kind: "statement", text: `${index}-`.padEnd(100, "x") },
              source,
            }),
          ),
          ...(fillerLength === 0
            ? []
            : [
                buildClaim({
                  claimId: "fine".padEnd(MAX_IDENTIFIER_LENGTH, "-"),
                  field: "evidence",
                  value: { kind: "statement", text: "x".repeat(fillerLength) },
                  source,
                }),
              ]),
        ],
      };
      if (wouldOverflowOnRebase(sessionAtLimit)) break;
    }
    expect(fillerLength).toBeLessThanOrEqual(2_000);

    const { promise } = run([textStep("Anything else?")], [failing], sessionAtLimit);
    const result = await promise;

    expect(result.stats.claimDepthReview).toBe("failed");
    // The rebase itself was skipped, since even it would have overflowed: claimDepthReview is left
    // exactly as it was (null), rather than committing a session the next turn's own upfront check
    // would refuse.
    expect(result.session.claimDepthReview).toBeNull();
    expect(measureStateItem(result.session)).toBeLessThanOrEqual(MAX_STATE_ITEM_LENGTH);
  });

  it("treats a review that cites a claim it was not given as a failed review", async () => {
    const { fullSession, run } = setup();
    const invented: ScriptedExtractionStep = () =>
      ({
        findings: [
          {
            priorFindingId: null,
            targetClaimId: "a-claim-nobody-recorded",
            focus: "required_input",
            question: "What must it include?",
          },
        ],
        resolvedPriorFindingIds: [],
      }) satisfies ClaimDepthAnalysisOutput;
    const { promise } = run([textStep("Anything else?")], [invented], fullSession());
    const result = await promise;
    expect(result.stats.claimDepthReview).toBe("failed");
    expect(result.session.claimDepthReview?.findings).toEqual([]);
    // The call was made and billed even though its answer was refused.
    expect(result.stats.inputTokens).toBeGreaterThanOrEqual(100);
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

  it("skips the consistency-review call entirely when a fresh claim-depth question already fired this turn", async () => {
    const { fullSession, run } = setup();
    // Only one extraction step is scripted: if the consistency review were also attempted, the
    // fake client would push a second request and throw "ran out of steps" inside it (caught,
    // fail-open) — this asserts that call is never made at all, not merely that it fails quietly.
    const { client, promise } = run(
      [textStep("Anything else?")],
      [findingAboutTheStep],
      fullSession(),
    );
    await promise;
    expect(client.extractionRequests).toHaveLength(1);
  });

  it("defers an existing unoffered consistency question instead of silently consuming it, when a claim-depth question takes priority", async () => {
    const { fullSession, run } = setup();
    const before = fullSession();
    // A consistency question is already on file from an earlier turn's successful review, unrelated
    // to this turn's fresh claim-depth finding.
    const withPendingConsistencyQuestion: SopSession = {
      ...before,
      consistencyReview: {
        basis: consistencyBasisOf(before),
        checkedAt: before.updatedAt,
        offeredTotal: 0,
        findings: [
          {
            findingId: "pending-consistency-finding",
            category: "missing_outcome_path",
            targetField: "procedure",
            relatedClaimIds: [],
            question: "What happens when a repair is refused under warranty?",
            wasOffered: false,
          },
        ],
      },
    };
    const { promise } = run(
      [textStep("Anything else?")],
      [findingAboutTheStep],
      withPendingConsistencyQuestion,
    );
    const result = await promise;

    // The claim-depth question was asked and offered...
    expect(result.stats.claimDepthQuestionFocus).toBe("required_input");
    expect(result.session.claimDepthReview?.offeredTotal).toBe(1);
    // ...but the consistency question, which lost that priority fight and was never actually put
    // to the person this turn, must not have silently burned its one-time offer either.
    expect(result.stats.consistencyQuestionCategory).toBeNull();
    expect(result.session.consistencyReview?.findings[0]?.wasOffered).toBe(false);
    expect(result.session.consistencyReview?.offeredTotal).toBe(0);
  });

  it("discards a freshly found question that would push the state past its limit, treating it as a failed review", async () => {
    const { fullSession, messageId, run } = setup();
    const before = fullSession();
    const procedureClaimId = before.procedureOrder[0] ?? "";
    const source = {
      type: "employee_statement" as const,
      reference: { kind: "message" as const, messageId },
    };
    const buildMaximalFinding = (): ClaimDepthAnalysisOutput => ({
      findings: [
        {
          priorFindingId: null,
          targetClaimId: procedureClaimId,
          focus: "required_input",
          question: "Q".repeat(MAX_CLAIM_DEPTH_QUESTION_LENGTH),
        },
      ],
      resolvedPriorFindingIds: [],
    });
    const maximalFinding: ScriptedExtractionStep = () => buildMaximalFinding();
    const deterministicContext = createDeterministicContext();

    // Many short claims add far more state-item size per character of claim text than a few long
    // ones (each repeats an id, a field, a status and other JSON structure), and the schema also
    // caps total claim text well below the state-item limit — so the bulk phase grows the *count*
    // of short claims (up to the session's own claim-count cap), and a fine phase then grows one
    // more claim's text one character at a time, to find the exact point where merging the maximal
    // finding above would first exceed the write margin — checked directly, not estimated, so the
    // real, async turn below only has to run once.
    const buildFiller = (bulkCount: number, fineLength: number) => [
      ...Array.from({ length: bulkCount }, (_, index) =>
        buildClaim({
          claimId: `bulk-${index}`.padEnd(MAX_IDENTIFIER_LENGTH, "-"),
          field: "evidence",
          value: { kind: "statement", text: `${index}-`.padEnd(100, "x") },
          source,
        }),
      ),
      ...(fineLength === 0
        ? []
        : [
            buildClaim({
              claimId: "fine".padEnd(MAX_IDENTIFIER_LENGTH, "-"),
              field: "evidence",
              value: { kind: "statement", text: "x".repeat(fineLength) },
              source,
            }),
          ]),
    ];
    const exceedsMargin = (session: SopSession): boolean => {
      const simulated = mergeClaimDepthAnalysis(
        session,
        buildMaximalFinding(),
        deterministicContext,
      );
      return (
        simulated.ok &&
        measureStateItem(simulated.session) > MAX_STATE_ITEM_LENGTH - STATE_ITEM_WRITE_MARGIN
      );
    };

    let bulkCount = 0;
    let sessionAtLimit: SopSession = before;
    for (; bulkCount <= 480; bulkCount += 1) {
      sessionAtLimit = { ...before, claims: [...before.claims, ...buildFiller(bulkCount, 0)] };
      if (exceedsMargin(sessionAtLimit)) break;
    }
    expect(bulkCount).toBeLessThanOrEqual(480);
    bulkCount = Math.max(0, bulkCount - 1); // back off one step, then fine-tune from just below it
    let fillerLength = 0;
    for (; fillerLength <= 2_000; fillerLength += 1) {
      sessionAtLimit = {
        ...before,
        claims: [...before.claims, ...buildFiller(bulkCount, fillerLength)],
      };
      if (exceedsMargin(sessionAtLimit)) break;
    }
    expect(fillerLength).toBeLessThanOrEqual(2_000);

    const { promise } = run([textStep("Anything else?")], [maximalFinding], sessionAtLimit);
    const result = await promise;

    expect(result.stats.claimDepthReview).toBe("failed");
    expect(result.session.claimDepthReview?.findings).toEqual([]);
    expect(measureStateItem(result.session)).toBeLessThanOrEqual(MAX_STATE_ITEM_LENGTH);
  });
});

describe("what the review model is given", () => {
  it("holds the procedure candidates and other stated claims as read-only context, and no conversation", () => {
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
    const input = renderClaimDepthReviewInput(withSuggestion);
    expect(input).not.toContain("SUGGESTION-TEXT");
    expect(input).not.toContain("Here is the whole process.");
    const parsed = JSON.parse(input) as {
      candidates: { statement: string }[];
      context: { field: string; statement: string }[];
    };
    expect(parsed.candidates.map((candidate) => candidate.statement)).toEqual([
      "The requester submits an equipment fault report.",
    ]);
    expect(parsed.context.some((claim) => claim.field === "roles")).toBe(true);
  });

  it("includes every candidate in context too, so a sibling candidate under review in the same call can supply the detail another one seems to leave out", () => {
    const { fullSession, apply, messageId } = setup();
    const withSecondStep = apply(fullSession(), {
      kind: "record",
      createdByType: "agent",
      field: "procedure",
      status: "observed",
      statement:
        "The technician logs the asset id, location and fault description in the ticketing system.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    });
    const input = renderClaimDepthReviewInput(withSecondStep);
    const parsed = JSON.parse(input) as {
      candidates: { statement: string }[];
      context: { statement: string }[];
    };
    expect(parsed.candidates).toHaveLength(2);
    for (const candidate of parsed.candidates) {
      expect(parsed.context.some((claim) => claim.statement === candidate.statement)).toBe(true);
    }
  });

  it("includes a candidate's and a context claim's note, since the missing detail can be recorded there instead of in the statement", () => {
    const { fullSession, apply, messageId } = setup();
    const session = fullSession();
    const procedureClaimId = session.procedureOrder[0] ?? "";
    const rolesClaimId = session.claims.find((claim) => claim.field === "roles")?.claimId ?? "";
    const withProcedureNote = apply(session, {
      kind: "correct",
      createdByType: "agent",
      claimId: procedureClaimId,
      statement: "The requester submits an equipment fault report.",
      note: "Includes the asset id, location and fault description.",
      effectiveDate: null,
      sourceMessageId: messageId,
    });
    const withNotes = apply(withProcedureNote, {
      kind: "correct",
      createdByType: "agent",
      claimId: rolesClaimId,
      statement: "The maintenance supervisor assigns a technician.",
      note: "Assignment happens within one business day.",
      effectiveDate: null,
      sourceMessageId: messageId,
    });
    const input = renderClaimDepthReviewInput(withNotes);
    const parsed = JSON.parse(input) as {
      candidates: { note: string | null }[];
      context: { note: string | null }[];
    };
    expect(parsed.candidates[0]?.note).toBe(
      "Includes the asset id, location and fault description.",
    );
    expect(
      parsed.context.some((claim) => claim.note === "Assignment happens within one business day."),
    ).toBe(true);
  });

  it("keeps claim text out of both sets of fixed instructions", () => {
    for (const [, statement] of BLOCKING) {
      expect(CLAIM_DEPTH_REVIEW_INSTRUCTIONS).not.toContain(statement);
      expect(INSTRUCTIONS).not.toContain(statement);
    }
  });

  it("tells the agent a claim-depth question is a question, and never to answer it itself", () => {
    expect(INSTRUCTIONS).toContain("claimDepthQuestion");
    expect(INSTRUCTIONS).toContain("Never record your own answer to either");
    expect(INSTRUCTIONS).toContain("do not mark a field or a step unknown because of one");
  });

  it("gives every focus a bullet, and never chooses which is right for the actor", () => {
    for (const focus of CLAIM_DEPTH_FOCUSES) {
      expect(CLAIM_DEPTH_REVIEW_INSTRUCTIONS).toContain(`${focus}:`);
    }
    expect(CLAIM_DEPTH_REVIEW_INSTRUCTIONS).toContain("who performs it");
  });

  it("tells the agent how to read a claimDepthQuestion and what to do once it is answered", () => {
    expect(INSTRUCTIONS).toContain("pendingClaimDepthTarget");
    expect(INSTRUCTIONS).toContain("position");
    expect(INSTRUCTIONS).toContain("call correct_claim on that step");
  });

  it("tells the agent to keep the step's existing action and actor rather than replace it with only the missing detail", () => {
    expect(INSTRUCTIONS).toContain("missing detail itself");
    expect(INSTRUCTIONS).toContain("keeping the existing action and actor");
  });
});
