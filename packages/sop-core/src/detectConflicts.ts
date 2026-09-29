import type { Claim } from "./claim.ts";
import {
  type ApplyClaimResult,
  buildValue,
  type ClaimWriteError,
  checkSessionLimits,
  commit,
  failure,
  historyEntryFor,
  type SessionChanges,
} from "./claimWriteSupport.ts";
import {
  findPassage,
  isPassageStale,
  type ReferencePassage,
  updatePassage,
} from "./referenceSchema.ts";
import type { SopSession } from "./session.ts";
import { normalizeStatement, quantitiesIn, significantWordsOf } from "./text.ts";
import type { WriteContext } from "./writeContext.ts";

/*
 * Conflicts between an uploaded document and the person. A document's passages are reference
 * material, so a disagreement is found between a passage and a claim the person stands behind (or
 * between passages of two different documents). When one is found, the passage is written as the
 * document side of a conflict pair, and the person's final answer settles it.
 */

/**
 * How much of the shorter statement's words the other one also uses before the two count as being
 * about the same thing. Half is deliberately generous: missing a conflict lets a document silently
 * disagree with the SOP, while flagging a paraphrase costs one answer in chat.
 */
export const CONFLICT_TOPIC_OVERLAP = 0.5;

/** With different numbers, two statements need only this many words in common to be about one thing. */
const SHARED_WORDS_WHEN_NUMBERS_DIFFER = 1;

function sharedCount(first: ReadonlySet<string>, second: ReadonlySet<string>): number {
  let shared = 0;
  for (const word of first) if (second.has(word)) shared += 1;
  return shared;
}

function haveSameFigures(first: string, second: string): boolean {
  const firstQuantities = quantitiesIn(first);
  const secondQuantities = quantitiesIn(second);
  return (
    firstQuantities.size === secondQuantities.size &&
    [...firstQuantities].every((quantity) => secondQuantities.has(quantity))
  );
}

/**
 * Words that turn a statement into its opposite. Two statements are only the same when they agree
 * on these exactly: "refunds need approval" is not "refunds do not need approval".
 */
const NEGATION_WORDS: ReadonlySet<string> = new Set(["not", "no", "never", "without", "except"]);

/**
 * The words that set a boundary or a direction: "over" against "under", "up to" against "above".
 * The topic comparison leaves them out on purpose ("above" is not a topic), so a statement counts
 * as already said only when the other one uses every one of its boundary words too.
 */
const QUALIFIER_WORDS: ReadonlySet<string> = new Set([
  "only",
  "over",
  "under",
  "above",
  "below",
  "within",
  "before",
  "after",
  "until",
  "less",
  "more",
  "fewer",
  "least",
  "most",
  "exceed",
  "exceeds",
  "up",
]);

function wordsFrom(text: string, vocabulary: ReadonlySet<string>): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => vocabulary.has(word)),
  );
}

/**
 * Does `claimText` already say what `statement` says? The same words, or every word that matters in
 * `statement`, every figure and every boundary word, and the same negation: "over $100" and "under
 * $100" share their topic and figure but not their meaning. The claim may say more ("clock out by
 * 11:30 after closing duties" already says "clock out by 11:30"). A passage the SOP already states
 * is neither new material nor a disagreement.
 */
export function statesTheSameThing(statement: string, claimText: string): boolean {
  if (normalizeStatement(statement) === normalizeStatement(claimText)) return true;
  if (!haveSameFigures(statement, claimText)) return false;
  const negations = wordsFrom(statement, NEGATION_WORDS);
  const claimNegations = wordsFrom(claimText, NEGATION_WORDS);
  if (
    negations.size !== claimNegations.size ||
    [...negations].some((word) => !claimNegations.has(word))
  ) {
    return false;
  }
  const claimQualifiers = wordsFrom(claimText, QUALIFIER_WORDS);
  if ([...wordsFrom(statement, QUALIFIER_WORDS)].some((word) => !claimQualifiers.has(word))) {
    return false;
  }
  const words = significantWordsOf(statement);
  const claimWords = significantWordsOf(claimText);
  return words.size > 0 && [...words].every((word) => claimWords.has(word));
}

/**
 * Do these two statements disagree about the same thing? Deterministic on purpose: a model judging
 * this would let a document influence whether a conflict is raised at all.
 *
 * - Both state numbers and they differ, and the two share at least one word: a conflict. This is
 *   the case that matters, "above $10,000" against "up to $25,000".
 * - Only one states numbers: not a conflict. One is more specific than the other ("label each sample
 *   after collection" against "label each sample within 30 minutes"), which is detail for the agent to put to the
 *   person as a passage, not two answers to choose between.
 * - Otherwise they conflict when at least half of the shorter one's words appear in the other.
 *   That includes two statements with the same figures: the same $10,000 approved by the CFO in one
 *   and by a manager in the other still disagree, and the rule cannot tell who from the words, so
 *   it flags a restatement too rather than let a contradiction through.
 */
function disagreeAboutTheSameThing(firstText: string, secondText: string): boolean {
  if (statesTheSameThing(firstText, secondText) || statesTheSameThing(secondText, firstText)) {
    return false;
  }
  const firstWords = significantWordsOf(firstText);
  const secondWords = significantWordsOf(secondText);
  const shared = sharedCount(firstWords, secondWords);

  const firstHasFigures = quantitiesIn(firstText).size > 0;
  const secondHasFigures = quantitiesIn(secondText).size > 0;
  if (firstHasFigures !== secondHasFigures) return false;
  if (firstHasFigures && !haveSameFigures(firstText, secondText)) {
    return shared >= SHARED_WORDS_WHEN_NUMBERS_DIFFER;
  }

  const shorter = Math.min(firstWords.size, secondWords.size);
  return shorter > 0 && shared / shorter >= CONFLICT_TOPIC_OVERLAP;
}

/** A claim the person stands behind, and not already half of a conflict. */
function isUnpairedStatement(claim: Claim): boolean {
  return (
    claim.value !== null &&
    (claim.status === "observed" || claim.status === "confirmed") &&
    claim.source.type === "employee_statement" &&
    claim.conflictsWithClaimId === null
  );
}

/** A passage that can still disagree with something: kept, not yet settled, and still on target. */
function canConflict(session: SopSession, passage: ReferencePassage): boolean {
  return (
    (passage.state === "open" || passage.state === "offered") && !isPassageStale(session, passage)
  );
}

/** The document a claim rests on, if it rests on a passage. Two statements from one document are never compared. */
function restsOnDocument(session: SopSession, claim: Claim): string | null {
  if (claim.basedOnPassageId === null) return null;
  return findPassage(session, claim.basedOnPassageId)?.documentId ?? null;
}

function claimDisagreesWithPassage(
  session: SopSession,
  claim: Claim,
  passage: ReferencePassage,
): boolean {
  return (
    claim.field === passage.field &&
    claim.basedOnPassageId !== passage.passageId &&
    restsOnDocument(session, claim) !== passage.documentId &&
    disagreeAboutTheSameThing(claim.value?.text ?? "", passage.statement)
  );
}

/**
 * Whether a passage read from a document would disagree with something the person said. The upload
 * ranks such a passage first, since the SOP cannot be finished until the person settles it.
 */
export function disagreesWithWhatWasSaid(
  session: SopSession,
  passage: { field: ReferencePassage["field"]; statement: string },
): boolean {
  return session.claims.some(
    (claim) =>
      isUnpairedStatement(claim) &&
      claim.field === passage.field &&
      disagreeAboutTheSameThing(claim.value?.text ?? "", passage.statement),
  );
}

/** The passage, written as the document side of a conflict with `partnerClaimId`. */
function documentSideOf(
  passage: ReferencePassage,
  claimId: string,
  partnerClaimId: string,
  timestamp: string,
): Claim {
  return {
    claimId,
    field: passage.field,
    value: buildValue(passage.field, passage.statement),
    status: "conflict",
    source: {
      type: "policy_document",
      reference: { kind: "document", citation: passage.citation },
    },
    authority: "official_policy",
    effectiveDate: passage.effectiveDate,
    note: null,
    createdByType: "extraction",
    conflictsWithClaimId: partnerClaimId,
    basedOnPassageId: passage.passageId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function markInConflict(changes: SessionChanges, passageId: string, claimId: string) {
  changes.references = updatePassage(
    changes.references as NonNullable<SessionChanges["references"]>,
    passageId,
    (passage) => ({ ...passage, state: "in_conflict", claimIds: [...passage.claimIds, claimId] }),
  );
}

/**
 * Pairs the person's claim with a disagreeing passage: the claim becomes `conflict`, the passage is
 * written beside it as the document side, and a history entry keeps the claim as it was. A document
 * step sits right after the step it disagrees with.
 */
function pairClaimWithPassage(
  changes: SessionChanges,
  claim: Claim,
  passage: ReferencePassage,
  context: WriteContext,
  timestamp: string,
): Claim {
  const documentSide = documentSideOf(passage, context.newId(), claim.claimId, timestamp);
  const marked: Claim = {
    ...claim,
    status: "conflict",
    conflictsWithClaimId: documentSide.claimId,
    updatedAt: timestamp,
  };
  changes.claims = [
    ...changes.claims.map((existing) => (existing.claimId === claim.claimId ? marked : existing)),
    documentSide,
  ];
  if (claim.field === "procedure") {
    const index = changes.procedureOrder.indexOf(claim.claimId);
    changes.procedureOrder =
      index === -1
        ? [...changes.procedureOrder, documentSide.claimId]
        : [
            ...changes.procedureOrder.slice(0, index + 1),
            documentSide.claimId,
            ...changes.procedureOrder.slice(index + 1),
          ];
  }
  changes.claimHistory = [
    ...changes.claimHistory,
    historyEntryFor({
      context,
      timestamp,
      previousClaim: claim,
      changedBy: "system",
      sourceMessageId: null,
      reason: "conflict_detected",
    }),
  ];
  markInConflict(changes, passage.passageId, documentSide.claimId);
  return marked;
}

/** Two documents disagree: both passages are written as a conflict pair, and the person settles it. */
function pairPassages(
  changes: SessionChanges,
  first: ReferencePassage,
  second: ReferencePassage,
  context: WriteContext,
  timestamp: string,
) {
  const firstId = context.newId();
  const secondId = context.newId();
  const firstSide = documentSideOf(first, firstId, secondId, timestamp);
  const secondSide = documentSideOf(second, secondId, firstId, timestamp);
  changes.claims = [...changes.claims, firstSide, secondSide];
  if (first.field === "procedure") {
    changes.procedureOrder = [...changes.procedureOrder, firstId, secondId];
  }
  markInConflict(changes, first.passageId, firstId);
  markInConflict(changes, second.passageId, secondId);
}

/**
 * Called by `applyClaim` on the result of every write that adds or changes what the person said. If
 * the claim disagrees with a passage from an uploaded document, both sides become a conflict pair in
 * the same commit, so flagging is never silent. Nothing calls this for a review action, a withdrawal
 * or a mark-unknown: those never add a statement that could disagree. Status `conflict` is in no
 * creator's list because no caller asks for it; this write path applies it.
 */
export function pairConflictsAfterWrite(
  result: ApplyClaimResult,
  context: WriteContext,
): ApplyClaimResult {
  if (!result.ok || result.change === "unchanged" || result.change === "withdrawn") return result;

  const { session } = result;
  const candidate = session.claims.find((claim) => claim.claimId === result.claim.claimId);
  if (candidate === undefined || !isUnpairedStatement(candidate)) return result;
  const passage = session.references.passages.find(
    (entry) => canConflict(session, entry) && claimDisagreesWithPassage(session, candidate, entry),
  );
  if (passage === undefined) return result;

  const timestamp = session.updatedAt;
  const changes: SessionChanges = {
    claims: session.claims,
    procedureOrder: session.procedureOrder,
    claimHistory: session.claimHistory,
    references: session.references,
  };
  const marked = pairClaimWithPassage(changes, candidate, passage, context, timestamp);
  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return failure(limitError.code, limitError.message);

  return {
    ok: true,
    claim: marked,
    change: result.change,
    session: commit(session, changes, timestamp),
  };
}

/**
 * Raises the conflicts that newly kept passages bring: each one is compared with what the person
 * said, and then with the other documents' passages. A passage, and a claim, is in at most one pair.
 */
export function raiseReferenceConflicts(
  session: SopSession,
  passageIds: readonly string[],
  context: WriteContext,
): { ok: true; session: SopSession; raised: number } | { ok: false; error: ClaimWriteError } {
  const timestamp = session.updatedAt;
  const changes: SessionChanges = {
    claims: session.claims,
    procedureOrder: session.procedureOrder,
    claimHistory: session.claimHistory,
    references: session.references,
  };
  const current = (): SopSession => ({
    ...session,
    claims: changes.claims,
    references: changes.references ?? session.references,
  });

  let raised = 0;
  for (const passageId of passageIds) {
    const view = current();
    const passage = findPassage(view, passageId);
    if (passage === undefined || !canConflict(view, passage)) continue;

    const claim = view.claims.find(
      (entry) => isUnpairedStatement(entry) && claimDisagreesWithPassage(view, entry, passage),
    );
    if (claim !== undefined) {
      pairClaimWithPassage(changes, claim, passage, context, timestamp);
      raised += 1;
      continue;
    }
    const other = view.references.passages.find(
      (entry) =>
        entry.passageId !== passage.passageId &&
        entry.documentId !== passage.documentId &&
        entry.field === passage.field &&
        canConflict(view, entry) &&
        disagreeAboutTheSameThing(passage.statement, entry.statement),
    );
    if (other !== undefined) {
      pairPassages(changes, other, passage, context, timestamp);
      raised += 1;
    }
  }
  if (raised === 0) return { ok: true, session, raised };

  const limitError = checkSessionLimits(session, changes);
  if (limitError !== null) return { ok: false, error: limitError };
  return { ok: true, session: commit(session, changes, timestamp), raised };
}
