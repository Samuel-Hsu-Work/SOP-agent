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
import { type ReferenceMaterial, totalReferenceTextLength } from "./referenceSchema.ts";
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
  // What a person's review action can produce: confirming, or stepping a claim back to what it was.
  user: ["confirmed", "observed", "proposed", "unknown"],
  // A document states nothing on its own: its only claim is the document side of a conflict, and
  // `conflict` is applied by conflict detection, never asked for.
  extraction: [],
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
  /** Only when the write also changes a passage: using it, declining it, or raising a conflict. */
  references?: ReferenceMaterial | undefined;
}

function totalTextLength(claims: readonly Claim[], references: ReferenceMaterial): number {
  return totalClaimTextLength(claims) + totalReferenceTextLength(references);
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
  const before = totalTextLength(session.claims, session.references);
  const after = totalTextLength(changes.claims, changes.references ?? session.references);
  if (after > before && after > MAX_TOTAL_CLAIM_TEXT) {
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
  return {
    ...session,
    updatedAt: timestamp,
    claims: changes.claims,
    procedureOrder: changes.procedureOrder,
    claimHistory: changes.claimHistory,
    references: changes.references ?? session.references,
    advisoryAcknowledgements: [],
  };
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

/** The text of the user message a write cites, or "" when there is none. */
export function userMessageText(session: SopSession, messageId: string): string {
  return session.messages.find((message) => message.id === messageId)?.text ?? "";
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Whether a text states this whole calendar date as one expression: "September 1, 2026", "Sept. 1st
 * 2026", "1 September 2026", "the 1st of Sept, 2026", 2026-09-01, 9/1/2026 or 01/09/2026. Its parts
 * found apart do not count: "the September 2026 policy, version 1" states no day.
 */
export function statesCalendarDate(text: string, calendarDate: string): boolean {
  const [year, month, day] = calendarDate.split("-");
  if (year === undefined || month === undefined || day === undefined) return false;
  const lower = text.toLowerCase();
  if (lower.includes(calendarDate)) return true;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const monthWord = `${(MONTH_NAMES[monthNumber - 1] ?? "").slice(0, 3)}[a-z]*\\.?`;
  const dayWord = `0?${dayNumber}(?:st|nd|rd|th)?`;
  const expressions = [
    `\\b${monthWord}\\s+${dayWord},?\\s+${year}\\b`,
    `\\b${dayWord}\\s+(?:of\\s+)?${monthWord},?\\s+${year}\\b`,
    `(?:^|[^0-9])0?${monthNumber}/0?${dayNumber}/${year}\\b`,
    `(?:^|[^0-9])0?${dayNumber}/0?${monthNumber}/${year}\\b`,
  ];
  return expressions.some((expression) => new RegExp(expression).test(lower));
}

/**
 * A claim's effective date, unless it is a document's date the user never stated. A claim that
 * does not rest on a document is not the document's rule, so it must not carry the document's date
 * (a manual test printed one beside a rule the user had changed). The same value alone does not
 * show that it was copied, though: a user may say their rule starts the same day. So the date stays
 * when the user's message states that whole date.
 */
export function withoutCopiedDocumentDate(
  effectiveDate: string | null,
  documentDates: readonly (string | null)[],
  userText: string,
): string | null {
  if (effectiveDate === null || !documentDates.includes(effectiveDate)) return effectiveDate;
  return statesCalendarDate(userText, effectiveDate) ? effectiveDate : null;
}
