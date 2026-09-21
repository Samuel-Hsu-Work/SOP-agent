import type { Claim } from "./claim.ts";
import { computeGaps } from "./computeGaps.ts";
import {
  type ConsistencyAnalysisOutput,
  type ConsistencyFinding,
  type ConsistencyReview,
  MAX_CONSISTENCY_FINDINGS,
  MAX_CONSISTENCY_QUESTION_LENGTH,
  MAX_CONSISTENCY_QUESTIONS_PER_SESSION,
  MAX_RELATED_CLAIMS,
} from "./consistencyReviewSchema.ts";
import type { SopSession } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import type { WriteContext } from "./writeContext.ts";

/**
 * What a person says when they want the questions to stop. Deliberately narrow, and in the first
 * person: "there is no time limit for appeals" and "appeals filed out of time go to Legal" are statements about the process, not requests. A
 * false positive costs one consistency question that is not asked, and nothing else, because the
 * ordinary agenda never reads this.
 */
const OUT_OF_TIME_PATTERN =
  /\b(?:i'?m|i am|we'?re|we are)(?: (?:really|totally|just|almost))? (?:out of|running out of) time\b|\bi (?:have|got) no (?:more )?time|\bi (?:don'?t|do not) have (?:much |any |more |the )?time|no more questions|stop asking|that'?s (?:all|everything)|that is (?:all|everything)|i'?m done|i am done/i;

export function statesOutOfTime(userMessage: string): boolean {
  return OUT_OF_TIME_PATTERN.test(userMessage);
}

/**
 * The claims a consistency review reads: what the person stated (observed or confirmed), with the
 * procedure's steps in their real order. A suggestion is not the person's word, an unknown has no
 * text, and a document claim is left out on purpose: text from an upload does not decide what the
 * agent asks.
 */
export function statedClaimsInReadingOrder(session: SopSession): Claim[] {
  const isStated = (claim: Claim) =>
    claim.value !== null && (claim.status === "observed" || claim.status === "confirmed");
  const stated = session.claims.filter(isStated);
  const byId = new Map(stated.map((claim) => [claim.claimId, claim]));
  const orderedSteps = session.procedureOrder.flatMap((claimId) => {
    const step = byId.get(claimId);
    return step === undefined ? [] : [step];
  });
  const stepIds = new Set(orderedSteps.map((step) => step.claimId));
  return [
    ...orderedSteps,
    ...stated.filter((claim) => claim.field !== "procedure" || !stepIds.has(claim.claimId)),
  ];
}

/** A fixed-size hash of a string (FNV-1a, 32 bit), so a fingerprint stays short whatever the claims hold. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * A fingerprint of what the claims say: the stated claims' field, text, note and date, in reading
 * order. A confirmation changes no wording, so it does not change the fingerprint, and reviewing
 * claims in the browser never makes a consistency review out of date.
 */
export function consistencyBasisOf(session: SopSession): string {
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

function lastUserMessageText(session: SopSession): string {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

/** Whether the interview has reached the point where the recorded claims can be read as a whole. */
function isReadyToBeReadAsAWhole(session: SopSession): boolean {
  return (
    session.status === "draft" &&
    computeGaps(session).blockingGapCount === 0 &&
    // An unreviewed document rule or an unanswered conflict means the SOP is still being settled.
    !session.claims.some((claim) => claim.status === "extracted" || claim.status === "conflict")
  );
}

/** The review on file, if it was made for the claims as they are now. */
export function currentConsistencyReview(session: SopSession): ConsistencyReview | null {
  const review = session.consistencyReview;
  return review !== null && review.basis === consistencyBasisOf(session) ? review : null;
}

/**
 * Whether a consistency review should run now. It never runs on a sparse interview, while the
 * person has said they are out of time, once the session's question budget is spent, or when the
 * review on file already saw these claims.
 */
export function needsConsistencyReview(session: SopSession): boolean {
  if (!isReadyToBeReadAsAWhole(session)) return false;
  if (statesOutOfTime(lastUserMessageText(session))) return false;
  if ((session.consistencyReview?.offeredTotal ?? 0) >= MAX_CONSISTENCY_QUESTIONS_PER_SESSION) {
    return false;
  }
  return currentConsistencyReview(session) === null;
}

export interface ConsistencyQuestion {
  findingId: string;
  category: ConsistencyFinding["category"];
  field: SopFieldName;
  question: string;
  aboutClaimIds: string[];
}

/**
 * The one question to hand the agent now, or null. Only from a review made for these claims, only
 * once the interview has nothing blocking left, never after the person asked for the questions to
 * stop, and never past the session's budget. Each finding is offered once.
 */
export function nextConsistencyQuestion(session: SopSession): ConsistencyQuestion | null {
  const review = currentConsistencyReview(session);
  if (review === null || !isReadyToBeReadAsAWhole(session)) return null;
  if (statesOutOfTime(lastUserMessageText(session))) return null;
  if (review.offeredTotal >= MAX_CONSISTENCY_QUESTIONS_PER_SESSION) return null;

  const finding = review.findings.find((candidate) => !candidate.wasOffered);
  if (finding === undefined) return null;
  return {
    findingId: finding.findingId,
    category: finding.category,
    field: finding.targetField,
    question: finding.question,
    aboutClaimIds: finding.relatedClaimIds,
  };
}

export type MergeConsistencyResult =
  | {
      ok: true;
      session: SopSession;
      raisedCount: number;
      carriedCount: number;
      resolvedCount: number;
    }
  | { ok: false; reason: string };

/**
 * Validates what the model returned against the session and, if it holds up, stores it as the
 * current review. The whole output is refused if it cites a claim that is not in the review's
 * input, names an earlier finding twice or one that does not exist, or leaves an earlier finding
 * unaccounted for: a finding never disappears without the model saying it is answered. It also
 * refuses an output over the limits on counts and lengths, which the output schema does not state.
 */
export function mergeConsistencyAnalysis(
  session: SopSession,
  output: ConsistencyAnalysisOutput,
  context: WriteContext,
): MergeConsistencyResult {
  if (
    output.findings.length > MAX_CONSISTENCY_FINDINGS ||
    output.resolvedPriorFindingIds.length > MAX_CONSISTENCY_FINDINGS
  ) {
    return { ok: false, reason: "The review returned too many findings." };
  }
  if (
    output.findings.some(
      (finding) =>
        finding.relatedClaimIds.length > MAX_RELATED_CLAIMS ||
        finding.question.trim().length > MAX_CONSISTENCY_QUESTION_LENGTH,
    )
  ) {
    return { ok: false, reason: "A finding was too long." };
  }
  const statedIds = new Set(statedClaimsInReadingOrder(session).map((claim) => claim.claimId));
  const prior = session.consistencyReview?.findings ?? [];
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

  const findings: ConsistencyFinding[] = [];
  for (const candidate of output.findings) {
    if (candidate.relatedClaimIds.some((claimId) => !statedIds.has(claimId))) {
      return { ok: false, reason: "The review cited a claim it was not given." };
    }
    const question = candidate.question.trim();
    if (question === "") return { ok: false, reason: "The review returned an empty question." };
    const earlier =
      candidate.priorFindingId === null ? undefined : priorById.get(candidate.priorFindingId);
    findings.push({
      findingId: earlier?.findingId ?? context.newId(),
      category: candidate.category,
      targetField: candidate.targetField,
      relatedClaimIds: candidate.relatedClaimIds,
      question,
      // A question already put to the person is not put again because it was reworded.
      wasOffered: earlier?.wasOffered ?? false,
    });
  }

  const timestamp = context.now();
  return {
    ok: true,
    session: {
      ...session,
      updatedAt: timestamp,
      consistencyReview: {
        basis: consistencyBasisOf(session),
        checkedAt: timestamp,
        findings,
        offeredTotal: session.consistencyReview?.offeredTotal ?? 0,
      },
    },
    raisedCount: output.findings.filter((finding) => finding.priorFindingId === null).length,
    carriedCount: carriedIds.length,
    resolvedCount: output.resolvedPriorFindingIds.length,
  };
}

/**
 * Records that a finding's question was handed to the agent, so it is not offered again and the
 * session's budget shrinks. It changes the review's bookkeeping and nothing else: this is not a
 * claim write.
 */
export function markConsistencyQuestionOffered(
  session: SopSession,
  findingId: string,
  context: WriteContext,
): SopSession {
  const review = session.consistencyReview;
  const finding = review?.findings.find((candidate) => candidate.findingId === findingId);
  if (review === null || review === undefined || finding === undefined || finding.wasOffered) {
    return session;
  }
  return {
    ...session,
    updatedAt: context.now(),
    consistencyReview: {
      ...review,
      offeredTotal: Math.min(review.offeredTotal + 1, MAX_CONSISTENCY_QUESTIONS_PER_SESSION),
      findings: review.findings.map((candidate) =>
        candidate.findingId === findingId ? { ...candidate, wasOffered: true } : candidate,
      ),
    },
  };
}

/**
 * What to do when a review could not be made: say the review on file is the one for the claims as
 * they are now, so the failed attempt is not repeated until the claims change again (a model that
 * keeps failing or timing out costs one attempt, not one per message). Only the findings already put
 * to the person stay, so a later successful review can carry them on. A finding still waiting is
 * dropped: it was written for claims that have since changed, and the person may have answered it or
 * removed what it was about.
 */
export function keepConsistencyReviewForCurrentClaims(
  session: SopSession,
  context: WriteContext,
): SopSession {
  const timestamp = context.now();
  return {
    ...session,
    updatedAt: timestamp,
    consistencyReview: {
      basis: consistencyBasisOf(session),
      checkedAt: timestamp,
      findings: (session.consistencyReview?.findings ?? []).filter((finding) => finding.wasOffered),
      offeredTotal: session.consistencyReview?.offeredTotal ?? 0,
    },
  };
}
