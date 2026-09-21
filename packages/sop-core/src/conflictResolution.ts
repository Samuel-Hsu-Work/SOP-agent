import type { Claim } from "./claim.ts";
import {
  type ApplyClaimResult,
  agentHistoryEntry,
  buildValue,
  checkSessionLimits,
  commit,
  failure,
  hasUserMessage,
  isClaimWriteError,
  type SessionChanges,
  validateText,
} from "./claimWriteSupport.ts";
import type { SopSession } from "./session.ts";
import type { WriteContext } from "./writeContext.ts";

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
    value: buildValue(target.field, text.statement ?? ""),
    status: "observed",
    source: {
      type: "employee_statement",
      reference: { kind: "message", messageId: command.sourceMessageId },
    },
    authority: "observed_practice",
    effectiveDate: text.effectiveDate,
    note: text.note,
    createdByType: "agent",
    conflictsWithClaimId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

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
