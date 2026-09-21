import type { Claim, ClaimStatus } from "./claim.ts";
import {
  type ApplyClaimResult,
  checkSessionLimits,
  commit,
  failure,
  historyEntryFor,
} from "./claimWriteSupport.ts";
import { normalizeStatement, quantitiesIn, significantWordsOf } from "./text.ts";
import type { WriteContext } from "./writeContext.ts";

/**
 * How much of the shorter statement's words the other one also uses before the two count as being
 * about the same thing. Half is deliberately generous: missing a conflict leaves an unresolved
 * claim in front of the user, while flagging a paraphrase costs one answer in chat.
 */
export const CONFLICT_TOPIC_OVERLAP = 0.5;

/** With different numbers, two statements need only this many words in common to be about one thing. */
const SHARED_WORDS_WHEN_NUMBERS_DIFFER = 1;

/** Only a claim someone stands behind, or a document states, can be in conflict. A suggestion or an unknown cannot. */
const CONFLICTABLE_STATUSES: readonly ClaimStatus[] = ["observed", "confirmed", "extracted"];

function documentNameOf(claim: Claim): string | null {
  return claim.source.reference.kind === "document"
    ? claim.source.reference.citation.documentName
    : null;
}

/**
 * At least one side is a document, and the two do not come from the same place. A handbook that
 * lists a $500 limit and, further down, a $5,000 limit is consistent with itself by construction,
 * and two things the user said are never compared: the agent corrects those instead.
 */
function comeFromDifferentSources(first: Claim, second: Claim): boolean {
  const firstDocument = documentNameOf(first);
  const secondDocument = documentNameOf(second);
  if (firstDocument === null && secondDocument === null) return false;
  return firstDocument !== secondDocument;
}

function sharedCount(first: ReadonlySet<string>, second: ReadonlySet<string>): number {
  let shared = 0;
  for (const word of first) if (second.has(word)) shared += 1;
  return shared;
}

/**
 * Do these two statements disagree about the same thing? Deterministic on purpose: a model judging
 * this would let a document influence whether a conflict is raised at all.
 *
 * - Both state numbers and they differ, and the two share at least one word: a conflict. This is
 *   the case that matters, "above $10,000" against "up to $25,000".
 * - Otherwise they conflict when at least half of the shorter one's words appear in the other.
 *   That includes two statements with the same figures: the same $10,000 approved by the CFO in one
 *   and by a manager in the other still disagree, and the rule cannot tell who from the words, so
 *   it flags a restatement too rather than let a contradiction through.
 */
function disagreeAboutTheSameThing(firstText: string, secondText: string): boolean {
  if (normalizeStatement(firstText) === normalizeStatement(secondText)) return false;

  const firstWords = significantWordsOf(firstText);
  const secondWords = significantWordsOf(secondText);
  const shared = sharedCount(firstWords, secondWords);

  const firstQuantities = quantitiesIn(firstText);
  const secondQuantities = quantitiesIn(secondText);
  const sameFigures =
    firstQuantities.size === secondQuantities.size &&
    [...firstQuantities].every((quantity) => secondQuantities.has(quantity));
  if (firstQuantities.size > 0 && secondQuantities.size > 0 && !sameFigures) {
    return shared >= SHARED_WORDS_WHEN_NUMBERS_DIFFER;
  }

  const shorter = Math.min(firstWords.size, secondWords.size);
  return shorter > 0 && shared / shorter >= CONFLICT_TOPIC_OVERLAP;
}

/** The first other claim, in claim order, that `candidate` conflicts with. A claim is in at most one pair. */
export function findConflictPartner(claims: readonly Claim[], candidate: Claim): Claim | undefined {
  if (!CONFLICTABLE_STATUSES.includes(candidate.status) || candidate.value === null) {
    return undefined;
  }
  return claims.find(
    (other) =>
      other.claimId !== candidate.claimId &&
      other.field === candidate.field &&
      CONFLICTABLE_STATUSES.includes(other.status) &&
      other.conflictsWithClaimId === null &&
      other.value !== null &&
      comeFromDifferentSources(candidate, other) &&
      disagreeAboutTheSameThing(candidate.value?.text ?? "", other.value.text),
  );
}

/**
 * Called by `applyClaim` on the result of every write that adds or changes what a claim says. If
 * the claim disagrees with another, both become `conflict` in the same commit, each pointing at the
 * other, and each writes a history entry holding the claim as it was, so flagging is never silent.
 *
 * A resolution is checked too: the user's answer is a new statement, and a third claim that was
 * left unpaired when the first two paired up may disagree with it. Nothing calls this for a review
 * action, a withdrawal or a mark-unknown: those never add a statement that could disagree. Status `conflict` is in no creator's list because no caller
 * asks for it; this write path applies it.
 */
export function pairConflictsAfterWrite(
  result: ApplyClaimResult,
  context: WriteContext,
): ApplyClaimResult {
  if (!result.ok || result.change === "unchanged" || result.change === "withdrawn") return result;

  const { session } = result;
  const candidate = session.claims.find((claim) => claim.claimId === result.claim.claimId);
  if (candidate === undefined) return result;
  const partner = findConflictPartner(session.claims, candidate);
  if (partner === undefined) return result;

  const timestamp = session.updatedAt;
  const markedCandidate: Claim = {
    ...candidate,
    status: "conflict",
    conflictsWithClaimId: partner.claimId,
    updatedAt: timestamp,
  };
  const markedPartner: Claim = {
    ...partner,
    status: "conflict",
    conflictsWithClaimId: candidate.claimId,
    updatedAt: timestamp,
  };
  const changes = {
    claims: session.claims.map((claim) => {
      if (claim.claimId === candidate.claimId) return markedCandidate;
      if (claim.claimId === partner.claimId) return markedPartner;
      return claim;
    }),
    procedureOrder: session.procedureOrder,
    claimHistory: [
      ...session.claimHistory,
      ...[candidate, partner].map((previousClaim) =>
        historyEntryFor({
          context,
          timestamp,
          previousClaim,
          changedBy: "system",
          sourceMessageId: null,
          reason: "conflict_detected",
        }),
      ),
    ],
  };
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return failure(limitError.code, limitError.message);

  return {
    ok: true,
    claim: markedCandidate,
    change: result.change,
    session: commit(session, changes, timestamp),
  };
}
