import type { WriteContext } from "@sop-agent/sop-core";
import { type RunAgentTurnResult, runAgentTurn } from "../agent/runTurn.ts";
import type { ModelClient } from "../model/modelClient.ts";
import type { EvalScenario, Transcript, TranscriptTurn } from "./evalTypes.ts";
import { buildSeedSession } from "./seedSession.ts";

export interface RunScenarioInput {
  client: ModelClient;
  model: string;
  scenario: EvalScenario;
  trial: number;
  context: WriteContext;
}

/**
 * Plays one scenario once: the scripted expert speaks, the real agent turn runs against the given
 * client, and everything is written down. It calls `runAgentTurn` directly, so the eval exercises
 * the same prompt, tools and rules as the server, without HTTP. A failed turn ends the trial; the
 * assertions then see a transcript with a failure in it instead of the eval crashing.
 */
export async function runScenario(input: RunScenarioInput): Promise<Transcript> {
  const { client, model, scenario, trial, context } = input;
  const seedSession = buildSeedSession(scenario.seed, context);
  const turns: TranscriptTurn[] = [];

  let session = seedSession;
  for (const expertLine of scenario.expertLines) {
    const userMessage = {
      id: context.newId(),
      role: "user" as const,
      createdAt: context.now(),
      text: expertLine,
    };
    const startingSession = {
      ...session,
      updatedAt: userMessage.createdAt,
      messages: [...session.messages, userMessage],
    };

    let result: RunAgentTurnResult;
    try {
      result = await runAgentTurn({
        client,
        model,
        session: startingSession,
        userMessageId: userMessage.id,
        context,
        signal: new AbortController().signal,
        onTextDelta: () => {},
      });
    } catch (error) {
      turns.push({
        expertLine,
        assistantText: null,
        toolCalls: [],
        sessionAfter: startingSession,
        stats: null,
        failure: error instanceof Error ? error.constructor.name : "UnknownError",
      });
      break;
    }

    session = result.session;
    turns.push({
      expertLine,
      assistantText: result.assistantMessage.text,
      toolCalls: result.assistantMessage.toolCalls,
      sessionAfter: result.session,
      stats: result.stats,
      failure: null,
    });
  }

  return { scenarioId: scenario.id, model, trial, seedSession, turns };
}
