import { type ClaimStatus, UNRESOLVED_STATUSES } from "./claim.ts";
import type { SopSession } from "./session.ts";
import { type FieldClass, SOP_FIELDS, type SopFieldName } from "./sopFields.ts";

/**
 * A field's state comes from its claims:
 * - empty: it has no claims;
 * - unresolved: at least one claim is `unknown`, `conflict`, or `extracted`;
 * - resolved: anything else. `observed` and `proposed` claims never leave a field unresolved.
 */
export type FieldState = "empty" | "unresolved" | "resolved";

export interface FieldGap {
  /** Comes from the field's class, never from a claim's status. */
  severity: FieldClass;
  reason: "empty" | "unresolved";
}

export interface FieldReadiness {
  field: SopFieldName;
  label: string;
  fieldClass: FieldClass;
  state: FieldState;
  claimCount: number;
  unresolvedClaimIds: string[];
  gap: FieldGap | null;
  /**
   * Whether the agent may still ask about this field. A gap the user already answered "I don't
   * know" to, or one that only awaits a document review, is not askable, so the agent does not
   * pester. An empty field or one with a conflict is.
   */
  askable: boolean;
}

export interface GapReport {
  /** All 13 fields, blocking first. The readiness panel reads this. */
  fields: FieldReadiness[];
  /** The fields that have a gap, in the same order. The agent's prompt reads this. */
  gaps: FieldReadiness[];
  blockingGapCount: number;
  advisoryGapCount: number;
}

function isUnresolved(status: ClaimStatus): boolean {
  return (UNRESOLVED_STATUSES as readonly ClaimStatus[]).includes(status);
}

/**
 * Deterministic and pure: no clock, no I/O, no model. The browser and the API both call it, so the
 * readiness panel and the agent's prompt cannot disagree about what is missing.
 */
export function computeGaps(session: SopSession): GapReport {
  const fields = SOP_FIELDS.map((definition): FieldReadiness => {
    const claims = session.claims.filter((claim) => claim.field === definition.name);
    const unresolvedClaims = claims.filter((claim) => isUnresolved(claim.status));
    const unresolvedClaimIds = unresolvedClaims.map((claim) => claim.claimId);

    const state: FieldState =
      claims.length === 0 ? "empty" : unresolvedClaimIds.length > 0 ? "unresolved" : "resolved";
    const gap: FieldGap | null =
      state === "resolved" ? null : { severity: definition.fieldClass, reason: state };

    const isOnlyUnknownOrExtracted = unresolvedClaims.every(
      (claim) => claim.status === "unknown" || claim.status === "extracted",
    );
    const askable = gap !== null && (state === "empty" || !isOnlyUnknownOrExtracted);

    return {
      field: definition.name,
      label: definition.label,
      fieldClass: definition.fieldClass,
      state,
      claimCount: claims.length,
      unresolvedClaimIds,
      gap,
      askable,
    };
  });

  const gaps = fields.filter((readiness) => readiness.gap !== null);
  return {
    fields,
    gaps,
    blockingGapCount: gaps.filter((readiness) => readiness.gap?.severity === "blocking").length,
    advisoryGapCount: gaps.filter((readiness) => readiness.gap?.severity === "advisory").length,
  };
}
