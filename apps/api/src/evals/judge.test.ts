import { describe, expect, it } from "vitest";
import { parseJudgeVerdict } from "./judge.ts";

describe("parseJudgeVerdict", () => {
  it("passes on a first line that starts with YES, and keeps the reason", () => {
    expect(parseJudgeVerdict("YES\nIt asks where the process goes wrong.")).toEqual({
      pass: true,
      detail: "It asks where the process goes wrong.",
    });
    expect(parseJudgeVerdict("yes. It does.").pass).toBe(true);
  });

  it("fails on NO, on anything unexpected, and on empty output", () => {
    expect(parseJudgeVerdict("NO\nIt asks about controls.").pass).toBe(false);
    expect(parseJudgeVerdict("Yesterday it did not.").pass).toBe(false);
    expect(parseJudgeVerdict("").pass).toBe(false);
  });
});
