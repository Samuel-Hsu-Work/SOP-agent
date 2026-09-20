import {
  applyClaim,
  approveSession,
  type ClaimWriteCommand,
  checkFinalization,
  SOP_FIELD_NAMES,
  type SopFieldName,
  type SopSession,
  setAdvisoryAcknowledgement,
} from "@sop-agent/sop-core";
import {
  buildClaim,
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
 * conflict and an extracted claim in advisory fields, every advisory gap acknowledged, then
 * approved. Nothing here is hand-forged except the two claims that only slice 5 can create.
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
    extra: { note?: string; effectiveDate?: string } = {},
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

  // Advisory fields: an unknown, a conflict and an extracted claim (the last two exist only from
  // slice 5, so they are built by hand), which leave those fields as gaps to acknowledge.
  session = apply(session, {
    kind: "markUnknown",
    createdByType: "agent",
    field: "evidence",
    claimId: null,
    note: "Which system holds the refund receipts.",
    sourceMessageId: messageId,
  });
  const handBuilt = (field: SopFieldName, status: "conflict" | "extracted", text: string) =>
    buildClaim({
      claimId: `built-${field}`,
      field,
      status,
      value: { kind: "statement", text },
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
    });
  session = {
    ...session,
    claims: [
      ...session.claims,
      handBuilt("controls", "conflict", "Refunds over 500 need a second approver."),
      handBuilt("decisionRules", "extracted", "Approve automatically under 50."),
    ],
  };

  for (const field of checkFinalization(session).advisoryGapFields) {
    const result = setAdvisoryAcknowledgement(session, { field, acknowledged: true }, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    session = result.session;
  }
  const approved = approveSession(session, context);
  if (!approved.ok) throw new Error(`setup failed: ${approved.error.code}`);
  return approved.session;
}
