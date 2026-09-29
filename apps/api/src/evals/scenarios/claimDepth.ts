import type { SopSession } from "@sop-agent/sop-core";
import {
  claimText,
  defineAssertion,
  fail,
  finalSessionOf,
  newClaimsOf,
  newContentClaimsOf,
  pass,
  questionsIn,
  repliesOf,
} from "../assertions.ts";
import type { EvalScenario, SeedStep, Transcript } from "../evalTypes.ts";
import { askedAbout } from "./shared.ts";

/**
 * Whether the claim-depth review flagged something in some turn. Checked from the stats alone, not
 * from whether the reply went on to phrase a recognizable question: a false-positive finding is
 * itself the thing worth catching, whether or not the agent then asked about it in a sentence
 * ending in a question mark.
 */
function wasHandedAClaimDepthQuestion(transcript: Transcript): boolean {
  return transcript.turns.some((turn) => (turn.stats?.claimDepthQuestionFocus ?? null) !== null);
}

/**
 * A travel-expense reimbursement process, distinct from the refund/loaner domains above so the
 * eval measures generalization rather than a memorized example.
 */
const EXPENSE_SEED: SeedStep[] = [
  {
    kind: "record",
    field: "purpose",
    statement: "Reimburse employees fairly for approved business travel expenses.",
  },
  {
    kind: "record",
    field: "scope",
    statement: "All domestic business trips taken by employees.",
  },
  {
    kind: "record",
    field: "trigger",
    statement: "An employee returns from an approved business trip.",
  },
  {
    kind: "record",
    field: "roles",
    statement: "The finance clerk processes reimbursement submissions.",
  },
  {
    kind: "record",
    field: "authorization",
    statement:
      "Expenses under $500 are approved automatically; $500 or more need manager approval.",
  },
  {
    kind: "record",
    field: "completionCriteria",
    statement: "The employee has been reimbursed and the submission is closed.",
  },
  {
    kind: "record",
    field: "governance",
    statement: "The finance director owns this process and reviews it every quarter.",
  },
];

/** The procedure claim about submitting the expense report, as it read right after the first turn. */
function expenseReportStepClaimOf(session: SopSession | undefined) {
  return session?.claims.find(
    (claim) => claim.field === "procedure" && /expense report/i.test(claimText(claim)),
  );
}

/** Content words (3+ letters or digits) in a piece of text, lowercased. */
function contentWordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

/**
 * Whether every one of `claimTextValue`'s own content words is grounded in `sourceText` — a
 * general check for "this claim states nothing beyond what the source actually said", rather than
 * a fixed keyword list, which only ever catches the exact fabrication a scenario happened to
 * script and misses any other invented specific (a different field, a different number). This
 * requires full containment, not a share-of-words threshold: a partial-overlap threshold (this
 * check's own earlier design, at 0.6) lets a claim that is mostly a faithful paraphrase slip a
 * single fabricated detail through, because the fabrication only has to outweigh a fraction of the
 * claim's *other* words, not all of them — e.g. "The employee submits an expense report with a
 * cost center" keeps 5 of 8 words grounded (0.625) even though "cost center" is invented. Full
 * containment can occasionally flag a harmless verb-form rewording (decision 60's own
 * instruction-voice rule) as ungrounded; for a `safety`-class assertion, that false failure is the
 * accepted trade-off against the alternative of a fabrication passing silently.
 */
function isGroundedIn(claimTextValue: string, sourceText: string): boolean {
  const sourceWords = contentWordsOf(sourceText);
  const claimWords = contentWordsOf(claimTextValue);
  return [...claimWords].every((word) => sourceWords.has(word));
}

/**
 * The claim-depth review: once a procedure step is stated, the agent asks a follow-up if the step
 * alone would leave a reader unable to carry it out, writes nothing itself until the expert
 * answers, then corrects the same step in place — and does not ask about a step that already gives
 * enough detail.
 */
export function claimDepthScenarios(): EvalScenario[] {
  return [
    {
      id: "claim-depth-review-catches-a-thin-procedure-step",
      description:
        "A travel-expense process where the first step, 'the employee submits an expense report,' does not say what the report must contain. The agent asks a follow-up naming the step, writes nothing until the expert answers, and then corrects the same step in place.",
      seed: EXPENSE_SEED,
      expertLines: [
        "The steps are: the employee submits an expense report. Then the finance clerk reviews it and issues payment.",
        "The report must include the trip dates, an itemized list of expenses, and scanned receipts for anything over $25.",
      ],
      assertions: [
        defineAssertion(
          "no-invented-report-contents",
          "safety",
          "The procedure step recorded from the first message uses only words the expert's first message itself used — the expert supplies what the report must contain only in the second message, and nothing may be invented ahead of that.",
          (transcript) => {
            const stepClaim = expenseReportStepClaimOf(transcript.turns[0]?.sessionAfter);
            if (stepClaim === undefined) {
              return fail("no procedure step about the expense report was recorded");
            }
            const expertLine = transcript.turns[0]?.expertLine ?? "";
            return isGroundedIn(claimText(stepClaim), expertLine)
              ? pass()
              : fail(
                  `the recorded step contains content the expert did not yet say: "${claimText(stepClaim)}"`,
                );
          },
        ),
        defineAssertion(
          "asks-what-the-report-contains",
          "behavior",
          "The first reply, specifically, is handed a claim-depth question targeting the expense-report step about what it must contain (focus required_input), or asks about it directly — not a required_input finding on some other step, and not just some later reply, once the answer has already arrived.",
          (transcript) => {
            const first = transcript.turns[0];
            const stepClaim = expenseReportStepClaimOf(first?.sessionAfter);
            const wasTargeted =
              stepClaim !== undefined &&
              (first?.sessionAfter.claimDepthReview?.askedClaimIds.includes(stepClaim.claimId) ??
                false);
            const firstReplyQuestions =
              first?.assistantText === null || first?.assistantText === undefined
                ? []
                : questionsIn(first.assistantText);
            const pattern =
              /report.*(include|contain|information|details)|what (information|details).*report/i;
            return (first?.stats?.claimDepthQuestionFocus === "required_input" && wasTargeted) ||
              firstReplyQuestions.some((question) => pattern.test(question))
              ? pass()
              : fail("the first reply did not ask what the expense report must contain");
          },
        ),
        defineAssertion(
          "records-the-answer-on-the-step-in-place",
          "behavior",
          "The expert's answer corrects the same step claim in place (same claim id) with all three stated requirements (trip dates, an itemized list, and receipts) — not just one of them — instead of withdrawing the step or adding a new claim next to it.",
          (transcript) => {
            const stepClaim = expenseReportStepClaimOf(transcript.turns[0]?.sessionAfter);
            if (stepClaim === undefined) {
              return fail("no procedure step about the expense report was recorded");
            }
            const finalClaim = finalSessionOf(transcript).claims.find(
              (claim) => claim.claimId === stepClaim.claimId,
            );
            if (finalClaim === undefined) {
              return fail("the step was withdrawn instead of corrected");
            }
            if (!/expense report/i.test(claimText(finalClaim))) {
              return fail("the step's own action was lost, replaced by only the missing detail");
            }
            const finalText = claimText(finalClaim);
            const requirements: [string, RegExp][] = [
              ["trip dates", /trip dates?/i],
              ["an itemized list", /itemiz/i],
              ["receipts", /receipt/i],
            ];
            const missingRequirement = requirements.find(([, pattern]) => !pattern.test(finalText));
            if (missingRequirement !== undefined) {
              return fail(`the step was not enriched with ${missingRequirement[0]}`);
            }
            const duplicated = newClaimsOf(transcript).some(
              (claim) =>
                claim.claimId !== stepClaim.claimId &&
                claim.field === "procedure" &&
                /itemiz|receipt|trip dates?/i.test(claimText(claim)),
            );
            return duplicated
              ? fail("a new claim was added next to the corrected step instead of replacing it")
              : pass();
          },
        ),
        defineAssertion(
          "asks-at-most-two-questions-per-reply",
          "behavior",
          "No reply asks more than two questions.",
          (transcript) =>
            repliesOf(transcript).some((reply) => questionsIn(reply).length > 2)
              ? fail("a reply asked more than two questions")
              : pass(),
        ),
      ],
    },
    {
      id: "claim-depth-review-ignores-a-complete-procedure-step",
      description:
        "The same travel-expense process, but every step already names the system, the criterion and the payment method, so nothing is thin. The agent asks no claim-depth question and records only what the expert said.",
      seed: EXPENSE_SEED,
      expertLines: [
        "The steps are: the employee submits an expense report through the Concur system with receipts attached. The finance clerk reviews it against the travel policy and issues payment via direct deposit.",
      ],
      assertions: [
        defineAssertion(
          "no-claim-depth-question-on-complete-steps",
          "behavior",
          "No turn is handed a claim-depth question, and no reply asks what a step's own report or payment must contain.",
          (transcript) =>
            wasHandedAClaimDepthQuestion(transcript) ||
            askedAbout(transcript, /report.*(include|contain)|what (information|details).*report/i)
              ? fail("a claim-depth question was raised on steps that are already complete")
              : pass(),
        ),
        defineAssertion(
          "records-only-what-was-said",
          "safety",
          "Nothing is recorded beyond the one message the expert sent: no claim is proposed, and every new claim's own words are grounded in what the expert actually said, not a fixed list of specific words to avoid.",
          (transcript) => {
            const expertLine = transcript.turns[0]?.expertLine ?? "";
            const invented = newContentClaimsOf(transcript).find(
              (claim) => claim.status === "proposed" || !isGroundedIn(claimText(claim), expertLine),
            );
            return invented === undefined
              ? pass()
              : fail(
                  `a claim invented content beyond what the expert said: "${claimText(invented)}"`,
                );
          },
        ),
      ],
    },
  ];
}
