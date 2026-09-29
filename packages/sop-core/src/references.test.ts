import { describe, expect, it } from "vitest";
import {
  applyClaim,
  type ClaimWriteCommand,
  type CorrectClaimCommand,
  type RecordClaimCommand,
} from "./applyClaim.ts";
import { totalClaimTextLength } from "./claim.ts";
import { computeGaps } from "./computeGaps.ts";
import {
  buildInterviewAgenda,
  pendingDocumentPassages,
  selectDocumentPassages,
} from "./interviewAgenda.ts";
import { MAX_REFERENCE_DOCUMENTS, MAX_REFERENCE_PASSAGES, MAX_TOTAL_CLAIM_TEXT } from "./limits.ts";
import { findPassage } from "./referenceSchema.ts";
import {
  addReferenceDocument,
  declineDocumentPassage,
  markDocumentPassagesOffered,
  sopTargetOf,
} from "./references.ts";
import { type SopSession, sopSessionSchema } from "./session.ts";
import { buildSopDocument } from "./sopDocument.ts";
import type { SopFieldName } from "./sopFields.ts";
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
    for (let index = 0; index < MAX_REFERENCE_PASSAGES / 8; index += 1) {
      full = upload(
        full,
        `policy-${index}.md`,
        Array.from({ length: 8 }, (_, step) => ({
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

  it("refuses an answer to a passage that was never put to the user, or as a suggestion", () => {
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
    expect(codeOf(notOffered, agreeing(onlyPassage(notOffered).passageId))).toBe(
      "passage_not_offered",
    );
    expect(codeOf(offered, agreeing("missing"))).toBe("passage_not_found");
    expect(codeOf(offered, { ...agreeing(passageId), status: "proposed" })).toBe(
      "wrong_command_for_status",
    );
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
      sourceMessageId: messageId,
    });
    expect(resolved.session.claims.filter((claim) => claim.status === "conflict")).toEqual([]);
    expect(onlyState(resolved.session)).toEqual(["settled"]);
    expect(resolved.session.claims).toHaveLength(2);
    expect(sopSessionSchema.safeParse(resolved.session).success).toBe(true);
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
