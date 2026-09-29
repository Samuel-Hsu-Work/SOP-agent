import {
  activeClaimsOf,
  claimText,
  defineAssertion,
  fail,
  finalSessionOf,
  newContentClaimsOf,
  pass,
} from "../assertions.ts";
import type { EvalScenario, SeedStep } from "../evalTypes.ts";

/**
 * A grocery store's cashier closing process as it stood before the expert said the closing steps are
 * only suggestions: the purpose, a role and the completion criteria still read the tasks as
 * something to get done by clock-out. Taken from a live interview in which that one remark was
 * written into every procedure step and restated as new claims in four other fields.
 */
const CASHIER_CLOSING_SEED: SeedStep[] = [
  {
    kind: "record",
    field: "purpose",
    statement:
      "Make sure the cashier gets the closing tasks done before clocking out at 11:30 p.m.",
  },
  { kind: "record", field: "scope", statement: "This process applies to all cashiers every day." },
  {
    kind: "record",
    field: "trigger",
    statement: "Begin the closing process at 11:00 p.m., when the store officially closes.",
  },
  { kind: "record", field: "roles", statement: "The cashier performs the closing tasks." },
  {
    kind: "record",
    field: "roles",
    statement: "The team lead checks that the cashier completed the closing tasks.",
  },
  { kind: "record", field: "procedure", statement: "Clean the checkout belt." },
  { kind: "record", field: "procedure", statement: "Clean the bagging table." },
  { kind: "record", field: "procedure", statement: "Clean the scanner." },
  { kind: "record", field: "procedure", statement: "Clean the card terminal." },
  { kind: "record", field: "procedure", statement: "Put the floor mat on the cart." },
  {
    kind: "record",
    field: "procedure",
    statement: "Sort the returned items in the basket by the aisle number that matches each item.",
  },
  {
    kind: "record",
    field: "authorization",
    statement:
      "The team lead makes the final decision when a cashier cannot complete a task or decide alone.",
  },
  {
    kind: "record",
    field: "completionCriteria",
    statement: "The closing tasks are done by 11:30 p.m., when the cashier clocks out.",
  },
  {
    kind: "record",
    field: "governance",
    statement: "The team lead may change this procedure, and the store manager reviews changes.",
  },
];

/** Words that make a statement a requirement. The modality scenario's expert says none of them. */
const REQUIREMENT_WORDS =
  /\b(?:all|every|must|required|mandatory|always|shall|obliged|obligated|(?:has|have|needs?) to|is expected to)\b/i;

/** Words that carry the expert's "only suggestions" correction, however the agent phrases it. */
const SUGGESTION_WORDS =
  /suggest|optional|if possible|not (?:required|mandatory)|need not|do(?:es)? not have to|rather than (?:mandatory|required)/i;

/** A statement that only says something is not required, not checked or not done. */
const NEGATION_ONLY =
  /\b(?:not|no|never|don't|doesn't)\b.{0,40}\b(?:required|mandatory|check|checked|checks|compliance)\b/i;

/** A completion criterion that speaks of work left undone or optional, the sign of a non-answer. */
const LEAVES_WORK_UNDONE =
  /even if|unfinished|incomplete|not (?:required|done|complete|completed)|need not|do(?:es)? not have to|suggest|optional/i;

/** Says what marks the process as done: "the process ends when ...", "is complete once ...". */
const END_PHRASE =
  "(?:ends|finishes|is (?:complete|completed|done|finished|over)|are (?:complete|done|finished))";

const STATES_AN_END = new RegExp(
  `\\b${END_PHRASE}\\b[\\s\\S]{0,60}?\\b(?:when|once|after)\\b|\\b(?:when|once|after)\\b[\\s\\S]{0,80}?\\b${END_PHRASE}\\b`,
  "i",
);

/**
 * Two moments from a live interview whose finished SOP read oddly even though every sentence came
 * from the expert: a goal ("make sure the tasks get done") recorded as a hard rule ("all tasks must
 * be finished"), and a single correction ("the steps are only suggestions") repeated in every step
 * and restated as new claims in other fields.
 */
export function statementFidelityScenarios(): EvalScenario[] {
  return [
    {
      id: "a-goal-is-not-recorded-as-a-requirement",
      description:
        "The expert states a goal in soft words: make sure the cashier gets the tasks done before clocking out. The agent records it in those terms, or asks whether it is a requirement, but never turns it into 'all tasks must be finished'.",
      seed: [],
      expertLines: [
        "I want to document our grocery store's cashier closing. We want to make sure the cashier got tasks done before clock out at 11:30 pm.",
      ],
      assertions: [
        defineAssertion(
          "keeps-the-experts-strength-of-statement",
          "behavior",
          "No claim recorded from the expert's words says 'all', 'every', 'must', 'required', 'mandatory' or 'always': the expert used none of them.",
          (transcript) => {
            const inflated = newContentClaimsOf(transcript).find((claim) =>
              REQUIREMENT_WORDS.test(claimText(claim)),
            );
            return inflated === undefined
              ? pass()
              : fail(`a goal was recorded as a requirement: "${claimText(inflated)}"`);
          },
        ),
      ],
    },
    {
      id: "a-correction-is-recorded-once-not-in-every-claim",
      description:
        "A cashier closing SOP that reads the tasks as something to finish by clock-out, and the expert says the closing steps are only suggestions. The agent records that once, fixes only what it now contradicts, and never answers a field with what is not required.",
      seed: CASHIER_CLOSING_SEED,
      expertLines: [
        "closing steps does not really matter, just suggestion",
        "Right, the cashier can clock out at 11:30 even if some tasks are not done. The tasks are only suggestions.",
      ],
      assertions: [
        defineAssertion(
          "leaves-each-step-as-it-was",
          "behavior",
          "No procedure step is rewritten to carry the 'only a suggestion' qualifier: the steps themselves did not change, and the qualifier belongs in one place.",
          (transcript) => {
            const qualified = activeClaimsOf(finalSessionOf(transcript), "procedure").find(
              (claim) => SUGGESTION_WORDS.test(claimText(claim)),
            );
            return qualified === undefined
              ? pass()
              : fail(`a step was rewritten with the qualifier: "${claimText(qualified)}"`);
          },
        ),
        defineAssertion(
          "records-the-correction-once",
          "behavior",
          "The correction is recorded, as at most one new claim, and repeated in at most one claim outside decisionRules (where the rule belongs), completionCriteria and procedure (each checked by its own assertion). Rewriting a contradicted purpose may mention it once; copying it into several other claims, whether as new claims or by correcting existing ones, is the fan-out this scenario guards against.",
          (transcript) => {
            const seededIds = new Set(transcript.seedSession.claims.map((claim) => claim.claimId));
            const carrying = finalSessionOf(transcript).claims.filter(
              (claim) => claim.value !== null && SUGGESTION_WORDS.test(claimText(claim)),
            );
            if (carrying.length === 0) return fail("the correction was not recorded anywhere");
            const added = carrying.filter((claim) => !seededIds.has(claim.claimId));
            if (added.length > 1) {
              return fail(`the correction was added as ${added.length} new claims`);
            }
            const elsewhere = carrying.filter(
              (claim) =>
                claim.field !== "decisionRules" &&
                claim.field !== "completionCriteria" &&
                claim.field !== "procedure",
            );
            return elsewhere.length <= 1
              ? pass()
              : fail(
                  `the correction was repeated in ${elsewhere.length} other claims (${elsewhere.map((claim) => claim.field).join(", ")})`,
                );
          },
        ),
        defineAssertion(
          "adds-no-claim-that-only-says-what-is-not-required",
          "behavior",
          "No new claim only says that something is not required, not checked or not done, such as a control saying no check is made.",
          (transcript) => {
            const seededIds = new Set(transcript.seedSession.claims.map((claim) => claim.claimId));
            const negation = finalSessionOf(transcript).claims.find(
              (claim) =>
                !seededIds.has(claim.claimId) &&
                claim.value !== null &&
                NEGATION_ONLY.test(claimText(claim)),
            );
            return negation === undefined
              ? pass()
              : fail(`a claim only states a negation: "${claimText(negation)}"`);
          },
        ),
        defineAssertion(
          "completion-criteria-still-say-when-it-is-done",
          "behavior",
          "The seeded completion criterion, which says the tasks are done by 11:30 and so contradicts the answer, is corrected, withdrawn or marked unknown, and is not replaced by what is not required: a criterion that speaks of work left undone must still say what marks the process as done ('the process ends when ...'), or the field is marked unknown for the agent to ask about.",
          (transcript) => {
            const stale = transcript.seedSession.claims
              .filter((claim) => claim.field === "completionCriteria")
              .find((seeded) => {
                const now = finalSessionOf(transcript).claims.find(
                  (claim) => claim.claimId === seeded.claimId,
                );
                return (
                  now !== undefined &&
                  now.status === seeded.status &&
                  claimText(now) === claimText(seeded)
                );
              });
            if (stale !== undefined) {
              return fail(
                `the contradicted completion criterion was left as it was: "${claimText(stale)}"`,
              );
            }
            const nonAnswer = activeClaimsOf(finalSessionOf(transcript), "completionCriteria").find(
              (claim) =>
                claim.value !== null &&
                LEAVES_WORK_UNDONE.test(claimText(claim)) &&
                !STATES_AN_END.test(claimText(claim)),
            );
            return nonAnswer === undefined
              ? pass()
              : fail(
                  `the completion criteria now say what is not required: "${claimText(nonAnswer)}"`,
                );
          },
        ),
      ],
    },
  ];
}
