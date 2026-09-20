import type OpenAI from "openai";
import type { AssertionResult, JudgedExpectation, Transcript } from "./evalTypes.ts";

const JUDGE_INSTRUCTIONS = `You grade the replies of an interviewing assistant against one yes/no question. Read the conversation, then answer on the first line with exactly YES or NO, and on the second line give one short reason. Grade only what the question asks.`;

function formatConversation(transcript: Transcript): string {
  return transcript.turns
    .map(
      (turn, index) =>
        `Turn ${index + 1}\nExpert: ${turn.expertLine}\nAssistant: ${turn.assistantText ?? "(no reply)"}`,
    )
    .join("\n\n");
}

/** Reads the verdict from the judge's text. Anything that does not start with YES counts as NO. */
export function parseJudgeVerdict(text: string): AssertionResult {
  const [firstLine = "", ...rest] = text.trim().split("\n");
  const isYes = /^\s*yes\b/i.test(firstLine);
  const reason = rest.join(" ").trim().slice(0, 300);
  return { pass: isYes, detail: reason.length > 0 ? reason : firstLine.slice(0, 300) };
}

/**
 * Asks a model one yes/no question about a transcript. It is a soft signal for behavior that a
 * rule cannot capture, so it only ever backs a `behavior` assertion, and a scenario has at most one.
 */
export async function judgeTranscript(input: {
  client: OpenAI;
  model: string;
  expectation: JudgedExpectation;
  transcript: Transcript;
}): Promise<AssertionResult> {
  const response = await input.client.responses.create({
    model: input.model,
    instructions: JUDGE_INSTRUCTIONS,
    input: `Question: ${input.expectation.question}\n\n${formatConversation(input.transcript)}`,
    store: false,
    max_output_tokens: 300,
  });
  return parseJudgeVerdict(response.output_text);
}
