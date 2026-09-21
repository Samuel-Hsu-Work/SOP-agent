import {
  AGENT_WRITABLE_STATUSES,
  type AgentWritableStatus,
  type AuthorityTier,
  type Claim,
  type ClaimStatus,
  type SourceType,
} from "./claim.ts";
import {
  type ApplyClaimResult,
  agentHistoryEntry,
  buildValue,
  type ClaimWriteError,
  checkSessionLimits,
  commit,
  failure,
  hasUserMessage,
  isClaimWriteError,
  type SessionChanges,
  STATUSES_WRITABLE_BY,
  validateText,
} from "./claimWriteSupport.ts";
import type { ResolveConflictCommand } from "./conflictResolution.ts";
import { applyResolveConflict } from "./conflictResolution.ts";
import { pairConflictsAfterWrite } from "./detectConflicts.ts";
import type { IngestExtractedClaimCommand } from "./documentClaims.ts";
import { applyIngestExtracted } from "./documentClaims.ts";
import type { ReviewClaimCommand } from "./reviewClaim.ts";
import { applyReviewCommand } from "./reviewClaim.ts";
import type { SopSession } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import { normalizeStatement } from "./text.ts";
import type { WriteContext } from "./writeContext.ts";

/** Statuses a correction, a mark-unknown or a withdrawal may act on. An `extracted` claim waits for a person's review, and a `conflict` for the user's final answer. */
const STATUSES_AGENT_MAY_CHANGE: readonly ClaimStatus[] = [
  "observed",
  "proposed",
  "unknown",
  "confirmed",
];

/**
 * Add a claim. The status is a plain `ClaimStatus` on purpose: the model-facing tool schema only
 * offers legal choices, but a forbidden request must still reach this function and be refused with
 * a message the model can read.
 */
export interface RecordClaimCommand {
  kind: "record";
  createdByType: "agent";
  field: SopFieldName;
  status: ClaimStatus;
  statement: string;
  note: string | null;
  effectiveDate: string | null;
  /** The user message the claim came from. Must exist in the session. */
  sourceMessageId: string;
  /** Procedure only: place the new step before this step. Null appends. */
  insertBeforeClaimId: string | null;
}

/** The user restated or fixed something already recorded. The result is always `observed`, and the field never changes. */
export interface CorrectClaimCommand {
  kind: "correct";
  createdByType: "agent";
  claimId: string;
  statement: string;
  note: string | null;
  effectiveDate: string | null;
  sourceMessageId: string;
}

/** The user does not know. Targets an existing claim, or with a null `claimId` records a new unknown in `field`. */
export interface MarkUnknownCommand {
  kind: "markUnknown";
  createdByType: "agent";
  field: SopFieldName;
  claimId: string | null;
  /** Says what is unknown. Required. */
  note: string;
  sourceMessageId: string;
}

/** The user said a claim should not be there at all. The claim moves to the history. */
export interface WithdrawClaimCommand {
  kind: "withdraw";
  createdByType: "agent";
  claimId: string;
  /** Says why. Required. */
  note: string;
  sourceMessageId: string;
}

/**
 * The commands the agent's tools can build. The model cannot construct a review command, and it
 * cannot construct an ingestion command either: both are outside this type.
 */
export type AgentClaimCommand =
  | RecordClaimCommand
  | CorrectClaimCommand
  | MarkUnknownCommand
  | WithdrawClaimCommand
  | ResolveConflictCommand;

export type ClaimWriteCommand =
  | AgentClaimCommand
  | ReviewClaimCommand
  | IngestExtractedClaimCommand;

export type {
  ApplyClaimResult,
  ClaimWriteError,
  IngestExtractedClaimCommand,
  ResolveConflictCommand,
};
export { STATUSES_WRITABLE_BY };

/**
 * Source and authority are derived here, never taken from the caller. A model that could choose
 * `official_policy` for a hallway remark would quietly break conflict ranking in a later slice.
 */
function deriveAgentProvenance(status: AgentWritableStatus): {
  sourceType: SourceType;
  authority: AuthorityTier;
} {
  switch (status) {
    case "observed":
      return { sourceType: "employee_statement", authority: "observed_practice" };
    case "proposed":
      return { sourceType: "agent_suggestion", authority: "proposed" };
    case "unknown":
      return { sourceType: "employee_statement", authority: "unknown" };
  }
}

function isAgentWritableStatus(status: ClaimStatus): status is AgentWritableStatus {
  return (AGENT_WRITABLE_STATUSES as readonly ClaimStatus[]).includes(status);
}

/**
 * The claim that a `record` would merely repeat, if any: same field, status and words. A procedure
 * step is different, because the same action can happen twice in a process ("notify the customer"
 * at step 2 and again at step 5). There it only counts as a repeat when the step just before the
 * place where the new one would go already says the same thing, which is what a retried call looks
 * like.
 */
function findRecordedDuplicate(
  session: SopSession,
  command: RecordClaimCommand,
  statement: string,
): Claim | undefined {
  const normalized = normalizeStatement(statement);
  const isSameWords = (claim: Claim | undefined): claim is Claim =>
    claim !== undefined &&
    claim.field === command.field &&
    claim.status === command.status &&
    claim.value !== null &&
    normalizeStatement(claim.value.text) === normalized;

  if (command.field !== "procedure") return session.claims.find(isSameWords);

  const insertIndex =
    command.insertBeforeClaimId === null
      ? session.procedureOrder.length
      : session.procedureOrder.indexOf(command.insertBeforeClaimId);
  const stepBefore = session.procedureOrder[insertIndex - 1];
  const candidate = session.claims.find((claim) => claim.claimId === stepBefore);
  return isSameWords(candidate) ? candidate : undefined;
}

/** An unknown with no slot in the procedure: it stands for the whole field, not one step. */
function isFieldLevelUnknown(session: SopSession, claim: Claim): boolean {
  return claim.status === "unknown" && !session.procedureOrder.includes(claim.claimId);
}

function applyRecord(
  session: SopSession,
  command: RecordClaimCommand,
  context: WriteContext,
): ApplyClaimResult {
  if (!STATUSES_WRITABLE_BY[command.createdByType].includes(command.status)) {
    return failure(
      "status_not_allowed_for_creator",
      `The agent cannot write a claim with status "${command.status}". Only a person can confirm a claim.`,
    );
  }
  if (!isAgentWritableStatus(command.status)) {
    return failure("status_not_allowed_for_creator", "That status is not available to the agent.");
  }
  if (command.status === "unknown") {
    return failure(
      "wrong_command_for_status",
      'Use mark_claim_unknown to record that something is unknown. record_claim takes "observed" or "proposed".',
    );
  }

  const text = validateText({
    statement: command.statement,
    isStatementRequired: true,
    isNoteRequired: false,
    note: command.note,
    effectiveDate: command.effectiveDate,
  });
  if (isClaimWriteError(text)) return { ok: false, error: text };
  const statement = text.statement ?? "";

  if (!hasUserMessage(session, command.sourceMessageId)) {
    return failure("source_message_not_found", "The claim must cite an existing user message.");
  }

  if (command.insertBeforeClaimId !== null) {
    if (command.field !== "procedure") {
      return failure(
        "anchor_not_applicable",
        "Only a procedure step can be placed before another step.",
      );
    }
    if (!session.procedureOrder.includes(command.insertBeforeClaimId)) {
      return failure("anchor_not_found", "There is no procedure step with that id.");
    }
  }

  const duplicate = findRecordedDuplicate(session, command, statement);
  if (duplicate !== undefined) {
    const isIdentical =
      duplicate.note === text.note && duplicate.effectiveDate === text.effectiveDate;
    if (isIdentical) return { ok: true, session, claim: duplicate, change: "unchanged" };
    // Same words, but a different note or date: dropping it would lose the new detail, and adding
    // it would put the same statement in twice. The model can change the existing claim instead.
    return failure(
      "already_recorded",
      `This claim is already recorded with id ${duplicate.claimId}. To change its note or effective date, call correct_claim on that id.`,
    );
  }

  // A new claim never closes an unknown, even in the same field: a fact next to an unknown may be
  // about something else. Only `correct` on the unknown itself answers it.
  const timestamp = context.now();
  const provenance = deriveAgentProvenance(command.status);
  const claim: Claim = {
    claimId: context.newId(),
    field: command.field,
    value: buildValue(command.field, statement),
    status: command.status,
    source: {
      type: provenance.sourceType,
      reference: { kind: "message", messageId: command.sourceMessageId },
    },
    authority: provenance.authority,
    effectiveDate: text.effectiveDate,
    note: text.note,
    createdByType: command.createdByType,
    conflictsWithClaimId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  let procedureOrder = session.procedureOrder;
  if (command.field === "procedure") {
    const anchorIndex =
      command.insertBeforeClaimId === null
        ? -1
        : procedureOrder.indexOf(command.insertBeforeClaimId);
    procedureOrder =
      anchorIndex === -1
        ? [...procedureOrder, claim.claimId]
        : [
            ...procedureOrder.slice(0, anchorIndex),
            claim.claimId,
            ...procedureOrder.slice(anchorIndex),
          ];
  }

  const changes: SessionChanges = {
    claims: [...session.claims, claim],
    procedureOrder,
    claimHistory: session.claimHistory,
  };
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return { ok: false, error: limitError };

  return { ok: true, claim, change: "created", session: commit(session, changes, timestamp) };
}

function applyCorrect(
  session: SopSession,
  command: CorrectClaimCommand,
  context: WriteContext,
): ApplyClaimResult {
  const previous = session.claims.find((claim) => claim.claimId === command.claimId);
  if (previous === undefined) {
    return failure("target_claim_not_found", "There is no active claim with that id.");
  }
  if (!STATUSES_AGENT_MAY_CHANGE.includes(previous.status)) {
    return failure(
      "status_transition_not_allowed",
      `A claim with status "${previous.status}" cannot be corrected.`,
    );
  }

  const text = validateText({
    statement: command.statement,
    isStatementRequired: true,
    isNoteRequired: false,
    note: command.note,
    effectiveDate: command.effectiveDate,
  });
  if (isClaimWriteError(text)) return { ok: false, error: text };
  const statement = text.statement ?? "";

  if (!hasUserMessage(session, command.sourceMessageId)) {
    return failure("source_message_not_found", "The claim must cite an existing user message.");
  }

  if (
    previous.status === "observed" &&
    previous.value !== null &&
    normalizeStatement(previous.value.text) === normalizeStatement(statement) &&
    previous.note === text.note &&
    previous.effectiveDate === text.effectiveDate
  ) {
    return { ok: true, session, claim: previous, change: "unchanged" };
  }

  const timestamp = context.now();
  const provenance = deriveAgentProvenance("observed");
  const claim: Claim = {
    ...previous,
    value: buildValue(previous.field, statement),
    status: "observed",
    source: {
      type: provenance.sourceType,
      reference: { kind: "message", messageId: command.sourceMessageId },
    },
    authority: provenance.authority,
    effectiveDate: text.effectiveDate,
    note: text.note,
    updatedAt: timestamp,
  };

  // A field-level unknown that gets a step joins the end of the procedure.
  const needsSlot = claim.field === "procedure" && !session.procedureOrder.includes(claim.claimId);
  const changes: SessionChanges = {
    claims: session.claims.map((existing) =>
      existing.claimId === claim.claimId ? claim : existing,
    ),
    procedureOrder: needsSlot ? [...session.procedureOrder, claim.claimId] : session.procedureOrder,
    claimHistory: [
      ...session.claimHistory,
      agentHistoryEntry(
        context,
        timestamp,
        previous,
        command.sourceMessageId,
        previous.status === "unknown" ? "answered_unknown" : "corrected",
      ),
    ],
  };
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return { ok: false, error: limitError };

  return { ok: true, claim, change: "updated", session: commit(session, changes, timestamp) };
}

/**
 * A confirmed claim carries a person's verification, so the agent may replace its wording with
 * `correct_claim` (which visibly drops it to observed) but may not remove it or blank it. The
 * person withdraws the confirmation in the review panel first. Code enforces this because code
 * cannot read intent, but it can refuse the destructive commands outright.
 */
function refuseToChangeConfirmed(action: "withdrawn" | "marked unknown"): ApplyClaimResult {
  return failure(
    "confirmation_required",
    `This claim is confirmed by the user, so it cannot be ${action} from chat. Tell the user to withdraw the confirmation in the review panel first. If they gave a replacement, use correct_claim.`,
  );
}

/**
 * Marking something unknown again is a no-op when the note is the same. A more precise note is
 * kept: the note is the only description of what is unknown, and the earlier one goes to the history.
 */
function refreshUnknownNote(
  session: SopSession,
  existing: Claim,
  note: string | null,
  command: MarkUnknownCommand,
  context: WriteContext,
): ApplyClaimResult {
  if (existing.note === note) return { ok: true, session, claim: existing, change: "unchanged" };

  const timestamp = context.now();
  const claim: Claim = {
    ...existing,
    source: {
      type: "employee_statement",
      reference: { kind: "message", messageId: command.sourceMessageId },
    },
    note,
    updatedAt: timestamp,
  };
  const changes: SessionChanges = {
    claims: session.claims.map((candidate) =>
      candidate.claimId === claim.claimId ? claim : candidate,
    ),
    procedureOrder: session.procedureOrder,
    claimHistory: [
      ...session.claimHistory,
      agentHistoryEntry(context, timestamp, existing, command.sourceMessageId, "marked_unknown"),
    ],
  };
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return { ok: false, error: limitError };
  return { ok: true, claim, change: "updated", session: commit(session, changes, timestamp) };
}

function applyMarkUnknown(
  session: SopSession,
  command: MarkUnknownCommand,
  context: WriteContext,
): ApplyClaimResult {
  const text = validateText({
    statement: null,
    isStatementRequired: false,
    isNoteRequired: true,
    note: command.note,
    effectiveDate: null,
  });
  if (isClaimWriteError(text)) return { ok: false, error: text };

  if (!hasUserMessage(session, command.sourceMessageId)) {
    return failure("source_message_not_found", "The claim must cite an existing user message.");
  }

  const timestamp = context.now();
  const provenance = deriveAgentProvenance("unknown");
  const source = {
    type: provenance.sourceType,
    reference: { kind: "message" as const, messageId: command.sourceMessageId },
  };

  if (command.claimId === null) {
    const existingUnknown = session.claims.find(
      (claim) => claim.field === command.field && isFieldLevelUnknown(session, claim),
    );
    if (existingUnknown !== undefined) {
      return refreshUnknownNote(session, existingUnknown, text.note, command, context);
    }
    const claim: Claim = {
      claimId: context.newId(),
      field: command.field,
      value: null,
      status: "unknown",
      source,
      authority: provenance.authority,
      effectiveDate: null,
      note: text.note,
      createdByType: command.createdByType,
      conflictsWithClaimId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const changes: SessionChanges = {
      claims: [...session.claims, claim],
      procedureOrder: session.procedureOrder,
      claimHistory: session.claimHistory,
    };
    const limitError = checkSessionLimits(session, changes);
    if (limitError !== null) return { ok: false, error: limitError };
    return { ok: true, claim, change: "created", session: commit(session, changes, timestamp) };
  }

  const previous = session.claims.find(
    (claim) => claim.claimId === command.claimId && claim.field === command.field,
  );
  if (previous === undefined) {
    return failure(
      "target_claim_not_found",
      "There is no active claim with that id in that field.",
    );
  }
  if (previous.status === "confirmed") return refuseToChangeConfirmed("marked unknown");
  if (previous.status === "unknown") {
    return refreshUnknownNote(session, previous, text.note, command, context);
  }
  if (!STATUSES_AGENT_MAY_CHANGE.includes(previous.status)) {
    return failure(
      "status_transition_not_allowed",
      `A claim with status "${previous.status}" cannot be marked unknown.`,
    );
  }

  // The step keeps its slot in the procedure, so the order survives the gap.
  const claim: Claim = {
    ...previous,
    value: null,
    status: "unknown",
    source,
    authority: provenance.authority,
    effectiveDate: null,
    note: text.note,
    updatedAt: timestamp,
  };
  const changes: SessionChanges = {
    claims: session.claims.map((existing) =>
      existing.claimId === claim.claimId ? claim : existing,
    ),
    procedureOrder: session.procedureOrder,
    claimHistory: [
      ...session.claimHistory,
      agentHistoryEntry(context, timestamp, previous, command.sourceMessageId, "marked_unknown"),
    ],
  };
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return { ok: false, error: limitError };

  return { ok: true, claim, change: "updated", session: commit(session, changes, timestamp) };
}

function applyWithdraw(
  session: SopSession,
  command: WithdrawClaimCommand,
  context: WriteContext,
): ApplyClaimResult {
  const text = validateText({
    statement: null,
    isStatementRequired: false,
    isNoteRequired: true,
    note: command.note,
    effectiveDate: null,
  });
  if (isClaimWriteError(text)) return { ok: false, error: text };

  if (!hasUserMessage(session, command.sourceMessageId)) {
    return failure("source_message_not_found", "The claim must cite an existing user message.");
  }

  const previous = session.claims.find((claim) => claim.claimId === command.claimId);
  if (previous === undefined) {
    return failure("target_claim_not_found", "There is no active claim with that id.");
  }
  if (previous.status === "confirmed") return refuseToChangeConfirmed("withdrawn");
  if (!STATUSES_AGENT_MAY_CHANGE.includes(previous.status)) {
    return failure(
      "status_transition_not_allowed",
      `A claim with status "${previous.status}" cannot be withdrawn.`,
    );
  }

  const timestamp = context.now();
  const changes: SessionChanges = {
    claims: session.claims.filter((claim) => claim.claimId !== previous.claimId),
    procedureOrder: session.procedureOrder.filter((claimId) => claimId !== previous.claimId),
    claimHistory: [
      ...session.claimHistory,
      agentHistoryEntry(
        context,
        timestamp,
        previous,
        command.sourceMessageId,
        "withdrawn",
        text.note,
      ),
    ],
  };
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return { ok: false, error: limitError };

  return {
    ok: true,
    claim: previous,
    change: "withdrawn",
    session: commit(session, changes, timestamp),
  };
}

/**
 * The single claim-writing function. Every path that changes a claim goes through here, so the
 * provenance rules cannot be bypassed by a second, less careful write path.
 *
 * It is pure: it returns a new session and never mutates its input. It returns a result instead of
 * throwing, because its main caller is a tool handler that must report a failure back to the model
 * rather than crash the turn.
 *
 * A change is never silent: correcting, marking unknown and withdrawing each write a history entry
 * with the whole previous claim and the user message that caused the change.
 */
export function applyClaim(
  session: SopSession,
  command: ClaimWriteCommand,
  context: WriteContext,
): ApplyClaimResult {
  // Checked first, for every command, now and in every later slice.
  if (session.status === "approved") {
    return failure("session_approved", "The SOP is approved, so it can no longer be changed.");
  }

  switch (command.kind) {
    case "record":
      return pairConflictsAfterWrite(applyRecord(session, command, context), context);
    case "correct":
      return pairConflictsAfterWrite(applyCorrect(session, command, context), context);
    case "ingestExtracted":
      return pairConflictsAfterWrite(applyIngestExtracted(session, command, context), context);
    case "resolveConflict":
      return pairConflictsAfterWrite(applyResolveConflict(session, command, context), context);
    case "markUnknown":
      return applyMarkUnknown(session, command, context);
    case "withdraw":
      return applyWithdraw(session, command, context);
    case "confirm":
    case "reject":
      return applyReviewCommand(session, command, context);
  }
}
