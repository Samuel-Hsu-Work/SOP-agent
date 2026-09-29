import { questionsIn, repliesOf } from "../assertions.ts";
import type { Transcript } from "../evalTypes.ts";

export function askedAbout(transcript: Transcript, pattern: RegExp): boolean {
  return repliesOf(transcript).some((reply) =>
    questionsIn(reply).some((question) => pattern.test(question)),
  );
}
