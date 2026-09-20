import {
  type Claim,
  type ClaimHistoryEntry,
  type ClaimStatus,
  computeGaps,
  type FieldClass,
  type FieldGap,
  type FieldState,
  type HistoryReason,
  reviewActionsFor,
  type SopFieldName,
  type SopSession,
} from "@sop-agent/sop-core";

const STATUS_LABELS: Record<ClaimStatus, string> = {
  confirmed: "Confirmed",
  observed: "Stated by you",
  proposed: "Suggested by the agent",
  unknown: "Unknown",
  conflict: "Conflict",
  extracted: "Extracted from a document",
};

const HISTORY_REASON_LABELS: Record<HistoryReason, string> = {
  corrected: "Corrected",
  answered_unknown: "Answered",
  marked_unknown: "Marked unknown",
  withdrawn: "Removed",
  confirmed: "Confirmed",
  rejected: "Rejected",
};

/** An earlier version of a claim, as shown under the claim that replaced it or in the removed list. */
export interface ClaimVersionView {
  entryId: string;
  reasonLabel: string;
  statusLabel: string;
  /** Null when that version was an unknown. */
  text: string | null;
  note: string | null;
  /** The date that version took effect, so a change to the date alone is visible. */
  effectiveDate: string | null;
  /** Why it was removed, for a withdrawal. */
  changeNote: string | null;
  changedAt: string;
}

export interface ClaimView {
  claimId: string;
  /** 1-based step number for a procedure step, otherwise null. */
  stepNumber: number | null;
  status: ClaimStatus;
  statusLabel: string;
  /** Null for an unknown claim, which has no value. */
  text: string | null;
  note: string | null;
  effectiveDate: string | null;
  /** What the review panel offers for this claim. Read from the same predicate as the write path. */
  canConfirm: boolean;
  canReject: boolean;
  /** "Withdraw confirmation" for a confirmed claim, "Reject" otherwise. Same action, honest name. */
  rejectLabel: string;
  /** Earlier versions of this claim, newest first. */
  previousVersions: ClaimVersionView[];
}

export interface FieldClaimsView {
  field: SopFieldName;
  label: string;
  fieldClass: FieldClass;
  state: FieldState;
  gap: FieldGap | null;
  claims: ClaimView[];
  /**
   * True when the field has claims and every one is the agent's own suggestion. Such a field has no
   * gap, by the scope rules, but nobody has stated it, so the panel must not call it complete.
   */
  isSuggestionOnly: boolean;
  /** Claims that are no longer active, for example withdrawn ones, newest first. */
  removedClaims: ClaimVersionView[];
}

function toVersionView(entry: ClaimHistoryEntry): ClaimVersionView {
  return {
    entryId: entry.entryId,
    reasonLabel: HISTORY_REASON_LABELS[entry.reason],
    statusLabel: STATUS_LABELS[entry.previousClaim.status],
    text: entry.previousClaim.value?.text ?? null,
    note: entry.previousClaim.note,
    effectiveDate: entry.previousClaim.effectiveDate,
    changeNote: entry.changeNote,
    changedAt: entry.changedAt,
  };
}

function newestFirst(entries: readonly ClaimHistoryEntry[]): ClaimHistoryEntry[] {
  // Entries are appended in order, so reversing gives newest first without comparing timestamps.
  return [...entries].reverse();
}

/**
 * The read-only claims view, one entry per SOP field in readiness order. Pure: the same session
 * always gives the same view, so it is tested without a DOM. A procedure lists its steps by their
 * real order; every other field lists its claims as recorded.
 */
export function buildClaimsView(session: SopSession): FieldClaimsView[] {
  const activeIds = new Set(session.claims.map((claim) => claim.claimId));
  const stepNumbers = new Map(session.procedureOrder.map((claimId, index) => [claimId, index + 1]));

  const orderClaims = (claims: Claim[]): Claim[] =>
    [...claims].sort((first, second) => {
      const firstStep = stepNumbers.get(first.claimId) ?? Number.MAX_SAFE_INTEGER;
      const secondStep = stepNumbers.get(second.claimId) ?? Number.MAX_SAFE_INTEGER;
      return firstStep - secondStep;
    });

  return computeGaps(session).fields.map((readiness) => {
    const claims = orderClaims(session.claims.filter((claim) => claim.field === readiness.field));
    const fieldHistory = session.claimHistory.filter(
      (entry) => entry.previousClaim.field === readiness.field,
    );

    return {
      field: readiness.field,
      label: readiness.label,
      fieldClass: readiness.fieldClass,
      state: readiness.state,
      gap: readiness.gap,
      isSuggestionOnly: claims.length > 0 && claims.every((claim) => claim.status === "proposed"),
      claims: claims.map((claim): ClaimView => {
        return {
          claimId: claim.claimId,
          stepNumber: stepNumbers.get(claim.claimId) ?? null,
          status: claim.status,
          statusLabel: STATUS_LABELS[claim.status],
          text: claim.value?.text ?? null,
          note: claim.note,
          effectiveDate: claim.effectiveDate,
          ...reviewActionsFor(claim),
          rejectLabel: claim.status === "confirmed" ? "Withdraw confirmation" : "Reject",
          previousVersions: newestFirst(
            fieldHistory.filter((entry) => entry.claimId === claim.claimId),
          ).map(toVersionView),
        };
      }),
      removedClaims: newestFirst(fieldHistory.filter((entry) => !activeIds.has(entry.claimId))).map(
        toVersionView,
      ),
    };
  });
}
