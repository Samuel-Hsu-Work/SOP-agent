import type { RecordedToolCall, SopFieldName, SopSession } from "@sop-agent/sop-core";
import type { TurnStats } from "../agent/runTurn.ts";

/** One thing a scenario puts in the session before the first scripted message. */
export type SeedStep =
  | { kind: "record"; field: SopFieldName; statement: string; status?: "observed" | "proposed" }
  | { kind: "unknown"; field: SopFieldName; note: string }
  /** A claim a person has confirmed, built through the review action like a real one. */
  | { kind: "confirmed"; field: SopFieldName; statement: string };

/**
 * A scripted simulated subject-matter expert. The lines are fixed, not generated: a scenario is a
 * deterministic input so that a change in results comes from the agent, not from the simulator.
 */
export interface EvalScenario {
  id: string;
  description: string;
  seed: SeedStep[];
  /** What the expert says, one line per turn. */
  expertLines: string[];
  /** Checked on every trial, on top of the global assertions. */
  assertions: Assertion[];
  /** Judged by a model, at most one per scenario. Skipped when the judge is off. */
  judgedExpectation?: JudgedExpectation;
}

export interface JudgedExpectation {
  id: string;
  /** A yes/no question about the agent's replies. "Yes" means the agent behaved well. */
  question: string;
}

export interface TranscriptTurn {
  expertLine: string;
  /** Null when the turn failed. */
  assistantText: string | null;
  toolCalls: RecordedToolCall[];
  /** The session the turn committed, or the session it started from when it failed. */
  sessionAfter: SopSession;
  stats: TurnStats | null;
  /** The error class name only, never its text. Null when the turn committed. */
  failure: string | null;
}

/** Everything one trial produced. The assertions are pure functions of this, and nothing else. */
export interface Transcript {
  scenarioId: string;
  model: string;
  trial: number;
  seedSession: SopSession;
  turns: TranscriptTurn[];
}

export interface AssertionResult {
  pass: boolean;
  /** Short, and free of user content beyond what a scenario itself scripted. */
  detail: string;
}

/**
 * `safety` must hold on every trial. `behavior` is allowed to slip once in three, because a model
 * is not deterministic, but every failure stays visible in the report.
 */
export interface Assertion {
  id: string;
  kind: "safety" | "behavior";
  description: string;
  check(transcript: Transcript): AssertionResult;
}

export interface TrialOutcome {
  trial: number;
  results: Record<string, AssertionResult>;
}
