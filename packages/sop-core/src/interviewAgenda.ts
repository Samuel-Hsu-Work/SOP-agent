import type { Claim, ClaimStatus } from "./claim.ts";
import { computeGaps } from "./computeGaps.ts";
import { type ConsistencyQuestion, nextConsistencyQuestion } from "./consistencyReview.ts";
import type { SopSession } from "./session.ts";
import { getFieldDefinition, type SopFieldName } from "./sopFields.ts";
import { quantitiesIn } from "./text.ts";

/** How many questions the agenda proposes at once. The agent asks one or two, not a form. */
export const MAX_AGENDA_QUESTIONS = 3;

/** How many of the agent's earlier questions are checked for repeats of a probe. */
const MAX_TRACKED_QUESTIONS = 30;

/** Two questions count as the same one when this share of their words is shared. */
const SAME_QUESTION_OVERLAP = 0.6;

/** The longest recent question kept, so a rambling reply cannot inflate the state item. */
const MAX_RECENT_QUESTION_LENGTH = 300;

/** How each kind of source is named to the agent. Shared with the state item's claim list. */
export const CLAIM_SOURCE_LABELS: Readonly<Record<Claim["source"]["type"], string>> = {
  employee_statement: "what the user said",
  agent_suggestion: "the assistant's suggestion",
  policy_document: "an uploaded document",
};

/** One side of a conflict, as the agent needs to put it to the user. It carries no file name and no quote. */
export interface ConflictSide {
  claimId: string;
  statement: string;
  /** Who said it: what the user said, the assistant's suggestion, or an uploaded document. */
  sourceLabel: string;
  effectiveDate: string | null;
}

export interface AgendaQuestion {
  field: SopFieldName;
  label: string;
  /** A ready-made way to ask, so the same field is asked the same good way every time. */
  probe: string;
  reason: "empty" | "unresolved" | "conflict";
  /** Both sides of the conflict in this field when `reason` is `conflict`, otherwise null. */
  conflict: { sides: ConflictSide[] } | null;
  /**
   * How many earlier questions were about the same thing as this probe, whatever their exact
   * words. Above zero means the user has already been asked and moved on without answering, so the
   * agent should ask something narrower or different instead of repeating itself.
   */
  timesAskedBefore: number;
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
  /**
   * One thing the recorded claims do not say together, put as a question, or null. Present only
   * when no blocking gap remains, and it comes before the advisory fields in `askNext`. It is a
   * question and never a fact: nothing is recorded because it exists.
   */
  consistencyQuestion: ConsistencyQuestion | null;
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
  const earlierQuestions = recentQuestions(session, MAX_TRACKED_QUESTIONS);
  // A field can hold several conflict pairs. One is put to the user at a time: a claim and the
  // partner it points at, never two claims that merely share a status.
  const conflictSidesOf = (field: SopFieldName): ConflictSide[] => {
    const first = session.claims.find(
      (claim) => claim.field === field && claim.status === "conflict",
    );
    const partner = session.claims.find((claim) => claim.claimId === first?.conflictsWithClaimId);
    if (first === undefined || partner === undefined) return [];
    return [first, partner].map(
      (claim): ConflictSide => ({
        claimId: claim.claimId,
        statement: claim.value?.text ?? "",
        sourceLabel: CLAIM_SOURCE_LABELS[claim.source.type],
        effectiveDate: claim.effectiveDate,
      }),
    );
  };

  // A conflict is one answer from being resolved, so within its class it comes before an empty field.
  const severityRank = (severity: "blocking" | "advisory" | undefined) =>
    severity === "blocking" ? 0 : 1;
  const askable = report.gaps
    .filter((readiness) => readiness.askable)
    .map((readiness) => ({ readiness, sides: conflictSidesOf(readiness.field) }));
  const askNext = askable
    .map((entry, index) => ({ ...entry, index }))
    .sort(
      (first, second) =>
        severityRank(first.readiness.gap?.severity) -
          severityRank(second.readiness.gap?.severity) ||
        Number(second.sides.length > 0) - Number(first.sides.length > 0) ||
        first.index - second.index,
    )
    .slice(0, MAX_AGENDA_QUESTIONS)
    .map(
      ({ readiness, sides }): AgendaQuestion => ({
        field: readiness.field,
        label: readiness.label,
        probe: getFieldDefinition(readiness.field).probe,
        reason:
          sides.length > 0 ? "conflict" : readiness.state === "empty" ? "empty" : "unresolved",
        conflict: sides.length > 0 ? { sides } : null,
        timesAskedBefore: countQuestionsAbout(
          getFieldDefinition(readiness.field).probe,
          earlierQuestions,
        ),
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
    consistencyQuestion: nextConsistencyQuestion(session),
    readyToReview: report.blockingGapCount === 0,
    blockingGapsRemaining: report.blockingGapCount,
    advisoryGapsRemaining: report.advisoryGapCount,
  };
}

function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * How many of the given questions ask about the same thing as `probe`. The agent rarely repeats a
 * probe letter for letter ("this refund process" for "this process"), so the comparison is the
 * share of words the two have in common, not equality.
 */
function countQuestionsAbout(probe: string, questions: readonly string[]): number {
  const probeWords = wordsOf(probe);
  return questions.filter((question) => {
    const questionWords = wordsOf(question);
    const shared = [...questionWords].filter((word) => probeWords.has(word)).length;
    const total = new Set([...probeWords, ...questionWords]).size;
    return total > 0 && shared / total >= SAME_QUESTION_OVERLAP;
  }).length;
}

/**
 * Does the latest user message state a number the conversation has not talked about yet, such as
 * an amount, a limit or a time frame? Then the agent is told to ask why that number. A number an
 * earlier reply already mentioned does not count: the agent asked about it then, and asking again
 * every time the user repeats it is what a person would find robotic. It errs toward true, which
 * costs at most one extra question. "one" is left out on purpose because it is too common ("no
 * one", "one of them").
 */
export function statesNewQuantity(session: SopSession): boolean {
  const latest = session.messages[session.messages.length - 1];
  if (latest === undefined || latest.role !== "user") return false;

  const stated = quantitiesIn(latest.text);
  if (stated.size === 0) return false;

  const alreadyDiscussed = new Set(
    session.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => [...quantitiesIn(message.text)]),
  );
  return [...stated].some((quantity) => !alreadyDiscussed.has(quantity));
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
