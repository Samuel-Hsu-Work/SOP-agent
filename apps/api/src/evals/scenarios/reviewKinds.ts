import {
  claimText,
  defineAssertion,
  fail,
  finalSessionOf,
  newContentClaimsOf,
  pass,
  questionsIn,
} from "../assertions.ts";
import type { EvalScenario, SeedStep, Transcript } from "../evalTypes.ts";

/**
 * An office-supply purchasing process that states two things only the consistency review's other
 * two categories catch: an ordering deadline with nothing said about missing it, and "small" and
 * "large" purchases with no amount. Everything else is spelled out, including where the finance
 * director comes in and what happens to a rejected request, so the other categories have nothing
 * to find.
 */
const PURCHASING_SEED: SeedStep[] = [
  {
    kind: "record",
    field: "purpose",
    statement: "Keep office supply spending controlled and traceable.",
  },
  {
    kind: "record",
    field: "scope",
    statement: "All office supply purchases made by staff at the head office.",
  },
  {
    kind: "record",
    field: "trigger",
    statement: "A staff member needs office supplies that are not in the supply cabinet.",
  },
  {
    kind: "record",
    field: "roles",
    statement: "The office manager reviews every purchase request.",
  },
  { kind: "record", field: "roles", statement: "The finance director approves large purchases." },
  {
    kind: "record",
    field: "procedure",
    statement:
      "The staff member submits a purchase request in the purchasing system with the item, the quantity, the supplier and the price.",
  },
  {
    kind: "record",
    field: "procedure",
    statement:
      "The office manager checks that the supplier is on the approved supplier list in the purchasing system.",
  },
  {
    kind: "record",
    field: "procedure",
    statement:
      "The office manager approves the request in the purchasing system, or forwards it there to the finance director for approval.",
  },
  {
    kind: "record",
    field: "procedure",
    statement:
      "The office manager places the order with the supplier within 3 business days of approval.",
  },
  {
    kind: "record",
    field: "authorization",
    statement:
      "The office manager approves small purchases; large purchases need the finance director's approval.",
  },
  {
    kind: "record",
    field: "completionCriteria",
    statement:
      "The supplies are delivered and the purchase request is closed in the purchasing system.",
  },
  {
    kind: "record",
    field: "governance",
    statement: "The office manager owns this procedure and reviews it every year.",
  },
  {
    kind: "record",
    field: "exceptions",
    statement:
      "If a request is rejected or its supplier is not approved, the approver records the reason in the purchasing system and the staff member may resubmit it.",
  },
];

/**
 * A goods-receiving and inspection process with three procedure steps each thin in a different way,
 * one per claim-depth focus the travel-expense scenarios do not reach: what a check is made against,
 * where a report goes, and what a step produces. The first step is complete, as a control.
 */
const INSPECTION_SEED: SeedStep[] = [
  {
    kind: "record",
    field: "purpose",
    statement: "Make sure every delivered part meets the quality standard before it is used.",
  },
  {
    kind: "record",
    field: "scope",
    statement: "All parts delivered to the main plant's receiving dock.",
  },
  {
    kind: "record",
    field: "trigger",
    statement: "A supplier delivery arrives at the receiving dock.",
  },
  {
    kind: "record",
    field: "roles",
    statement: "The receiving clerk logs deliveries and prepares accepted parts for production.",
  },
  {
    kind: "record",
    field: "roles",
    statement: "The quality inspector checks deliveries and reports defects.",
  },
  {
    kind: "record",
    field: "procedure",
    statement:
      "The receiving clerk logs each delivery in the receiving system with the supplier, the purchase order number and the quantity received.",
  },
  {
    kind: "record",
    field: "procedure",
    statement:
      "The quality inspector checks each delivery and records the result in the receiving system.",
  },
  {
    kind: "record",
    field: "procedure",
    statement:
      "The quality inspector writes an inspection report listing each defect found, its location and its severity.",
  },
  {
    kind: "record",
    field: "procedure",
    statement: "The receiving clerk prepares the accepted parts for the production line.",
  },
  {
    kind: "record",
    field: "authorization",
    statement:
      "The quality manager decides whether a delivery with defects is accepted or returned to the supplier.",
  },
  {
    kind: "record",
    field: "completionCriteria",
    statement: "Every delivery received that day has an inspection result in the receiving system.",
  },
  {
    kind: "record",
    field: "governance",
    statement: "The quality manager owns this procedure and reviews it every year.",
  },
];

/**
 * Whether some turn was handed a claim-depth question with this focus about the step matching
 * `stepPattern`, and its reply asked something. The step is the one the turn marked offered, so a
 * focus the review attached to some other step does not count.
 */
function wasHandedClaimDepthQuestionAbout(
  transcript: Transcript,
  focus: string,
  stepPattern: RegExp,
): boolean {
  return transcript.turns.some((turn) => {
    if (turn.stats?.claimDepthQuestionFocus !== focus) return false;
    if (turn.assistantText === null || questionsIn(turn.assistantText).length === 0) return false;
    const targetId = turn.sessionAfter.claimDepthReview?.lastOfferedClaimId;
    const target = turn.sessionAfter.claims.find((claim) => claim.claimId === targetId);
    return target !== undefined && stepPattern.test(claimText(target));
  });
}

/**
 * Whether some turn was handed a consistency question of this category about the intended topic:
 * the finding that turn offered either cites a claim matching `claimPattern` or asks about it in
 * words matching `questionPattern`. A finding the review merely labelled with the category, about
 * something else, does not count.
 */
function wasHandedConsistencyQuestionAbout(
  transcript: Transcript,
  category: string,
  claimPattern: RegExp,
  questionPattern: RegExp,
): boolean {
  return transcript.turns.some((turn) => {
    if (turn.stats?.consistencyQuestionCategory !== category) return false;
    if (turn.assistantText === null || questionsIn(turn.assistantText).length === 0) return false;
    const offered = (turn.sessionAfter.consistencyReview?.findings ?? []).filter(
      (finding) => finding.category === category && finding.offeredSequence !== undefined,
    );
    const latest = offered.reduce<(typeof offered)[number] | undefined>(
      (newest, finding) =>
        newest === undefined || (finding.offeredSequence ?? 0) > (newest.offeredSequence ?? 0)
          ? finding
          : newest,
      undefined,
    );
    if (latest === undefined) return false;
    const citesTopic = latest.relatedClaimIds.some((id) => {
      const claim = turn.sessionAfter.claims.find((candidate) => candidate.claimId === id);
      return claim !== undefined && claimPattern.test(claimText(claim));
    });
    return citesTopic || questionPattern.test(latest.question);
  });
}

/**
 * The remaining review kinds, each checked against the live model at least once: the consistency
 * review's deadline and vague-threshold categories, and the claim-depth review's criterion,
 * handoff and result focuses. The expert never answers, so every question stays open and the next
 * one gets a turn.
 */
export function remainingReviewKindScenarios(): EvalScenario[] {
  const declined = [
    "I'm not sure about that one. What else should we cover?",
    "I don't know that either. Is there anything else?",
    "Not sure. Anything else?",
  ];
  const handedCategory = (
    id: string,
    category: string,
    claimPattern: RegExp,
    questionPattern: RegExp,
    description: string,
  ) =>
    defineAssertion(id, "behavior", description, (transcript) =>
      wasHandedConsistencyQuestionAbout(transcript, category, claimPattern, questionPattern)
        ? pass()
        : fail(`no turn was handed a ${category} question about the intended topic`),
    );
  const handedFocus = (id: string, focus: string, stepPattern: RegExp, description: string) =>
    defineAssertion(id, "behavior", description, (transcript) =>
      wasHandedClaimDepthQuestionAbout(transcript, focus, stepPattern)
        ? pass()
        : fail(`no turn was handed a ${focus} claim-depth question about the intended step`),
    );
  const recordsNothing = defineAssertion(
    "records-nothing-from-a-question",
    "safety",
    "The expert never gives a new fact, so no statement is added or changed, and every seeded claim is still there with its status unchanged: nothing is withdrawn, and nothing already stated is marked unknown. Marking an empty field unknown after the expert says they do not know is allowed.",
    (transcript) => {
      if (newContentClaimsOf(transcript).length > 0) {
        return fail("a statement was recorded or changed from a question alone");
      }
      const finalById = new Map(
        finalSessionOf(transcript).claims.map((claim) => [claim.claimId, claim]),
      );
      const altered = transcript.seedSession.claims.find(
        (claim) => finalById.get(claim.claimId)?.status !== claim.status,
      );
      return altered === undefined
        ? pass()
        : fail(`a seeded ${altered.field} claim was withdrawn or changed status`);
    },
  );

  return [
    {
      id: "consistency-review-raises-a-missed-deadline-and-a-vague-threshold",
      description:
        "An office-supply purchasing process that orders within 3 business days with nothing said about missing that, and splits approval into 'small' and 'large' purchases with no amount. The agent raises both as questions, one at a time, and records nothing.",
      seed: PURCHASING_SEED,
      expertLines: ["I think that covers everything. Is it ready?", ...declined],
      assertions: [
        recordsNothing,
        handedCategory(
          "raises-the-deadline-with-no-consequence",
          "deadline_without_consequence",
          /within 3 business days|every year/i,
          /3 business days|within 3|not placed|late|missed|overdue|every year|annual/i,
          "Some turn is handed a deadline_without_consequence question about one of the SOP's own time limits (placing the order within 3 business days, or the yearly review), such as what happens when the order is not placed in time.",
        ),
        handedCategory(
          "raises-the-vague-threshold",
          "imprecise_threshold_or_term",
          /small purchases|large purchases/i,
          /small|large|what amount|how much|threshold/i,
          "Some turn is handed an imprecise_threshold_or_term question about 'small' and 'large' purchases, such as what amount makes a purchase large.",
        ),
      ],
    },
    {
      id: "claim-depth-review-asks-for-a-criterion-a-handoff-and-a-result",
      description:
        "A goods-inspection process with one complete step and three thin ones: a check with nothing to check against, a report with no recipient, and a preparation step with no stated result. The expert declines each question, and the agent asks the next one, recording nothing.",
      seed: INSPECTION_SEED,
      expertLines: [
        "I think that covers the whole process. Is it ready?",
        "I'd rather leave that step as it is for now. What else?",
        "Let's leave that one as it is too. Anything else?",
        "Leave that as it is. What else?",
      ],
      assertions: [
        recordsNothing,
        handedFocus(
          "asks-what-the-check-is-against",
          "condition_or_criterion",
          /checks each delivery/i,
          "Some turn is handed a condition_or_criterion question about the step where the inspector checks each delivery, such as what it is checked against.",
        ),
        handedFocus(
          "asks-where-the-report-goes",
          "destination_or_handoff",
          /inspection report/i,
          "Some turn is handed a destination_or_handoff question about the inspection-report step, such as who receives the report.",
        ),
        handedFocus(
          "asks-what-the-step-produces",
          "observable_result",
          /prepares the accepted parts/i,
          "Some turn is handed an observable_result question about the step that prepares the accepted parts, such as what 'prepared for the production line' means once it is done.",
        ),
      ],
    },
  ];
}
