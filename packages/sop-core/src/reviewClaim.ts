import type { AuthorityTier, Claim, ClaimStatus } from "./claim.ts";
import {
  type ApplyClaimResult,
  checkSessionLimits,
  commit,
  failure,
  historyEntryFor,
  type SessionChanges,
  STATUSES_WRITABLE_BY,
} from "./claimWriteSupport.ts";
import type { HistoryReason, SopSession } from "./session.ts";
import type { WriteContext } from "./writeContext.ts";

/**
 * A person's review of one claim. Review never edits what a claim says: confirming verifies it,
 * and rejecting undoes one step of endorsement. Changing the words goes through the agent.
 */
export interface ReviewClaimCommand {
  kind: "confirm" | "reject";
  createdByType: "user";
  claimId: string;
}

/** The note a rejected extracted claim keeps, since it becomes an unknown with no value. */
export const REJECTED_NOTE = "A rule read from a document was rejected in review.";

const CONFIRMABLE: readonly ClaimStatus[] = ["observed", "proposed", "extracted"];
const REJECTABLE: readonly ClaimStatus[] = ["proposed", "confirmed", "extracted"];

/**
 * Which review actions a claim offers. The panel and the write path both read this, so a button
 * that is shown is a button that works. `observed` has no reject: it is the user's own words, and
 * changing them is a chat correction. A confirmed claim has no confirm: it already is.
 */
export function reviewActionsFor(claim: Claim): { canConfirm: boolean; canReject: boolean } {
  return {
    canConfirm: CONFIRMABLE.includes(claim.status),
    canReject: REJECTABLE.includes(claim.status),
  };
}

/** A person who vouches for a suggestion makes it as strong as something they stated themselves. */
function authorityAfterConfirming(authority: AuthorityTier): AuthorityTier {
  return authority === "proposed" || authority === "unknown" ? "observed_practice" : authority;
}

function reviewHistory(
  session: SopSession,
  previousClaim: Claim,
  reason: HistoryReason,
  timestamp: string,
  context: WriteContext,
) {
  return [
    ...session.claimHistory,
    historyEntryFor({
      context,
      timestamp,
      previousClaim,
      changedBy: "user",
      sourceMessageId: null,
      reason,
    }),
  ];
}

/**
 * What a confirmed claim was before a person confirmed it. The confirmation left the whole
 * previous claim in the history, so that is where to read it: a claim confirmed from an extracted
 * one must go back to extracted, with its extraction authority, and its source alone cannot say so.
 * A confirmed claim with no such entry (a session built by hand) falls back to what its source
 * implies, which is right for the three claims a person can make, an agent can suggest, or a document can hold.
 */
function statusBeforeConfirming(
  session: SopSession,
  confirmed: Claim,
): { status: ClaimStatus; authority: AuthorityTier } {
  const confirmation = [...session.claimHistory]
    .reverse()
    .find((entry) => entry.claimId === confirmed.claimId && entry.reason === "confirmed");
  if (confirmation !== undefined) {
    return {
      status: confirmation.previousClaim.status,
      authority: confirmation.previousClaim.authority,
    };
  }
  switch (confirmed.source.type) {
    case "agent_suggestion":
      return { status: "proposed", authority: "proposed" };
    case "policy_document":
      return { status: "extracted", authority: "official_policy" };
    case "employee_statement":
      return { status: "observed", authority: "observed_practice" };
  }
}

function replaceClaim(session: SopSession, claim: Claim): Claim[] {
  return session.claims.map((existing) => (existing.claimId === claim.claimId ? claim : existing));
}

function finish(
  session: SopSession,
  changes: SessionChanges,
  claim: Claim,
  change: "updated" | "withdrawn",
  timestamp: string,
): ApplyClaimResult {
  // The permission table is the one place that says what a person's review may produce.
  if (change === "updated" && !STATUSES_WRITABLE_BY.user.includes(claim.status)) {
    return failure(
      "status_not_allowed_for_creator",
      `A review action cannot produce a claim with status "${claim.status}".`,
    );
  }
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return { ok: false, error: limitError };
  return { ok: true, claim, change, session: commit(session, changes, timestamp) };
}

function confirmClaim(
  session: SopSession,
  previous: Claim,
  context: WriteContext,
): ApplyClaimResult {
  if (previous.status === "confirmed") {
    return { ok: true, session, claim: previous, change: "unchanged" };
  }
  if (!CONFIRMABLE.includes(previous.status)) {
    return failure(
      "review_action_not_allowed",
      `A claim with status "${previous.status}" cannot be confirmed.`,
    );
  }

  // Confirming changes the status, and the authority only for an unreviewed suggestion. The source
  // and the wording stay: a confirmed suggestion is still traceable to the agent that suggested it.
  const timestamp = context.now();
  const claim: Claim = {
    ...previous,
    status: "confirmed",
    authority: authorityAfterConfirming(previous.authority),
    updatedAt: timestamp,
  };
  return finish(
    session,
    {
      claims: replaceClaim(session, claim),
      procedureOrder: session.procedureOrder,
      claimHistory: reviewHistory(session, previous, "confirmed", timestamp, context),
    },
    claim,
    "updated",
    timestamp,
  );
}

function rejectClaim(
  session: SopSession,
  previous: Claim,
  context: WriteContext,
): ApplyClaimResult {
  const timestamp = context.now();
  const claimHistory = reviewHistory(session, previous, "rejected", timestamp, context);

  switch (previous.status) {
    case "proposed": {
      // A rejected suggestion is removed. Turning it into an unknown would make the field not
      // askable, so the agent would never ask again while the gap still blocked approval.
      return finish(
        session,
        {
          claims: session.claims.filter((existing) => existing.claimId !== previous.claimId),
          procedureOrder: session.procedureOrder.filter((claimId) => claimId !== previous.claimId),
          claimHistory,
        },
        previous,
        "withdrawn",
        timestamp,
      );
    }
    case "confirmed": {
      const before = statusBeforeConfirming(session, previous);
      const claim: Claim = {
        ...previous,
        status: before.status,
        authority: before.authority,
        updatedAt: timestamp,
      };
      return finish(
        session,
        {
          claims: replaceClaim(session, claim),
          procedureOrder: session.procedureOrder,
          claimHistory,
        },
        claim,
        "updated",
        timestamp,
      );
    }
    case "extracted": {
      // A field that holds something else keeps it, and the rejected rule just goes to the history.
      // Leaving an unknown behind would keep the whole field unresolved and unaskable for a rule the
      // person has already turned down.
      const isOnlyClaimOfItsField = !session.claims.some(
        (existing) => existing.field === previous.field && existing.claimId !== previous.claimId,
      );
      if (!isOnlyClaimOfItsField) {
        return finish(
          session,
          {
            claims: session.claims.filter((existing) => existing.claimId !== previous.claimId),
            procedureOrder: session.procedureOrder.filter(
              (claimId) => claimId !== previous.claimId,
            ),
            claimHistory,
          },
          previous,
          "withdrawn",
          timestamp,
        );
      }
      // The only claim: the field goes back to unknown, so it is not asked about again. A step
      // keeps its slot in the procedure order, as when a step is marked unknown.
      const claim: Claim = {
        ...previous,
        value: null,
        status: "unknown",
        authority: "unknown",
        effectiveDate: null,
        note: REJECTED_NOTE,
        updatedAt: timestamp,
      };
      return finish(
        session,
        {
          claims: replaceClaim(session, claim),
          procedureOrder: session.procedureOrder,
          claimHistory,
        },
        claim,
        "updated",
        timestamp,
      );
    }
    case "observed":
      return failure(
        "review_action_not_allowed",
        "An observed claim is the user's own statement, so it cannot be rejected. Say in chat what should change.",
      );
    case "unknown":
    case "conflict":
      return failure(
        "review_action_not_allowed",
        `A claim with status "${previous.status}" cannot be rejected.`,
      );
  }
}

/**
 * Applies a person's review action. Called by `applyClaim`, which has already refused an approved
 * session, so every write path shares that first check.
 */
export function applyReviewCommand(
  session: SopSession,
  command: ReviewClaimCommand,
  context: WriteContext,
): ApplyClaimResult {
  const previous = session.claims.find((claim) => claim.claimId === command.claimId);
  if (previous === undefined) {
    return failure("target_claim_not_found", "There is no active claim with that id.");
  }
  return command.kind === "confirm"
    ? confirmClaim(session, previous, context)
    : rejectClaim(session, previous, context);
}
