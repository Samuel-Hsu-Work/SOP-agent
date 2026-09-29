import type { EvalScenario } from "../evalTypes.ts";
import { claimDepthScenarios } from "./claimDepth.ts";
import { consistencyScenarios } from "./consistency.ts";
import { documentPassageScenarios } from "./documentPassages.ts";
import {
  fillInTheRestScenarios,
  interviewRuleScenarios,
  openingScenarios,
} from "./interviewBasics.ts";
import { remainingReviewKindScenarios } from "./reviewKinds.ts";
import { statementFidelityScenarios } from "./statementFidelity.ts";

/** The most model-judged expectations the whole suite may have. Judging costs, and can be wrong. */
export const MAX_JUDGED_EXPECTATIONS = 4;

/** Every scenario, in the order the suite runs and reports them. */
export const SCENARIOS: EvalScenario[] = [
  ...openingScenarios(),
  ...fillInTheRestScenarios(),
  ...interviewRuleScenarios(),
  ...documentPassageScenarios(),
  ...consistencyScenarios(),
  ...claimDepthScenarios(),
  ...remainingReviewKindScenarios(),
  ...statementFidelityScenarios(),
];
