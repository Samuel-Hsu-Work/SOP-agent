import type { Claim, ClaimStatus } from "./claim.ts";
import { computeGaps } from "./computeGaps.ts";
import type { SopSession } from "./session.ts";
import { getFieldDefinition, type SopFieldName } from "./sopFields.ts";

/** How many questions the agenda proposes at once. The agent asks one or two, not a form. */
export const MAX_AGENDA_QUESTIONS = 3;

/** The longest recent question kept, so a rambling reply cannot inflate the state item. */
const MAX_RECENT_QUESTION_LENGTH = 300;

export interface AgendaQuestion {
  field: SopFieldName;
  label: string;
  /** A ready-made way to ask, so the same field is asked the same good way every time. */
  probe: string;
  reason: "empty" | "unresolved";
}

export interface AgendaExclusion {
  field: SopFieldName;
  why: "user_does_not_know" | "awaiting_review";
}

export interface InterviewAgenda {
  /** Up to three fields to ask about next, blocking first. */
  askNext: AgendaQuestion[];
  /** Fields with a gap that the agent must not ask about again. */
  doNotAsk: AgendaExclusion[];
  /** True when no blocking gap remains. Only then may the agent say the SOP is ready to review. */
  readyToReview: boolean;
  blockingGapsRemaining: number;
  advisoryGapsRemaining: number;
}

/**
 * The deterministic core of the interview: which fields to ask about next. The model decides how
 * to word a question, but never which gap comes first, so "blocking first" and "stop asking after
 * I don't know" hold no matter how the model behaves.
 */
export function buildInterviewAgenda(session: SopSession): InterviewAgenda {
  const report = computeGaps(session);
  const askNext = report.gaps
    .filter((readiness) => readiness.askable)
    .slice(0, MAX_AGENDA_QUESTIONS)
    .map(
      (readiness): AgendaQuestion => ({
        field: readiness.field,
        label: readiness.label,
        probe: getFieldDefinition(readiness.field).probe,
        reason: readiness.state === "empty" ? "empty" : "unresolved",
      }),
    );

  const doNotAsk = report.gaps
    .filter((readiness) => !readiness.askable)
    .map((readiness): AgendaExclusion => {
      const isAwaitingReview = session.claims.some(
        (claim) => claim.field === readiness.field && claim.status === "extracted",
      );
      return {
        field: readiness.field,
        why: isAwaitingReview ? "awaiting_review" : "user_does_not_know",
      };
    });

  return {
    askNext,
    doNotAsk,
    readyToReview: report.blockingGapCount === 0,
    blockingGapsRemaining: report.blockingGapCount,
    advisoryGapsRemaining: report.advisoryGapCount,
  };
}

const SPELLED_NUMBERS = [
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "fifteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "dozen",
];
const QUANTITY_PATTERN = new RegExp(`\\d|\\b(?:${SPELLED_NUMBERS.join("|")})\\b`, "i");

/**
 * A cheap trigger, not a judgment: does this message state a number, such as an amount, a limit or
 * a time frame? When it does, the agent is told to ask why that number. It errs toward true, which
 * costs at most one extra question. "one" is left out on purpose because it is too common ("no
 * one", "one of them").
 */
export function mentionsQuantity(text: string): boolean {
  return QUANTITY_PATTERN.test(text);
}

export interface ProcedureStepView {
  claimId: string;
  /** 1-based position in the procedure. */
  position: number;
  status: ClaimStatus;
  /** Null when the step is unknown. */
  text: string | null;
  note: string | null;
}

/** The procedure as an ordered list. A step that became unknown keeps its place. */
export function orderProcedureSteps(session: SopSession): ProcedureStepView[] {
  const claimsById = new Map<string, Claim>(session.claims.map((claim) => [claim.claimId, claim]));
  const steps: ProcedureStepView[] = [];
  for (const claimId of session.procedureOrder) {
    const claim = claimsById.get(claimId);
    if (claim === undefined) continue;
    steps.push({
      claimId,
      position: steps.length + 1,
      status: claim.status,
      text: claim.value?.text ?? null,
      note: claim.note,
    });
  }
  return steps;
}

/**
 * The last `count` questions the assistant asked, oldest first. The agent sees them so it does not
 * ask the same thing twice in a row.
 */
export function recentQuestions(session: SopSession, count: number): string[] {
  const questions: string[] = [];
  for (const message of session.messages) {
    if (message.role !== "assistant") continue;
    for (const match of message.text.matchAll(/[^.!?\n]*\?/g)) {
      const question = match[0].trim();
      if (question.length > 1) questions.push(question.slice(0, MAX_RECENT_QUESTION_LENGTH));
    }
  }
  return count <= 0 ? [] : questions.slice(-count);
}
