import {
  CLAIM_STATUSES,
  type Claim,
  type ClaimStatus,
  type DocumentCitation,
  type SourceType,
  UNRESOLVED_STATUSES,
} from "./claim.ts";
import { computeGaps, type FieldGap } from "./computeGaps.ts";
import type { SessionStatus, SopSession } from "./session.ts";
import { type FieldClass, SOP_FIELDS, type SopFieldName } from "./sopFields.ts";

/** The title and version are fixed in v1: there is no reliable process name to derive a title from. */
export const SOP_DOCUMENT_TITLE = "Standard Operating Procedure";
export const SOP_DOCUMENT_VERSION = "1.0";

/**
 * The tag printed beside every claim, so a reader can see how much weight it carries. A tag is the
 * claim's status name in brackets, which lets the PDF be read back and matched to the claims.
 */
export const PROVENANCE_TAGS: Readonly<Record<ClaimStatus, string>> = {
  confirmed: "[confirmed]",
  observed: "[observed]",
  proposed: "[proposed]",
  unknown: "[unknown]",
  conflict: "[conflict]",
  extracted: "[extracted]",
};

const PROVENANCE_MEANINGS: Readonly<Record<ClaimStatus, string>> = {
  confirmed: "Verified by the person who approved this SOP.",
  observed: "Stated by the person interviewed, and not verified.",
  proposed: "Suggested by the assistant, not stated by the person interviewed.",
  unknown: "The person interviewed does not know. An open item, not an instruction.",
  conflict: "Sources disagree. An open item, not an instruction.",
  extracted: "Read from a document and not checked yet. An open item, not an instruction.",
};

export type GapLabel = "blocking gap" | "advisory gap" | "gap acknowledged";

export interface SopDocumentItem {
  claimId: string;
  /** 1-based step number for a procedure step, otherwise null. */
  position: number | null;
  /** Null for an unknown claim, which has no value. */
  text: string | null;
  status: ClaimStatus;
  provenanceTag: string;
  sourceType: SourceType;
  note: string | null;
  effectiveDate: string | null;
  /** The document and quote behind a claim read from a document. Null for anything said in the interview. */
  citation: DocumentCitation | null;
  /** The other half of a conflict, so a reader can pair the two sides. Null for any other status. */
  conflictsWithClaimId: string | null;
  /**
   * Where the item came from, worded once here so the preview and the PDF say the same thing.
   * An unknown item's note is its open-item text, so it is never repeated in this line.
   */
  sourceLine: string;
  /** True for unknown, conflict and extracted: an open item that must not read as an instruction. */
  isUnresolved: boolean;
}

export interface SopDocumentSection {
  field: SopFieldName;
  heading: string;
  fieldClass: FieldClass;
  gap: FieldGap | null;
  /** A plain sentence for a section that is empty or still open. Null when there is no gap. */
  gapNotice: string | null;
  /** The short flag printed beside the heading. Null when there is no gap. */
  gapLabel: GapLabel | null;
  /** An advisory gap that the approver acknowledged. Always false for a blocking one. */
  isGapAcknowledged: boolean;
  items: SopDocumentItem[];
}

export interface SopDocument {
  title: string;
  version: string;
  status: SessionStatus;
  approvedAt: string | null;
  /**
   * What the approval does and does not mean, for the document-control block. Null for a draft.
   * Approval is the interviewed person's sign-off, so a statement they made and never confirmed
   * is still their own word, and the document says so instead of implying it was verified.
   */
  approvalBasis: string | null;
  /**
   * The Governance section's stated items, repeated in the document-control block so the owner and
   * the review cycle are visible at the top. The section itself still prints them with their tags.
   */
  governanceSummary: string[];
  /** All 13 sections, blocking fields first, empty ones included. */
  sections: SopDocumentSection[];
  /** The tags that appear in this document, each with what it means. */
  legend: { tag: string; meaning: string }[];
  counts: {
    blockingGaps: number;
    advisoryGaps: number;
    confirmedClaims: number;
    totalClaims: number;
  };
}

function approvalBasisFor(
  status: SessionStatus,
  counts: { confirmedClaims: number; totalClaims: number },
): string | null {
  if (status !== "approved") return null;
  const { confirmedClaims, totalClaims } = counts;
  if (confirmedClaims === totalClaims) {
    return "Approved by the person interviewed. Every claim was individually confirmed.";
  }
  if (confirmedClaims === 0) {
    return "Approved by the person interviewed. No claim was individually confirmed: the statements below are that person's own words and were not independently verified.";
  }
  return `Approved by the person interviewed. ${confirmedClaims} of ${totalClaims} claims were individually confirmed; the others are that person's own statements and were not independently verified.`;
}

function gapNoticeFor(gap: FieldGap | null): string | null {
  if (gap === null) return null;
  return gap.reason === "empty"
    ? "Nothing has been recorded for this section."
    : "Part of this section is still open.";
}

function gapLabelFor(gap: FieldGap | null, isAcknowledged: boolean): GapLabel | null {
  if (gap === null) return null;
  if (gap.severity === "blocking") return "blocking gap";
  return isAcknowledged ? "gap acknowledged" : "advisory gap";
}

const SOURCE_LABELS: Readonly<Record<SourceType, string>> = {
  employee_statement: "from the interview",
  agent_suggestion: "suggested by the assistant",
  policy_document: "from an uploaded document",
};

/**
 * A suggestion's note already says who suggested it and why, so it replaces the generic label
 * instead of following it (which used to print the same sentence twice). A statement keeps its
 * label and appends the note. Decided by the claim's shape, never by comparing text.
 */
function sourceLineFor(claim: Claim): string {
  const hasText = claim.value !== null;
  const { reference } = claim.source;
  const noteReplacesLabel =
    claim.source.type === "agent_suggestion" && hasText && claim.note !== null;
  const label =
    reference.kind === "document"
      ? `from ${reference.citation.documentName}, ${reference.citation.location}`
      : noteReplacesLabel
        ? claim.note
        : SOURCE_LABELS[claim.source.type];
  const parts = [label];
  if (claim.effectiveDate !== null) parts.push(`effective ${claim.effectiveDate}`);
  if (claim.source.type !== "agent_suggestion" && hasText && claim.note !== null) {
    parts.push(claim.note);
  }
  return parts.join(", ");
}

/**
 * Turns the claims into the document that the on-screen preview shows and that slice 4's PDF will
 * print. Pure and clock-free, so it renders the same every time, and the preview and the PDF
 * cannot disagree about order or tags. Every active claim is printed, suggestions and unknowns
 * included, each tagged: leaving them out would make an approved SOP look more certain than the
 * state it was built from. Withdrawn claims and the history are not part of the document.
 */
export function buildSopDocument(session: SopSession): SopDocument {
  const report = computeGaps(session);
  const claimsById = new Map(session.claims.map((claim) => [claim.claimId, claim]));
  const stepPositions = new Map(
    session.procedureOrder.map((claimId, index) => [claimId, index + 1]),
  );
  const acknowledged = new Set(session.advisoryAcknowledgements.map((entry) => entry.field));

  const sections = SOP_FIELDS.map((definition): SopDocumentSection => {
    const readiness = report.fields.find((entry) => entry.field === definition.name);
    const gap = readiness?.gap ?? null;

    const isGapAcknowledged =
      gap?.severity === "advisory" &&
      (acknowledged as ReadonlySet<SopFieldName>).has(definition.name);

    const fieldClaims = session.claims.filter((claim) => claim.field === definition.name);
    // A procedure reads in step order. A whole-procedure unknown has no slot, so it goes last.
    const ordered =
      definition.name === "procedure"
        ? [
            ...session.procedureOrder.flatMap((claimId) => {
              const claim = claimsById.get(claimId);
              return claim === undefined ? [] : [claim];
            }),
            ...fieldClaims.filter((claim) => !stepPositions.has(claim.claimId)),
          ]
        : fieldClaims;

    return {
      field: definition.name,
      heading: definition.label,
      fieldClass: definition.fieldClass,
      gap,
      gapNotice: gapNoticeFor(gap),
      gapLabel: gapLabelFor(gap, isGapAcknowledged),
      isGapAcknowledged,
      items: ordered.map(
        (claim): SopDocumentItem => ({
          claimId: claim.claimId,
          position: stepPositions.get(claim.claimId) ?? null,
          text: claim.value?.text ?? null,
          status: claim.status,
          provenanceTag: PROVENANCE_TAGS[claim.status],
          sourceType: claim.source.type,
          note: claim.note,
          effectiveDate: claim.effectiveDate,
          citation:
            claim.source.reference.kind === "document" ? claim.source.reference.citation : null,
          conflictsWithClaimId: claim.conflictsWithClaimId,
          sourceLine: sourceLineFor(claim),
          isUnresolved: (UNRESOLVED_STATUSES as readonly ClaimStatus[]).includes(claim.status),
        }),
      ),
    };
  });

  const present = new Set(session.claims.map((claim) => claim.status));
  const counts = {
    blockingGaps: report.blockingGapCount,
    advisoryGaps: report.advisoryGapCount,
    confirmedClaims: session.claims.filter((claim) => claim.status === "confirmed").length,
    totalClaims: session.claims.length,
  };
  return {
    title: SOP_DOCUMENT_TITLE,
    version: SOP_DOCUMENT_VERSION,
    status: session.status,
    approvedAt: session.approvedAt,
    approvalBasis: approvalBasisFor(session.status, counts),
    governanceSummary: (sections.find((section) => section.field === "governance")?.items ?? [])
      .filter((item) => !item.isUnresolved && item.text !== null)
      .map((item) => item.text ?? ""),
    sections,
    legend: CLAIM_STATUSES.filter((status) => present.has(status)).map((status) => ({
      tag: PROVENANCE_TAGS[status],
      meaning: PROVENANCE_MEANINGS[status],
    })),
    counts,
  };
}
