import {
  addReferenceDocument,
  applyClaim,
  approveSession,
  type ClaimWriteCommand,
  checkFinalization,
  markDocumentPassagesOffered,
  SOP_FIELD_NAMES,
  type SopFieldName,
  type SopSession,
  setAdvisoryAcknowledgement,
} from "@sop-agent/sop-core";
import {
  buildReferenceUpload,
  createDeterministicContext,
  createSessionWithUserMessage,
} from "@sop-agent/sop-core/testing";

export interface ApprovedSessionOptions {
  /** Extra text placed in the purpose claim, for tests that look for one distinctive string. */
  purposeText?: string;
  /** Extra text placed in the note of the roles claim. */
  noteText?: string;
  /** Number of procedure steps. */
  stepCount?: number;
}

/**
 * A session that went through the real path: statements recorded, some confirmed, an unknown, a
 * document passage the user agreed with, and a conflict between a document and the user in
 * advisory fields, every advisory gap acknowledged, then approved. Every claim is written through
 * the real write paths; nothing is forged by hand.
 */
export function buildApprovedSession(options: ApprovedSessionOptions = {}): SopSession {
  const context = createDeterministicContext();
  const { session: emptySession, messageId } = createSessionWithUserMessage(
    context,
    "We refund within 30 days.",
  );
  const apply = (current: SopSession, command: ClaimWriteCommand): SopSession => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result.session;
  };
  const record = (
    current: SopSession,
    field: SopFieldName,
    statement: string,
    extra: { note?: string; effectiveDate?: string; passageId?: string } = {},
  ): SopSession =>
    apply(current, {
      kind: "record",
      createdByType: "agent",
      field,
      status: "observed",
      statement,
      note: extra.note ?? null,
      effectiveDate: extra.effectiveDate ?? null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
      documentPassage:
        extra.passageId === undefined ? null : { passageId: extra.passageId, userAgrees: true },
    });

  let session = emptySession;
  for (const field of SOP_FIELD_NAMES.slice(0, 8)) {
    if (field === "procedure") continue;
    const statement =
      field === "purpose"
        ? `Handle refunds fairly. ${options.purposeText ?? ""}`.trim()
        : `The ${field} statement.`;
    session = record(session, field, statement, {
      ...(field === "roles" && options.noteText !== undefined ? { note: options.noteText } : {}),
      ...(field === "trigger" ? { effectiveDate: "2026-01-15" } : {}),
    });
  }
  for (let step = 1; step <= (options.stepCount ?? 3); step += 1) {
    session = record(session, "procedure", `Procedure step number ${step}.`);
  }

  // The user confirms the purpose and the roles.
  for (const field of ["purpose", "roles"] as const) {
    const claim = session.claims.find((entry) => entry.field === field);
    if (claim === undefined) throw new Error("setup failed");
    session = apply(session, { kind: "confirm", createdByType: "user", claimId: claim.claimId });
  }

  // Advisory fields: an unknown, a document passage the user agreed with, and a conflict between
  // what the user said and what the document says, which leave gaps to acknowledge.
  session = apply(session, {
    kind: "markUnknown",
    createdByType: "agent",
    field: "evidence",
    claimId: null,
    note: "Which system holds the refund receipts.",
    sourceMessageId: messageId,
  });
  session = record(session, "controls", "Refunds over 800 need a second approver.");
  const uploaded = addReferenceDocument(
    session,
    buildReferenceUpload("refund-policy.pdf", [
      {
        field: "decisionRules",
        statement: "Refunds under 50 are approved automatically.",
        location: "p.2",
      },
      {
        field: "controls",
        statement: "Refunds over 500 need a second approver.",
        location: "p.3",
      },
    ]),
    context,
  );
  if (!uploaded.ok) throw new Error(`setup failed: ${uploaded.error.code}`);
  const agreed = uploaded.session.references.passages.find(
    (passage) => passage.field === "decisionRules",
  );
  if (agreed === undefined) throw new Error("setup failed");
  session = markDocumentPassagesOffered(uploaded.session, [agreed.passageId]);
  session = record(session, "decisionRules", "Refunds under 50 are approved automatically.", {
    passageId: agreed.passageId,
  });

  for (const field of checkFinalization(session).advisoryGapFields) {
    const result = setAdvisoryAcknowledgement(session, { field, acknowledged: true }, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    session = result.session;
  }
  const approved = approveSession(session, context);
  if (!approved.ok) throw new Error(`setup failed: ${approved.error.code}`);
  return approved.session;
}
