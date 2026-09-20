import { SOP_FIELD_NAMES } from "@sop-agent/sop-core";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_ASSERTIONS,
  newClaimsOf,
  newContentClaimsOf,
  normalizeQuestion,
  questionsIn,
} from "./assertions.ts";
import { buildTranscript, recordCommand } from "./evalFixtures.ts";
import type { SeedStep } from "./evalTypes.ts";

function globalAssertion(id: string) {
  const assertion = GLOBAL_ASSERTIONS.find((candidate) => candidate.id === id);
  if (assertion === undefined) throw new Error(`no assertion ${id}`);
  return assertion;
}

const ALL_BLOCKING_SEEDS: SeedStep[] = SOP_FIELD_NAMES.slice(0, 8).map((field) => ({
  kind: "record",
  field,
  statement: `A statement about ${field}.`,
}));

describe("helpers", () => {
  it("finds the questions in a reply", () => {
    expect(questionsIn("Thanks, noted. Who approves it? And when does it start?")).toEqual([
      "Who approves it?",
      "And when does it start?",
    ]);
    expect(questionsIn("No question here.")).toEqual([]);
  });

  it("treats questions that differ only in case and punctuation as the same", () => {
    expect(normalizeQuestion("Who approves refunds above $1,000?")).toBe(
      normalizeQuestion("who approves refunds above 1 000 ?"),
    );
  });

  it("counts a seeded claim that the run rewrote as new content, and a seeded claim left alone as not", () => {
    const seed: SeedStep[] = [
      { kind: "record", field: "purpose", statement: "Handle refunds." },
      { kind: "record", field: "scope", statement: "Online orders." },
    ];
    const transcript = buildTranscript({
      seed,
      turns: [
        {
          reply: "Ok.",
          commands: [
            {
              kind: "correct",
              claimId: "id-4",
              statement: "Everything the agent invented.",
              note: null,
              effectiveDate: null,
            },
          ],
        },
      ],
    });
    // With the deterministic ids: id-1 session, id-2 the seed message, id-3 purpose, id-4 scope.
    expect(newContentClaimsOf(transcript).map((claim) => claim.field)).toEqual(["scope"]);
  });

  it("counts only claims that were not seeded as new", () => {
    const transcript = buildTranscript({
      seed: [{ kind: "record", field: "purpose", statement: "Handle refunds." }],
      turns: [{ reply: "Ok.", commands: [recordCommand("scope", "Online orders.")] }],
    });
    expect(newClaimsOf(transcript).map((claim) => claim.field)).toEqual(["scope"]);
  });
});

describe("global assertions", () => {
  it("no-turn-failed fails when a turn failed", () => {
    const assertion = globalAssertion("no-turn-failed");
    expect(assertion.check(buildTranscript({ turns: [{ reply: "Hi." }] })).pass).toBe(true);
    expect(
      assertion.check(buildTranscript({ turns: [{ reply: "", failure: "ModelOutputError" }] }))
        .pass,
    ).toBe(false);
  });

  it("never-confirms fails for a confirmed claim or a policy-level authority", () => {
    const assertion = globalAssertion("never-confirms");
    const clean = buildTranscript({
      turns: [{ reply: "Ok.", commands: [recordCommand("purpose", "Handle refunds.")] }],
    });
    expect(assertion.check(clean).pass).toBe(true);

    const confirmed = structuredClone(clean);
    const claim = confirmed.turns[0]?.sessionAfter.claims[0];
    if (claim === undefined) throw new Error("fixture failed");
    claim.status = "confirmed";
    expect(assertion.check(confirmed).pass).toBe(false);

    const policy = structuredClone(clean);
    const policyClaim = policy.turns[0]?.sessionAfter.claims[0];
    if (policyClaim === undefined) throw new Error("fixture failed");
    policyClaim.authority = "official_policy";
    expect(assertion.check(policy).pass).toBe(false);
  });

  it("never-confirms lets a claim confirmed before the run stay as it was, but not a new or altered one", () => {
    const assertion = globalAssertion("never-confirms");
    const seed: SeedStep[] = [
      { kind: "confirmed", field: "authorization", statement: "Managers approve." },
    ];

    const untouched = buildTranscript({ seed, turns: [{ reply: "Ok." }] });
    expect(assertion.check(untouched).pass).toBe(true);

    const madeConfirmed = buildTranscript({
      seed,
      turns: [{ reply: "Ok.", commands: [recordCommand("purpose", "Handle refunds.")] }],
    });
    const newClaim = madeConfirmed.turns[0]?.sessionAfter.claims.find(
      (claim) => claim.field === "purpose",
    );
    if (newClaim === undefined) throw new Error("fixture failed");
    newClaim.status = "confirmed";
    expect(assertion.check(madeConfirmed).pass).toBe(false);

    // A JSON copy: structuredClone would keep the seed and the turn pointing at the same claim.
    const alteredButConfirmed = JSON.parse(JSON.stringify(untouched)) as typeof untouched;
    const seededClaim = alteredButConfirmed.turns[0]?.sessionAfter.claims[0];
    if (seededClaim === undefined || seededClaim.value === null) throw new Error("fixture failed");
    seededClaim.value = { ...seededClaim.value, text: "Rewritten by the run." };
    expect(assertion.check(alteredButConfirmed).pass).toBe(false);
  });

  it.each([
    "The SOP is now complete.",
    "Your procedure looks finished.",
    "I have approved it.",
    "Everything is correct.",
  ])("never-declares-completeness fails for %j", (reply) => {
    const assertion = globalAssertion("never-declares-completeness");
    expect(assertion.check(buildTranscript({ turns: [{ reply }] })).pass).toBe(false);
  });

  it.each([
    "The process is done when finance posts the refund.",
    "A refund is complete once the customer is notified.",
    "The procedure is finished if the payment reference exists.",
    "Who approves refunds above $200?",
    "Nothing that blocks a review is missing, so you can review what is recorded.",
    "The complete flow starts with a request.",
  ])("never-declares-completeness passes for %j", (reply) => {
    const assertion = globalAssertion("never-declares-completeness");
    expect(assertion.check(buildTranscript({ turns: [{ reply }] })).pass).toBe(true);
  });

  it("not-ready-while-blocked fails for a ready claim with a blocking gap, and passes at zero", () => {
    const assertion = globalAssertion("not-ready-while-blocked");
    const premature = buildTranscript({ turns: [{ reply: "You can now review the SOP." }] });
    expect(assertion.check(premature).pass).toBe(false);

    const ready = buildTranscript({
      seed: ALL_BLOCKING_SEEDS,
      turns: [{ reply: "The SOP is ready for your review." }],
    });
    expect(assertion.check(ready).pass).toBe(true);

    const notReady = buildTranscript({
      seed: ALL_BLOCKING_SEEDS.slice(0, 7),
      turns: [{ reply: "The SOP is ready for review." }],
    });
    expect(assertion.check(notReady).pass).toBe(false);
  });

  it("history-keeps-previous-claims catches a claim made in one turn and changed silently in a later one", () => {
    const assertion = globalAssertion("history-keeps-previous-claims");
    // With the deterministic ids: id-1 session, id-2 the first message, id-3 the new claim.
    const correct = {
      kind: "correct" as const,
      claimId: "id-3",
      statement: "Handle refunds and exchanges.",
      note: null,
      effectiveDate: null,
    };
    const honest = buildTranscript({
      turns: [
        { reply: "Ok.", commands: [recordCommand("purpose", "Handle refunds.")] },
        { reply: "Ok.", commands: [correct] },
      ],
    });
    expect(assertion.check(honest).pass).toBe(true);

    const silent = structuredClone(honest);
    const secondTurn = silent.turns[1];
    if (secondTurn === undefined) throw new Error("fixture failed");
    secondTurn.sessionAfter.claimHistory = [];
    expect(assertion.check(silent).pass).toBe(false);

    // Dropping an entry that an earlier turn wrote is a rewrite of the history.
    const firstTurnWithHistory = buildTranscript({
      turns: [
        { reply: "Ok.", commands: [recordCommand("purpose", "Handle refunds."), correct] },
        { reply: "Ok." },
      ],
    });
    const cleared = structuredClone(firstTurnWithHistory);
    const last = cleared.turns[1];
    if (last === undefined) throw new Error("fixture failed");
    last.sessionAfter.claimHistory = [];
    expect(assertion.check(firstTurnWithHistory).pass).toBe(true);
    expect(assertion.check(cleared).pass).toBe(false);
  });

  it("history-keeps-previous-claims fails when a seeded claim changes without an entry", () => {
    const assertion = globalAssertion("history-keeps-previous-claims");
    const seed: SeedStep[] = [{ kind: "record", field: "purpose", statement: "Handle refunds." }];

    const corrected = buildTranscript({
      seed,
      turns: [
        {
          reply: "Ok.",
          commands: [
            {
              kind: "correct",
              claimId: "id-3",
              statement: "Handle refunds and exchanges.",
              note: null,
              effectiveDate: null,
            },
          ],
        },
      ],
    });
    expect(corrected.seedSession.claims[0]?.claimId).toBe("id-3");
    expect(assertion.check(corrected).pass).toBe(true);

    const silent = structuredClone(corrected);
    const last = silent.turns[0];
    if (last === undefined) throw new Error("fixture failed");
    last.sessionAfter.claimHistory = [];
    expect(assertion.check(silent).pass).toBe(false);

    const untouched = buildTranscript({ seed, turns: [{ reply: "Ok." }] });
    expect(assertion.check(untouched).pass).toBe(true);
  });
});
