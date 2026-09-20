import { computeGaps } from "./computeGaps.ts";
import type { SopSession } from "./session.ts";
import { ADVISORY_FIELD_NAMES, type AdvisoryFieldName, type SopFieldName } from "./sopFields.ts";
import type { WriteContext } from "./writeContext.ts";

/** Why a session cannot be approved yet. A session can have several at once. */
export const APPROVAL_BLOCKERS = [
  "already_approved",
  "blocking_gap",
  "advisory_gap_not_acknowledged",
  "unreviewed_suggestion",
] as const;

export type ApprovalBlocker = (typeof APPROVAL_BLOCKERS)[number];

export interface FinalizationCheck {
  canApprove: boolean;
  blockers: ApprovalBlocker[];
  /** Blocking fields that are empty or unresolved. Nothing can acknowledge these. */
  blockingGapFields: SopFieldName[];
  /** Advisory fields that are empty or unresolved right now. */
  advisoryGapFields: AdvisoryFieldName[];
  /** The advisory gaps a person has not acknowledged yet. */
  unacknowledgedAdvisoryFields: AdvisoryFieldName[];
  /** Agent suggestions that a person has neither confirmed nor rejected. */
  unreviewedSuggestionClaimIds: string[];
}

function isAdvisoryField(field: SopFieldName): field is AdvisoryFieldName {
  return (ADVISORY_FIELD_NAMES as readonly SopFieldName[]).includes(field);
}

/**
 * The single answer to "may this SOP be approved?". The approve action, the approval panel, and
 * slice 4's PDF endpoint all call it, so they cannot disagree. It is computed from the session
 * alone: no clock, no I/O.
 *
 * Three things stand in the way, and none of them is a gap rule of its own:
 * a blocking gap, an advisory gap nobody acknowledged, and an agent suggestion nobody reviewed
 * (a suggestion never creates a gap, but it must not enter an approved SOP unreviewed).
 */
export function checkFinalization(session: SopSession): FinalizationCheck {
  const report = computeGaps(session);
  const blockingGapFields = report.gaps
    .filter((entry) => entry.gap?.severity === "blocking")
    .map((entry) => entry.field);
  const advisoryGapFields = report.gaps
    .filter((entry) => entry.gap?.severity === "advisory")
    .map((entry) => entry.field)
    .filter(isAdvisoryField);

  const acknowledged = new Set(session.advisoryAcknowledgements.map((entry) => entry.field));
  const unacknowledgedAdvisoryFields = advisoryGapFields.filter(
    (field) => !acknowledged.has(field),
  );
  const unreviewedSuggestionClaimIds = session.claims
    .filter((claim) => claim.status === "proposed")
    .map((claim) => claim.claimId);

  const blockers: ApprovalBlocker[] = [];
  if (session.status === "approved") blockers.push("already_approved");
  if (blockingGapFields.length > 0) blockers.push("blocking_gap");
  if (unacknowledgedAdvisoryFields.length > 0) blockers.push("advisory_gap_not_acknowledged");
  if (unreviewedSuggestionClaimIds.length > 0) blockers.push("unreviewed_suggestion");

  return {
    canApprove: blockers.length === 0,
    blockers,
    blockingGapFields,
    advisoryGapFields,
    unacknowledgedAdvisoryFields,
    unreviewedSuggestionClaimIds,
  };
}

export const ACKNOWLEDGEMENT_ERROR_CODES = [
  "session_approved",
  "not_an_advisory_field",
  "no_gap_to_acknowledge",
] as const;

export type AcknowledgementErrorCode = (typeof ACKNOWLEDGEMENT_ERROR_CODES)[number];

export type SetAcknowledgementResult =
  | { ok: true; session: SopSession; change: "updated" | "unchanged" }
  | { ok: false; error: { code: AcknowledgementErrorCode; message: string } };

/**
 * Records that a person saw an advisory gap and accepts it, or takes that back. Only advisory
 * fields can be acknowledged, only while they have a gap, and only on a draft. Any change to a
 * claim clears every acknowledgement (see `commit`), so one can never outlive what it covered.
 */
export function setAdvisoryAcknowledgement(
  session: SopSession,
  input: { field: SopFieldName; acknowledged: boolean },
  context: WriteContext,
): SetAcknowledgementResult {
  // Checked first, like every write.
  if (session.status === "approved") {
    return {
      ok: false,
      error: {
        code: "session_approved",
        message: "The SOP is approved, so it can no longer be changed.",
      },
    };
  }
  const { field } = input;
  if (!isAdvisoryField(field)) {
    return {
      ok: false,
      error: {
        code: "not_an_advisory_field",
        message: "Only an advisory gap can be acknowledged. A blocking gap has to be filled.",
      },
    };
  }

  const isAcknowledged = session.advisoryAcknowledgements.some((entry) => entry.field === field);
  if (input.acknowledged === isAcknowledged) return { ok: true, session, change: "unchanged" };

  const timestamp = context.now();
  if (!input.acknowledged) {
    return {
      ok: true,
      change: "updated",
      session: {
        ...session,
        updatedAt: timestamp,
        advisoryAcknowledgements: session.advisoryAcknowledgements.filter(
          (entry) => entry.field !== field,
        ),
      },
    };
  }

  if (!checkFinalization(session).advisoryGapFields.includes(field)) {
    return {
      ok: false,
      error: {
        code: "no_gap_to_acknowledge",
        message: "That field has no gap, so there is nothing to acknowledge.",
      },
    };
  }
  return {
    ok: true,
    change: "updated",
    session: {
      ...session,
      updatedAt: timestamp,
      advisoryAcknowledgements: [
        ...session.advisoryAcknowledgements,
        { field, acknowledgedAt: timestamp },
      ],
    },
  };
}

export const APPROVAL_ERROR_CODES = [
  "session_approved",
  "blocking_gaps_remaining",
  "advisory_gaps_unacknowledged",
  "suggestions_unreviewed",
] as const;

export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[number];

export type ApproveSessionResult =
  | { ok: true; session: SopSession }
  | {
      ok: false;
      error: { code: ApprovalErrorCode; message: string; check: FinalizationCheck };
    };

const APPROVAL_ERRORS: Record<ApprovalBlocker, { code: ApprovalErrorCode; message: string }> = {
  already_approved: {
    code: "session_approved",
    message: "The SOP is already approved.",
  },
  blocking_gap: {
    code: "blocking_gaps_remaining",
    message: "The SOP cannot be approved while a blocking gap remains.",
  },
  advisory_gap_not_acknowledged: {
    code: "advisory_gaps_unacknowledged",
    message: "Every remaining advisory gap must be acknowledged before approval.",
  },
  unreviewed_suggestion: {
    code: "suggestions_unreviewed",
    message: "Every suggestion must be confirmed or rejected before approval.",
  },
};

/**
 * Approves the SOP: status and approval time change together, or not at all. The session is
 * immutable afterwards, because `applyClaim` and the acknowledgement function refuse an approved
 * session first. This runs in the browser; with no login, what it guarantees is the shape of an
 * approval, not that a person clicked. Slice 4's PDF endpoint calls `checkFinalization` itself.
 */
export function approveSession(session: SopSession, context: WriteContext): ApproveSessionResult {
  const check = checkFinalization(session);
  const firstBlocker = check.blockers[0];
  if (firstBlocker !== undefined) {
    return { ok: false, error: { ...APPROVAL_ERRORS[firstBlocker], check } };
  }
  const timestamp = context.now();
  return {
    ok: true,
    session: { ...session, status: "approved", approvedAt: timestamp, updatedAt: timestamp },
  };
}
