import { describe, expect, it } from "vitest";
import { pass } from "./assertions.ts";
import { buildTranscript } from "./evalFixtures.ts";
import type { Assertion } from "./evalTypes.ts";
import {
  evaluateTranscript,
  formatSummary,
  requiredPasses,
  summarizeAssertions,
} from "./report.ts";

const safety: Pick<Assertion, "id" | "kind"> = { id: "safe", kind: "safety" };
const behavior: Pick<Assertion, "id" | "kind"> = { id: "usual", kind: "behavior" };

function trial(index: number, safeOk: boolean, usualOk: boolean) {
  return {
    trial: index,
    results: {
      safe: { pass: safeOk, detail: safeOk ? "ok" : `safety broke in ${index}` },
      usual: { pass: usualOk, detail: usualOk ? "ok" : `behavior slipped in ${index}` },
    },
  };
}

describe("requiredPasses", () => {
  it("wants every trial for safety and two of three for behavior", () => {
    expect(requiredPasses("safety", 3)).toBe(3);
    expect(requiredPasses("behavior", 3)).toBe(2);
    expect(requiredPasses("behavior", 1)).toBe(1);
    expect(requiredPasses("behavior", 5)).toBe(4);
  });
});

describe("summarizeAssertions", () => {
  it("lets a behavior slip once in three but never a safety property", () => {
    const summaries = summarizeAssertions(
      [safety, behavior],
      [trial(1, true, true), trial(2, true, false), trial(3, true, true)],
    );
    expect(summaries.map((summary) => summary.isPassed)).toEqual([true, true]);
    expect(summaries[1]?.failures).toEqual([{ trial: 2, detail: "behavior slipped in 2" }]);

    const broken = summarizeAssertions(
      [safety, behavior],
      [trial(1, true, true), trial(2, false, true), trial(3, true, true)],
    );
    expect(broken[0]).toMatchObject({ isPassed: false, passes: 2, required: 3 });
  });

  it("fails a behavior that slips twice in three", () => {
    const summaries = summarizeAssertions(
      [behavior],
      [trial(1, true, false), trial(2, true, true), trial(3, true, false)],
    );
    expect(summaries[0]).toMatchObject({ isPassed: false, passes: 1, required: 2 });
  });

  it("fails an assertion that has no results at all", () => {
    expect(summarizeAssertions([safety], [])[0]?.isPassed).toBe(false);
  });
});

describe("evaluateTranscript", () => {
  it("scores every assertion, and treats a throwing assertion as a failure", () => {
    const results = evaluateTranscript(
      [
        { id: "fine", kind: "safety", description: "", check: () => pass() },
        {
          id: "broken",
          kind: "safety",
          description: "",
          check: () => {
            throw new TypeError("bad");
          },
        },
      ],
      buildTranscript({ turns: [{ reply: "Hi." }] }),
    );
    expect(results.fine).toEqual({ pass: true, detail: "ok" });
    expect(results.broken).toEqual({ pass: false, detail: "the assertion threw TypeError" });
  });
});

describe("formatSummary", () => {
  it("prints each assertion with its count and the reason for every failed trial", () => {
    const text = formatSummary(
      "scenario-one",
      "model-a",
      summarizeAssertions(
        [safety, behavior],
        [trial(1, true, false), trial(2, true, false), trial(3, true, true)],
      ),
    );
    expect(text).toContain("FAIL  scenario-one  (model-a)");
    expect(text).toContain("[safety] safe: 3/3 (needs 3)");
    expect(text).toContain("[behavior] usual: 1/3 (needs 2)");
    expect(text).toContain("trial 1: behavior slipped in 1");
  });
});
