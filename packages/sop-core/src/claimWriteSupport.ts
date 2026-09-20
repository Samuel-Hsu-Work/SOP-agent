import {
  AGENT_WRITABLE_STATUSES,
  type Claim,
  type ClaimStatus,
  type ClaimWriteErrorCode,
  type CreatorType,
  totalClaimTextLength,
} from "./claim.ts";
import { MAX_CLAIMS, MAX_HISTORY_ENTRIES, MAX_TOTAL_CLAIM_TEXT } from "./limits.ts";
import type { ClaimChange, ClaimHistoryEntry, HistoryReason, SopSession } from "./session.ts";
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
 * `conflict` is in no creator's list: only an internal system path (slice 5) may produce it.
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
  changedBy: "agent" | "user";
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
