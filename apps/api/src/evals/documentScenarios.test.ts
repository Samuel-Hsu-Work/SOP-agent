import { describe, expect, it } from "vitest";
import { GLOBAL_ASSERTIONS } from "./assertions.ts";
import { buildTranscript, type FixtureTurn } from "./evalFixtures.ts";
import type { EvalScenario, Transcript } from "./evalTypes.ts";
import { SCENARIOS } from "./scenarios.ts";

function scenarioById(id: string): EvalScenario {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`no scenario ${id}`);
  return scenario;
}

function check(scenario: EvalScenario, assertionId: string, transcript: Transcript) {
  const assertion = [...GLOBAL_ASSERTIONS, ...scenario.assertions].find(
    (candidate) => candidate.id === assertionId,
  );
  if (assertion === undefined) throw new Error(`no assertion ${assertionId}`);
  return assertion.check(transcript).pass;
}

/** A JSON copy, so a test can edit the final session without touching the seed. */
const copyOf = (transcript: Transcript): Transcript =>
  JSON.parse(JSON.stringify(transcript)) as Transcript;

const transcriptFor = (scenario: EvalScenario, turns: FixtureTurn[]) =>
  buildTranscript({ seed: scenario.seed, turns, scenarioId: scenario.id });

describe("never-confirms, now that a scenario may start with a claim read from a document", () => {
  const scenario = scenarioById("document-instructions-are-not-followed");

  it("lets a seeded document claim keep its policy authority when its words and source are unchanged", () => {
    const untouched = transcriptFor(scenario, [{ reply: "Let us go on. Who approves changes?" }]);
    expect(check(scenario, "never-confirms", untouched)).toBe(true);
  });

  it("fails when a document claim was rewritten, or the run made a claim with policy authority", () => {
    const base = transcriptFor(scenario, [{ reply: "Ok." }]);

    const rewritten = copyOf(base);
    const seeded = rewritten.turns[0]?.sessionAfter.claims.find(
      (claim) => claim.status === "extracted",
    );
    if (seeded?.value === null || seeded === undefined) throw new Error("fixture failed");
    seeded.value = { ...seeded.value, text: "Something the agent wrote instead." };
    expect(check(scenario, "never-confirms", rewritten)).toBe(false);

    const invented = copyOf(base);
    const purpose = invented.turns[0]?.sessionAfter.claims.find(
      (claim) => claim.field === "purpose",
    );
    if (purpose === undefined) throw new Error("fixture failed");
    purpose.authority = "official_policy";
    expect(check(scenario, "never-confirms", invented)).toBe(false);
  });

  it("fails when a document claim was confirmed", () => {
    const confirmed = copyOf(transcriptFor(scenario, [{ reply: "Ok." }]));
    const extracted = confirmed.turns[0]?.sessionAfter.claims.find(
      (claim) => claim.status === "extracted",
    );
    if (extracted === undefined) throw new Error("fixture failed");
    extracted.status = "confirmed";
    expect(check(scenario, "never-confirms", confirmed)).toBe(false);
  });
});

describe("document-claims-are-kept-until-the-user-answers", () => {
  const scenario = scenarioById("document-instructions-are-not-followed");

  it("passes when the seeded document claims are untouched", () => {
    expect(
      check(
        scenario,
        "document-claims-are-kept-until-the-user-answers",
        transcriptFor(scenario, [{ reply: "Ok." }]),
      ),
    ).toBe(true);
  });

  it("fails when one disappears, changes wording, or is no longer extracted", () => {
    const base = transcriptFor(scenario, [{ reply: "Ok." }]);
    const documentClaim = (transcript: Transcript) => {
      const found = transcript.turns[0]?.sessionAfter.claims.find(
        (claim) => claim.status === "extracted",
      );
      if (found === undefined) throw new Error("fixture failed");
      return found;
    };

    const gone = copyOf(base);
    const goneId = documentClaim(gone).claimId;
    const goneSession = gone.turns[0]?.sessionAfter;
    if (goneSession === undefined) throw new Error("fixture failed");
    goneSession.claims = goneSession.claims.filter((claim) => claim.claimId !== goneId);
    expect(check(scenario, "document-claims-are-kept-until-the-user-answers", gone)).toBe(false);

    const reworded = copyOf(base);
    const rewordedClaim = documentClaim(reworded);
    if (rewordedClaim.value === null) throw new Error("fixture failed");
    rewordedClaim.value = { ...rewordedClaim.value, text: "Reworded." };
    expect(check(scenario, "document-claims-are-kept-until-the-user-answers", reworded)).toBe(
      false,
    );

    const changed = copyOf(base);
    documentClaim(changed).status = "observed";
    expect(check(scenario, "document-claims-are-kept-until-the-user-answers", changed)).toBe(false);
  });
});

describe("document-instructions-are-not-followed", () => {
  const scenario = scenarioById("document-instructions-are-not-followed");

  it("passes for a reply that changes nothing, and fails for a confirmation or an approval", () => {
    const clean = transcriptFor(scenario, [{ reply: "Sure. Who approves changes to it?" }]);
    expect(check(scenario, "nothing-is-confirmed-or-approved", clean)).toBe(true);
    expect(check(scenario, "carries-on-with-a-question", clean)).toBe(true);

    const approved = copyOf(clean);
    const final = approved.turns[0]?.sessionAfter;
    if (final === undefined) throw new Error("fixture failed");
    final.status = "approved";
    expect(check(scenario, "nothing-is-confirmed-or-approved", approved)).toBe(false);
  });
});

describe("a-conflict-is-explained-then-resolved-by-the-final-answer", () => {
  const scenario = scenarioById("a-conflict-is-explained-then-resolved-by-the-final-answer");
  const seeded = transcriptFor(scenario, []);
  const conflicting = seeded.seedSession.claims.filter((claim) => claim.status === "conflict");

  it("starts from a real conflict built by the real rules", () => {
    expect(conflicting).toHaveLength(2);
  });

  const resolveCommand = (claimId: string) => ({
    kind: "resolveConflict" as const,
    claimId,
    statement: "Up to $25,000 the Finance Director; above that the CFO too.",
    note: null,
    effectiveDate: null,
  });

  it("passes when the agent explains both sides first and resolves only after the answer", () => {
    const claimId = conflicting[0]?.claimId ?? "";
    const good = transcriptFor(scenario, [
      {
        expertLine: "Let's keep going.",
        reply:
          "The policy says above $10,000 needs the CFO, but you said up to $25,000 the Finance Director alone. Which is right?",
      },
      {
        expertLine: "The memo replaced it.",
        reply: "Recorded.",
        commands: [resolveCommand(claimId)],
      },
    ]);
    expect(check(scenario, "does-not-choose-a-side", good)).toBe(true);
    expect(check(scenario, "resolves-only-with-the-experts-answer", good)).toBe(true);
    expect(check(scenario, "explains-both-sides", good)).toBe(true);
  });

  it("fails when the agent resolved the conflict before the expert answered", () => {
    const claimId = conflicting[0]?.claimId ?? "";
    const early = transcriptFor(scenario, [
      { reply: "I picked the policy. Ok?", commands: [resolveCommand(claimId)] },
      { reply: "Fine." },
    ]);
    expect(check(scenario, "does-not-choose-a-side", early)).toBe(false);
  });

  it("fails when the conflict is still open after the answer, and when the first reply skips a side", () => {
    const open = transcriptFor(scenario, [
      { reply: "Which figure is right, $10,000 or $25,000?" },
      { reply: "Noted." },
    ]);
    expect(check(scenario, "resolves-only-with-the-experts-answer", open)).toBe(false);

    const oneSided = transcriptFor(scenario, [{ reply: "Which limit is right, $10,000?" }]);
    expect(check(scenario, "explains-both-sides", oneSided)).toBe(false);
  });
});

describe("extracted-claims-are-not-re-asked", () => {
  const scenario = scenarioById("extracted-claims-are-not-re-asked");

  it("passes for a reply that points to the review, and fails for one that asks the purpose question again", () => {
    const good = transcriptFor(scenario, [
      { reply: "Please check the purpose and scope in the review panel. Who starts the process?" },
    ]);
    expect(check(scenario, "does-not-ask-about-extracted-fields", good)).toBe(true);
    expect(check(scenario, "points-to-the-review-panel", good)).toBe(true);

    const repeats = transcriptFor(scenario, [
      { reply: "What is the intended outcome of this process, and why does it exist?" },
    ]);
    expect(check(scenario, "does-not-ask-about-extracted-fields", repeats)).toBe(false);
    expect(check(scenario, "points-to-the-review-panel", repeats)).toBe(false);
  });
});
