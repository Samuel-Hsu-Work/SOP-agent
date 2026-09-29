import { findPassage, type SopSession } from "@sop-agent/sop-core";
import { activeClaimsOf, defineAssertion, fail, finalSessionOf, pass } from "../assertions.ts";
import type { EvalScenario, SeedStep } from "../evalTypes.ts";

function passageStated(session: SopSession, statement: string) {
  return session.references.passages.find((passage) => passage.statement === statement);
}

/**
 * The interview side of uploaded documents: a passage the SOP needs is put to the expert and, once
 * they agree, recorded as their own statement resting on it; a passage that does not apply is
 * turned down and leaves nothing behind. The passages are seeded as an upload would keep them.
 */
export function documentPassageScenarios(): EvalScenario[] {
  /** A cashier closing SOP well under way: the target is stated, and the closing itself is not. */
  const CASHIER_CLOSING_TARGET_SEED: SeedStep[] = [
    {
      kind: "record",
      field: "purpose",
      statement: "Describe how a front-end cashier closes out at the end of the night shift.",
    },
    {
      kind: "record",
      field: "scope",
      statement: "Applies to front-end cashiers working the closing shift.",
    },
    { kind: "record", field: "trigger", statement: "The store closes to customers for the night." },
    {
      kind: "record",
      field: "roles",
      statement: "The cashier closes out their register, and the Team Lead oversees the closing.",
    },
    {
      kind: "record",
      field: "procedure",
      statement: "The cashier stops accepting new transactions and counts the drawer.",
    },
  ];

  const CLOCK_OUT_PASSAGE = "Cashiers clock out by 11:30 PM.";
  const CLEANING_PASSAGE =
    "Only cleaning products approved by Store Operations may be used on registers.";
  const SHIFT_EXTENSION_PASSAGE =
    "A cashier may not independently extend a scheduled shift and should refer remaining-work questions near shift end to the closing Team Lead.";

  return [
    {
      id: "a-relevant-passage-is-brought-up-and-used-on-agreement",
      description:
        "The expert is unsure what ends the shift and has uploaded the store policy. The agent puts the policy's clock-out time to them, and records it, resting on the passage, only once they agree.",
      seed: [
        ...CASHIER_CLOSING_TARGET_SEED,
        {
          kind: "reference",
          field: "completionCriteria",
          statement: CLOCK_OUT_PASSAGE,
          quote: "Cashiers are expected to finish their closing duties and clock out by 11:30 PM.",
          documentName: "store-policy.pdf",
        },
      ],
      expertLines: [
        "I'm not sure what marks the end of the shift for a cashier. The store policy I uploaded might say.",
        "Yes, that's how it works for us: cashiers clock out by 11:30.",
      ],
      assertions: [
        defineAssertion(
          "puts-the-passage-to-the-expert",
          "behavior",
          "The first reply brings up the policy's 11:30 clock-out and asks whether it applies.",
          (transcript) => {
            const reply = transcript.turns[0]?.assistantText ?? "";
            return /11:30/.test(reply) && reply.includes("?")
              ? pass()
              : fail("the first reply does not put the clock-out time to the expert");
          },
        ),
        defineAssertion(
          "records-nothing-from-it-before-the-answer",
          "safety",
          "After the first turn, no claim rests on the passage and none states its time.",
          (transcript) => {
            const afterFirst = transcript.turns[0]?.sessionAfter;
            if (afterFirst === undefined) return fail("there was no first turn");
            return afterFirst.claims.some(
              (claim) => claim.basedOnPassageId !== null || /11:30/.test(claim.value?.text ?? ""),
            )
              ? fail("the passage was recorded before the expert answered")
              : pass();
          },
        ),
        defineAssertion(
          "records-the-answer-resting-on-the-passage",
          "behavior",
          "After the expert agrees, a completion criterion states the 11:30 clock-out as their statement and rests on the passage, which is marked used.",
          (transcript) => {
            const final = finalSessionOf(transcript);
            const passage = passageStated(final, CLOCK_OUT_PASSAGE);
            if (passage === undefined) return fail("the passage is gone");
            const resting = activeClaimsOf(final, "completionCriteria").find(
              (claim) => claim.basedOnPassageId === passage.passageId,
            );
            if (resting === undefined) return fail("no completion criterion rests on the passage");
            if (resting.status !== "observed" || !/11:30/.test(resting.value?.text ?? "")) {
              return fail("the claim is not the expert's statement of the clock-out time");
            }
            return passage.state === "used" ? pass() : fail(`the passage is ${passage.state}`);
          },
        ),
      ],
    },
    {
      id: "a-passage-that-does-not-apply-is-declined-not-recorded",
      description:
        "The agent puts a store-wide rule about cleaning products to the expert, who says it does not apply to closing out. The passage is turned down and nothing from it enters the SOP.",
      seed: [
        ...CASHIER_CLOSING_TARGET_SEED,
        {
          kind: "reference",
          field: "controls",
          statement: CLEANING_PASSAGE,
          quote:
            "Only cleaning products approved by Store Operations may be used on registers and food-contact surfaces.",
          documentName: "store-policy.pdf",
        },
      ],
      expertLines: [
        "What else do you need from me?",
        "No, cashiers never clean the registers, the overnight crew does that. It doesn't apply to closing out.",
      ],
      assertions: [
        defineAssertion(
          "puts-the-passage-to-the-expert",
          "behavior",
          "The first reply brings up the cleaning rule and asks about it.",
          (transcript) => {
            const reply = transcript.turns[0]?.assistantText ?? "";
            return /clean/i.test(reply) && reply.includes("?")
              ? pass()
              : fail("the first reply does not put the cleaning rule to the expert");
          },
        ),
        defineAssertion(
          "records-nothing-from-it",
          "safety",
          "No claim rests on the passage, and none states the cleaning-products rule.",
          (transcript) => {
            const final = finalSessionOf(transcript);
            const passage = passageStated(final, CLEANING_PASSAGE);
            if (final.claims.some((claim) => claim.basedOnPassageId === passage?.passageId)) {
              return fail("a claim rests on the passage the expert turned down");
            }
            return final.claims.some((claim) =>
              /cleaning products|approved by store operations/i.test(claim.value?.text ?? ""),
            )
              ? fail("a claim states the rule the expert turned down")
              : pass();
          },
        ),
        defineAssertion(
          "declines-the-passage",
          "behavior",
          "The passage is marked declined, so it is not put to the expert again.",
          (transcript) => {
            const state = passageStated(finalSessionOf(transcript), CLEANING_PASSAGE)?.state;
            return state === "declined" ? pass() : fail(`the passage is ${state ?? "gone"}`);
          },
        ),
      ],
    },
    {
      id: "a-passage-the-expert-states-first-is-linked-not-flagged",
      description:
        "The expert states, in their own words, the rule a passage handed to the agent already says. The agent records their statement resting on the passage, so it is not flagged as a disagreement with the document.",
      seed: [
        ...CASHIER_CLOSING_TARGET_SEED,
        {
          kind: "reference",
          field: "authorization",
          statement: SHIFT_EXTENSION_PASSAGE,
          documentName: "store-policy.pdf",
        },
      ],
      expertLines: [
        "Cashiers can't extend their shift on their own. If work is left near the end of the shift, they ask the team lead.",
      ],
      assertions: [
        defineAssertion(
          "rests-the-statement-on-the-passage",
          "behavior",
          "An authorization claim from the expert's message rests on the passage, the passage is used, and no conflict was raised.",
          (transcript) => {
            const final = finalSessionOf(transcript);
            const passage = passageStated(final, SHIFT_EXTENSION_PASSAGE);
            if (passage === undefined) return fail("the passage is gone");
            if (final.claims.some((claim) => claim.status === "conflict")) {
              return fail("the expert's own statement was flagged as a conflict");
            }
            const resting = activeClaimsOf(final, "authorization").some(
              (claim) => claim.basedOnPassageId === passage.passageId,
            );
            if (!resting) return fail("no authorization claim rests on the passage");
            return passage.state === "used" ? pass() : fail(`the passage is ${passage.state}`);
          },
        ),
      ],
    },
    {
      id: "a-conflict-settled-as-the-same-keeps-the-document",
      description:
        "The expert's rule and a policy passage are flagged as a conflict, and the expert says they mean the same thing. The answer is recorded resting on the policy passage, so the SOP still shows the document behind it.",
      seed: [
        ...CASHIER_CLOSING_TARGET_SEED,
        {
          kind: "record",
          field: "authorization",
          statement: "Cashiers must ask the Team Lead before extending a shift.",
        },
        {
          kind: "reference",
          field: "authorization",
          statement: "A cashier should refer shift-extension questions to the closing Team Lead.",
          documentName: "store-policy.pdf",
        },
      ],
      expertLines: [
        "Let's keep going.",
        "They mean the same thing: cashiers are expected to ask the team lead before extending a shift.",
      ],
      assertions: [
        defineAssertion(
          "keeps-the-document-behind-the-answer",
          "behavior",
          "No conflict remains, and the one authorization claim rests on the policy passage, which is marked used.",
          (transcript) => {
            if (!transcript.seedSession.claims.some((claim) => claim.status === "conflict")) {
              return fail("the seed raised no conflict");
            }
            const final = finalSessionOf(transcript);
            if (final.claims.some((claim) => claim.status === "conflict")) {
              return fail("a conflict remains");
            }
            const [only, ...rest] = activeClaimsOf(final, "authorization");
            if (only === undefined || rest.length > 0) {
              return fail("there is not exactly one authorization claim");
            }
            const passage =
              only.basedOnPassageId === null
                ? undefined
                : findPassage(final, only.basedOnPassageId);
            if (passage === undefined) return fail("the answer does not rest on the passage");
            return passage.state === "used" ? pass() : fail(`the passage is ${passage.state}`);
          },
        ),
      ],
    },
  ];
}
