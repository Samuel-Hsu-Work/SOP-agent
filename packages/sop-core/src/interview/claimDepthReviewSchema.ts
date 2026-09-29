import { z } from "zod";
import { identifierSchema, timestampSchema } from "../claims/claim.ts";

/**
 * The kinds of operational detail a claim-depth review looks for. Fixed, so a log line or a test
 * can name one and a model cannot invent a new kind. Unlike the consistency review's categories,
 * this is about one claim's own completeness, judged in isolation, never a relationship between
 * two claims: "who does this" is left out on purpose, since decision 60's wording rule already
 * covers naming the actor when a procedure field has more than one.
 */
export const CLAIM_DEPTH_FOCUSES = [
  /** What the step's own artifact (a form, request or record) must contain. */
  "required_input",
  /** The condition or criterion an action is checked against. */
  "condition_or_criterion",
  /** Where the step's output goes, or who receives it. */
  "destination_or_handoff",
  /** What the step produces or confirms once done. */
  "observable_result",
] as const;

export type ClaimDepthFocus = (typeof CLAIM_DEPTH_FOCUSES)[number];

export const MAX_CLAIM_DEPTH_FINDINGS = 4;
/** The most claim-depth questions one session is ever asked, so the interview never becomes an interrogation. */
export const MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION = 4;
export const MAX_CLAIM_DEPTH_QUESTION_LENGTH = 200;

/**
 * One claim judged operationally too thin to act on, still waiting to be asked about. Not a claim:
 * it has no status, source or authority, cannot be confirmed, and never gates an approval. Once
 * offered, a finding is removed from the persisted review entirely (see `claimDepthReviewSchema`),
 * so every finding here is, by construction, one the agent has not yet asked about.
 */
export const claimDepthFindingSchema = z.object({
  findingId: identifierSchema,
  /** The claim whose own wording is too thin. Scoped to `procedure` steps in this release. */
  targetClaimId: identifierSchema,
  focus: z.enum(CLAIM_DEPTH_FOCUSES),
  question: z.string().trim().min(1).max(MAX_CLAIM_DEPTH_QUESTION_LENGTH),
});

export type ClaimDepthFinding = z.infer<typeof claimDepthFindingSchema>;

/**
 * The result of the latest claim-depth review, kept in the session so a claim is not asked about
 * twice and the analysis is not repeated for the same candidates. `basis` fingerprints the
 * candidate claims the review saw: when they differ, the review is out of date. Unlike the
 * consistency review, `findings` holds only unoffered findings — the moment one is offered it is
 * removed from this array and its claim id moves to `askedClaimIds` for good, so there is never
 * more than one "most recently offered" candidate to disambiguate.
 */
export const claimDepthReviewSchema = z
  .object({
    basis: z.string().min(1).max(64),
    checkedAt: timestampSchema,
    findings: z.array(claimDepthFindingSchema).max(MAX_CLAIM_DEPTH_FINDINGS),
    /** Questions handed to the agent over the whole session, across every review. */
    offeredTotal: z.number().int().min(0).max(MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION),
    /** Every claim id ever offered about, permanently: a step is asked about at most once, ever. */
    askedClaimIds: z.array(identifierSchema).max(MAX_CLAIM_DEPTH_QUESTIONS_PER_SESSION),
    /** The claim id of the most recently offered finding, so its target can still be corrected
     * once the person answers, even on a later turn. Resolved against the live session at read
     * time: if the claim was withdrawn since, there is simply nothing left to point at. */
    lastOfferedClaimId: identifierSchema.nullable(),
    /**
     * A fingerprint of that claim's own statement and note together, at the moment it was offered
     * (the review is told a note can already cover the missing detail, so the person's answer may
     * land in either). The person's answer is applied through the ordinary `correct_claim` tool,
     * which knows nothing of this bookkeeping, so nothing else marks the question resolved —
     * comparing the claim's current statement and note against this snapshot is what lets
     * `pendingClaimDepthTarget` notice the step was already corrected and stop exposing it, rather
     * than keep pointing at an already-answered step indefinitely and risking a later, unrelated
     * statement being applied to it instead.
     */
    lastOfferedClaimTextHash: z.string().length(8).nullable(),
  })
  .superRefine((review, context) => {
    const findingIds = review.findings.map((finding) => finding.findingId);
    if (new Set(findingIds).size !== findingIds.length) {
      context.addIssue({
        code: "custom",
        message: "Finding ids must be unique.",
        path: ["findings"],
      });
    }
    const targetIds = review.findings.map((finding) => finding.targetClaimId);
    if (new Set(targetIds).size !== targetIds.length) {
      context.addIssue({
        code: "custom",
        message: "At most one waiting finding per claim.",
        path: ["findings"],
      });
    }
    if (review.askedClaimIds.length > review.offeredTotal) {
      context.addIssue({
        code: "custom",
        message: "More claims are marked asked than the total offered.",
        path: ["askedClaimIds"],
      });
    }
  });

export type ClaimDepthReview = z.infer<typeof claimDepthReviewSchema>;

/**
 * What the model returns from a claim-depth review. It carries no id of its own for a new finding
 * and nothing here can become a claim. A finding that continues an earlier one names it in
 * `priorFindingId`. `targetField` is deliberately absent: since a finding always targets exactly
 * one claim, its field is derived from that claim in code, never chosen by the model.
 *
 * The schema states no lengths or counts on purpose: it is sent to the provider as the required
 * output format, where such limits are not reliably supported, so `mergeClaimDepthAnalysis`
 * enforces them and refuses an output that breaks one.
 */
export const claimDepthAnalysisOutputSchema = z.object({
  findings: z.array(
    z.object({
      priorFindingId: z.string().nullable(),
      targetClaimId: z.string(),
      focus: z.enum(CLAIM_DEPTH_FOCUSES),
      question: z.string(),
    }),
  ),
  /** Earlier findings the claims now cover well enough. Every earlier finding is here or carried. */
  resolvedPriorFindingIds: z.array(z.string()),
});

export type ClaimDepthAnalysisOutput = z.infer<typeof claimDepthAnalysisOutputSchema>;
