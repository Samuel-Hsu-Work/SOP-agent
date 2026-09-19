import {
  AGENT_WRITABLE_STATUSES,
  type AgentWritableStatus,
  type AuthorityTier,
  type Claim,
  type ClaimStatus,
  type ClaimWriteErrorCode,
  type CreatorType,
  calendarDateSchema,
  claimValueSchema,
  type SourceType,
} from "./claim.ts";
import { MAX_CLAIMS, MAX_HISTORY_ENTRIES, MAX_NOTE_LENGTH } from "./limits.ts";
import type { ClaimHistoryEntry, SopSession } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import type { WriteContext } from "./writeContext.ts";

/**
 * Who may write which claim status. This table is the structural form of the product's central
 * promise: the model proposes, and only a person confirms.
 *
 * `conflict` is in no creator's list: only an internal system path (slice 5) may produce it.
 *
 * An honest limit: with no login, the server cannot tell a person from a script. What this table
 * guarantees is that neither the agent nor a document can cause a `confirmed` claim, not that a
 * hand-built request cannot forge a session that already contains one.
 */
export const STATUSES_WRITABLE_BY: Readonly<Record<CreatorType, readonly ClaimStatus[]>> = {
  agent: AGENT_WRITABLE_STATUSES,
  user: ["confirmed", "unknown"],
  extraction: ["extracted"],
};

/** Slice 1 records claims for the agent only. Other creators arrive with their slices. */
export interface RecordClaimCommand {
  kind: "record";
  createdByType: "agent";
  field: SopFieldName;
  status: ClaimStatus;
  /** Required unless the status is `unknown`, in which case it must be null. */
  statement: string | null;
  note: string | null;
  effectiveDate: string | null;
  /** The user message the claim came from. Must exist in the session. */
  sourceMessageId: string;
  /** Slice 1 allows replacing an active `unknown` claim in the same field, and nothing else. */
  replacesClaimId: string | null;
}

export type ClaimWriteCommand = RecordClaimCommand;

export interface ClaimWriteError {
  code: ClaimWriteErrorCode;
  message: string;
}

export type ApplyClaimResult =
  | { ok: true; session: SopSession; claim: Claim }
  | { ok: false; error: ClaimWriteError };

function failure(code: ClaimWriteErrorCode, message: string): ApplyClaimResult {
  return { ok: false, error: { code, message } };
}

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
 * The single claim-writing function. Every path that changes a claim goes through here, so the
 * provenance rules cannot be bypassed by a second, less careful write path.
 *
 * It is pure: it returns a new session and never mutates its input. It returns a result instead of
 * throwing, because its main caller is a tool handler that must report a failure back to the model
 * rather than crash the turn.
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

  if (!STATUSES_WRITABLE_BY[command.createdByType].includes(command.status)) {
    return failure(
      "status_not_allowed_for_creator",
      `The agent cannot write a claim with status "${command.status}". Only a person can confirm a claim.`,
    );
  }
  if (!isAgentWritableStatus(command.status)) {
    return failure("status_not_allowed_for_creator", "That status is not available to the agent.");
  }

  const statement = command.statement === null ? null : command.statement.trim();
  if (command.status === "unknown") {
    if (statement !== null) {
      return failure("value_not_allowed", 'A claim with status "unknown" must have no statement.');
    }
  } else {
    if (statement === null || statement === "") {
      return failure(
        "value_required",
        `A claim with status "${command.status}" needs a statement.`,
      );
    }
  }

  const value = statement === null ? null : { kind: "statement" as const, text: statement };
  if (value !== null && !claimValueSchema.safeParse(value).success) {
    return failure("invalid_value", "The statement is too long.");
  }

  const note = command.note === null ? null : command.note.trim() || null;
  if (note !== null && note.length > MAX_NOTE_LENGTH) {
    return failure("invalid_value", "The note is too long.");
  }
  if (
    command.effectiveDate !== null &&
    !calendarDateSchema.safeParse(command.effectiveDate).success
  ) {
    return failure("invalid_value", "The effective date must be a calendar date, YYYY-MM-DD.");
  }

  const sourceIsUserMessage = session.messages.some(
    (message) => message.role === "user" && message.id === command.sourceMessageId,
  );
  if (!sourceIsUserMessage) {
    return failure("source_message_not_found", "The claim must cite an existing user message.");
  }

  let claimsToKeep = session.claims;
  let replacedClaim: Claim | undefined;
  if (command.replacesClaimId !== null) {
    replacedClaim = session.claims.find((claim) => claim.claimId === command.replacesClaimId);
    if (replacedClaim === undefined) {
      return failure("replace_target_not_found", "There is no active claim with that id.");
    }
    if (replacedClaim.field !== command.field) {
      return failure(
        "replace_field_mismatch",
        "A claim can only replace a claim in the same field.",
      );
    }
    if (replacedClaim.status !== "unknown") {
      return failure(
        "replace_target_not_unknown",
        'Only a claim with status "unknown" can be replaced.',
      );
    }
    const targetId = replacedClaim.claimId;
    claimsToKeep = session.claims.filter((claim) => claim.claimId !== targetId);
  }

  if (claimsToKeep.length + 1 > MAX_CLAIMS) {
    return failure(
      "session_limit_reached",
      "The session already holds the maximum number of claims.",
    );
  }
  if (replacedClaim !== undefined && session.claimHistory.length + 1 > MAX_HISTORY_ENTRIES) {
    return failure("session_limit_reached", "The session history is full.");
  }

  const provenance = deriveAgentProvenance(command.status);
  const timestamp = context.now();
  const claim: Claim = {
    claimId: context.newId(),
    field: command.field,
    value,
    status: command.status,
    source: {
      type: provenance.sourceType,
      reference: { kind: "message", messageId: command.sourceMessageId },
    },
    authority: provenance.authority,
    effectiveDate: command.effectiveDate,
    note,
    createdByType: command.createdByType,
    createdAt: timestamp,
  };

  const historyEntry: ClaimHistoryEntry | undefined =
    replacedClaim === undefined
      ? undefined
      : {
          entryId: context.newId(),
          claimId: replacedClaim.claimId,
          changedAt: timestamp,
          changedBy: command.createdByType,
          reason: "replaced",
          previousClaim: replacedClaim,
        };

  return {
    ok: true,
    claim,
    session: {
      ...session,
      updatedAt: timestamp,
      claims: [...claimsToKeep, claim],
      claimHistory:
        historyEntry === undefined ? session.claimHistory : [...session.claimHistory, historyEntry],
    },
  };
}
