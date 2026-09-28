import { describe, expect, it } from "vitest";
import { applyClaim, type ClaimWriteCommand } from "./applyClaim.ts";
import {
  consistencyBasisOf,
  currentConsistencyReview,
  keepConsistencyReviewForCurrentClaims,
  markConsistencyQuestionOffered,
  mergeConsistencyAnalysis,
  needsConsistencyReview,
  nextConsistencyQuestion,
  pendingMismatchClaims,
  statedClaimsInReadingOrder,
  statesOutOfTime,
} from "./consistencyReview.ts";
import {
  type ConsistencyAnalysisOutput,
  consistencyReviewSchema,
  MAX_ABOUT_CLAIM_STATEMENT_LENGTH,
  MAX_CONSISTENCY_QUESTIONS_PER_SESSION,
} from "./consistencyReviewSchema.ts";
import { buildInterviewAgenda } from "./interviewAgenda.ts";
import { type SopSession, sopSessionSchema } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import { createDeterministicContext, createSessionWithUserMessage } from "./testing.ts";

const BLOCKING_STATEMENTS: [SopFieldName, string][] = [
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

function setup() {
  const context = createDeterministicContext();
  const { session: empty, messageId } = createSessionWithUserMessage(
    context,
    "Here is the process.",
  );
  const apply = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result;
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
  const fullSession = (): SopSession =>
    BLOCKING_STATEMENTS.reduce(
      (current, [field, statement]) => record(current, field, statement).session,
      empty,
    );
  const withUserMessage = (current: SopSession, text: string): SopSession => ({
    ...current,
    messages: [
      ...current.messages,
      {
        id: `later-${current.messages.length}`,
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        text,
      },
    ],
  });
  return { context, empty, messageId, apply, record, fullSession, withUserMessage };
}

const OUTPUT_WITH_ONE_FINDING = (relatedClaimIds: string[]): ConsistencyAnalysisOutput => ({
  findings: [
    {
      priorFindingId: null,
      category: "unreached_role_or_tier",
      targetField: "procedure",
      relatedClaimIds,
      question: "What happens to a refund above $2,000? No step sends it to the Finance Director.",
    },
  ],
  resolvedPriorFindingIds: [],
});

describe("statesOutOfTime", () => {
  it("reads a person asking for the questions to stop", () => {
    for (const message of [
      "I'm out of time.",
      "We are running out of time here.",
      "I don't have time for more.",
      "No more questions please",
      "That's everything.",
      "Stop asking, I am done",
    ]) {
      expect(statesOutOfTime(message)).toBe(true);
    }
  });

  it("does not read an ordinary answer", () => {
    expect(statesOutOfTime("Managers approve up to $2,000 within one business day.")).toBe(false);
    // Statements about the process, not a request to stop.
    expect(statesOutOfTime("There is no time limit for appeals.")).toBe(false);
    expect(statesOutOfTime("We don't have time requirements for that step.")).toBe(false);
    expect(statesOutOfTime("Appeals filed out of time go to Legal.")).toBe(false);
  });
});

describe("when a consistency review is needed", () => {
  it("is not needed on a sparse interview", () => {
    const { record, empty } = setup();
    const sparse = record(empty, "purpose", "Make every refund fair.").session;
    expect(needsConsistencyReview(sparse)).toBe(false);
  });

  it("is needed once no blocking gap remains and no review has been made", () => {
    const { fullSession } = setup();
    expect(needsConsistencyReview(fullSession())).toBe(true);
  });

  it("is not needed while a document rule or a conflict is unsettled", () => {
    const { fullSession, apply } = setup();
    const withExtracted = apply(fullSession(), {
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
    }).session;
    expect(needsConsistencyReview(withExtracted)).toBe(false);
  });

  it("is not needed after the person asked for the questions to stop", () => {
    const { fullSession, withUserMessage } = setup();
    expect(
      needsConsistencyReview(withUserMessage(fullSession(), "I'm out of time, that's everything.")),
    ).toBe(false);
  });

  it("is not needed for claims the latest review already saw, and is needed again after a change", () => {
    const { fullSession, context, record } = setup();
    const session = fullSession();
    const merged = mergeConsistencyAnalysis(
      session,
      { findings: [], resolvedPriorFindingIds: [] },
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    expect(needsConsistencyReview(merged.session)).toBe(false);

    const changed = record(
      merged.session,
      "exceptions",
      "A missing receipt is replaced by the order number.",
    );
    expect(needsConsistencyReview(changed.session)).toBe(true);
  });

  it("is not needed once the session's question budget is spent", () => {
    const { fullSession, context } = setup();
    const merged = mergeConsistencyAnalysis(
      fullSession(),
      { findings: [], resolvedPriorFindingIds: [] },
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    const spent: SopSession = {
      ...merged.session,
      consistencyReview: {
        ...(merged.session.consistencyReview as NonNullable<SopSession["consistencyReview"]>),
        basis: "stale",
        offeredTotal: MAX_CONSISTENCY_QUESTIONS_PER_SESSION,
      },
    };
    expect(needsConsistencyReview(spent)).toBe(false);
  });
});

describe("the fingerprint of the claims", () => {
  it("does not change when a claim is confirmed, and does when its wording changes", () => {
    const { fullSession, apply } = setup();
    const session = fullSession();
    const first = session.claims[0];
    if (first === undefined) throw new Error("no claim");
    const confirmed = apply(session, {
      kind: "confirm",
      createdByType: "user",
      claimId: first.claimId,
    }).session;
    expect(consistencyBasisOf(confirmed)).toBe(consistencyBasisOf(session));

    const corrected = apply(session, {
      kind: "correct",
      createdByType: "agent",
      claimId: first.claimId,
      statement: "Make every refund fair, consistent and traceable.",
      note: null,
      effectiveDate: null,
      sourceMessageId: session.messages[0]?.id ?? "",
    }).session;
    expect(consistencyBasisOf(corrected)).not.toBe(consistencyBasisOf(session));
  });

  it("reads the procedure in its real order and leaves out a suggestion and a document rule", () => {
    const { fullSession, record, apply } = setup();
    const withSuggestion = apply(fullSession(), {
      kind: "record",
      createdByType: "agent",
      field: "controls",
      status: "proposed",
      statement: "Audit a sample every month.",
      note: "Suggested by the assistant.",
      effectiveDate: null,
      sourceMessageId: fullSession().messages[0]?.id ?? "",
      insertBeforeClaimId: null,
    }).session;
    const texts = statedClaimsInReadingOrder(withSuggestion).map((claim) => claim.value?.text);
    expect(texts).not.toContain("Audit a sample every month.");
    expect(texts.slice(0, 2)).toEqual([
      "Log the request in the ticketing system.",
      "Send refunds above $200 to the Support Manager.",
    ]);
    expect(record).toBeDefined();
  });
});

describe("storing what the model returned", () => {
  it("stores a valid review for the current claims and gives every new finding an id", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const cited = session.claims.find((claim) => claim.field === "roles");
    const merged = mergeConsistencyAnalysis(
      session,
      OUTPUT_WITH_ONE_FINDING([cited?.claimId ?? ""]),
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);

    expect(merged.raisedCount).toBe(1);
    const review = currentConsistencyReview(merged.session);
    expect(review?.findings).toHaveLength(1);
    expect(review?.findings[0]).toMatchObject({
      wasOffered: false,
      category: "unreached_role_or_tier",
    });
    expect(sopSessionSchema.safeParse(merged.session).success).toBe(true);
    // A finding is not a claim: the claims are exactly what they were.
    expect(merged.session.claims).toEqual(session.claims);
  });

  it("refuses a citation to a claim it was not given, and an empty question", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    expect(
      mergeConsistencyAnalysis(session, OUTPUT_WITH_ONE_FINDING(["no-such-claim"]), context).ok,
    ).toBe(false);
    const blank = OUTPUT_WITH_ONE_FINDING([]);
    const first = blank.findings[0];
    if (first === undefined) throw new Error("no finding");
    first.question = "   ";
    expect(mergeConsistencyAnalysis(session, blank, context).ok).toBe(false);
  });

  it("refuses an output over the limits that the output schema does not state", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const one = OUTPUT_WITH_ONE_FINDING([]).findings[0];
    if (one === undefined) throw new Error("no finding");
    const tooMany = { findings: Array.from({ length: 5 }, () => one), resolvedPriorFindingIds: [] };
    expect(mergeConsistencyAnalysis(session, tooMany, context).ok).toBe(false);
    const tooLong = {
      findings: [{ ...one, question: "Why? ".repeat(100) }],
      resolvedPriorFindingIds: [],
    };
    expect(mergeConsistencyAnalysis(session, tooLong, context).ok).toBe(false);
    const tooManyClaims = {
      findings: [{ ...one, relatedClaimIds: ["a", "b", "c", "d"] }],
      resolvedPriorFindingIds: [],
    };
    expect(mergeConsistencyAnalysis(session, tooManyClaims, context).ok).toBe(false);
  });

  it("never lets an earlier finding disappear without being answered", () => {
    const { fullSession, context } = setup();
    const first = mergeConsistencyAnalysis(fullSession(), OUTPUT_WITH_ONE_FINDING([]), context);
    if (!first.ok) throw new Error(first.reason);
    const findingId = first.session.consistencyReview?.findings[0]?.findingId ?? "";

    const dropped = mergeConsistencyAnalysis(
      first.session,
      { findings: [], resolvedPriorFindingIds: [] },
      context,
    );
    expect(dropped.ok).toBe(false);

    const resolved = mergeConsistencyAnalysis(
      first.session,
      { findings: [], resolvedPriorFindingIds: [findingId] },
      context,
    );
    expect(resolved.ok && resolved.session.consistencyReview?.findings).toEqual([]);

    const twice = mergeConsistencyAnalysis(
      first.session,
      {
        findings: [
          { ...OUTPUT_WITH_ONE_FINDING([]).findings[0], priorFindingId: findingId } as never,
        ],
        resolvedPriorFindingIds: [findingId],
      },
      context,
    );
    expect(twice.ok).toBe(false);
    const unknown = mergeConsistencyAnalysis(
      first.session,
      { findings: [], resolvedPriorFindingIds: [findingId, "ghost"] },
      context,
    );
    expect(unknown.ok).toBe(false);
  });

  it("keeps the id and the offered flag of a finding that carries on", () => {
    const { fullSession, context } = setup();
    const first = mergeConsistencyAnalysis(fullSession(), OUTPUT_WITH_ONE_FINDING([]), context);
    if (!first.ok) throw new Error(first.reason);
    const findingId = first.session.consistencyReview?.findings[0]?.findingId ?? "";
    const offered = markConsistencyQuestionOffered(first.session, findingId, context);

    const carried = mergeConsistencyAnalysis(
      offered,
      {
        findings: [
          {
            ...OUTPUT_WITH_ONE_FINDING([]).findings[0],
            priorFindingId: findingId,
            question: "Reworded: what happens above $2,000?",
          } as never,
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    if (!carried.ok) throw new Error(carried.reason);
    expect(carried.carriedCount).toBe(1);
    expect(carried.session.consistencyReview?.findings[0]).toMatchObject({
      findingId,
      wasOffered: true,
    });
  });
});

describe("restatement_mismatch", () => {
  const MISMATCH_OUTPUT = (
    relatedClaimIds: string[],
    targetField: SopFieldName = "authorization",
  ): ConsistencyAnalysisOutput => ({
    findings: [
      {
        priorFindingId: null,
        category: "restatement_mismatch",
        targetField,
        relatedClaimIds,
        question:
          "The roles and authorization fields disagree about the $2,000 boundary. Which is right?",
      },
    ],
    resolvedPriorFindingIds: [],
  });

  function twoDistinctClaimIds(session: SopSession): [string, string] {
    const roles = session.claims.find((claim) => claim.field === "roles");
    const authorization = session.claims.find((claim) => claim.field === "authorization");
    if (roles === undefined || authorization === undefined) throw new Error("fixture missing");
    return [roles.claimId, authorization.claimId];
  }

  it("accepts a mismatch citing two distinct claims from different fields, and writes no claim", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const [rolesId, authorizationId] = twoDistinctClaimIds(session);
    const merged = mergeConsistencyAnalysis(
      session,
      MISMATCH_OUTPUT([rolesId, authorizationId]),
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    expect(merged.session.consistencyReview?.findings[0]).toMatchObject({
      category: "restatement_mismatch",
    });
    expect(sopSessionSchema.safeParse(merged.session).success).toBe(true);
    expect(merged.session.claims).toEqual(session.claims);
  });

  it("refuses fewer than two distinct related claims", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const [rolesId] = twoDistinctClaimIds(session);
    expect(mergeConsistencyAnalysis(session, MISMATCH_OUTPUT([]), context).ok).toBe(false);
    expect(mergeConsistencyAnalysis(session, MISMATCH_OUTPUT([rolesId]), context).ok).toBe(false);
    // The same claim cited twice is still only one side of a disagreement.
    expect(mergeConsistencyAnalysis(session, MISMATCH_OUTPUT([rolesId, rolesId]), context).ok).toBe(
      false,
    );
  });

  it("refuses a targetField that is not one of the cited claims' own fields", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const [rolesId, authorizationId] = twoDistinctClaimIds(session);
    expect(
      mergeConsistencyAnalysis(
        session,
        MISMATCH_OUTPUT([rolesId, authorizationId], "procedure"),
        context,
      ).ok,
    ).toBe(false);
  });

  it("does not apply the two-claim rule to the other categories", () => {
    const { fullSession, context } = setup();
    const merged = mergeConsistencyAnalysis(fullSession(), OUTPUT_WITH_ONE_FINDING([]), context);
    expect(merged.ok).toBe(true);
  });

  it("offers a mismatch before an omission, whatever order the model returned them in", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const [rolesId, authorizationId] = twoDistinctClaimIds(session);
    const omission = OUTPUT_WITH_ONE_FINDING([]).findings[0];
    const mismatch = MISMATCH_OUTPUT([rolesId, authorizationId]).findings[0];
    if (omission === undefined || mismatch === undefined) throw new Error("fixture missing");
    const merged = mergeConsistencyAnalysis(
      session,
      { findings: [omission, mismatch], resolvedPriorFindingIds: [] },
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    expect(merged.session.consistencyReview?.findings[0]?.category).not.toBe(
      "restatement_mismatch",
    );
    expect(nextConsistencyQuestion(merged.session)?.category).toBe("restatement_mismatch");
  });

  it("gives the agent each related claim's field and current wording, in citation order", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const [rolesId, authorizationId] = twoDistinctClaimIds(session);
    const merged = mergeConsistencyAnalysis(
      session,
      MISMATCH_OUTPUT([authorizationId, rolesId]),
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    const question = nextConsistencyQuestion(merged.session);
    expect(question?.aboutClaims).toEqual([
      {
        id: authorizationId,
        field: "authorization",
        statement: "Managers up to $2,000, and above that the Finance Director.",
      },
      {
        id: rolesId,
        field: "roles",
        statement: "The Finance Director approves refunds above $2,000.",
      },
    ]);
  });

  it("truncates a long claim statement, so up to three of them cannot meaningfully compete with the state-size margin", () => {
    const { fullSession, context, apply } = setup();
    const session = fullSession();
    const [rolesId, authorizationId] = twoDistinctClaimIds(session);
    const longStatement = "The Finance Director approves refunds above $2,000. ".repeat(20);
    const lengthened = apply(session, {
      kind: "correct",
      createdByType: "agent",
      claimId: rolesId,
      statement: longStatement,
      note: null,
      effectiveDate: null,
      sourceMessageId: session.messages[0]?.id ?? "",
    }).session;

    const merged = mergeConsistencyAnalysis(
      lengthened,
      MISMATCH_OUTPUT([authorizationId, rolesId]),
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    const question = nextConsistencyQuestion(merged.session);
    const roles = question?.aboutClaims.find((claim) => claim.id === rolesId);
    expect(roles?.statement.length).toBe(MAX_ABOUT_CLAIM_STATEMENT_LENGTH);
    expect(roles?.statement.endsWith("…")).toBe(true);
    expect(longStatement.startsWith(roles?.statement.slice(0, -1) ?? "")).toBe(true);
  });

  it("keeps a mismatch's claims available to correct on the answering turn, once it is no longer the question being asked", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const [rolesId, authorizationId] = twoDistinctClaimIds(session);
    const merged = mergeConsistencyAnalysis(
      session,
      MISMATCH_OUTPUT([rolesId, authorizationId]),
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.consistencyReview?.findings[0]?.findingId ?? "";

    // Before it is offered, there is nothing pending yet: it is still the question to ask.
    expect(pendingMismatchClaims(merged.session)).toEqual([]);
    expect(nextConsistencyQuestion(merged.session)?.findingId).toBe(findingId);

    // Once offered (the same turn it was asked), it is no longer nextConsistencyQuestion...
    const offered = markConsistencyQuestionOffered(merged.session, findingId, context);
    expect(nextConsistencyQuestion(offered)).toBeNull();
    // ...but its claims are still available on the answering turn, so it can still be corrected.
    expect(
      pendingMismatchClaims(offered)
        .map((claim) => claim.id)
        .sort(),
    ).toEqual([rolesId, authorizationId].sort());

    // Once a later review reports it resolved, it is gone from both.
    const resolved = mergeConsistencyAnalysis(
      offered,
      { findings: [], resolvedPriorFindingIds: [findingId] },
      context,
    );
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(pendingMismatchClaims(resolved.session)).toEqual([]);
  });

  it("exposes only the most recently offered mismatch, not every one ever offered, so the aggregate stays bounded", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const [rolesId, authorizationId] = twoDistinctClaimIds(session);
    const purposeId = session.claims.find((claim) => claim.field === "purpose")?.claimId ?? "";
    const scopeId = session.claims.find((claim) => claim.field === "scope")?.claimId ?? "";

    const firstMismatch = mergeConsistencyAnalysis(
      session,
      MISMATCH_OUTPUT([rolesId, authorizationId]),
      context,
    );
    if (!firstMismatch.ok) throw new Error(firstMismatch.reason);
    const firstId = firstMismatch.session.consistencyReview?.findings[0]?.findingId ?? "";
    const afterFirstOffered = markConsistencyQuestionOffered(
      firstMismatch.session,
      firstId,
      context,
    );

    // A second, distinct mismatch is raised and offered before the first is ever resolved. The
    // first is carried forward unchanged, since the review must account for every earlier finding.
    const firstFinding = firstMismatch.session.consistencyReview?.findings[0];
    if (firstFinding === undefined) throw new Error("no first finding");
    const secondOutput: ConsistencyAnalysisOutput = {
      // The new (about-to-be-offered) finding is listed BEFORE the older carried one on purpose:
      // "most recent" must come from offeredSequence, never from position in this array, since
      // nothing constrains which order the model returns findings in on a later merge.
      findings: [
        {
          priorFindingId: null,
          category: "restatement_mismatch",
          targetField: "scope",
          relatedClaimIds: [purposeId, scopeId],
          question: "The purpose and scope fields disagree. Which is right?",
        },
        {
          priorFindingId: firstId,
          category: firstFinding.category,
          targetField: firstFinding.targetField,
          relatedClaimIds: firstFinding.relatedClaimIds,
          question: firstFinding.question,
        },
      ],
      resolvedPriorFindingIds: [],
    };
    const secondMismatch = mergeConsistencyAnalysis(afterFirstOffered, secondOutput, context);
    if (!secondMismatch.ok) throw new Error(secondMismatch.reason);
    const secondId =
      secondMismatch.session.consistencyReview?.findings.find(
        (finding) => finding.findingId !== firstId,
      )?.findingId ?? "";
    const afterBothOffered = markConsistencyQuestionOffered(
      secondMismatch.session,
      secondId,
      context,
    );

    // Only the second (most recently offered) mismatch's claims are exposed, not both.
    const pending = pendingMismatchClaims(afterBothOffered);
    expect(pending.map((claim) => claim.id).sort()).toEqual([purposeId, scopeId].sort());
    expect(pending.some((claim) => claim.id === rolesId || claim.id === authorizationId)).toBe(
      false,
    );
  });

  it("treats a carried finding as new when its category changes, instead of silently suppressing it", () => {
    const { fullSession, context } = setup();
    const session = fullSession();
    const [rolesId, authorizationId] = twoDistinctClaimIds(session);

    // Raise and offer an ordinary finding, in a category other than restatement_mismatch.
    const firstMerge = mergeConsistencyAnalysis(session, OUTPUT_WITH_ONE_FINDING([]), context);
    if (!firstMerge.ok) throw new Error(firstMerge.reason);
    const findingId = firstMerge.session.consistencyReview?.findings[0]?.findingId ?? "";
    const offered = markConsistencyQuestionOffered(firstMerge.session, findingId, context);
    expect(nextConsistencyQuestion(offered)).toBeNull();

    // A later review carries the same finding id forward but reclassifies it as a
    // restatement_mismatch. This is a genuinely new concern the person was never asked about, even
    // though it reuses the earlier finding's id, so it must be offered like any new finding: never
    // silently absorbed as "already offered" under the new category, which would otherwise mean
    // nextConsistencyQuestion skips it forever while pendingMismatchClaims wrongly shows it as
    // stale already-offered context instead of a fresh question.
    const reclassified = mergeConsistencyAnalysis(
      offered,
      {
        findings: [
          {
            priorFindingId: findingId,
            category: "restatement_mismatch",
            targetField: "authorization",
            relatedClaimIds: [rolesId, authorizationId],
            question: "The roles and authorization fields disagree. Which is right?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    if (!reclassified.ok) throw new Error(reclassified.reason);
    expect(reclassified.session.consistencyReview?.findings[0]).toMatchObject({
      findingId,
      wasOffered: false,
    });
    expect(nextConsistencyQuestion(reclassified.session)?.findingId).toBe(findingId);
    expect(pendingMismatchClaims(reclassified.session)).toEqual([]);
  });
});

describe("handing the agent one question", () => {
  function sessionWithFindings(count: number) {
    const { fullSession, context } = setup();
    const findings = Array.from({ length: count }, (_, index) => ({
      ...OUTPUT_WITH_ONE_FINDING([]).findings[0],
      question: `Question number ${index + 1}?`,
    }));
    const merged = mergeConsistencyAnalysis(
      fullSession(),
      { findings: findings as never, resolvedPriorFindingIds: [] },
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    return { session: merged.session, context };
  }

  it("offers the first finding, once each, and counts it against the budget", () => {
    const { session, context } = sessionWithFindings(2);
    const first = nextConsistencyQuestion(session);
    expect(first?.question).toBe("Question number 1?");
    expect(buildInterviewAgenda(session).consistencyQuestion?.findingId).toBe(first?.findingId);

    const afterOffer = markConsistencyQuestionOffered(session, first?.findingId ?? "", context);
    expect(afterOffer.consistencyReview?.offeredTotal).toBe(1);
    expect(nextConsistencyQuestion(afterOffer)?.question).toBe("Question number 2?");
    // Marking the same finding again changes nothing.
    expect(markConsistencyQuestionOffered(afterOffer, first?.findingId ?? "", context)).toBe(
      afterOffer,
    );
    expect(sopSessionSchema.safeParse(afterOffer).success).toBe(true);
  });

  it("offers nothing when the review is out of date, the person is out of time, or the budget is spent", () => {
    const { session, context } = sessionWithFindings(1);
    const { withUserMessage } = setup();
    expect(nextConsistencyQuestion(withUserMessage(session, "I'm out of time."))).toBeNull();

    const changed: SopSession = {
      ...session,
      claims: session.claims.map((claim, index) =>
        index === 0
          ? { ...claim, value: { kind: "statement", text: "Changed wording of the purpose." } }
          : claim,
      ),
    };
    expect(nextConsistencyQuestion(changed)).toBeNull();

    let spent = session;
    for (let count = 0; count < MAX_CONSISTENCY_QUESTIONS_PER_SESSION; count += 1) {
      spent = {
        ...spent,
        consistencyReview: {
          ...(spent.consistencyReview as NonNullable<SopSession["consistencyReview"]>),
          offeredTotal: count + 1,
        },
      };
    }
    expect(nextConsistencyQuestion(spent)).toBeNull();
    expect(context).toBeDefined();
  });

  it("offers nothing while a blocking gap remains", () => {
    const { session } = sessionWithFindings(1);
    const withoutPurpose: SopSession = {
      ...session,
      claims: session.claims.filter((claim) => claim.field !== "purpose"),
    };
    expect(nextConsistencyQuestion(withoutPurpose)).toBeNull();
  });
});

describe("the review in the session schema", () => {
  it("refuses a review that marks more findings offered than were offered", () => {
    const parsed = consistencyReviewSchema.safeParse({
      basis: "1:abc",
      checkedAt: "2026-01-01T00:00:00.000Z",
      offeredTotal: 0,
      findings: [
        {
          findingId: "f1",
          category: "missing_outcome_path",
          targetField: "procedure",
          relatedClaimIds: [],
          question: "What happens when a request is denied?",
          wasOffered: true,
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("starts empty, and a session of an older version is refused", () => {
    const { empty } = setup();
    expect(empty.consistencyReview).toBeNull();
    expect(sopSessionSchema.safeParse({ ...empty, schemaVersion: 5 }).success).toBe(false);
  });
});

describe("when a review could not be made", () => {
  it("keeps what was on file for the current claims, so the attempt is not repeated until they change", () => {
    const { fullSession, context, record } = setup();
    const session = fullSession();
    const kept = keepConsistencyReviewForCurrentClaims(session, context);
    expect(kept.consistencyReview?.findings).toEqual([]);
    expect(needsConsistencyReview(kept)).toBe(false);
    expect(sopSessionSchema.safeParse(kept).success).toBe(true);

    const changed = record(
      kept,
      "exceptions",
      "A missing receipt is replaced by the order number.",
    );
    expect(needsConsistencyReview(changed.session)).toBe(true);
  });
});

describe("a failed review after the claims changed", () => {
  it("drops a finding that is still waiting, because it was written for claims that have since changed", () => {
    const { fullSession, context, record } = setup();
    const merged = mergeConsistencyAnalysis(fullSession(), OUTPUT_WITH_ONE_FINDING([]), context);
    if (!merged.ok) throw new Error(merged.reason);
    expect(nextConsistencyQuestion(merged.session)).not.toBeNull();

    const changed = record(
      merged.session,
      "exceptions",
      "A missing receipt is replaced by the order number.",
    );
    const kept = keepConsistencyReviewForCurrentClaims(changed.session, context);
    expect(kept.consistencyReview?.findings).toEqual([]);
    expect(nextConsistencyQuestion(kept)).toBeNull();
  });

  it("keeps a finding that was already put to the person, so a later review can carry it on", () => {
    const { fullSession, context } = setup();
    const merged = mergeConsistencyAnalysis(fullSession(), OUTPUT_WITH_ONE_FINDING([]), context);
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.consistencyReview?.findings[0]?.findingId ?? "";
    const offered = markConsistencyQuestionOffered(merged.session, findingId, context);
    const kept = keepConsistencyReviewForCurrentClaims(offered, context);
    expect(kept.consistencyReview?.findings.map((finding) => finding.findingId)).toEqual([
      findingId,
    ]);
  });

  it("drops an already-offered restatement_mismatch too, unlike every other category, so a claim correction it resolved is never shown as still pending", () => {
    const { fullSession, context, apply } = setup();
    const session = fullSession();
    const roles = session.claims.find((claim) => claim.field === "roles");
    const authorization = session.claims.find((claim) => claim.field === "authorization");
    if (roles === undefined || authorization === undefined) throw new Error("fixture missing");

    const merged = mergeConsistencyAnalysis(
      session,
      {
        findings: [
          {
            priorFindingId: null,
            category: "restatement_mismatch",
            targetField: "authorization",
            relatedClaimIds: [roles.claimId, authorization.claimId],
            question: "The roles and authorization fields disagree. Which is right?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.consistencyReview?.findings[0]?.findingId ?? "";
    const offered = markConsistencyQuestionOffered(merged.session, findingId, context);
    expect(pendingMismatchClaims(offered).length).toBeGreaterThan(0);

    // The person's answer resolves the disagreement: both claims are corrected to agree. A
    // re-review is now due (the claims changed), but suppose it fails or times out.
    const corrected = apply(
      apply(offered, {
        kind: "correct",
        createdByType: "agent",
        claimId: roles.claimId,
        statement: "The Finance Director approves refunds of $2,000 or more.",
        note: null,
        effectiveDate: null,
        sourceMessageId: session.messages[0]?.id ?? "",
      }).session,
      {
        kind: "correct",
        createdByType: "agent",
        claimId: authorization.claimId,
        statement: "Managers up to $2,000, and above that the Finance Director.",
        note: null,
        effectiveDate: null,
        sourceMessageId: session.messages[0]?.id ?? "",
      },
    ).session;
    expect(needsConsistencyReview(corrected)).toBe(true);

    const kept = keepConsistencyReviewForCurrentClaims(corrected, context);
    // The rebased review is now "current" again, so a stale carried finding would otherwise be
    // shown as pending with the corrected (already-agreeing) text, misleadingly implying it is
    // still unresolved.
    expect(currentConsistencyReview(kept)).not.toBeNull();
    expect(pendingMismatchClaims(kept)).toEqual([]);
    expect(sopSessionSchema.safeParse(kept).success).toBe(true);
  });
});
