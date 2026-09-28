import type { Claim } from "./claim.ts";
import {
  type ClaimDepthAnalysisOutput,
  type ClaimDepthFinding,
  MAX_CLAIM_DEPTH_FINDINGS,
  MAX_CLAIM_DEPTH_QUESTION_LENGTH,
  MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION,
} from "./claimDepthReviewSchema.ts";
import { computeGaps } from "./computeGaps.ts";
import {
  hashText,
  lastUserMessageText,
  statedClaimsInReadingOrder,
  statesOutOfTime,
} from "./consistencyReview.ts";
import type { SopSession } from "./session.ts";
import type { WriteContext } from "./writeContext.ts";

/**
 * Whether the procedure field is currently one `buildInterviewAgenda` puts in "doNotAsk": it has an
 * unresolved claim (awaiting a document review, or one the person already said they do not know)
 * that is not itself askable. A resolved field with no gap at all is not in "doNotAsk" either
 * (`readiness.askable` is only meaningful once `readiness.gap` is non-null — a fully resolved field
 * has neither), so this checks both, not `askable` alone, or every ordinary, fully-stated procedure
 * would wrongly count as excluded. Asking about one specific step while the field is in "doNotAsk"
 * anyway would directly contradict that instruction, or surface a step the person has not had a
 * chance to review yet. Scoped to the one field this review ever targets.
 */
function procedureFieldIsInDoNotAsk(session: SopSession): boolean {
  const readiness = computeGaps(session).fields.find((entry) => entry.field === "procedure");
  return readiness !== undefined && readiness.gap !== null && !readiness.askable;
}

/**
 * The procedure claims a claim-depth review may still ask about: stated (observed or confirmed,
 * with a value), in the procedure field, and not already asked about. Scoped to `procedure` in
 * this release — the executable part of an SOP, where a reader who cannot carry out a step has a
 * direct, first-party cost. Ordered by the session's own procedure order, matching every other
 * procedure-facing view in this codebase.
 */
export function claimDepthCandidates(session: SopSession): Claim[] {
  const askedClaimIds = new Set(session.claimDepthReview?.askedClaimIds ?? []);
  const isCandidate = (claim: Claim) =>
    claim.field === "procedure" &&
    claim.value !== null &&
    (claim.status === "observed" || claim.status === "confirmed") &&
    !askedClaimIds.has(claim.claimId);
  const byId = new Map(session.claims.filter(isCandidate).map((claim) => [claim.claimId, claim]));
  const ordered = session.procedureOrder.flatMap((claimId) => {
    const claim = byId.get(claimId);
    return claim === undefined ? [] : [claim];
  });
  // Every active procedure claim is required to appear in procedureOrder (a session invariant),
  // so this only ever catches a candidate that invariant does not hold for yet.
  const orderedIds = new Set(ordered.map((claim) => claim.claimId));
  return [...ordered, ...[...byId.values()].filter((claim) => !orderedIds.has(claim.claimId))];
}

/**
 * A fingerprint of what every stated claim says, not just the candidates: the review reads the
 * rest of the SOP as read-only context (to avoid asking for a detail already recorded elsewhere),
 * so a change to that context can make a stored finding wrong — either stale (something now
 * answers it) or missing (something new should be asked about) — even when no candidate's own
 * wording changed. Fingerprinting only the candidates would also make the basis change history-
 * dependent in an unwanted way: `askedClaimIds` removes a claim from the candidate set the instant
 * it is offered, which would otherwise change this fingerprint too, invalidating a review that
 * still correctly describes every other waiting finding. Fingerprinting every stated claim (whose
 * own text/status is untouched by asking) avoids that coupling entirely.
 */
export function claimDepthBasisOf(session: SopSession): string {
  const claims = statedClaimsInReadingOrder(session);
  const text = JSON.stringify(
    claims.map((claim) => [
      claim.claimId,
      claim.field,
      claim.value?.text ?? "",
      claim.note ?? "",
      claim.effectiveDate ?? "",
    ]),
  );
  return `${claims.length}:${hashText(text)}`;
}

function hasUnresolvedConflict(session: SopSession): boolean {
  return session.claims.some((claim) => claim.status === "conflict");
}

/** The review on file, if it was made for the candidates as they are now. */
export function currentClaimDepthReview(session: SopSession) {
  const review = session.claimDepthReview;
  return review !== null && review.basis === claimDepthBasisOf(session) ? review : null;
}

/**
 * Whether a claim-depth review should run now. It never runs on an approved session, while an
 * unresolved conflict exists (settling a disagreement takes priority over a new question), while
 * the procedure field itself is in "doNotAsk" (a claim there is awaiting a document review, or the
 * person already said they do not know — asking about one specific step anyway would contradict
 * that instruction), while the person has said they are out of time, once the session's question
 * budget is spent, when there are no candidates at all, or when the review on file already saw
 * these candidates.
 */
export function needsClaimDepthReview(session: SopSession): boolean {
  if (session.status !== "draft") return false;
  if (hasUnresolvedConflict(session)) return false;
  if (procedureFieldIsInDoNotAsk(session)) return false;
  if (statesOutOfTime(lastUserMessageText(session))) return false;
  if ((session.claimDepthReview?.offeredTotal ?? 0) >= MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION) {
    return false;
  }
  if (claimDepthCandidates(session).length === 0) return false;
  return currentClaimDepthReview(session) === null;
}

export interface ClaimDepthQuestion {
  findingId: string;
  targetClaimId: string;
  targetField: "procedure";
  /** 1-based position in the procedure. */
  position: number;
  focus: ClaimDepthFinding["focus"];
  question: string;
}

/** A claim's position in the live procedure order, or null if it is no longer an active step there. */
function procedurePosition(session: SopSession, claimId: string): number | null {
  const index = session.procedureOrder.indexOf(claimId);
  return index === -1 ? null : index + 1;
}

/**
 * The one question to hand the agent now, or null. Only from a review made for the current
 * candidates, never on an approved session, while a conflict is unresolved, or while the procedure
 * field itself is in "doNotAsk", never after the person asked for the questions to stop, and never
 * past the session's budget. Each finding is offered once, ever. Among several waiting findings,
 * the one earliest in the procedure comes first, so the order never depends on the order the model
 * happened to return them in.
 */
export function nextClaimDepthQuestion(session: SopSession): ClaimDepthQuestion | null {
  const review = currentClaimDepthReview(session);
  if (review === null) return null;
  if (session.status !== "draft" || hasUnresolvedConflict(session)) return null;
  if (procedureFieldIsInDoNotAsk(session)) return null;
  if (statesOutOfTime(lastUserMessageText(session))) return null;
  if (review.offeredTotal >= MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION) return null;

  const withPosition = review.findings.flatMap((finding) => {
    const position = procedurePosition(session, finding.targetClaimId);
    return position === null ? [] : [{ finding, position }];
  });
  withPosition.sort((first, second) => first.position - second.position);
  const first = withPosition[0];
  if (first === undefined) return null;
  return {
    findingId: first.finding.findingId,
    targetClaimId: first.finding.targetClaimId,
    targetField: "procedure",
    position: first.position,
    focus: first.finding.focus,
    question: first.finding.question,
  };
}

export interface PendingClaimDepthTarget {
  targetClaimId: string;
  targetField: "procedure";
  position: number;
}

/**
 * The text a claim-depth offer's staleness snapshot is taken from: the statement and the note
 * together, because the review is explicitly told a candidate's own note can already cover the
 * missing detail, so the person's answer may just as plausibly land in `correct_claim`'s `note` as
 * in its `statement` — either one changing must be enough to count as answered.
 */
function claimDepthSnapshotText(claim: Claim): string {
  return `${claim.value?.text ?? ""}\u0000${claim.note ?? ""}`;
}

/**
 * The most recently offered claim-depth question's target, so the agent can still correct that
 * claim once the person answers, even on a later turn once it is no longer `nextClaimDepthQuestion`
 * (unlike a `restatement_mismatch`'s `pendingMismatchClaims`, this carries no claim text: the
 * state item already lists every claim's own wording every turn regardless, so a bare pointer is
 * enough to resolve which one the answer is about). Null once the claim is no longer an active
 * procedure step (withdrawn since), once its text or note no longer matches the snapshot taken
 * when it was offered — the answer is applied through the ordinary `correct_claim` tool, which has
 * no way to also tell this bookkeeping "that one's answered now," so a changed snapshot is what
 * stands in for it: without this check, an already-answered step would keep being offered as
 * pending forever (until some later, unrelated claim-depth question happens to replace it), risking
 * a later, unrelated statement being misapplied to it — or once the claim has since become half of
 * a `conflict` (an uploaded document can disagree with a procedure step after it was offered): the
 * prompt tells the agent never to `correct_claim` a conflicted claim, only `resolve_conflict`, so
 * continuing to expose it here would hand the agent two contradictory instructions for the same
 * claim.
 */
export function pendingClaimDepthTarget(session: SopSession): PendingClaimDepthTarget | null {
  const review = session.claimDepthReview;
  const claimId = review?.lastOfferedClaimId ?? null;
  if (review === null || review === undefined || claimId === null) return null;
  const claim = session.claims.find((candidate) => candidate.claimId === claimId);
  if (claim === undefined || claim.status === "conflict") return null;
  if (hashText(claimDepthSnapshotText(claim)) !== review.lastOfferedClaimTextHash) return null;
  const position = procedurePosition(session, claimId);
  return position === null ? null : { targetClaimId: claimId, targetField: "procedure", position };
}

export type MergeClaimDepthResult =
  | { ok: true; session: SopSession; raisedCount: number }
  | { ok: false; reason: string };

/**
 * Validates what the model returned against the session and, if it holds up, stores it as the
 * current review. The whole output is refused if it cites a claim that is not a current candidate,
 * targets the same claim twice, names an earlier finding twice or one that does not exist, or
 * leaves an earlier finding unaccounted for. It also refuses an output over the limits on counts
 * and lengths, which the output schema does not state. `targetField` is never taken from the
 * model: every finding targets exactly one claim, so its field is read from that claim.
 */
export function mergeClaimDepthAnalysis(
  session: SopSession,
  output: ClaimDepthAnalysisOutput,
  context: WriteContext,
): MergeClaimDepthResult {
  if (
    output.findings.length > MAX_CLAIM_DEPTH_FINDINGS ||
    output.resolvedPriorFindingIds.length > MAX_CLAIM_DEPTH_FINDINGS
  ) {
    return { ok: false, reason: "The review returned too many findings." };
  }
  if (
    output.findings.some(
      (finding) => finding.question.trim().length > MAX_CLAIM_DEPTH_QUESTION_LENGTH,
    )
  ) {
    return { ok: false, reason: "A finding's question was too long." };
  }
  const candidateIds = new Set(claimDepthCandidates(session).map((claim) => claim.claimId));
  const targetIds = output.findings.map((finding) => finding.targetClaimId);
  if (new Set(targetIds).size !== targetIds.length) {
    return { ok: false, reason: "The review targeted the same claim twice." };
  }
  if (targetIds.some((claimId) => !candidateIds.has(claimId))) {
    return { ok: false, reason: "The review cited a claim it was not given." };
  }

  const prior = session.claimDepthReview?.findings ?? [];
  const priorById = new Map(prior.map((finding) => [finding.findingId, finding]));
  const carriedIds = output.findings.flatMap((finding) =>
    finding.priorFindingId === null ? [] : [finding.priorFindingId],
  );
  const accountedFor = [...carriedIds, ...output.resolvedPriorFindingIds];
  if (new Set(accountedFor).size !== accountedFor.length) {
    return { ok: false, reason: "An earlier finding was named twice." };
  }
  if (accountedFor.some((id) => !priorById.has(id))) {
    return { ok: false, reason: "The review named a finding that does not exist." };
  }
  if (prior.some((finding) => !accountedFor.includes(finding.findingId))) {
    return { ok: false, reason: "An earlier finding was left unaccounted for." };
  }
  // Carrying a finding forward means "the same concern, possibly reworded" — not a way to retarget
  // it to a different claim, or silently swap what kind of concern it is, while keeping its id.
  // Either would overwrite the original concern without ever listing it as resolved.
  for (const candidate of output.findings) {
    const earlier =
      candidate.priorFindingId === null ? undefined : priorById.get(candidate.priorFindingId);
    if (earlier === undefined) continue;
    if (earlier.targetClaimId !== candidate.targetClaimId) {
      return { ok: false, reason: "A carried finding switched its target claim." };
    }
    if (earlier.focus !== candidate.focus) {
      return { ok: false, reason: "A carried finding switched its focus." };
    }
  }

  const findings: ClaimDepthFinding[] = [];
  for (const candidate of output.findings) {
    const question = candidate.question.trim();
    if (question === "") return { ok: false, reason: "The review returned an empty question." };
    const earlier =
      candidate.priorFindingId === null ? undefined : priorById.get(candidate.priorFindingId);
    findings.push({
      findingId: earlier?.findingId ?? context.newId(),
      targetClaimId: candidate.targetClaimId,
      focus: candidate.focus,
      question,
    });
  }

  const timestamp = context.now();
  return {
    ok: true,
    session: {
      ...session,
      updatedAt: timestamp,
      claimDepthReview: {
        basis: claimDepthBasisOf(session),
        checkedAt: timestamp,
        findings,
        offeredTotal: session.claimDepthReview?.offeredTotal ?? 0,
        askedClaimIds: session.claimDepthReview?.askedClaimIds ?? [],
        lastOfferedClaimId: session.claimDepthReview?.lastOfferedClaimId ?? null,
        lastOfferedClaimTextHash: session.claimDepthReview?.lastOfferedClaimTextHash ?? null,
      },
    },
    raisedCount: output.findings.filter((finding) => finding.priorFindingId === null).length,
  };
}

/**
 * Records that a finding's question was handed to the agent: removed from the waiting findings,
 * its claim id moved to `askedClaimIds` for good (so it is never a candidate again, regardless of
 * how its wording changes later), and set as `lastOfferedClaimId` so its target stays resolvable —
 * alongside a snapshot of its current text, so `pendingClaimDepthTarget` can later notice once that
 * text has actually changed (the person's answer, applied through the ordinary `correct_claim`
 * tool) and stop exposing it. This changes the review's bookkeeping and nothing else: it is not a
 * claim write.
 */
export function markClaimDepthQuestionOffered(
  session: SopSession,
  findingId: string,
  context: WriteContext,
): SopSession {
  const review = session.claimDepthReview;
  const finding = review?.findings.find((candidate) => candidate.findingId === findingId);
  if (review === null || review === undefined || finding === undefined) return session;
  const targetClaim = session.claims.find((claim) => claim.claimId === finding.targetClaimId);
  const offeredTotal = Math.min(review.offeredTotal + 1, MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION);
  return {
    ...session,
    updatedAt: context.now(),
    claimDepthReview: {
      ...review,
      findings: review.findings.filter((candidate) => candidate.findingId !== findingId),
      offeredTotal,
      askedClaimIds: [...review.askedClaimIds, finding.targetClaimId],
      lastOfferedClaimId: finding.targetClaimId,
      lastOfferedClaimTextHash: hashText(
        targetClaim === undefined ? "" : claimDepthSnapshotText(targetClaim),
      ),
    },
  };
}

/**
 * What to do when a review could not be made: say the review on file is the one for the
 * candidates as they are now, so the failed attempt is not repeated until they change again (a
 * model that keeps failing or timing out costs one attempt, not one per message). Every waiting
 * finding is dropped: it was written for candidates that have since changed, and the person may
 * have already enriched what it was about. `askedClaimIds`, `lastOfferedClaimId` and
 * `lastOfferedClaimTextHash` are untouched: they are permanent bookkeeping, not tied to any one
 * review's basis, and `pendingClaimDepthTarget` already detects staleness itself, by comparing the
 * target claim's live text against this stored snapshot, so a failed review does not need to also
 * account for it here.
 */
export function keepClaimDepthReviewForCurrentClaims(
  session: SopSession,
  context: WriteContext,
): SopSession {
  const timestamp = context.now();
  return {
    ...session,
    updatedAt: timestamp,
    claimDepthReview: {
      basis: claimDepthBasisOf(session),
      checkedAt: timestamp,
      findings: [],
      offeredTotal: session.claimDepthReview?.offeredTotal ?? 0,
      askedClaimIds: session.claimDepthReview?.askedClaimIds ?? [],
      lastOfferedClaimId: session.claimDepthReview?.lastOfferedClaimId ?? null,
      lastOfferedClaimTextHash: session.claimDepthReview?.lastOfferedClaimTextHash ?? null,
    },
  };
}
