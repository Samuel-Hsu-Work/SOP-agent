import {
  type AdvisoryFieldName,
  checkFinalization,
  SOP_FIELDS,
  type SopFieldName,
  type SopSession,
} from "@sop-agent/sop-core";

export interface AdvisoryChecklistItem {
  field: AdvisoryFieldName;
  label: string;
  isAcknowledged: boolean;
}

export interface UnreviewedSuggestion {
  claimId: string;
  fieldLabel: string;
  text: string | null;
}

/** Everything the approval area shows, decided in one pure function so it can be tested without a DOM. */
export interface ApprovalView {
  isApproved: boolean;
  approvedAt: string | null;
  canApprove: boolean;
  /** Plain sentences, one per thing in the way. Empty when the SOP can be approved or already is. */
  reasons: string[];
  blockingGapLabels: string[];
  /** The advisory gaps that exist right now, each with its checkbox state. */
  advisoryChecklist: AdvisoryChecklistItem[];
  unreviewedSuggestions: UnreviewedSuggestion[];
}

const LABELS: Readonly<Record<SopFieldName, string>> = Object.fromEntries(
  SOP_FIELDS.map((field) => [field.name, field.label]),
) as Record<SopFieldName, string>;

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function listOf(labels: readonly string[]): string {
  return labels.join(", ");
}

export function buildApprovalView(session: SopSession): ApprovalView {
  const check = checkFinalization(session);
  const acknowledged = new Set<SopFieldName>(
    session.advisoryAcknowledgements.map((entry) => entry.field),
  );
  const blockingGapLabels = check.blockingGapFields.map((field) => LABELS[field]);

  const reasons: string[] = [];
  if (check.blockingGapFields.length > 0) {
    const count = check.blockingGapFields.length;
    reasons.push(
      `${count} blocking ${plural(count, "gap remains", "gaps remain")}: ${listOf(blockingGapLabels)}.`,
    );
  }
  if (check.unreviewedSuggestionClaimIds.length > 0) {
    const count = check.unreviewedSuggestionClaimIds.length;
    reasons.push(
      `${count} ${plural(count, "suggestion needs", "suggestions need")} to be confirmed or rejected.`,
    );
  }
  if (check.unacknowledgedAdvisoryFields.length > 0) {
    const count = check.unacknowledgedAdvisoryFields.length;
    reasons.push(
      `${count} advisory ${plural(count, "gap needs", "gaps need")} to be acknowledged: ${listOf(
        check.unacknowledgedAdvisoryFields.map((field) => LABELS[field]),
      )}.`,
    );
  }

  const claimsById = new Map(session.claims.map((claim) => [claim.claimId, claim]));
  return {
    isApproved: session.status === "approved",
    approvedAt: session.approvedAt,
    canApprove: check.canApprove,
    reasons: session.status === "approved" ? [] : reasons,
    blockingGapLabels,
    advisoryChecklist: check.advisoryGapFields.map((field) => ({
      field,
      label: LABELS[field],
      isAcknowledged: acknowledged.has(field),
    })),
    unreviewedSuggestions: check.unreviewedSuggestionClaimIds.flatMap((claimId) => {
      const claim = claimsById.get(claimId);
      return claim === undefined
        ? []
        : [{ claimId, fieldLabel: LABELS[claim.field], text: claim.value?.text ?? null }];
    }),
  };
}
