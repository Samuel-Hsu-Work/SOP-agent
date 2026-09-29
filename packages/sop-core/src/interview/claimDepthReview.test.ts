import { describe, expect, it } from "vitest";
import { applyClaim, type ClaimWriteCommand } from "../claims/applyClaim.ts";
import { type SopSession, sopSessionSchema } from "../session.ts";
import {
  buildClaim,
  createDeterministicContext,
  createSessionWithUserMessage,
} from "../testing.ts";
import {
  claimDepthBasisOf,
  claimDepthCandidates,
  currentClaimDepthReview,
  keepClaimDepthReviewForCurrentClaims,
  markClaimDepthQuestionOffered,
  mergeClaimDepthAnalysis,
  needsClaimDepthReview,
  nextClaimDepthQuestion,
  pendingClaimDepthTarget,
} from "./claimDepthReview.ts";
import {
  type ClaimDepthAnalysisOutput,
  MAX_CLAIM_DEPTH_QUESTION_LENGTH,
  MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION,
} from "./claimDepthReviewSchema.ts";

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
  const recordStep = (current: SopSession, statement: string) =>
    apply(current, {
      kind: "record",
      createdByType: "agent",
      field: "procedure",
      status: "observed",
      statement,
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    }).session;
  return { context, empty, messageId, apply, recordStep };
}

function stepIdAt(session: SopSession, position: number): string {
  const claimId = session.procedureOrder[position - 1];
  if (claimId === undefined) throw new Error(`no step at position ${position}`);
  return claimId;
}

const OUTPUT_WITH_ONE_FINDING = (targetClaimId: string): ClaimDepthAnalysisOutput => ({
  findings: [
    {
      priorFindingId: null,
      targetClaimId,
      focus: "required_input",
      question: "What information must the request include?",
    },
  ],
  resolvedPriorFindingIds: [],
});

describe("claimDepthCandidates", () => {
  it("includes an observed procedure claim, in procedure order", () => {
    const { empty, recordStep } = setup();
    let session = recordStep(empty, "The operator submits a maintenance request.");
    session = recordStep(session, "The supervisor assigns a technician.");
    const candidates = claimDepthCandidates(session);
    expect(candidates.map((claim) => claim.value?.text)).toEqual([
      "The operator submits a maintenance request.",
      "The supervisor assigns a technician.",
    ]);
  });

  it("excludes proposed, extracted, unknown and conflict statuses", () => {
    const { empty, recordStep, apply, messageId } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const observedId = stepIdAt(session, 1);

    const proposed = apply(session, {
      kind: "record",
      createdByType: "agent",
      field: "procedure",
      status: "proposed",
      statement: "The system emails a confirmation.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    }).session;
    const unknown = apply(proposed, {
      kind: "markUnknown",
      createdByType: "agent",
      field: "procedure",
      claimId: null,
      note: "Not stated yet.",
      sourceMessageId: messageId,
    }).session;

    const candidates = claimDepthCandidates(unknown);
    expect(candidates.map((claim) => claim.claimId)).toEqual([observedId]);
  });

  it("excludes a non-procedure claim", () => {
    const { empty, apply, messageId } = setup();
    const session = apply(empty, {
      kind: "record",
      createdByType: "agent",
      field: "purpose",
      status: "observed",
      statement: "Keep refunds fair.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    }).session;
    expect(claimDepthCandidates(session)).toEqual([]);
  });

  it("excludes a claim already asked about, even after its wording changes again", () => {
    const { empty, recordStep, apply, messageId, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const merged = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const offered = markClaimDepthQuestionOffered(merged.session, findingId, context);
    expect(claimDepthCandidates(offered)).toEqual([]);

    const corrected = apply(offered, {
      kind: "correct",
      createdByType: "agent",
      claimId,
      statement: "The operator submits a request with the asset id and fault description.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
    }).session;
    expect(claimDepthCandidates(corrected)).toEqual([]);
  });
});

describe("claimDepthBasisOf", () => {
  it("changes when a non-candidate claim changes, so a stale review is not read as current", () => {
    const { empty, recordStep, apply, messageId } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const before = claimDepthBasisOf(session);
    // The review reads every other stated claim as read-only context (to avoid asking for a
    // detail already recorded elsewhere), so a change to that context — not to any candidate's own
    // wording — must also be able to invalidate a stored review.
    const withNewContext = apply(session, {
      kind: "record",
      createdByType: "agent",
      field: "roles",
      status: "observed",
      statement: "The maintenance supervisor assigns a technician.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    }).session;
    expect(claimDepthBasisOf(withNewContext)).not.toBe(before);
  });

  it("does not change when a claim is only marked asked, so offering one finding cannot hide another still waiting", () => {
    const { empty, recordStep, context } = setup();
    let session = recordStep(empty, "The operator submits a request.");
    session = recordStep(session, "The supervisor assigns a technician.");
    const [firstId, secondId] = session.procedureOrder;
    const merged = mergeClaimDepthAnalysis(
      session,
      {
        findings: [
          {
            priorFindingId: null,
            targetClaimId: firstId ?? "",
            focus: "required_input",
            question: "A?",
          },
          {
            priorFindingId: null,
            targetClaimId: secondId ?? "",
            focus: "destination_or_handoff",
            question: "B?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    const firstFindingId = merged.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const offered = markClaimDepthQuestionOffered(merged.session, firstFindingId, context);

    // Marking the first claim asked removed it from the candidate set, but the basis is unchanged,
    // so the review is still current and the second, still-waiting finding is not lost.
    expect(currentClaimDepthReview(offered)).not.toBeNull();
    expect(nextClaimDepthQuestion(offered)?.targetClaimId).toBe(secondId);
  });
});

describe("needsClaimDepthReview", () => {
  it("is false with no candidates", () => {
    const { empty } = setup();
    expect(needsClaimDepthReview(empty)).toBe(false);
  });

  it("is true once a procedure claim is stated", () => {
    const { empty, recordStep } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    expect(needsClaimDepthReview(session)).toBe(true);
  });

  it("is false once the review on file already saw the current candidates", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const merged = mergeClaimDepthAnalysis(
      session,
      { findings: [], resolvedPriorFindingIds: [] },
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    expect(needsClaimDepthReview(merged.session)).toBe(false);
  });

  it("is false on an approved session", () => {
    const { empty, recordStep } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    expect(
      needsClaimDepthReview({ ...session, status: "approved", approvedAt: session.updatedAt }),
    ).toBe(false);
  });

  it("is false while any claim is in conflict, even in a different field", () => {
    const { empty, recordStep } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    // Built directly: this test only needs a conflict claim to exist, not how it was detected.
    const conflicted: SopSession = {
      ...session,
      claims: [
        ...session.claims,
        buildClaim({
          claimId: "conflict-claim",
          field: "authorization",
          status: "conflict",
          conflictsWithClaimId: "conflict-partner",
        }),
      ],
    };
    expect(needsClaimDepthReview(conflicted)).toBe(false);
  });

  it("is false while the procedure field is in doNotAsk, even though it also holds a perfectly good candidate", () => {
    const { empty, recordStep } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    // A second procedure step the person said they do not know puts the whole field in doNotAsk
    // (not askable, per computeGaps), even though the first, observed step is still a fine
    // candidate on its own — asking about it anyway would contradict "never ask about doNotAsk".
    const withUnknownStep: SopSession = {
      ...session,
      claims: [
        ...session.claims,
        buildClaim({ claimId: "unknown-step", field: "procedure", status: "unknown" }),
      ],
    };
    expect(needsClaimDepthReview(withUnknownStep)).toBe(false);
  });

  it("is false when the person says they are out of time", () => {
    const { empty, recordStep, context } = setup();
    let session = recordStep(empty, "The operator submits a request.");
    session = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: context.newId(),
          role: "user",
          createdAt: context.now(),
          text: "No more questions please.",
        },
      ],
    };
    expect(needsClaimDepthReview(session)).toBe(false);
  });

  it("is false once the session budget is spent", () => {
    const { empty, recordStep } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const spent: SopSession = {
      ...session,
      claimDepthReview: {
        basis: "stale",
        checkedAt: session.updatedAt,
        findings: [],
        offeredTotal: MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION,
        askedClaimIds: [],
        lastOfferedClaimId: null,
        lastOfferedClaimTextHash: null,
      },
    };
    expect(needsClaimDepthReview(spent)).toBe(false);
  });
});

describe("mergeClaimDepthAnalysis", () => {
  it("accepts a finding targeting a real candidate, and writes no claim", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const merged = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!merged.ok) throw new Error(merged.reason);
    expect(merged.session.claimDepthReview?.findings[0]).toMatchObject({ targetClaimId: claimId });
    expect(sopSessionSchema.safeParse(merged.session).success).toBe(true);
    expect(merged.session.claims).toEqual(session.claims);
  });

  it("refuses a finding targeting a claim that is not a current candidate", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const merged = mergeClaimDepthAnalysis(
      session,
      OUTPUT_WITH_ONE_FINDING("nonexistent"),
      context,
    );
    expect(merged.ok).toBe(false);
  });

  it("refuses two findings targeting the same claim", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const output: ClaimDepthAnalysisOutput = {
      findings: [
        { priorFindingId: null, targetClaimId: claimId, focus: "required_input", question: "A?" },
        {
          priorFindingId: null,
          targetClaimId: claimId,
          focus: "observable_result",
          question: "B?",
        },
      ],
      resolvedPriorFindingIds: [],
    };
    expect(mergeClaimDepthAnalysis(session, output, context).ok).toBe(false);
  });

  it("refuses an over-length question", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const output: ClaimDepthAnalysisOutput = {
      findings: [
        {
          priorFindingId: null,
          targetClaimId: claimId,
          focus: "required_input",
          question: "Q".repeat(MAX_CLAIM_DEPTH_QUESTION_LENGTH + 1),
        },
      ],
      resolvedPriorFindingIds: [],
    };
    expect(mergeClaimDepthAnalysis(session, output, context).ok).toBe(false);
  });

  it("refuses when an earlier finding is left unaccounted for", () => {
    const { empty, recordStep, context } = setup();
    let session = recordStep(empty, "The operator submits a request.");
    session = recordStep(session, "The supervisor assigns a technician.");
    const [firstId, secondId] = session.procedureOrder;
    const firstMerge = mergeClaimDepthAnalysis(
      session,
      {
        findings: [
          {
            priorFindingId: null,
            targetClaimId: firstId ?? "",
            focus: "required_input",
            question: "A?",
          },
          {
            priorFindingId: null,
            targetClaimId: secondId ?? "",
            focus: "destination_or_handoff",
            question: "B?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    if (!firstMerge.ok) throw new Error(firstMerge.reason);
    // A later merge names only one of the two earlier findings.
    const firstFindingId = firstMerge.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const secondMerge = mergeClaimDepthAnalysis(
      firstMerge.session,
      {
        findings: [
          {
            priorFindingId: firstFindingId,
            targetClaimId: firstId ?? "",
            focus: "required_input",
            question: "A, reworded?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    expect(secondMerge.ok).toBe(false);
  });

  it("refuses when an earlier finding is named twice", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const firstMerge = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!firstMerge.ok) throw new Error(firstMerge.reason);
    const findingId = firstMerge.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const secondMerge = mergeClaimDepthAnalysis(
      firstMerge.session,
      {
        findings: [
          {
            priorFindingId: findingId,
            targetClaimId: claimId,
            focus: "required_input",
            question: "A?",
          },
        ],
        resolvedPriorFindingIds: [findingId],
      },
      context,
    );
    expect(secondMerge.ok).toBe(false);
  });

  it("carries an earlier finding forward under the same id when reworded", () => {
    const { empty, recordStep, context } = setup();
    let session = recordStep(empty, "The operator submits a request.");
    session = recordStep(session, "The supervisor assigns a technician.");
    const [firstId, secondId] = session.procedureOrder;
    const firstMerge = mergeClaimDepthAnalysis(
      session,
      {
        findings: [
          {
            priorFindingId: null,
            targetClaimId: firstId ?? "",
            focus: "required_input",
            question: "A?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    if (!firstMerge.ok) throw new Error(firstMerge.reason);
    const findingId = firstMerge.session.claimDepthReview?.findings[0]?.findingId ?? "";

    // A later claim change (a new step) forces a fresh review, which must account for the first
    // finding: carried forward here, reworded, plus a brand-new one for the new step.
    const secondMerge = mergeClaimDepthAnalysis(
      firstMerge.session,
      {
        findings: [
          {
            priorFindingId: findingId,
            targetClaimId: firstId ?? "",
            focus: "required_input",
            question: "A, reworded?",
          },
          {
            priorFindingId: null,
            targetClaimId: secondId ?? "",
            focus: "destination_or_handoff",
            question: "B?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    if (!secondMerge.ok) throw new Error(secondMerge.reason);
    expect(secondMerge.session.claimDepthReview?.findings).toEqual([
      { findingId, targetClaimId: firstId, focus: "required_input", question: "A, reworded?" },
      {
        findingId: expect.any(String),
        targetClaimId: secondId,
        focus: "destination_or_handoff",
        question: "B?",
      },
    ]);
  });

  it("drops an earlier finding once the model resolves it", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const firstMerge = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!firstMerge.ok) throw new Error(firstMerge.reason);
    const findingId = firstMerge.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const secondMerge = mergeClaimDepthAnalysis(
      firstMerge.session,
      { findings: [], resolvedPriorFindingIds: [findingId] },
      context,
    );
    if (!secondMerge.ok) throw new Error(secondMerge.reason);
    expect(secondMerge.session.claimDepthReview?.findings).toEqual([]);
  });

  it("refuses a carried finding that switches its target claim", () => {
    const { empty, recordStep, context } = setup();
    let session = recordStep(empty, "The operator submits a request.");
    session = recordStep(session, "The supervisor assigns a technician.");
    const [firstId, secondId] = session.procedureOrder;
    const firstMerge = mergeClaimDepthAnalysis(
      session,
      OUTPUT_WITH_ONE_FINDING(firstId ?? ""),
      context,
    );
    if (!firstMerge.ok) throw new Error(firstMerge.reason);
    const findingId = firstMerge.session.claimDepthReview?.findings[0]?.findingId ?? "";

    // Claims the same finding id is being "carried forward," but retargets it at a different claim
    // — this would silently drop the original target's finding without ever resolving it.
    const retargeted = mergeClaimDepthAnalysis(
      firstMerge.session,
      {
        findings: [
          {
            priorFindingId: findingId,
            targetClaimId: secondId ?? "",
            focus: "required_input",
            question: "A, but now about the other step?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    expect(retargeted.ok).toBe(false);
  });

  it("refuses a carried finding that switches its focus", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const firstMerge = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!firstMerge.ok) throw new Error(firstMerge.reason);
    const findingId = firstMerge.session.claimDepthReview?.findings[0]?.findingId ?? "";

    // Claims the same finding id is being carried forward, but changes what kind of concern it is
    // — this would overwrite the original concern without ever listing it as resolved.
    const reclassified = mergeClaimDepthAnalysis(
      firstMerge.session,
      {
        findings: [
          {
            priorFindingId: findingId,
            targetClaimId: claimId,
            focus: "destination_or_handoff",
            question: "Where does the request go, but now a different concern?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    expect(reclassified.ok).toBe(false);
  });
});

describe("nextClaimDepthQuestion, markClaimDepthQuestionOffered and pendingClaimDepthTarget", () => {
  it("returns the earliest-in-procedure waiting finding, regardless of output order", () => {
    const { empty, recordStep, context } = setup();
    let session = recordStep(empty, "The operator submits a request.");
    session = recordStep(session, "The supervisor assigns a technician.");
    const [firstId, secondId] = session.procedureOrder;
    const merged = mergeClaimDepthAnalysis(
      session,
      {
        findings: [
          // Listed out of procedure order on purpose.
          {
            priorFindingId: null,
            targetClaimId: secondId ?? "",
            focus: "destination_or_handoff",
            question: "B?",
          },
          {
            priorFindingId: null,
            targetClaimId: firstId ?? "",
            focus: "required_input",
            question: "A?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    const question = nextClaimDepthQuestion(merged.session);
    expect(question).toMatchObject({ targetClaimId: firstId, position: 1, question: "A?" });
  });

  it("returns null while a conflict is unresolved, on an approved session, and once the budget is spent", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const merged = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!merged.ok) throw new Error(merged.reason);

    expect(
      nextClaimDepthQuestion({
        ...merged.session,
        status: "approved",
        approvedAt: merged.session.updatedAt,
      }),
    ).toBeNull();

    const withConflict: SopSession = {
      ...merged.session,
      claims: merged.session.claims.map((claim) => ({
        ...claim,
        status: "conflict" as const,
        conflictsWithClaimId: "partner",
      })),
    };
    expect(nextClaimDepthQuestion(withConflict)).toBeNull();

    const spent: SopSession = {
      ...merged.session,
      claimDepthReview: {
        ...(merged.session.claimDepthReview ?? {
          basis: "",
          checkedAt: merged.session.updatedAt,
          askedClaimIds: [],
          lastOfferedClaimId: null,
          lastOfferedClaimTextHash: null,
        }),
        findings: merged.session.claimDepthReview?.findings ?? [],
        offeredTotal: MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION,
      },
    };
    expect(nextClaimDepthQuestion(spent)).toBeNull();
  });

  it("returns null while the procedure field is in doNotAsk, even with a waiting finding already on file", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const merged = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!merged.ok) throw new Error(merged.reason);
    expect(nextClaimDepthQuestion(merged.session)).not.toBeNull();

    // A second procedure step the person said they do not know puts the whole field in doNotAsk,
    // separately from any conflict — the waiting finding above must not be handed out regardless.
    const withUnknownStep: SopSession = {
      ...merged.session,
      claims: [
        ...merged.session.claims,
        buildClaim({ claimId: "unknown-step", field: "procedure", status: "unknown" }),
      ],
    };
    expect(nextClaimDepthQuestion(withUnknownStep)).toBeNull();
  });

  it("marks a finding offered: removes it from findings, adds its claim to askedClaimIds, and sets lastOfferedClaimId", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const merged = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.claimDepthReview?.findings[0]?.findingId ?? "";

    const offered = markClaimDepthQuestionOffered(merged.session, findingId, context);
    expect(offered.claimDepthReview?.findings).toEqual([]);
    expect(offered.claimDepthReview?.askedClaimIds).toEqual([claimId]);
    expect(offered.claimDepthReview?.lastOfferedClaimId).toBe(claimId);
    expect(offered.claimDepthReview?.offeredTotal).toBe(1);
    expect(nextClaimDepthQuestion(offered)).toBeNull();
    // Marking the same finding again changes nothing.
    expect(markClaimDepthQuestionOffered(offered, findingId, context)).toBe(offered);
    expect(sopSessionSchema.safeParse(offered).success).toBe(true);
  });

  it("pendingClaimDepthTarget resolves the offered claim's live position, and is null once it is withdrawn", () => {
    const { empty, recordStep, apply, messageId, context } = setup();
    let session = recordStep(empty, "The operator submits a request.");
    session = recordStep(session, "The supervisor assigns a technician.");
    const [firstId, secondId] = session.procedureOrder;
    const merged = mergeClaimDepthAnalysis(
      session,
      OUTPUT_WITH_ONE_FINDING(secondId ?? ""),
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const offered = markClaimDepthQuestionOffered(merged.session, findingId, context);

    expect(pendingClaimDepthTarget(offered)).toEqual({
      targetClaimId: secondId,
      targetField: "procedure",
      position: 2,
    });

    const withdrawn = apply(offered, {
      kind: "withdraw",
      createdByType: "agent",
      claimId: secondId ?? "",
      note: "The user removed this step.",
      sourceMessageId: messageId,
    }).session;
    expect(pendingClaimDepthTarget(withdrawn)).toBeNull();
    // Withdrawing the offered step does not resurrect the earlier, unrelated candidate.
    expect(claimDepthCandidatesUnaffected(withdrawn, firstId)).toBe(true);
  });

  it("pendingClaimDepthTarget goes null once the person's answer corrects the offered step, even though it is still active", () => {
    const { empty, recordStep, apply, messageId, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const merged = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const offered = markClaimDepthQuestionOffered(merged.session, findingId, context);
    expect(pendingClaimDepthTarget(offered)).not.toBeNull();

    // The agent applies the person's answer through the ordinary correct_claim path, which knows
    // nothing about this bookkeeping — pendingClaimDepthTarget has to notice the text moved on by
    // itself, or it would keep pointing at this now-answered step forever (nothing else clears it,
    // since a claim already in askedClaimIds can never become a fresh finding again).
    const corrected = apply(offered, {
      kind: "correct",
      createdByType: "agent",
      claimId,
      statement: "The operator submits a request with the asset id and fault description.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
    }).session;
    expect(pendingClaimDepthTarget(corrected)).toBeNull();
  });

  it("pendingClaimDepthTarget goes null once the offered step becomes half of a conflict, even though its text is unchanged", () => {
    const { empty, recordStep, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const merged = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const offered = markClaimDepthQuestionOffered(merged.session, findingId, context);
    expect(pendingClaimDepthTarget(offered)).not.toBeNull();

    // An uploaded document can disagree with an already-offered step, built directly here since
    // this test only needs the conflict status to exist, not how it was detected. The prompt tells
    // the agent never to correct_claim a conflicted claim, so this must stop being exposed as
    // something to correct_claim, even though its own wording never changed.
    const conflicted: SopSession = {
      ...offered,
      claims: offered.claims.map((claim) =>
        claim.claimId === claimId
          ? { ...claim, status: "conflict" as const, conflictsWithClaimId: "conflict-partner" }
          : claim,
      ),
    };
    expect(pendingClaimDepthTarget(conflicted)).toBeNull();
  });

  it("pendingClaimDepthTarget goes null once the person's answer lands only in the step's note, not its statement", () => {
    const { empty, recordStep, apply, messageId, context } = setup();
    const session = recordStep(empty, "The operator submits a request.");
    const claimId = stepIdAt(session, 1);
    const merged = mergeClaimDepthAnalysis(session, OUTPUT_WITH_ONE_FINDING(claimId), context);
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const offered = markClaimDepthQuestionOffered(merged.session, findingId, context);
    expect(pendingClaimDepthTarget(offered)).not.toBeNull();

    // The review is told a note can already cover the missing detail, so the agent may plausibly
    // record the answer there instead of in the statement — that must count as answered too.
    const correctedViaNote = apply(offered, {
      kind: "correct",
      createdByType: "agent",
      claimId,
      statement: "The operator submits a request.",
      note: "Includes the asset id and fault description.",
      effectiveDate: null,
      sourceMessageId: messageId,
    }).session;
    expect(pendingClaimDepthTarget(correctedViaNote)).toBeNull();
  });
});

function claimDepthCandidatesUnaffected(session: SopSession, claimId: string | undefined): boolean {
  return claimDepthCandidates(session).some((claim) => claim.claimId === claimId);
}

describe("keepClaimDepthReviewForCurrentClaims", () => {
  it("drops waiting findings but keeps askedClaimIds, offeredTotal and lastOfferedClaimId", () => {
    const { empty, recordStep, context } = setup();
    let session = recordStep(empty, "The operator submits a request.");
    session = recordStep(session, "The supervisor assigns a technician.");
    const [firstId, secondId] = session.procedureOrder;
    const merged = mergeClaimDepthAnalysis(
      session,
      OUTPUT_WITH_ONE_FINDING(firstId ?? ""),
      context,
    );
    if (!merged.ok) throw new Error(merged.reason);
    const findingId = merged.session.claimDepthReview?.findings[0]?.findingId ?? "";
    const offered = markClaimDepthQuestionOffered(merged.session, findingId, context);

    // A second candidate now appears (the fresh step above), forcing a review that then fails.
    const secondMerge = mergeClaimDepthAnalysis(
      offered,
      {
        findings: [
          {
            priorFindingId: null,
            targetClaimId: secondId ?? "",
            focus: "required_input",
            question: "B?",
          },
        ],
        resolvedPriorFindingIds: [],
      },
      context,
    );
    if (!secondMerge.ok) throw new Error(secondMerge.reason);

    const kept = keepClaimDepthReviewForCurrentClaims(secondMerge.session, context);
    expect(kept.claimDepthReview?.findings).toEqual([]);
    expect(kept.claimDepthReview?.askedClaimIds).toEqual([firstId]);
    expect(kept.claimDepthReview?.offeredTotal).toBe(1);
    expect(kept.claimDepthReview?.lastOfferedClaimId).toBe(firstId);
    expect(currentClaimDepthReview(kept)).not.toBeNull();
    expect(nextClaimDepthQuestion(kept)).toBeNull();
    expect(sopSessionSchema.safeParse(kept).success).toBe(true);
  });
});

describe("schema", () => {
  it("a session written before claimDepthReview existed parses with it defaulted to null", () => {
    const { empty } = setup();
    const { claimDepthReview, ...withoutField } = empty;
    const parsed = sopSessionSchema.safeParse(withoutField);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.claimDepthReview).toBeNull();
  });
});
