import { z } from "zod";
import { identifierSchema, timestampSchema } from "./claim.ts";
import { SOP_FIELD_NAMES } from "./sopFields.ts";

/**
 * The kinds of omission a consistency review looks for. Fixed, so a log line or a test can name one
 * and a model cannot invent a new kind. Each is about how the recorded claims relate to one
 * another, which no per-field check can see.
 */
export const CONSISTENCY_CATEGORIES = [
  /** A role or an authorization tier the claims mention, that no procedure step reaches. */
  "unreached_role_or_tier",
  /** A case with no stated path: a denial, a refusal, an ineligible request, a failure. */
  "missing_outcome_path",
  /** A stated deadline with no stated action when it is missed. */
  "deadline_without_consequence",
  /** A threshold or a term too vague for a reader to act on. */
  "imprecise_threshold_or_term",
] as const;

export type ConsistencyCategory = (typeof CONSISTENCY_CATEGORIES)[number];

export const MAX_CONSISTENCY_FINDINGS = 4;
/** The most consistency questions one session is ever asked, so the interview never becomes an interrogation. */
export const MAX_CONSISTENCY_QUESTIONS_PER_SESSION = 4;
export const MAX_CONSISTENCY_QUESTION_LENGTH = 300;
export const MAX_RELATED_CLAIMS = 3;

/**
 * Something the recorded claims do not say when read together, worded as one question. It is not a
 * claim: it has no status, source or authority, cannot be confirmed, and never gates an approval.
 * The question text was written by a model from the claims, so it is treated as data everywhere it
 * travels.
 */
export const consistencyFindingSchema = z.object({
  findingId: identifierSchema,
  category: z.enum(CONSISTENCY_CATEGORIES),
  /** The field where a person's answer would belong. */
  targetField: z.enum(SOP_FIELD_NAMES),
  /** The claims the question is about. They may have been removed since. */
  relatedClaimIds: z.array(identifierSchema).max(MAX_RELATED_CLAIMS),
  question: z.string().trim().min(1).max(MAX_CONSISTENCY_QUESTION_LENGTH),
  /** True once the agent was handed this question in a turn. Each finding is offered once. */
  wasOffered: z.boolean(),
});

export type ConsistencyFinding = z.infer<typeof consistencyFindingSchema>;

/**
 * The result of the latest consistency review, kept in the session so a finding is not asked twice
 * and the analysis is not repeated for the same claims. `basis` fingerprints the claims the review
 * saw: when the claims differ, the review is out of date.
 */
export const consistencyReviewSchema = z
  .object({
    basis: z.string().min(1).max(64),
    checkedAt: timestampSchema,
    findings: z.array(consistencyFindingSchema).max(MAX_CONSISTENCY_FINDINGS),
    /** Questions handed to the agent over the whole session, across every review. */
    offeredTotal: z.number().int().min(0).max(MAX_CONSISTENCY_QUESTIONS_PER_SESSION),
  })
  .superRefine((review, context) => {
    const ids = review.findings.map((finding) => finding.findingId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Finding ids must be unique.",
        path: ["findings"],
      });
    }
    if (review.findings.filter((finding) => finding.wasOffered).length > review.offeredTotal) {
      context.addIssue({
        code: "custom",
        message: "More findings are marked offered than the total offered.",
        path: ["offeredTotal"],
      });
    }
  });

export type ConsistencyReview = z.infer<typeof consistencyReviewSchema>;

/**
 * What the model returns from a consistency review. It carries no id of its own for a new finding,
 * no severity, no status and no suggested answer: code assigns ids, and nothing here can become a
 * claim. A finding that continues an earlier one names it in `priorFindingId`.
 *
 * The schema states no lengths or counts on purpose: it is sent to the provider as the required
 * output format, where such limits are not reliably supported, so `mergeConsistencyAnalysis`
 * enforces them and refuses an output that breaks one.
 */
export const consistencyAnalysisOutputSchema = z.object({
  findings: z.array(
    z.object({
      priorFindingId: z.string().nullable(),
      category: z.enum(CONSISTENCY_CATEGORIES),
      targetField: z.enum(SOP_FIELD_NAMES),
      relatedClaimIds: z.array(z.string()),
      question: z.string(),
    }),
  ),
  /** Earlier findings that the claims now answer. Every earlier finding is either here or carried. */
  resolvedPriorFindingIds: z.array(z.string()),
});

export type ConsistencyAnalysisOutput = z.infer<typeof consistencyAnalysisOutputSchema>;
