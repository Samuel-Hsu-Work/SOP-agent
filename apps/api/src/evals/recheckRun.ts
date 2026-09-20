/**
 * Scores a saved eval run again with the current assertions, without calling any model:
 *
 *   pnpm eval:recheck evals/runs/<file>.json
 *
 * Use it after changing an assertion, to see what the change would have decided on real transcripts.
 * Model-judged results are kept as they were saved.
 */
import { readFileSync } from "node:fs";
import { GLOBAL_ASSERTIONS } from "./assertions.ts";
import {
  evaluateTranscript,
  formatSummary,
  type RunRecord,
  summarizeAssertions,
  type TrialResults,
} from "./report.ts";
import { SCENARIOS } from "./scenarios.ts";

const path = process.argv[2];
if (path === undefined) {
  console.error("Usage: pnpm eval:recheck <path to a run file>");
  process.exit(2);
}

const runRecord = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
let failedScenarios = 0;

for (const saved of runRecord.scenarios) {
  const scenario = SCENARIOS.find((candidate) => candidate.id === saved.scenarioId);
  if (scenario === undefined) {
    console.log(`SKIP  ${saved.scenarioId}: no longer defined`);
    continue;
  }
  const assertions = [...GLOBAL_ASSERTIONS, ...scenario.assertions];
  const judgedIds = Object.keys(saved.trials[0]?.results ?? {}).filter((id) =>
    id.startsWith("judged:"),
  );

  const trials: TrialResults[] = saved.trials.map((trial) => {
    const results = evaluateTranscript(assertions, trial.transcript);
    for (const id of judgedIds) {
      const savedResult = trial.results[id];
      if (savedResult !== undefined) results[id] = savedResult;
    }
    return { trial: trial.transcript.trial, results };
  });

  const targets = [...assertions, ...judgedIds.map((id) => ({ id, kind: "behavior" as const }))];
  const summaries = summarizeAssertions(targets, trials);
  if (!summaries.every((summary) => summary.isPassed)) failedScenarios += 1;
  console.log(`\n${formatSummary(saved.scenarioId, saved.model, summaries)}`);
}

console.log(
  `\n${failedScenarios === 0 ? "Every scenario passes." : `${failedScenarios} scenario(s) fail.`}`,
);
process.exitCode = failedScenarios === 0 ? 0 : 1;
