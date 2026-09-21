import {
  AGENT_WRITABLE_STATUSES,
  type Claim,
  type ClaimStatus,
  type ClaimValue,
  type ClaimWriteErrorCode,
  type CreatorType,
  calendarDateSchema,
  totalClaimTextLength,
} from "./claim.ts";
import {
  MAX_CLAIMS,
  MAX_HISTORY_ENTRIES,
  MAX_NOTE_LENGTH,
  MAX_STATEMENT_LENGTH,
  MAX_TOTAL_CLAIM_TEXT,
} from "./limits.ts";
import type { ClaimChange, ClaimHistoryEntry, HistoryReason, SopSession } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import type { WriteContext } from "./writeContext.ts";

/*
 * What every claim-writing path shares: the result types, the session-wide limits, the history
 * entry, and the one place a change is committed. `applyClaim` (the agent's commands) and
 * `reviewClaim` (a person's review actions) both build on it, so the rules that must be identical
 * cannot drift apart.
 */

/**
 * Who may write which claim status. This table is the structural form of the product's central
 * promise: the model proposes, and only a person confirms.
 *
 * `conflict` is in no creator's list: no caller asks for it. `detectConflicts` applies it inside the
 * write that added a disagreeing claim.
 *
 * An honest limit: with no login, the server cannot tell a person from a script. What this table
 * guarantees is that neither the agent nor a document can cause a `confirmed` claim, not that a
 * hand-built request cannot forge a session that already contains one.
 */
export const STATUSES_WRITABLE_BY: Readonly<Record<CreatorType, readonly ClaimStatus[]>> = {
  agent: AGENT_WRITABLE_STATUSES,
  // What a person's review action can produce: confirming, or stepping a claim back to what it
  // was, which can be an extracted claim.
  user: ["confirmed", "observed", "proposed", "unknown", "extracted"],
  extraction: ["extracted"],
};

export interface ClaimWriteError {
  code: ClaimWriteErrorCode;
  message: string;
}

export type ApplyClaimResult =
  | { ok: true; session: SopSession; claim: Claim; change: ClaimChange }
  | { ok: false; error: ClaimWriteError };

export function failure(code: ClaimWriteErrorCode, message: string): ApplyClaimResult {
  return { ok: false, error: { code, message } };
}

export interface SessionChanges {
  claims: Claim[];
  procedureOrder: string[];
  claimHistory: ClaimHistoryEntry[];
}

/** Refuses a result that would break a session-wide limit. Returns null when it fits. */
export function checkSessionLimits(
  session: SopSession,
  changes: SessionChanges,
): ClaimWriteError | null {
  if (changes.claims.length > MAX_CLAIMS) {
    return {
      code: "session_limit_reached",
      message: "The session already holds the maximum number of claims.",
    };
  }
  if (changes.claimHistory.length > MAX_HISTORY_ENTRIES) {
    return { code: "session_limit_reached", message: "The session history is full." };
  }
  const isGrowing = totalClaimTextLength(changes.claims) > totalClaimTextLength(session.claims);
  if (isGrowing && totalClaimTextLength(changes.claims) > MAX_TOTAL_CLAIM_TEXT) {
    return {
      code: "session_limit_reached",
      message: "The session already holds the maximum amount of claim text.",
    };
  }
  return null;
}

/**
 * Commits a change to the claims. Advisory acknowledgements are cleared on every change, so an
 * acknowledgement can never be older than the state it acknowledged.
 */
export function commit(
  session: SopSession,
  changes: SessionChanges,
  timestamp: string,
): SopSession {
  return { ...session, updatedAt: timestamp, ...changes, advisoryAcknowledgements: [] };
}

interface HistoryEntryInput {
  context: WriteContext;
  timestamp: string;
  previousClaim: Claim;
  changedBy: "agent" | "user" | "system";
  /** The user message that caused an agent's change. Null for a person's review action. */
  sourceMessageId: string | null;
  reason: HistoryReason;
  changeNote?: string | null;
}

export function historyEntryFor(input: HistoryEntryInput): ClaimHistoryEntry {
  return {
    entryId: input.context.newId(),
    claimId: input.previousClaim.claimId,
    changedAt: input.timestamp,
    changedBy: input.changedBy,
    sourceMessageId: input.sourceMessageId,
    reason: input.reason,
    changeNote: input.changeNote ?? null,
    previousClaim: input.previousClaim,
  };
}

/** The history entry for a change the agent made because of a user message. */
export function agentHistoryEntry(
  context: WriteContext,
  timestamp: string,
  previousClaim: Claim,
  sourceMessageId: string,
  reason: HistoryReason,
  changeNote: string | null = null,
): ClaimHistoryEntry {
  return historyEntryFor({
    context,
    timestamp,
    previousClaim,
    changedBy: "agent",
    sourceMessageId,
    reason,
    changeNote,
  });
}

export function buildValue(field: SopFieldName, text: string): ClaimValue {
  return { kind: field === "procedure" ? "step" : "statement", text };
}

export interface ValidatedText {
  statement: string | null;
  note: string | null;
  effectiveDate: string | null;
}

/** Trims and checks the free text and the date every command may carry. */
export function validateText(input: {
  statement: string | null;
  isStatementRequired: boolean;
  isNoteRequired: boolean;
  note: string | null;
  effectiveDate: string | null;
}): ValidatedText | ClaimWriteError {
  const statement = input.statement === null ? null : input.statement.trim();
  if (input.isStatementRequired && (statement === null || statement === "")) {
    return { code: "value_required", message: "The statement must not be empty." };
  }
  if (statement !== null && statement.length > MAX_STATEMENT_LENGTH) {
    return { code: "invalid_value", message: "The statement is too long." };
  }

  const note = input.note === null ? null : input.note.trim() || null;
  if (input.isNoteRequired && note === null) {
    return { code: "note_required", message: "A note is required. Say what is unknown or why." };
  }
  if (note !== null && note.length > MAX_NOTE_LENGTH) {
    return { code: "invalid_value", message: "The note is too long." };
  }

  if (input.effectiveDate !== null && !calendarDateSchema.safeParse(input.effectiveDate).success) {
    return {
      code: "invalid_value",
      message: "The effective date must be a calendar date, YYYY-MM-DD.",
    };
  }
  return {
    statement: statement === "" ? null : statement,
    note,
    effectiveDate: input.effectiveDate,
  };
}

export function isClaimWriteError(
  result: ValidatedText | ClaimWriteError,
): result is ClaimWriteError {
  return "code" in result;
}

export function hasUserMessage(session: SopSession, messageId: string): boolean {
  return session.messages.some((message) => message.role === "user" && message.id === messageId);
}
