import { describe, expect, it } from "vitest";
import {
  applyClaim,
  type ClaimWriteCommand,
  type CorrectClaimCommand,
  type RecordClaimCommand,
} from "./applyClaim.ts";
import { totalClaimTextLength } from "./claim.ts";
import { statesCalendarDate } from "./claimWriteSupport.ts";
import { computeGaps } from "./computeGaps.ts";
import {
  buildInterviewAgenda,
  pendingDocumentPassages,
  selectDocumentPassages,
} from "./interviewAgenda.ts";
import {
  MAX_PASSAGES_PER_UPLOAD,
  MAX_REFERENCE_DOCUMENTS,
  MAX_REFERENCE_PASSAGES,
  MAX_TOTAL_CLAIM_TEXT,
} from "./limits.ts";
import { findPassage } from "./referenceQueries.ts";
import { MAX_TIMES_NOT_ASKED } from "./referenceSchema.ts";
import {
  addReferenceDocument,
  declineDocumentPassage,
  markDocumentPassagesOffered,
  settleShownDocumentPassages,
  sopTargetOf,
} from "./references.ts";
import { type SopSession, sopSessionSchema } from "./session.ts";
import { buildSopDocument } from "./sopDocument.ts";
import type { SopFieldName } from "./sopFields.ts";
import { keepsPassageMeaning, usesPassageWording } from "./statementComparison.ts";
import {
  buildReferenceUpload,
  createDeterministicContext,
  createSessionWithUserMessage,
} from "./testing.ts";

const PURPOSE = "Describe how a front-end cashier closes out at the end of the night.";
const CLOCK_OUT = "Cashiers clock out by 11:30 PM.";

function setup(userText = "We close the registers at 11 and I think we leave by 11:30.") {
  const context = createDeterministicContext();
  const { session: empty, messageId } = createSessionWithUserMessage(context, userText);
  const apply = (current: SopSession, command: ClaimWriteCommand) =>
    applyClaim(current, command, context);
  const applyOk = (current: SopSession, command: ClaimWriteCommand) => {
    const result = apply(current, command);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result;
  };
  const recordCommand = (
    field: SopFieldName,
    statement: string,
    overrides: Partial<RecordClaimCommand> = {},
  ): RecordClaimCommand => ({
    kind: "record",
    createdByType: "agent",
    field,
    status: "observed",
    statement,
    note: null,
    effectiveDate: null,
    sourceMessageId: messageId,
    insertBeforeClaimId: null,
    ...overrides,
  });
  const record = (current: SopSession, field: SopFieldName, statement: string) =>
    applyOk(current, recordCommand(field, statement));
  const targeted = record(empty, "purpose", PURPOSE).session;
  const upload = (
    current: SopSession,
    fileName: string,
    passages: Parameters<typeof buildReferenceUpload>[1],
  ) => {
    const result = addReferenceDocument(current, buildReferenceUpload(fileName, passages), context);
    if (!result.ok) throw new Error(`upload failed: ${result.error.code}`);
    return result;
  };
  /** Hands the agent this turn's passages, as a committed turn would. */
  const offer = (current: SopSession) =>
    markDocumentPassagesOffered(
      current,
      selectDocumentPassages(current).map((passage) => passage.passageId),
    );
  const onlyPassage = (current: SopSession) => {
    const passage = current.references.passages[0];
    if (passage === undefined) throw new Error("no passage");
    return passage;
  };
  return {
    context,
    empty,
    messageId,
    targeted,
    apply,
    applyOk,
    record,
    recordCommand,
    upload,
    offer,
    onlyPassage,
  };
}

describe("adding a document's passages", () => {
  it("is refused until the person has said what the SOP covers", () => {
    const { context, empty, targeted } = setup();
    const input = buildReferenceUpload("policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]);
    const refused = addReferenceDocument(empty, input, context);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("no_target");
    expect(addReferenceDocument(targeted, input, context).ok).toBe(true);
  });

  it("keeps the passages outside the SOP: no claim, no gap filled, judged against the purpose", () => {
    const { targeted, upload } = setup();
    const result = upload(targeted, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
      { field: "roles", statement: "The Team Lead may defer non-urgent tasks." },
    ]);

    expect(result.added).toBe(2);
    expect(result.session.claims).toEqual(targeted.claims);
    expect(computeGaps(result.session)).toEqual(computeGaps(targeted));
    expect(result.session.references.documents).toMatchObject([{ documentName: "policy.md" }]);
    expect(result.session.references.passages.map((passage) => passage.state)).toEqual([
      "open",
      "open",
    ]);
    expect(result.session.references.passages[0]?.targetClaimIds).toEqual(
      sopTargetOf(targeted).claimIds,
    );
    expect(buildSopDocument(result.session)).toEqual(buildSopDocument(targeted));
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("adds nothing for a second upload of the same file", () => {
    const { targeted, upload } = setup();
    const passages = [{ field: "completionCriteria" as const, statement: CLOCK_OUT }];
    const first = upload(targeted, "policy.md", passages);
    const second = upload(first.session, "policy.md", passages);
    expect(second).toMatchObject({ added: 0, alreadyThere: 1 });
    expect(second.session).toBe(first.session);
  });

  it("refuses an approved session, a passage citing another file, and more than the session holds", () => {
    const { context, targeted, upload } = setup();
    const refusal = (session: SopSession, input: ReturnType<typeof buildReferenceUpload>) => {
      const result = addReferenceDocument(session, input, context);
      return result.ok ? null : result.error.code;
    };
    const approved: SopSession = {
      ...targeted,
      status: "approved",
      approvedAt: "2026-01-01T00:00:00.000Z",
    };
    const one = buildReferenceUpload("policy.md", [
      { field: "roles", statement: "The Team Lead approves each refund." },
    ]);
    expect(refusal(approved, one)).toBe("session_approved");

    const mislabelled = buildReferenceUpload("policy.md", [
      { field: "roles", statement: "The Team Lead approves each refund." },
    ]);
    const [passage] = mislabelled.passages;
    if (passage === undefined) throw new Error("no passage");
    expect(
      refusal(targeted, {
        ...mislabelled,
        passages: [{ ...passage, citation: { ...passage.citation, documentName: "other.md" } }],
      }),
    ).toBe("invalid_passage");

    let full = targeted;
    for (let index = 0; index < MAX_REFERENCE_PASSAGES / MAX_PASSAGES_PER_UPLOAD; index += 1) {
      full = upload(
        full,
        `policy-${index}.md`,
        Array.from({ length: MAX_PASSAGES_PER_UPLOAD }, (_, step) => ({
          field: "prerequisites" as const,
          statement: `Prerequisite ${index}-${step} is in place.`,
          location: `§ ${step}`,
        })),
      ).session;
    }
    expect(refusal(full, one)).toBe("reference_limit_reached");

    let manyDocuments = targeted;
    for (let index = 0; index < MAX_REFERENCE_DOCUMENTS; index += 1) {
      manyDocuments = upload(manyDocuments, `doc-${index}.md`, [
        { field: "controls", statement: `Control ${index} runs weekly.` },
      ]).session;
    }
    expect(refusal(manyDocuments, one)).toBe("reference_limit_reached");
  });

  it("raises a conflict when a passage disagrees with what the person said, keeping the document side apart", () => {
    const { targeted, record, upload } = setup();
    const stated = record(targeted, "completionCriteria", "Cashiers clock out by 11:45 PM.");
    const result = upload(stated.session, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT, location: "p.2" },
    ]);

    expect(result.conflictsRaised).toBe(1);
    const mine = result.session.claims.find((claim) => claim.claimId === stated.claim.claimId);
    const documentSide = result.session.claims.find(
      (claim) => claim.claimId === mine?.conflictsWithClaimId,
    );
    expect(mine).toMatchObject({ status: "conflict", source: { type: "employee_statement" } });
    expect(documentSide).toMatchObject({
      status: "conflict",
      value: { text: CLOCK_OUT },
      source: {
        type: "policy_document",
        reference: { kind: "document", citation: { documentName: "policy.md", location: "p.2" } },
      },
      authority: "official_policy",
      createdByType: "extraction",
      conflictsWithClaimId: mine?.claimId,
    });
    expect(onlyState(result.session)).toEqual(["in_conflict"]);
    expect(result.session.claimHistory).toMatchObject([
      { claimId: mine?.claimId, reason: "conflict_detected", changedBy: "system" },
    ]);
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);

    const agenda = buildInterviewAgenda(result.session);
    expect(agenda.askNext[0]).toMatchObject({ field: "completionCriteria", reason: "conflict" });
    expect(agenda.askNext[0]?.conflict?.sides.map((side) => side.sourceLabel).sort()).toEqual([
      "an uploaded document",
      "what the user said",
    ]);
    expect(JSON.stringify(agenda)).not.toContain("policy.md");
    expect(agenda.documentPassages).toEqual([]);
  });

  it("raises a conflict between two documents, but never within one", () => {
    const { targeted, upload } = setup();
    const policy = upload(targeted, "policy.md", [
      {
        field: "authorization",
        statement: "Refunds above $200 need the Team Lead.",
        location: "§ 1",
      },
      {
        field: "authorization",
        statement: "Refunds above $500 need the Store Manager.",
        location: "§ 2",
      },
    ]);
    expect(policy.conflictsRaised).toBe(0);

    const memo = upload(policy.session, "memo.md", [
      { field: "authorization", statement: "Refunds above $300 need the Team Lead." },
    ]);
    expect(memo.conflictsRaised).toBe(1);
    const sides = memo.session.claims.filter((claim) => claim.status === "conflict");
    expect(
      sides.map((claim) =>
        claim.source.reference.kind === "document"
          ? claim.source.reference.citation.documentName
          : "",
      ),
    ).toEqual(["policy.md", "memo.md"]);
    expect(sopSessionSchema.safeParse(memo.session).success).toBe(true);
  });

  it("treats a passage that only adds a figure as detail to offer, not a conflict", () => {
    const { targeted, record, upload } = setup();
    const stated = record(
      targeted,
      "completionCriteria",
      "Cashiers clock out after closing duties.",
    );
    const result = upload(stated.session, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]);
    expect(result.conflictsRaised).toBe(0);
    expect(selectDocumentPassages(result.session)).toMatchObject([
      { statement: CLOCK_OUT, relationship: "adds_detail" },
    ]);
  });

  it("raises a conflict for the other side of the same boundary, which is not the same statement", () => {
    const { targeted, record, upload } = setup();
    const stated = record(targeted, "authorization", "Refunds over $100 need approval.");
    const result = upload(stated.session, "policy.md", [
      { field: "authorization", statement: "Refunds under $100 need approval." },
    ]);
    expect(result.conflictsRaised).toBe(1);
  });

  it("still raises a conflict when the passage and the claim differ by a negation", () => {
    const { targeted, record, upload } = setup();
    const stated = record(targeted, "authorization", "Refunds do not need approval.");
    const result = upload(stated.session, "policy.md", [
      { field: "authorization", statement: "Refunds need approval." },
    ]);
    expect(result.conflictsRaised).toBe(1);
  });

  it("refuses passages that would put the session over its text cap, even with no conflict", () => {
    const { context, targeted, applyOk, recordCommand } = setup();
    // Fill the claims to just under the cap, so the passage alone tips it over.
    let bulky = targeted;
    for (let index = 0; ; index += 1) {
      const room = MAX_TOTAL_CLAIM_TEXT - 200 - totalClaimTextLength(bulky.claims);
      if (room < 20) break;
      bulky = applyOk(
        bulky,
        recordCommand("controls", `C${index} ${"x".repeat(Math.min(1_990, room - 10))}`),
      ).session;
    }
    const result = addReferenceDocument(
      bulky,
      buildReferenceUpload("policy.md", [
        {
          field: "evidence",
          statement: "Receipts are kept for seven years in the finance archive.",
          quote: `Receipts are kept for seven years in the finance archive. ${"y".repeat(200)}`,
        },
      ]),
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("session_limit_reached");
  });

  it("records at most twenty target claims on a passage, so the session stays valid", () => {
    const { targeted, applyOk, recordCommand, upload } = setup();
    let wide = targeted;
    for (let index = 0; index < 24; index += 1) {
      wide = applyOk(wide, recordCommand("scope", `Covers store number ${index}.`)).session;
    }
    const result = upload(wide, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]);
    expect(result.session.references.passages[0]?.targetClaimIds).toHaveLength(20);
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("neither raises nor offers a passage the SOP already states", () => {
    const { targeted, record, upload } = setup();
    const stated = record(targeted, "completionCriteria", `${CLOCK_OUT} after closing duties`);
    const result = upload(stated.session, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]);
    expect(result.conflictsRaised).toBe(0);
    expect(selectDocumentPassages(result.session)).toEqual([]);
  });
});

function onlyState(session: SopSession) {
  return session.references.passages.map((passage) => passage.state);
}

describe("uploading a document again after the target changed", () => {
  it("opens a stale passage nobody answered again, read for the current target", () => {
    const { targeted, upload, applyOk, record, messageId } = setup();
    const passages = [{ field: "completionCriteria" as const, statement: CLOCK_OUT }];
    const first = upload(targeted, "policy.md", passages).session;
    const oldTarget = sopTargetOf(first).claimIds[0] ?? "";
    const retargeted = applyOk(
      record(first, "scope", "Applies to cashiers on the closing shift.").session,
      {
        kind: "withdraw",
        createdByType: "agent",
        claimId: oldTarget,
        note: "Wrong purpose.",
        sourceMessageId: messageId,
      },
    ).session;
    expect(selectDocumentPassages(retargeted)).toEqual([]);

    const again = upload(retargeted, "policy.md", passages);
    expect(again).toMatchObject({ added: 1, alreadyThere: 0 });
    expect(again.session.references.passages).toHaveLength(1);
    expect(again.session.references.passages[0]).toMatchObject({
      state: "open",
      offeredSequence: null,
      targetClaimIds: sopTargetOf(retargeted).claimIds,
    });
    expect(selectDocumentPassages(again.session).map((passage) => passage.statement)).toEqual([
      CLOCK_OUT,
    ]);
    expect(sopSessionSchema.safeParse(again.session).success).toBe(true);
  });

  it("leaves a passage the person already answered as it is", () => {
    const { targeted, upload, offer, context } = setup();
    const passages = [{ field: "completionCriteria" as const, statement: CLOCK_OUT }];
    const offered = offer(upload(targeted, "policy.md", passages).session);
    const passageId = offered.references.passages[0]?.passageId ?? "";
    const declined = declineDocumentPassage(
      offered,
      { kind: "declineDocumentPassage", createdByType: "agent", passageId },
      context,
    );
    if (!declined.ok) throw new Error("setup failed");
    const again = upload(declined.session, "policy.md", passages);
    expect(again).toMatchObject({ added: 0, alreadyThere: 1 });
    expect(findPassage(again.session, passageId)?.state).toBe("declined");
  });
});

describe("putting passages to the person", () => {
  it("offers the passages for a blocking gap first, at most two, both about one field", () => {
    const { targeted, upload } = setup();
    const result = upload(targeted, "policy.md", [
      { field: "controls", statement: "The Team Lead checks each drawer count.", location: "§ 1" },
      { field: "completionCriteria", statement: CLOCK_OUT, location: "§ 2" },
      {
        field: "completionCriteria",
        statement: "The shift log is signed before leaving.",
        location: "§ 3",
      },
      {
        field: "completionCriteria",
        statement: "Registers are powered down.",
        location: "§ 4",
      },
    ]);
    const shown = selectDocumentPassages(result.session);
    expect(shown.map((passage) => passage.field)).toEqual([
      "completionCriteria",
      "completionCriteria",
    ]);
    expect(shown[0]).toMatchObject({ statement: CLOCK_OUT, relationship: "fills_gap" });
    expect(Object.keys(shown[0] ?? {}).sort()).toEqual([
      "effectiveDate",
      "field",
      "passageId",
      "relationship",
      "statement",
    ]);
    expect(buildInterviewAgenda(result.session).documentPassages).toEqual(shown);
  });

  it("marks what was offered, lists it as pending, and does not offer it twice", () => {
    const { targeted, upload, offer } = setup();
    const uploaded = upload(targeted, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]).session;
    const offered = offer(uploaded);
    expect(offered.references.passages[0]).toMatchObject({
      state: "offered",
      offeredSequence: 1,
    });
    expect(offered.references.offeredTotal).toBe(1);
    expect(selectDocumentPassages(offered)).toEqual([]);
    expect(pendingDocumentPassages(offered).map((passage) => passage.statement)).toEqual([
      CLOCK_OUT,
    ]);
    expect(sopSessionSchema.safeParse(offered).success).toBe(true);
  });

  it("offers nothing while a conflict waits, and nothing once the target it was read for is gone", () => {
    const { targeted, record, upload, applyOk, messageId } = setup();
    const withPassage = upload(targeted, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
      { field: "roles", statement: "The Team Lead may defer non-urgent tasks." },
    ]).session;
    const withConflict = record(
      withPassage,
      "completionCriteria",
      "Cashiers clock out by 11:45 PM.",
    ).session;
    expect(selectDocumentPassages(withConflict)).toEqual([]);

    const purposeId = sopTargetOf(withPassage).claimIds[0] ?? "";
    const retargeted = applyOk(withPassage, {
      kind: "withdraw",
      createdByType: "agent",
      claimId: purposeId,
      note: "Wrong process.",
      sourceMessageId: messageId,
    }).session;
    expect(selectDocumentPassages(retargeted)).toEqual([]);
    expect(buildInterviewAgenda(retargeted).documents.passagesNotYetUsed).toBe(0);
  });
});

describe("answering a passage", () => {
  const answered = () => {
    const helpers = setup();
    const offered = helpers.offer(
      helpers.upload(helpers.targeted, "policy.md", [
        {
          field: "completionCriteria",
          statement: CLOCK_OUT,
          quote: "Cashiers clock out by 11:30 PM.",
        },
      ]).session,
    );
    return { ...helpers, offered, passageId: helpers.onlyPassage(offered).passageId };
  };

  it("records the user's agreement as their own statement, resting on the passage", () => {
    const { offered, passageId, applyOk, recordCommand } = answered();
    const result = applyOk(
      offered,
      recordCommand("completionCriteria", "The cashier clocks out by 11:30 PM.", {
        documentPassage: { passageId, userAgrees: true },
      }),
    );
    expect(result.claim).toMatchObject({
      status: "observed",
      source: { type: "employee_statement", reference: { kind: "message" } },
      authority: "observed_practice",
      basedOnPassageId: passageId,
    });
    expect(findPassage(result.session, passageId)).toMatchObject({
      state: "used",
      claimIds: [result.claim.claimId],
    });
    expect(result.session.claims.some((claim) => claim.status === "conflict")).toBe(false);
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);

    const item = buildSopDocument(result.session).sections.find(
      (section) => section.field === "completionCriteria",
    )?.items[0];
    expect(item).toMatchObject({
      status: "observed",
      sourceLine: "from the interview, based on policy.md, § Rules",
      citation: { documentName: "policy.md", quote: "Cashiers clock out by 11:30 PM." },
    });
  });

  it("refuses a different answer to a passage never put to the user, or an answer as a suggestion", () => {
    const { targeted, upload, apply, recordCommand, onlyPassage, offered, passageId } = answered();
    const notOffered = upload(targeted, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]).session;
    const codeOf = (session: SopSession, command: RecordClaimCommand) => {
      const result = apply(session, command);
      return result.ok ? null : result.error.code;
    };
    const agreeing = (id: string) =>
      recordCommand("completionCriteria", CLOCK_OUT, {
        documentPassage: { passageId: id, userAgrees: true },
      });
    expect(
      codeOf(
        notOffered,
        recordCommand("completionCriteria", "Cashiers leave when the Team Lead says so.", {
          documentPassage: { passageId: onlyPassage(notOffered).passageId, userAgrees: false },
        }),
      ),
    ).toBe("passage_not_offered");
    expect(codeOf(offered, agreeing("missing"))).toBe("passage_not_found");
    expect(codeOf(offered, { ...agreeing(passageId), status: "proposed" })).toBe(
      "wrong_command_for_status",
    );
  });

  it("rests the user's own words on a passage they stated before being asked, instead of raising a conflict", () => {
    const { targeted, upload, applyOk, recordCommand, onlyPassage } = setup(
      "Cashiers clock out by 11:30.",
    );
    const notOffered = upload(targeted, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT, effectiveDate: "2026-09-01" },
    ]).session;
    const passageId = onlyPassage(notOffered).passageId;
    const result = applyOk(
      notOffered,
      recordCommand("completionCriteria", "Cashiers clock out by 11:30 PM.", {
        documentPassage: { passageId, userAgrees: true },
      }),
    );
    // The user never saw the passage, so its date is not theirs either.
    expect(result.claim).toMatchObject({
      status: "observed",
      basedOnPassageId: passageId,
      effectiveDate: null,
    });
    expect(findPassage(result.session, passageId)?.state).toBe("used");
    expect(result.session.claims.some((claim) => claim.status === "conflict")).toBe(false);
  });

  it("refuses to rest the user's words on a passage they share a topic with but not a meaning", () => {
    const cases = [
      {
        userText: "Cashiers may clock out before 11:30 if the Team Lead agrees.",
        passage: "Cashiers may not clock out before 11:30.",
        statement: "Cashiers may clock out before 11:30 if the Team Lead agrees.",
      },
      {
        userText: "The Team Lead reconciles the cash drawers weekly.",
        passage: "The Team Lead reconciles the cash drawers daily.",
        statement: "The Team Lead reconciles the cash drawers weekly.",
      },
      {
        userText: "Payments over $10,000 need the CFO.",
        passage: "Payments over $25,000 need the CFO.",
        statement: "Payments over $10,000 need the CFO.",
      },
    ];
    // The agent's statement copies the passage, but the user's own message flips its negation.
    cases.push({
      userText: "Cashiers may clock out before 11:30 if the Team Lead agrees.",
      passage: "Cashiers may not clock out before 11:30.",
      statement: "Cashiers may not clock out before 11:30.",
    });
    for (const { userText, passage, statement } of cases) {
      const { targeted, upload, apply, recordCommand, onlyPassage } = setup(userText);
      const uploaded = upload(targeted, "policy.md", [
        { field: "completionCriteria", statement: passage },
      ]).session;
      const result = apply(
        uploaded,
        recordCommand("completionCriteria", statement, {
          documentPassage: { passageId: onlyPassage(uploaded).passageId, userAgrees: true },
        }),
      );
      expect(result.ok ? null : result.error.code, passage).toBe("statement_not_supported");
    }
  });

  it("takes a figure only from the user's words when they were never shown the passage", () => {
    const { targeted, upload, apply, recordCommand, onlyPassage } = setup(
      "Cashiers clock out when the Team Lead releases them.",
    );
    const notOffered = upload(targeted, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]).session;
    const result = apply(
      notOffered,
      recordCommand("completionCriteria", CLOCK_OUT, {
        documentPassage: { passageId: onlyPassage(notOffered).passageId, userAgrees: true },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("statement_not_supported");
  });

  it("never gives the user's own different answer the document's effective date", () => {
    const { targeted, upload, offer, applyOk, recordCommand, onlyPassage } = setup();
    const offered = offer(
      upload(targeted, "policy.md", [
        { field: "completionCriteria", statement: CLOCK_OUT, effectiveDate: "2026-09-01" },
      ]).session,
    );
    const result = applyOk(
      offered,
      recordCommand("completionCriteria", "Cashiers clock out when the Team Lead releases them.", {
        effectiveDate: "2026-09-01",
        documentPassage: { passageId: onlyPassage(offered).passageId, userAgrees: false },
      }),
    );
    expect(result.claim.effectiveDate).toBeNull();
  });

  it("drops a document's date when the user's message names only its year", () => {
    const { targeted, upload, offer, applyOk, recordCommand, onlyPassage } = setup(
      "Ours changed in 2026: the Team Lead releases cashiers.",
    );
    const offered = offer(
      upload(targeted, "policy.md", [
        { field: "completionCriteria", statement: CLOCK_OUT, effectiveDate: "2026-09-01" },
      ]).session,
    );
    const result = applyOk(
      offered,
      recordCommand("completionCriteria", "The Team Lead releases the cashiers.", {
        effectiveDate: "2026-09-01",
        documentPassage: { passageId: onlyPassage(offered).passageId, userAgrees: false },
      }),
    );
    expect(result.claim.effectiveDate).toBeNull();
  });

  it("keeps a date the user states themselves, even when the document gives the same one", () => {
    const { targeted, upload, offer, applyOk, recordCommand, onlyPassage } = setup(
      "Ours is different: the Team Lead releases cashiers, starting September 1, 2026.",
    );
    const offered = offer(
      upload(targeted, "policy.md", [
        { field: "completionCriteria", statement: CLOCK_OUT, effectiveDate: "2026-09-01" },
      ]).session,
    );
    const result = applyOk(
      offered,
      recordCommand("completionCriteria", "The Team Lead releases the cashiers.", {
        effectiveDate: "2026-09-01",
        documentPassage: { passageId: onlyPassage(offered).passageId, userAgrees: false },
      }),
    );
    expect(result.claim.effectiveDate).toBe("2026-09-01");
  });

  it("refuses a spelled-out figure the passage never gave, such as one approver or fourteen days", () => {
    const { offered, passageId, apply, recordCommand } = answered();
    for (const statement of [
      "One Team Lead checks that cashiers clock out by 11:30 PM.",
      "Cashiers clock out by 11:30 PM, fourteen days a fortnight.",
    ]) {
      const result = apply(
        offered,
        recordCommand("completionCriteria", statement, {
          documentPassage: { passageId, userAgrees: true },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("statement_not_supported");
    }
  });

  it("refuses an answer that files the passage under another field", () => {
    const { offered, passageId, apply, recordCommand } = answered();
    const result = apply(
      offered,
      recordCommand("roles", "Cashiers clock out by 11:30 PM.", {
        documentPassage: { passageId, userAgrees: true },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("passage_field_mismatch");
  });

  it("refuses a figure that neither the passage nor the user gave", () => {
    const { offered, passageId, apply, recordCommand } = answered();
    const withFigure = (statement: string) =>
      apply(
        offered,
        recordCommand("completionCriteria", statement, {
          documentPassage: { passageId, userAgrees: true },
        }),
      );
    const invented = withFigure("Cashiers clock out by 11:30 PM, within 20 minutes of closing.");
    expect(invented.ok).toBe(false);
    if (!invented.ok) expect(invented.error.code).toBe("statement_not_supported");
    // "11" is in what the user said, so it is theirs to state.
    expect(withFigure("Registers close at 11 and cashiers clock out by 11:30 PM.").ok).toBe(true);
  });

  it("records a different answer as the user's alone, declines the passage, and raises no conflict", () => {
    const { offered, passageId, applyOk, recordCommand } = answered();
    const result = applyOk(
      offered,
      recordCommand("completionCriteria", "Cashiers clock out by 11:45 PM.", {
        documentPassage: { passageId, userAgrees: false },
      }),
    );
    expect(result.claim).toMatchObject({ status: "observed", basedOnPassageId: null });
    expect(findPassage(result.session, passageId)?.state).toBe("declined");
    expect(result.session.claims.some((claim) => claim.status === "conflict")).toBe(false);
  });

  it("declines a passage that does not apply, whether already asked about or only just shown", () => {
    const { offered, passageId, context, targeted, upload, onlyPassage, applyOk, recordCommand } =
      answered();
    const decline = (session: SopSession, id: string) =>
      declineDocumentPassage(
        session,
        { kind: "declineDocumentPassage", createdByType: "agent", passageId: id },
        context,
      );
    const declined = decline(offered, passageId);
    expect(declined.ok && findPassage(declined.session, passageId)?.state).toBe("declined");
    expect(declined.ok && declined.session.claims).toEqual(offered.claims);

    const justShown = upload(targeted, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]).session;
    const shownId = onlyPassage(justShown).passageId;
    const early = decline(justShown, shownId);
    expect(early.ok && findPassage(early.session, shownId)?.state).toBe("declined");

    // A passage the user already agreed with is theirs now, and is not turned down behind them.
    const used = applyOk(
      offered,
      recordCommand("completionCriteria", CLOCK_OUT, {
        documentPassage: { passageId, userAgrees: true },
      }),
    ).session;
    const refused = decline(used, passageId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("passage_not_offered");
  });

  it("links a correction that answers a passage, and drops the link on a later correction", () => {
    const { offered, passageId, applyOk, record, messageId } = answered();
    const stated = record(
      offered,
      "completionCriteria",
      "Cashiers clock out after closing duties.",
    );
    const correct = (statement: string, extra: Partial<CorrectClaimCommand> = {}) =>
      ({
        kind: "correct",
        createdByType: "agent",
        claimId: stated.claim.claimId,
        statement,
        note: null,
        effectiveDate: null,
        sourceMessageId: messageId,
        ...extra,
      }) satisfies CorrectClaimCommand;
    const linked = applyOk(
      stated.session,
      correct("Cashiers finish closing duties and clock out by 11:30 PM.", {
        documentPassage: { passageId, userAgrees: true },
      }),
    );
    expect(linked.claim.basedOnPassageId).toBe(passageId);
    expect(findPassage(linked.session, passageId)?.state).toBe("used");

    const reworded = applyOk(linked.session, correct("Cashiers clock out once the log is signed."));
    expect(reworded.claim.basedOnPassageId).toBeNull();
    expect(sopSessionSchema.safeParse(reworded.session).success).toBe(true);
  });

  it("raises a conflict with an open passage the user later contradicts, and settles it with their answer", () => {
    const { targeted, upload, record, applyOk, messageId } = setup();
    const uploaded = upload(targeted, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]).session;
    const contradicted = record(uploaded, "completionCriteria", "Cashiers clock out by 11:45 PM.");
    expect(contradicted.claim.status).toBe("conflict");

    const resolved = applyOk(contradicted.session, {
      kind: "resolveConflict",
      createdByType: "agent",
      claimId: contradicted.claim.claimId,
      statement: "Cashiers clock out by 11:45 PM.",
      note: null,
      effectiveDate: null,
      documentSideClaimId: null,
      sourceMessageId: messageId,
    });
    expect(resolved.session.claims.filter((claim) => claim.status === "conflict")).toEqual([]);
    expect(onlyState(resolved.session)).toEqual(["settled"]);
    expect(resolved.session.claims).toHaveLength(2);
    expect(sopSessionSchema.safeParse(resolved.session).success).toBe(true);
  });

  it("keeps the document behind an answer that says the document side is right, or that both agree", () => {
    const { targeted, upload, record, apply, applyOk, messageId } = setup(
      "They say the same thing: cashiers ask the Team Lead before extending a shift.",
    );
    const uploaded = upload(targeted, "policy.md", [
      {
        field: "authorization",
        statement: "A cashier should refer shift extensions to the closing Team Lead.",
        effectiveDate: "2026-09-01",
      },
    ]).session;
    const contradicted = record(
      uploaded,
      "authorization",
      "A cashier must ask the Team Lead before extending a shift.",
    );
    const documentSide = contradicted.session.claims.find(
      (claim) => claim.source.type === "policy_document",
    );
    if (documentSide === undefined) throw new Error("setup failed: no conflict");
    const resolveCommand = (documentSideClaimId: string | null) => ({
      kind: "resolveConflict" as const,
      createdByType: "agent" as const,
      claimId: contradicted.claim.claimId,
      statement: "Cashiers are expected to ask the Team Lead before extending a shift.",
      note: null,
      effectiveDate: null,
      documentSideClaimId,
      sourceMessageId: messageId,
    });

    const refused = apply(contradicted.session, resolveCommand(contradicted.claim.claimId));
    expect(refused.ok ? null : refused.error.code).toBe("not_a_document_side");

    const resolved = applyOk(contradicted.session, resolveCommand(documentSide.claimId));
    expect(resolved.claim).toMatchObject({
      status: "observed",
      basedOnPassageId: documentSide.basedOnPassageId,
      effectiveDate: "2026-09-01",
    });
    expect(onlyState(resolved.session)).toEqual(["used"]);
    expect(sopSessionSchema.safeParse(resolved.session).success).toBe(true);
    const item = buildSopDocument(resolved.session).sections.find(
      (section) => section.field === "authorization",
    )?.items[0];
    expect(item?.sourceLine).toBe(
      "from the interview, based on policy.md, § Rules, effective 2026-09-01",
    );
  });

  it("refuses to rest an answer on the document side when it drops the document's figure", () => {
    const { targeted, upload, record, apply, messageId } = setup(
      "The document is right, it's over $25,000.",
    );
    const uploaded = upload(targeted, "policy.md", [
      { field: "authorization", statement: "Payments over $10,000 need the CFO." },
    ]).session;
    const contradicted = record(uploaded, "authorization", "Payments over $25,000 need the CFO.");
    const documentSide = contradicted.session.claims.find(
      (claim) => claim.source.type === "policy_document",
    );
    const result = apply(contradicted.session, {
      kind: "resolveConflict",
      createdByType: "agent",
      claimId: contradicted.claim.claimId,
      statement: "Payments over $25,000 need the CFO.",
      note: null,
      effectiveDate: null,
      documentSideClaimId: documentSide?.claimId ?? "",
      sourceMessageId: messageId,
    });
    expect(result.ok ? null : result.error.code).toBe("statement_not_supported");
  });

  it("drops a document side's date from an answer that does not rest on the document", () => {
    const { targeted, upload, record, applyOk, messageId } = setup();
    const uploaded = upload(targeted, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT, effectiveDate: "2026-09-01" },
    ]).session;
    const contradicted = record(uploaded, "completionCriteria", "Cashiers clock out by 11:45 PM.");
    const resolved = applyOk(contradicted.session, {
      kind: "resolveConflict",
      createdByType: "agent",
      claimId: contradicted.claim.claimId,
      statement: "Cashiers clock out by 11:45 PM.",
      note: null,
      effectiveDate: "2026-09-01",
      documentSideClaimId: null,
      sourceMessageId: messageId,
    });
    expect(resolved.claim.effectiveDate).toBeNull();
  });

  it("refuses every passage write on an approved session", () => {
    const { offered, passageId, context } = answered();
    const approved: SopSession = {
      ...offered,
      status: "approved",
      approvedAt: "2026-01-01T00:00:00.000Z",
    };
    const declined = declineDocumentPassage(
      approved,
      { kind: "declineDocumentPassage", createdByType: "agent", passageId },
      context,
    );
    expect(declined.ok).toBe(false);
  });
});

describe("settling the passages handed to the agent", () => {
  // Wording from a manual test, where one passage was handed over and the reply asked a general
  // question instead; marking it offered anyway meant it was never put to the user.
  const AUTHORIZATION =
    "A cashier may not independently extend a scheduled shift and should refer remaining-work questions near shift end to the closing Team Lead.";
  const GENERAL_QUESTION =
    "I recorded the corrected timing and the late-departure report requirement. During closeout, what decisions can cashiers not make alone, and who decides instead?";

  it("does not count a general question that shares the passage's topic words", () => {
    const { targeted, upload } = setup();
    const uploaded = upload(targeted, "policy.md", [
      { field: "authorization", statement: "The manager approves refunds." },
    ]).session;
    const passageId = uploaded.references.passages[0]?.passageId ?? "";
    expect(
      settleShownDocumentPassages(uploaded, [passageId], "Who approves refunds?").askedIds,
    ).toEqual([]);
    expect(
      settleShownDocumentPassages(
        uploaded,
        [passageId],
        "Your uploaded policy says the manager approves refunds. Is that right?",
      ).askedIds,
    ).toEqual([passageId]);
  });

  it("tells a reply that puts a passage in its own words from one that asks something else", () => {
    expect(
      usesPassageWording(
        "Your uploaded document says the closing Team Lead coordinates front-end operations and may assign, reorder, or defer work when store conditions require it. Is that how this process works?",
        "The closing Team Lead coordinates front-end operations and may assign work, reorder activities, or defer an activity when store conditions require it.",
      ),
    ).toBe(true);
    expect(
      usesPassageWording(
        "Your uploaded document says customers already purchasing at closing may finish before closing work interferes with service, and final-shift cashiers are normally scheduled until 11:30 p.m. and should complete duties within that shift. Do both rules apply here?",
        "Final-shift cashiers are normally scheduled to clock out at 11:30 p.m. and should manage end-of-day duties within their scheduled shift.",
      ),
    ).toBe(true);
    expect(usesPassageWording(GENERAL_QUESTION, AUTHORIZATION)).toBe(false);
  });

  it("offers only what the reply asked, and hands a passed-over passage back later", () => {
    const { targeted, upload } = setup();
    const uploaded = upload(targeted, "policy.md", [
      { field: "authorization", statement: AUTHORIZATION },
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]).session;
    const [authorization, clockOut] = uploaded.references.passages;
    if (authorization === undefined || clockOut === undefined) throw new Error("setup failed");

    const settled = settleShownDocumentPassages(
      uploaded,
      [authorization.passageId],
      GENERAL_QUESTION,
    );
    expect(settled.askedIds).toEqual([]);
    expect(findPassage(settled.session, authorization.passageId)).toMatchObject({
      state: "open",
      timesNotAsked: 1,
    });
    // Behind the passage not handed over yet, but still there to be handed over.
    expect(selectDocumentPassages(settled.session).map((passage) => passage.passageId)).toEqual([
      clockOut.passageId,
    ]);

    const asked = settleShownDocumentPassages(
      settled.session,
      [authorization.passageId],
      "Your uploaded document says a cashier may not extend a scheduled shift independently and should refer remaining-work questions to the closing Team Lead. Is that how it works?",
    );
    expect(asked.askedIds).toEqual([authorization.passageId]);
    expect(findPassage(asked.session, authorization.passageId)?.state).toBe("offered");
  });

  it("stops handing over a passage the agent keeps passing over, and leaves it open", () => {
    const { targeted, upload } = setup();
    let session = upload(targeted, "policy.md", [
      { field: "authorization", statement: AUTHORIZATION },
    ]).session;
    const passageId = session.references.passages[0]?.passageId ?? "";
    for (let turn = 0; turn < MAX_TIMES_NOT_ASKED; turn += 1) {
      expect(selectDocumentPassages(session).map((passage) => passage.passageId)).toEqual([
        passageId,
      ]);
      session = settleShownDocumentPassages(session, [passageId], GENERAL_QUESTION).session;
    }
    expect(selectDocumentPassages(session)).toEqual([]);
    expect(findPassage(session, passageId)?.state).toBe("open");
    expect(sopSessionSchema.safeParse(session).success).toBe(true);
  });
});

describe("conflicts with a confirmed suggestion", () => {
  it("raises a conflict when a document disagrees with a suggestion the person confirmed", () => {
    const { targeted, apply, applyOk, recordCommand, upload } = setup();
    const suggested = applyOk(
      targeted,
      recordCommand("completionCriteria", "Cashiers clock out by 11:45 PM.", {
        status: "proposed",
      }),
    );
    const confirmed = apply(suggested.session, {
      kind: "confirm",
      createdByType: "user",
      claimId: suggested.claim.claimId,
    });
    if (!confirmed.ok) throw new Error(`setup failed: ${confirmed.error.code}`);

    const uploaded = upload(confirmed.session, "policy.md", [
      { field: "completionCriteria", statement: CLOCK_OUT },
    ]);
    expect(uploaded.conflictsRaised).toBe(1);
    expect(
      uploaded.session.claims.find((claim) => claim.claimId === suggested.claim.claimId)?.status,
    ).toBe("conflict");
  });
});

describe("keepsPassageMeaning", () => {
  it("allows a reworded statement that keeps the figures, limits and negation", () => {
    expect(
      keepsPassageMeaning(
        "Cashiers cannot extend a shift on their own and ask the Team Lead instead.",
        "A cashier may not independently extend a scheduled shift.",
      ),
    ).toBe(true);
    expect(
      keepsPassageMeaning(
        "No cashier may clock out before the Team Lead has walked the front end.",
        "Cashiers may not clock out before the Team Lead has walked the front end.",
      ),
    ).toBe(true);
  });

  it("refuses a statement that adds a figure of its own, even one that names the passage's", () => {
    expect(
      keepsPassageMeaning(
        "Payments over $10,000 rather than $25,000 need the CFO.",
        "Payments over $25,000 need the CFO.",
      ),
    ).toBe(false);
  });

  it("refuses one that drops or flips a figure, a frequency, a limit or a negation", () => {
    const passage = "Refunds over $500 do not need a manager's approval.";
    expect(keepsPassageMeaning("Refunds over $500 need a manager's approval.", passage)).toBe(
      false,
    );
    expect(keepsPassageMeaning("Refunds over $300 don't need a manager's approval.", passage)).toBe(
      false,
    );
    expect(
      keepsPassageMeaning("Refunds under $500 don't need a manager's approval.", passage),
    ).toBe(false);
    expect(keepsPassageMeaning("Drawers are counted weekly.", "Drawers are counted daily.")).toBe(
      false,
    );
  });
});

describe("statesCalendarDate", () => {
  it("accepts the whole date in words or numbers, and nothing less", () => {
    for (const text of [
      "It started on September 1, 2026.",
      "From 1 Sept 2026 on.",
      "Since 2026-09-01.",
      "Effective 9/1/2026.",
    ]) {
      expect(statesCalendarDate(text, "2026-09-01"), text).toBe(true);
    }
    for (const text of [
      "It changed in 2026.",
      "Since September 2026.",
      "On the 1st, in 2025.",
      "The September 2026 policy, version 1, governs us.",
    ]) {
      expect(statesCalendarDate(text, "2026-09-01"), text).toBe(false);
    }
  });
});
