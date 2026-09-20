/**
 * The interview evals: scripted simulated experts talk to the real agent, and pure assertions check
 * what was recorded and said.
 *
 *   pnpm eval
 *
 * It is not part of `pnpm test` (see `vitest.eval.config.ts`) because it calls the live model and
 * costs money. Settings, all optional:
 *   EVAL_REPETITIONS  trials per scenario (default 3)
 *   EVAL_MODELS       "all" to run the primary and the fallback model (default: the primary only)
 *   EVAL_SCENARIO     run only scenarios whose id contains this text
 *   EVAL_JUDGE        "off" to skip the model-judged expectations
 *
 * Each run is written to apps/api/evals/runs/. Re-score a saved run without the model:
 *   pnpm eval:recheck evals/runs/<file>.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { systemWriteContext } from "@sop-agent/sop-core";
import OpenAI from "openai";
import { afterAll, describe, expect, it } from "vitest";
import { readModelsFromEnvironment } from "../model/modelFallback.ts";
import { createOpenAiModelClient } from "../model/openaiModelClient.ts";
import { GLOBAL_ASSERTIONS } from "./assertions.ts";
import { judgeTranscript } from "./judge.ts";
import {
  evaluateTranscript,
  formatSummary,
  type RunRecord,
  summarizeAssertions,
  type TrialResults,
} from "./report.ts";
import { runScenario } from "./runScenario.ts";
import { SCENARIOS } from "./scenarios.ts";

const REPETITIONS = Number(process.env.EVAL_REPETITIONS ?? 3);
const configuredModels = readModelsFromEnvironment();
const models = process.env.EVAL_MODELS === "all" ? configuredModels : configuredModels.slice(0, 1);
const scenarioFilter = process.env.EVAL_SCENARIO ?? "";
const isJudgeOn = process.env.EVAL_JUDGE !== "off";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || configuredModels[0] || "";

if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    "OPENAI_API_KEY is not set. Put it in the repository root .env, then run pnpm eval.",
  );
}
const openai = new OpenAI();
const modelClient = createOpenAiModelClient(openai);

const runRecord: RunRecord = {
  startedAt: new Date().toISOString(),
  repetitions: REPETITIONS,
  models,
  scenarios: [],
};

afterAll(() => {
  const directory = new URL("../../evals/runs/", import.meta.url);
  mkdirSync(directory, { recursive: true });
  const file = new URL(`${runRecord.startedAt.replace(/[:.]/g, "-")}.json`, directory);
  writeFileSync(file, JSON.stringify(runRecord, null, 2));
  console.log(`\nRun saved to ${file.pathname}`);
});

for (const model of models) {
  describe(`interview evals on ${model}`, () => {
    for (const scenario of SCENARIOS.filter((candidate) => candidate.id.includes(scenarioFilter))) {
      it(scenario.id, async () => {
        const assertions = [...GLOBAL_ASSERTIONS, ...scenario.assertions];
        const judged = isJudgeOn ? scenario.judgedExpectation : undefined;
        const summaryTargets = [
          ...assertions,
          ...(judged === undefined
            ? []
            : [{ id: `judged:${judged.id}`, kind: "behavior" as const }]),
        ];

        const trials: TrialResults[] = [];
        const record: RunRecord["scenarios"][number] = {
          scenarioId: scenario.id,
          model,
          trials: [],
        };
        runRecord.scenarios.push(record);

        for (let trial = 1; trial <= REPETITIONS; trial += 1) {
          const transcript = await runScenario({
            client: modelClient,
            model,
            scenario,
            trial,
            context: systemWriteContext,
          });
          const results = evaluateTranscript(assertions, transcript);
          if (judged !== undefined) {
            results[`judged:${judged.id}`] = await judgeTranscript({
              client: openai,
              model: JUDGE_MODEL,
              expectation: judged,
              transcript,
            });
          }
          trials.push({ trial, results });
          record.trials.push({ transcript, results });
        }

        const summaries = summarizeAssertions(summaryTargets, trials);
        const report = formatSummary(scenario.id, model, summaries);
        console.log(`\n${report}`);
        const failed = summaries
          .filter((summary) => !summary.isPassed)
          .map((summary) => summary.id);
        expect(failed, report).toEqual([]);
      });
    }
  });
}
