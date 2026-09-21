import { type Claim, type DocumentCitation, documentCitationSchema } from "./claim.ts";
import {
  type ApplyClaimResult,
  buildValue,
  checkSessionLimits,
  commit,
  failure,
  isClaimWriteError,
  type SessionChanges,
  validateText,
} from "./claimWriteSupport.ts";
import type { SopSession } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import { normalizeStatement } from "./text.ts";
import type { WriteContext } from "./writeContext.ts";

/**
 * A rule read from an uploaded document. The API has already proved that `citation.quote` exists in
 * the cited section; this command carries no status, source type, authority or creator, because
 * those are derived here and nowhere else. It is not one of the agent's commands, so the model
 * cannot build it, exactly as it cannot build a confirmation.
 */
export interface IngestExtractedClaimCommand {
  kind: "ingestExtracted";
  createdByType: "extraction";
  field: SopFieldName;
  /** The extraction model's one-sentence summary of the rule. */
  statement: string;
  citation: DocumentCitation;
  /** Read from the document and format-checked only: the quote check cannot prove a date. */
  effectiveDate: string | null;
  note: string | null;
}

/** The claim reads the same rule from the same place as the command does. */
function isSameRuleFromSamePlace(
  claim: Claim,
  command: IngestExtractedClaimCommand,
  normalizedStatement: string,
): boolean {
  return (
    claim.field === command.field &&
    claim.source.reference.kind === "document" &&
    claim.source.reference.citation.documentName === command.citation.documentName &&
    claim.source.reference.citation.location === command.citation.location &&
    claim.value !== null &&
    normalizeStatement(claim.value.text) === normalizedStatement
  );
}

/**
 * The same rule from the same place was already added: it is still there whatever its status now,
 * a person rejected it in review, or the user's final answer in a conflict replaced it. A second
 * upload of the same file must not bring back a rule that was turned down or already answered, or
 * the rejection would mean nothing and the same conflict would be raised again.
 */
function findIngestedDuplicate(
  session: SopSession,
  command: IngestExtractedClaimCommand,
  statement: string,
): Claim | undefined {
  const normalized = normalizeStatement(statement);
  const active = session.claims.find((claim) =>
    isSameRuleFromSamePlace(claim, command, normalized),
  );
  if (active !== undefined) return active;
  return session.claimHistory.find(
    (entry) =>
      ((entry.reason === "rejected" && entry.previousClaim.status === "extracted") ||
        (entry.reason === "conflict_resolved" && entry.previousClaim.status === "conflict")) &&
      isSameRuleFromSamePlace(entry.previousClaim, command, normalized),
  )?.previousClaim;
}

export function applyIngestExtracted(
  session: SopSession,
  command: IngestExtractedClaimCommand,
  context: WriteContext,
): ApplyClaimResult {
  // The type already says so; this stops a hand-built command from claiming another creator.
  if (command.createdByType !== "extraction") {
    return failure(
      "status_not_allowed_for_creator",
      "Only document extraction can write an extracted claim.",
    );
  }
  const text = validateText({
    statement: command.statement,
    isStatementRequired: true,
    isNoteRequired: false,
    note: command.note,
    effectiveDate: command.effectiveDate,
  });
  if (isClaimWriteError(text)) return { ok: false, error: text };
  const statement = text.statement ?? "";

  const citation = documentCitationSchema.safeParse(command.citation);
  if (!citation.success) {
    return failure("invalid_value", "The citation needs a document name, a location and a quote.");
  }

  // A second upload of the same file adds nothing, and neither does a rule a person rejected.
  const duplicate = findIngestedDuplicate(session, command, statement);
  if (duplicate !== undefined) return { ok: true, session, claim: duplicate, change: "unchanged" };

  const timestamp = context.now();
  const claim: Claim = {
    claimId: context.newId(),
    field: command.field,
    value: buildValue(command.field, statement),
    status: "extracted",
    source: { type: "policy_document", reference: { kind: "document", citation: citation.data } },
    authority: "official_policy",
    effectiveDate: text.effectiveDate,
    note: text.note,
    createdByType: "extraction",
    conflictsWithClaimId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  // Every procedure step needs a place in the order; an extracted step joins the end.
  const changes: SessionChanges = {
    claims: [...session.claims, claim],
    procedureOrder:
      command.field === "procedure"
        ? [...session.procedureOrder, claim.claimId]
        : session.procedureOrder,
    claimHistory: session.claimHistory,
  };
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return { ok: false, error: limitError };

  return { ok: true, claim, change: "created", session: commit(session, changes, timestamp) };
}
