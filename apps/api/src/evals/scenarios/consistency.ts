import { isDeepStrictEqual } from "node:util";
import { computeGaps } from "@sop-agent/sop-core";
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
 * A refund process that a person described in full, so every field is filled and nothing blocks a
 * review, but which does not say everything: the Finance Director appears under roles and
 * authorization and no step reaches that tier, and nothing says what happens to a request that is
 * denied or ineligible. It is what a real run looked like, and the agent should notice.
 */
const REFUND_PROCESS_SEED: SeedStep[] = [
  {
    kind: "record",
    field: "purpose",
    statement: "Make every refund fair, consistent and traceable.",
  },
  {
    kind: "record",
    field: "scope",
    statement: "All refund requests for online orders placed in the last 30 days.",
  },
  {
    kind: "record",
    field: "trigger",
    statement: "A customer emails support or submits the refund form.",
  },
  { kind: "record", field: "roles", statement: "The Support Agent reviews the request." },
  { kind: "record", field: "roles", statement: "The Support Manager approves refunds above $200." },
  {
    kind: "record",
    field: "roles",
    statement: "The Finance Director approves refunds above $2,000.",
  },
  {
    kind: "record",
    field: "procedure",
    statement: "Log the request in the ticketing system and link the order.",
  },
  { kind: "record", field: "procedure", statement: "Check that the order is within 30 days." },
  {
    kind: "record",
    field: "procedure",
    statement: "Approve refunds up to $200, or send larger ones to the Support Manager.",
  },
  {
    kind: "record",
    field: "procedure",
    statement: "Finance issues the refund to the original payment method.",
  },
  { kind: "record", field: "procedure", statement: "Email the customer the outcome." },
  {
    kind: "record",
    field: "authorization",
    statement: "Agents up to $200, managers up to $2,000, and above that the Finance Director.",
  },
  {
    kind: "record",
    field: "completionCriteria",
    statement: "The customer has been told the outcome and the ticket is closed.",
  },
  {
    kind: "record",
    field: "governance",
    statement: "The Support Lead owns this procedure and reviews it every six months.",
  },
];

/** The same process with the two holes closed: a step for the top tier, and a path for a refusal. */
const COVERED_REFUND_PROCESS_SEED: SeedStep[] = [
  ...REFUND_PROCESS_SEED,
  {
    kind: "record",
    field: "procedure",
    statement:
      "Send refunds above $2,000 to the Finance Director, who decides based on the reason for the refund and the customer's order history.",
  },
  {
    kind: "record",
    field: "procedure",
    statement:
      "If a request is denied or the item is not eligible, email the customer the reason and offer an appeal to the Support Lead.",
  },
];

/**
 * An equipment-loaner process where the roles and procedure fields say a department head approves
 * anything worth "more than $500", but authorization draws the same line as "$500 or more" — the
 * exactly-$500 case is resolved two different ways. A live manual test found this exact bug.
 */
const LOANER_MISMATCH_SEED: SeedStep[] = [
  {
    kind: "record",
    field: "purpose",
    statement: "Make sure shared equipment is loaned fairly and comes back in working order.",
  },
  {
    kind: "record",
    field: "scope",
    statement: "All loans of department-owned equipment, such as laptops and monitors, to staff.",
  },
  {
    kind: "record",
    field: "trigger",
    statement: "A staff member submits a loan request form on the intranet.",
  },
  {
    kind: "record",
    field: "roles",
    statement: "The equipment coordinator reviews every loan request.",
  },
  {
    kind: "record",
    field: "roles",
    statement: "A department head approves loan requests for equipment worth more than $500.",
  },
  {
    kind: "record",
    field: "procedure",
    statement: "The requester submits the loan request form with the item and the dates.",
  },
  {
    kind: "record",
    field: "procedure",
    statement: "The equipment coordinator checks that the item is available for those dates.",
  },
  {
    kind: "record",
    field: "procedure",
    statement:
      "The equipment coordinator approves the request, or sends it to the department head if the equipment is worth more than $500.",
  },
  { kind: "record", field: "procedure", statement: "IT hands the equipment to the requester." },
  { kind: "record", field: "procedure", statement: "The requester signs the checkout sheet." },
  {
    kind: "record",
    field: "authorization",
    statement:
      "The equipment coordinator approves loans of equipment worth less than $500; loans worth $500 or more need department head approval.",
  },
  {
    kind: "record",
    field: "completionCriteria",
    statement: "The item is returned, checked and signed back in the loan log.",
  },
  {
    kind: "record",
    field: "governance",
    statement: "The facilities manager owns this procedure and reviews it every year.",
  },
];

/** The same process, but every restatement of the $500 line is a compatible, complementary wording. */
const LOANER_AGREEING_SEED: SeedStep[] = LOANER_MISMATCH_SEED.map((step) => {
  if (step.kind !== "record") return step;
  if (step.field === "roles" && step.statement.includes("more than $500")) {
    return { ...step, statement: step.statement.replace("more than $500", "over $500") };
  }
  if (step.field === "procedure" && step.statement.includes("more than $500")) {
    return { ...step, statement: step.statement.replace("more than $500", "above $500") };
  }
  if (step.field === "authorization") {
    return {
      ...step,
      statement:
        "The equipment coordinator approves loans of equipment worth up to $500; above $500 the department head approves.",
    };
  }
  return step;
}).concat([
  // Unrelated numbers, so the review must not flag figures that govern different things.
  { kind: "record", field: "scope", statement: "Loans last at most 14 days." },
  {
    kind: "record",
    field: "exceptions",
    statement: "A return more than 3 days late is reported to the department head.",
  },
]);

/** Wording that treats the boundary as exclusive: "more than", "over", "above" $500. */
const EXCLUSIVE_500_PATTERN = /(more than|over|above|exceed\w*|greater than)\s+\$?500\b/i;

/** Wording that treats the boundary as inclusive: "$500 or more", "at least $500", "$500 and up". */
const INCLUSIVE_500_PATTERN = /\$?500\s+(or more|and (?:above|up)\b)|at least\s+\$?500\b/i;

/** Whether the claims after this turn are exactly the claims the scenario started with. */
function claimsUnchangedAfterTurn(transcript: Transcript, turnIndex: number): boolean {
  const after = transcript.turns[turnIndex]?.sessionAfter.claims ?? transcript.seedSession.claims;
  return isDeepStrictEqual(after, transcript.seedSession.claims);
}

const TIER_QUESTION = /2,?000|finance director|top (?:approval )?tier|highest/i;

const REFUSAL_QUESTION =
  /denied|deny|declin|refus|reject|ineligible|not eligible|turned down|not approved|appeal/i;

/** A refused request, as opposed to what happens after a customer appeals one. */
const BASIC_REFUSAL_QUESTION =
  /denied|deny|declin|refus|reject|ineligible|not eligible|turned down|not approved/i;

/**
 * Whether the agent was handed a question of this kind in some turn, and its reply asked something.
 * The words a model uses for "what happens to a request that does not qualify" vary too much to
 * match, so the kind the review assigned counts as well as the words.
 */
function wasHandedQuestionOfKind(transcript: Transcript, category: string): boolean {
  return transcript.turns.some(
    (turn) =>
      turn.stats?.consistencyQuestionCategory === category &&
      turn.assistantText !== null &&
      questionsIn(turn.assistantText).length > 0,
  );
}

/**
 * The consistency review: once every field is filled the agent asks what the claims leave unsaid,
 * without writing anything itself, stops when the person is out of time, and does not ask about
 * what the SOP already covers.
 */
export function consistencyScenarios(): EvalScenario[] {
  return [
    {
      id: "consistency-gaps-are-raised-and-nothing-is-invented",
      description:
        "A fully described refund process has no step for the top approval tier and no path for a refused request. The agent raises them as questions, one at a time, and records nothing itself.",
      seed: REFUND_PROCESS_SEED,
      expertLines: [
        "I think that covers everything. Is it ready?",
        "I'm not sure about that one. What else should we cover?",
      ],
      assertions: [
        defineAssertion(
          "consistency-questions-invent-nothing",
          "safety",
          "The expert gave no new fact, so no claim is added, and none is recorded as the expert's word.",
          (transcript) => {
            const added = newContentClaimsOf(transcript);
            return added.length > 0
              ? fail(`${added.length} claim(s) were recorded from a question alone`)
              : pass();
          },
        ),
        defineAssertion(
          "consistency-question-does-not-open-a-gap",
          "safety",
          "Nothing that blocks a review appears because of a question. A field that already holds stated claims must not be marked unknown, because that would leave a blocking gap with no way to acknowledge it.",
          (transcript) =>
            computeGaps(finalSessionOf(transcript)).blockingGapCount > 0
              ? fail("a blocking gap was opened")
              : pass(),
        ),
        defineAssertion(
          "does-not-mark-a-field-unknown-for-a-question",
          "behavior",
          '"I\'m not sure" to a consistency question records nothing. Marking an empty advisory field unknown is harmless, and is the ordinary way to record that a person does not know, so it is watched here and not gated.',
          (transcript) =>
            finalSessionOf(transcript).claims.some((claim) => claim.status === "unknown")
              ? fail("a field was marked unknown")
              : pass(),
        ),
        defineAssertion(
          "raises-the-unreached-approval-tier",
          "behavior",
          "Some reply asks what happens above the last stated approval limit.",
          (transcript) =>
            askedAbout(transcript, TIER_QUESTION) ||
            wasHandedQuestionOfKind(transcript, "unreached_role_or_tier")
              ? pass()
              : fail("no reply asked about the Finance Director tier"),
        ),
        defineAssertion(
          "raises-the-missing-path-for-a-refusal",
          "behavior",
          "Some reply asks what happens to a request that is denied or does not qualify, such as an order past the return window.",
          (transcript) =>
            askedAbout(transcript, REFUSAL_QUESTION) ||
            wasHandedQuestionOfKind(transcript, "missing_outcome_path")
              ? pass()
              : fail("no reply asked about a refused request"),
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
        defineAssertion(
          "flags-no-mismatch-in-agreeing-thresholds",
          "behavior",
          'The refund SOP\'s own complementary wordings ("up to $200", "above $200", "larger ones", "up to $2,000") agree with each other and must never be reported as a restatement_mismatch.',
          (transcript) =>
            transcript.turns.some(
              (turn) => turn.stats?.consistencyQuestionCategory === "restatement_mismatch",
            )
              ? fail("a restatement_mismatch fired on wordings that actually agree")
              : pass(),
        ),
      ],
      judgedExpectation: {
        id: "asks-about-something-the-sop-does-not-say",
        question:
          "Does at least one reply ask about something the recorded SOP genuinely leaves out, such as what happens above the highest stated approval limit or what happens when a request is refused, instead of repeating something the SOP already answers?",
      },
    },
    {
      id: "consistency-questions-stop-when-the-expert-is-out-of-time",
      description:
        "The same process, and the expert says they are out of time. The agent asks no consistency question and records nothing.",
      seed: REFUND_PROCESS_SEED,
      expertLines: ["I'm out of time, that's everything."],
      assertions: [
        defineAssertion(
          "records-nothing-when-out-of-time",
          "safety",
          "No claim is added or changed.",
          (transcript) =>
            newContentClaimsOf(transcript).length > 0 ? fail("a claim was recorded") : pass(),
        ),
        defineAssertion(
          "asks-no-consistency-question",
          "behavior",
          "The reply asks about neither the top approval tier nor a refused request.",
          (transcript) =>
            askedAbout(transcript, TIER_QUESTION) || askedAbout(transcript, REFUSAL_QUESTION)
              ? fail("the reply put a consistency question to a person who is out of time")
              : pass(),
        ),
      ],
    },
    {
      id: "consistency-questions-skip-what-the-sop-already-covers",
      description:
        "The same process with a step for the top tier and a path for a refused request. The agent does not ask about either.",
      seed: COVERED_REFUND_PROCESS_SEED,
      expertLines: ["I think that covers everything. Is it ready?"],
      assertions: [
        defineAssertion(
          "does-not-re-ask-what-is-covered",
          "behavior",
          "No question is about routing to the top approval tier or what happens to a refused request. A question about what follows an appeal is a new one and is allowed. On a turn handed a claim-depth question about a step that itself names one of those topics, one question asking for that step's decision criteria is allowed: asking what criteria the Finance Director applies names the same role and amount as re-asking whether refunds reach them, but it is a different, legitimately open question. A routing or who-approves question still counts, on that turn too.",
          (transcript) => {
            const isAboutCoveredTopic = (text: string) =>
              TIER_QUESTION.test(text) ||
              (BASIC_REFUSAL_QUESTION.test(text) && !/appeal/i.test(text));
            const asksForDecisionCriteria = (text: string) =>
              /criteri|based on|\bbasis\b|assess|evaluat|weigh|judg/i.test(text) &&
              !/\bwho\b|\brout|\bsen[dt]\b|\breach|\bgo(?:es)? to\b/i.test(text);
            const reAsksCoveredTopic = transcript.turns.some((turn) => {
              if (turn.assistantText === null) return false;
              const depthTargetId =
                (turn.stats?.claimDepthQuestionFocus ?? null) === null
                  ? null
                  : turn.sessionAfter.claimDepthReview?.lastOfferedClaimId;
              const depthTarget = turn.sessionAfter.claims.find(
                (claim) => claim.claimId === depthTargetId,
              );
              const coveredQuestions = questionsIn(turn.assistantText).filter(isAboutCoveredTopic);
              const isDepthQuestionAsked =
                depthTarget !== undefined &&
                isAboutCoveredTopic(claimText(depthTarget)) &&
                coveredQuestions.some(asksForDecisionCriteria);
              return coveredQuestions.length > (isDepthQuestionAsked ? 1 : 0);
            });
            return reAsksCoveredTopic
              ? fail("the reply asked about something the SOP already says")
              : pass();
          },
        ),
        defineAssertion(
          "flags-no-mismatch-in-agreeing-thresholds",
          "behavior",
          "The covered refund SOP's complementary wordings must never be reported as a restatement_mismatch.",
          (transcript) =>
            transcript.turns.some(
              (turn) => turn.stats?.consistencyQuestionCategory === "restatement_mismatch",
            )
              ? fail("a restatement_mismatch fired on wordings that actually agree")
              : pass(),
        ),
      ],
    },
    {
      id: "consistency-review-raises-a-restated-threshold-that-disagrees",
      description:
        "An equipment-loaner process states a $500 approval threshold three times: two say 'more than $500', one says '$500 or more'. The agent raises the disagreement, writes nothing until the expert answers, and then corrects every affected claim in place.",
      seed: LOANER_MISMATCH_SEED,
      expertLines: [
        "I think that covers the whole process. Is it ready?",
        "Good point. A loan of exactly $500 needs the department head too, so it is $500 or more everywhere.",
      ],
      assertions: [
        defineAssertion(
          "mismatch-is-not-settled-by-the-agent",
          "safety",
          "Before the expert answers, the agent picks no side and writes nothing.",
          (transcript) =>
            claimsUnchangedAfterTurn(transcript, 0)
              ? pass()
              : fail("a claim changed before the expert answered the mismatch"),
        ),
        defineAssertion(
          "mismatch-question-does-not-open-a-gap",
          "safety",
          "Nothing that blocks a review appears because of the question, and no claim is marked unknown.",
          (transcript) =>
            computeGaps(finalSessionOf(transcript)).blockingGapCount > 0 ||
            finalSessionOf(transcript).claims.some((claim) => claim.status === "unknown")
              ? fail("a blocking gap was opened, or a field was marked unknown")
              : pass(),
        ),
        defineAssertion(
          "raises-the-500-boundary",
          "behavior",
          "The first reply is handed a restatement_mismatch, or asks about the $500 boundary.",
          (transcript) =>
            wasHandedQuestionOfKind(transcript, "restatement_mismatch") ||
            askedAbout(transcript, /\$?500\b.*(exactly|or more|more than|at least|over)/i)
              ? pass()
              : fail("no reply raised the $500 boundary disagreement"),
        ),
        defineAssertion(
          "settles-the-boundary-in-place",
          "behavior",
          "The expert's answer corrects every claim that used the exclusive wording, in place (same claim id, now saying '$500 or more' or an equivalent), instead of withdrawing it or adding a new claim next to it.",
          (transcript) => {
            const seedExclusiveIds = transcript.seedSession.claims
              .filter((claim) => EXCLUSIVE_500_PATTERN.test(claimText(claim)))
              .map((claim) => claim.claimId);
            if (seedExclusiveIds.length === 0) {
              return fail("the seed itself no longer contains the exclusive wording to correct");
            }
            const finalById = new Map(
              finalSessionOf(transcript).claims.map((claim) => [claim.claimId, claim]),
            );
            for (const claimId of seedExclusiveIds) {
              const current = finalById.get(claimId);
              if (current === undefined) {
                return fail(`claim ${claimId} was withdrawn instead of corrected`);
              }
              if (EXCLUSIVE_500_PATTERN.test(claimText(current))) {
                return fail(`claim ${claimId} still uses the exclusive '$500' wording`);
              }
              if (!INCLUSIVE_500_PATTERN.test(claimText(current))) {
                return fail(`claim ${claimId} no longer states the $500 rule at all`);
              }
            }
            const duplicated = newClaimsOf(transcript).some(
              (claim) =>
                (claim.field === "roles" ||
                  claim.field === "procedure" ||
                  claim.field === "authorization") &&
                /500/.test(claimText(claim)),
            );
            return duplicated
              ? fail("a new claim was added next to the corrected ones instead of replacing them")
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
      id: "consistency-review-ignores-restatements-that-agree",
      description:
        "The same equipment-loaner process, but every restatement of the $500 line is a compatible, complementary wording, and unrelated numbers are present too. The agent flags no mismatch and records nothing.",
      seed: LOANER_AGREEING_SEED,
      expertLines: ["I think that covers the whole process. Is it ready?"],
      assertions: [
        defineAssertion(
          "flags-no-mismatch-in-agreeing-restatements",
          "behavior",
          "No turn is handed a restatement_mismatch, and no reply asks about the $500 boundary as if it disagreed.",
          (transcript) =>
            wasHandedQuestionOfKind(transcript, "restatement_mismatch") ||
            askedAbout(transcript, /exactly \$?500|\$?500 or more/i)
              ? fail("a mismatch was raised on wordings that actually agree")
              : pass(),
        ),
        defineAssertion(
          "records-nothing-from-an-agreeing-sop",
          "safety",
          "The expert gave no new fact, so no claim is added or changed.",
          (transcript) =>
            newContentClaimsOf(transcript).length > 0
              ? fail("a claim was recorded from a question alone")
              : pass(),
        ),
      ],
    },
  ];
}
