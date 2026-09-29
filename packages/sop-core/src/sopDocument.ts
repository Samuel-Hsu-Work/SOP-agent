import {
  CLAIM_STATUSES,
  type Claim,
  type ClaimStatus,
  type DocumentCitation,
  type SourceType,
  UNRESOLVED_STATUSES,
} from "./claim.ts";
import { computeGaps, type FieldGap } from "./computeGaps.ts";
import { findPassage } from "./referenceSchema.ts";
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
};

const PROVENANCE_MEANINGS: Readonly<Record<ClaimStatus, string>> = {
  confirmed: "Verified by the person who approved this SOP.",
  observed: "Stated by the person interviewed, and not verified.",
  proposed: "Suggested by the assistant, not stated by the person interviewed.",
  unknown: "The person interviewed does not know. An open item, not an instruction.",
  conflict: "Sources disagree. An open item, not an instruction.",
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
  /**
   * The document and quote behind the item: the document side of a conflict, or a passage the
   * person agreed applies. Null for anything said in the interview with no document behind it.
   */
  citation: DocumentCitation | null;
  /** The other half of a conflict, so a reader can pair the two sides. Null for any other status. */
  conflictsWithClaimId: string | null;
  /**
   * Where the item came from, worded once here so the preview and the PDF say the same thing.
   * An unknown item's note is its open-item text, so it is never repeated in this line.
   */
  sourceLine: string;
  /** True for unknown and conflict: an open item that must not read as an instruction. */
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
  /** All 13 sections, blocking fields first, empty ones included. */
  sections: SopDocumentSection[];
  /** The tags that appear in this document, each with what it means. */
  legend: { tag: string; meaning: string }[];
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
/** The citation behind a claim: its own, on a document side, or the passage the person agreed with. */
function citationFor(session: SopSession, claim: Claim): DocumentCitation | null {
  if (claim.source.reference.kind === "document") return claim.source.reference.citation;
  if (claim.basedOnPassageId === null) return null;
  return findPassage(session, claim.basedOnPassageId)?.citation ?? null;
}

/**
 * The label and date, then the note as a sentence of its own: a note is a sentence ("The rule is
 * in the store handbook."), and joined with a comma it read "from the interview, The rule...".
 *
 * A statement that rests on a passage prints no note: the document and its location already say
 * where it came from, and every note a manual test left on one only retold the interview ("From the
 * uploaded document; the user said this applies", "the same rule as the report mentioned before").
 * The note stays on the claim, and the review panel still shows it.
 */
function sourceLineFor(claim: Claim, citation: DocumentCitation | null): string {
  const hasText = claim.value !== null;
  const { reference } = claim.source;
  const restsOnPassage = reference.kind !== "document" && citation !== null;
  const label =
    reference.kind === "document"
      ? `from ${reference.citation.documentName}, ${reference.citation.location}`
      : citation !== null
        ? `from the interview, based on ${citation.documentName}, ${citation.location}`
        : claim.source.type === "agent_suggestion" && hasText && claim.note !== null
          ? claim.note
          : SOURCE_LABELS[claim.source.type];
  const lead = claim.effectiveDate === null ? label : `${label}, effective ${claim.effectiveDate}`;
  const printsNote =
    claim.source.type !== "agent_suggestion" && hasText && claim.note !== null && !restsOnPassage;
  return printsNote ? `${lead}. ${claim.note}` : lead;
}

/**
 * Pulls each conflict claim's partner to sit immediately after it, so the pair prints adjacent
 * instead of separated by an unrelated open item. Walks the original order and, for every claim
 * not yet placed, emits it and then its unplaced partner (if any); every other claim keeps its
 * original relative position. Never called for "procedure": a step keeps its slot even while
 * unresolved (`stepPositions` covers every active claim in `procedureOrder`, not only resolved
 * ones), and the preview prints every field's items as one flat, position-labelled list with no
 * resolved/open split — pulling a later step's conflict partner forward past an earlier step would
 * make the printed step numbers run out of order (Codex review finding).
 */
function withConflictPairsAdjacent(claims: Claim[]): Claim[] {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  const placed = new Set<string>();
  const result: Claim[] = [];
  for (const claim of claims) {
    if (placed.has(claim.claimId)) continue;
    result.push(claim);
    placed.add(claim.claimId);
    if (claim.conflictsWithClaimId === null) continue;
    const partner = byId.get(claim.conflictsWithClaimId);
    if (partner === undefined || placed.has(partner.claimId)) continue;
    result.push(partner);
    placed.add(partner.claimId);
  }
  return result;
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
    // Step order always wins here, even over conflict-pair adjacency (see withConflictPairsAdjacent).
    const ordered =
      definition.name === "procedure"
        ? [
            ...session.procedureOrder.flatMap((claimId) => {
              const claim = claimsById.get(claimId);
              return claim === undefined ? [] : [claim];
            }),
            ...fieldClaims.filter((claim) => !stepPositions.has(claim.claimId)),
          ]
        : withConflictPairsAdjacent(fieldClaims);

    return {
      field: definition.name,
      heading: definition.label,
      fieldClass: definition.fieldClass,
      gap,
      gapNotice: gapNoticeFor(gap),
      gapLabel: gapLabelFor(gap, isGapAcknowledged),
      isGapAcknowledged,
      items: ordered.map((claim): SopDocumentItem => {
        const citation = citationFor(session, claim);
        return {
          claimId: claim.claimId,
          position: stepPositions.get(claim.claimId) ?? null,
          text: claim.value?.text ?? null,
          status: claim.status,
          provenanceTag: PROVENANCE_TAGS[claim.status],
          sourceType: claim.source.type,
          note: claim.note,
          effectiveDate: claim.effectiveDate,
          citation,
          conflictsWithClaimId: claim.conflictsWithClaimId,
          sourceLine: sourceLineFor(claim, citation),
          isUnresolved: (UNRESOLVED_STATUSES as readonly ClaimStatus[]).includes(claim.status),
        };
      }),
    };
  });

  const present = new Set(session.claims.map((claim) => claim.status));
  return {
    title: SOP_DOCUMENT_TITLE,
    version: SOP_DOCUMENT_VERSION,
    status: session.status,
    approvedAt: session.approvedAt,
    sections,
    legend: CLAIM_STATUSES.filter((status) => present.has(status)).map((status) => ({
      tag: PROVENANCE_TAGS[status],
      meaning: PROVENANCE_MEANINGS[status],
    })),
  };
}
