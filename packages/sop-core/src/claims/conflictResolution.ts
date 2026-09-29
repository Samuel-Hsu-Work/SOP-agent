import { findPassage } from "../references/referenceQueries.ts";
import {
  MAX_CLAIMS_PER_PASSAGE,
  type ReferencePassage,
  updatePassage,
} from "../references/referenceSchema.ts";
import type { SopSession } from "../session.ts";
import { hasUserMessage, userMessageText } from "../sessionQueries.ts";
import { areNumbersSupported } from "../text.ts";
import type { WriteContext } from "../writeContext.ts";
import type { Claim } from "./claim.ts";
import {
  type ApplyClaimResult,
  agentHistoryEntry,
  buildValue,
  checkSessionLimits,
  commit,
  failure,
  isClaimWriteError,
  type SessionChanges,
  validateText,
  withoutCopiedDocumentDate,
} from "./claimWriteSupport.ts";
import { keepsPassageMeaning } from "./statementComparison.ts";

/**
 * The user gave the final answer to a conflict. `claimId` is either member of the pair. The answer
 * is the user's wording, not a choice between the two sides: they may side with one, blend them, or
 * say the two agree, and in every case what they said is what gets recorded.
 */
export interface ResolveConflictCommand {
  kind: "resolveConflict";
  createdByType: "agent";
  claimId: string;
  statement: string;
  note: string | null;
  effectiveDate: string | null;
  /**
   * The document side of the pair whose rule the answer states, when the user says that side is
   * right or that both sides mean the same. The answer then rests on that side's passage, so the SOP
   * keeps showing the document behind it; otherwise null. Two manual-test conflicts settled as "they
   * say the same thing" lost their document this way, and one kept the document's date without it.
   */
  documentSideClaimId: string | null;
  /** The user message that holds the final answer. Must exist in the session. */
  sourceMessageId: string;
}

export function applyResolveConflict(
  session: SopSession,
  command: ResolveConflictCommand,
  context: WriteContext,
): ApplyClaimResult {
  const target = session.claims.find((claim) => claim.claimId === command.claimId);
  if (target === undefined) {
    return failure("target_claim_not_found", "There is no active claim with that id.");
  }
  const partner = session.claims.find((claim) => claim.claimId === target.conflictsWithClaimId);
  if (target.status !== "conflict" || partner === undefined) {
    return failure(
      "status_transition_not_allowed",
      `A claim with status "${target.status}" is not in a conflict, so there is nothing to resolve.`,
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
  if (!hasUserMessage(session, command.sourceMessageId)) {
    return failure("source_message_not_found", "The claim must cite an existing user message.");
  }

  const statement = text.statement ?? "";
  const userText = userMessageText(session, command.sourceMessageId);
  let restsOn: ReferencePassage | null = null;
  // A command built before this field existed leaves it out: that answer rests on no document.
  const documentSideClaimId = command.documentSideClaimId ?? null;
  if (documentSideClaimId !== null) {
    const side = [target, partner].find((claim) => claim.claimId === documentSideClaimId);
    const passage =
      side?.source.type === "policy_document" && side.basedOnPassageId !== null
        ? findPassage(session, side.basedOnPassageId)
        : undefined;
    if (passage === undefined) {
      return failure(
        "not_a_document_side",
        "documentSideClaimId must be the id of the side of this conflict that comes from an uploaded document, or null.",
      );
    }
    if (
      !areNumbersSupported(statement, [passage.citation.quote, passage.statement, userText]) ||
      !keepsPassageMeaning(statement, passage.statement)
    ) {
      return failure(
        "statement_not_supported",
        "The answer does not keep the document side's figures, limits or negation, so it is not the document's rule. Set documentSideClaimId to null.",
      );
    }
    restsOn = passage;
  }
  // An answer that does not rest on a document is not the document's rule, so it never carries a
  // document side's date unless the user stated it.
  const effectiveDate =
    restsOn !== null
      ? (text.effectiveDate ?? restsOn.effectiveDate)
      : withoutCopiedDocumentDate(
          text.effectiveDate,
          [target, partner]
            .filter((claim) => claim.source.type === "policy_document")
            .map((claim) => claim.effectiveDate),
          userText,
        );

  const timestamp = context.now();
  // The earlier of the two, in the procedure order or otherwise in claim order, keeps its place.
  const members = [target, partner];
  const orderedMembers =
    target.field === "procedure"
      ? [...members].sort(
          (first, second) =>
            session.procedureOrder.indexOf(first.claimId) -
            session.procedureOrder.indexOf(second.claimId),
        )
      : [...members].sort(
          (first, second) =>
            session.claims.findIndex((claim) => claim.claimId === first.claimId) -
            session.claims.findIndex((claim) => claim.claimId === second.claimId),
        );
  const [keeper, dropped] = orderedMembers as [Claim, Claim];

  const resolved: Claim = {
    claimId: context.newId(),
    field: target.field,
    value: buildValue(target.field, statement),
    status: "observed",
    source: {
      type: "employee_statement",
      reference: { kind: "message", messageId: command.sourceMessageId },
    },
    authority: "observed_practice",
    effectiveDate,
    note: text.note,
    createdByType: "agent",
    conflictsWithClaimId: null,
    basedOnPassageId: restsOn?.passageId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  // A document side's passage is settled by this answer, so it never raises the conflict again. The
  // one the answer rests on is used instead, like a passage the user agreed with.
  let references = session.references;
  for (const member of [keeper, dropped]) {
    const passageId = member.source.type === "policy_document" ? member.basedOnPassageId : null;
    if (passageId === null) continue;
    references = updatePassage(references, passageId, (passage) =>
      passageId === restsOn?.passageId
        ? {
            ...passage,
            state: "used",
            claimIds:
              passage.claimIds.length >= MAX_CLAIMS_PER_PASSAGE
                ? passage.claimIds
                : [...passage.claimIds, resolved.claimId],
          }
        : { ...passage, state: "settled" },
    );
  }

  const changes: SessionChanges = {
    claims: session.claims.flatMap((claim) => {
      if (claim.claimId === keeper.claimId) return [resolved];
      if (claim.claimId === dropped.claimId) return [];
      return [claim];
    }),
    procedureOrder: session.procedureOrder
      .map((claimId) => (claimId === keeper.claimId ? resolved.claimId : claimId))
      .filter((claimId) => claimId !== dropped.claimId),
    claimHistory: [
      ...session.claimHistory,
      ...[keeper, dropped].map((previous) =>
        agentHistoryEntry(
          context,
          timestamp,
          previous,
          command.sourceMessageId,
          "conflict_resolved",
        ),
      ),
    ],
    references,
  };
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return { ok: false, error: limitError };

  return {
    ok: true,
    claim: resolved,
    change: "created",
    session: commit(session, changes, timestamp),
  };
}
