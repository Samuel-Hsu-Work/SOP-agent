import {
  type AssistantMessage,
  type ClaimDepthFocus,
  type ClaimDepthQuestion,
  type ConsistencyCategory,
  type ConsistencyQuestion,
  claimDepthBasisOf,
  consistencyBasisOf,
  currentClaimDepthReview,
  currentConsistencyReview,
  keepClaimDepthReviewForCurrentClaims,
  keepConsistencyReviewForCurrentClaims,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  MAX_TOOL_CALLS_PER_MESSAGE,
  markClaimDepthQuestionOffered,
  markConsistencyQuestionOffered,
  needsClaimDepthReview,
  needsConsistencyReview,
  type PassageState,
  type RecordedToolCall,
  type SopSession,
  selectReviewQuestions,
  settleShownDocumentPassages,
  sopSessionSchema,
  type ToolOutcomeErrorCode,
  type WriteContext,
} from "@sop-agent/sop-core";
import type { ModelClient, ModelConversationItem } from "../model/modelClient.ts";
import { ModelOutputError } from "../model/modelFallback.ts";
import { runClaimDepthReview } from "./claimDepthReview.ts";
import { runConsistencyReview } from "./consistencyReview.ts";
import {
  INSTRUCTIONS,
  MAX_STATE_ITEM_LENGTH,
  measureStateItem,
  renderStateItem,
  STATE_ITEM_WRITE_MARGIN,
} from "./prompt.ts";
import { AGENT_TOOLS, executeToolCall, type ToolCallOutcome } from "./tools.ts";

/**
 * How many of the latest messages the model sees. The recorded claims are the real memory of the
 * interview and travel in the state item, so older messages add little and cost more every turn.
 */
export const MAX_CONVERSATION_MESSAGES = 16;

/** Rounds in which the model may call tools. A closing call without tools follows the last one. */
export const MAX_TOOL_ROUNDS = 6;

export interface TurnStats {
  modelSteps: number;
  toolRounds: number;
  toolRoundCapHit: boolean;
  toolCallsAttempted: number;
  toolCallsApplied: number;
  toolCallsRejected: number;
  toolCallsDropped: number;
  rejectionCodes: ToolOutcomeErrorCode[];
  claimsRecorded: number;
  claimsCorrected: number;
  claimsMarkedUnknown: number;
  claimsWithdrawn: number;
  conflictsResolved: number;
  /** Writes that found the same claim already there. */
  claimsUnchanged: number;
  historyEntriesWritten: number;
  withdrawLimitHits: number;
  conflictResolutionLimitHits: number;
  /** Whether the consistency review ran this turn, failed (and was skipped), or was not needed. */
  consistencyReview: "not_needed" | "ran" | "failed";
  /** Findings the review added this turn, and findings still waiting to be asked at its end. */
  consistencyFindingsRaised: number;
  consistencyFindingsWaiting: number;
  /** The category of the question handed to the agent for its reply, or null. Never its text. */
  consistencyQuestionCategory: ConsistencyCategory | null;
  /** Whether the claim-depth review ran this turn, failed (and was skipped), or was not needed. */
  claimDepthReview: "not_needed" | "ran" | "failed";
  /** Findings the review added this turn, and findings still waiting to be asked at its end. */
  claimDepthFindingsRaised: number;
  claimDepthFindingsWaiting: number;
  /** The focus of the question handed to the agent for its reply, or null. Never its text. */
  claimDepthQuestionFocus: ClaimDepthFocus | null;
  /** Document passages the reply put to the user, so their answer can rest on them. Counts only. */
  documentPassagesOffered: number;
  /** Passages handed to the agent that its reply did not put to the user: left open for later. */
  documentPassagesNotAsked: number;
  /** Passages the user agreed with this turn, so a claim now rests on them. */
  documentPassagesUsed: number;
  /** Passages the user turned down or answered differently this turn. */
  documentPassagesDeclined: number;
  /** Passages that became one side of a conflict this turn, because the user said otherwise. */
  referenceConflictsRaised: number;
  /** The size of the state item on the last step. */
  stateItemChars: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function createEmptyTurnStats(): TurnStats {
  return {
    modelSteps: 0,
    toolRounds: 0,
    toolRoundCapHit: false,
    toolCallsAttempted: 0,
    toolCallsApplied: 0,
    toolCallsRejected: 0,
    toolCallsDropped: 0,
    rejectionCodes: [],
    claimsRecorded: 0,
    claimsCorrected: 0,
    claimsMarkedUnknown: 0,
    claimsWithdrawn: 0,
    conflictsResolved: 0,
    claimsUnchanged: 0,
    historyEntriesWritten: 0,
    withdrawLimitHits: 0,
    conflictResolutionLimitHits: 0,
    consistencyReview: "not_needed",
    consistencyFindingsRaised: 0,
    consistencyFindingsWaiting: 0,
    consistencyQuestionCategory: null,
    claimDepthReview: "not_needed",
    claimDepthFindingsRaised: 0,
    claimDepthFindingsWaiting: 0,
    claimDepthQuestionFocus: null,
    documentPassagesOffered: 0,
    documentPassagesNotAsked: 0,
    documentPassagesUsed: 0,
    documentPassagesDeclined: 0,
    referenceConflictsRaised: 0,
    stateItemChars: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

export interface RunAgentTurnInput {
  client: ModelClient;
  model: string;
  /** The session before the turn, with the new user message already appended. */
  session: SopSession;
  userMessageId: string;
  context: WriteContext;
  signal: AbortSignal;
  onTextDelta(text: string): void;
}

export interface RunAgentTurnResult {
  /** The session with the assistant reply and every applied claim. Valid against the schema. */
  session: SopSession;
  assistantMessage: AssistantMessage;
  stats: TurnStats;
}

function countChange(stats: TurnStats, outcome: ToolCallOutcome): void {
  switch (outcome.change) {
    case "unchanged":
      stats.claimsUnchanged += 1;
      return;
    case "withdrawn":
      stats.claimsWithdrawn += 1;
      return;
    case "created":
    case "updated":
      if (outcome.toolName === "record_claim") stats.claimsRecorded += 1;
      else if (outcome.toolName === "correct_claim") stats.claimsCorrected += 1;
      else if (outcome.toolName === "resolve_conflict") stats.conflictsResolved += 1;
      else stats.claimsMarkedUnknown += 1;
      return;
    case null:
      // A declined document passage changes no claim; the turn counts passages separately.
      return;
  }
}

/** How many passages are in `state` now and were not at the start of the turn. */
function passagesNewlyIn(before: SopSession, after: SopSession, state: PassageState): number {
  const wasInState = new Set(
    before.references.passages
      .filter((passage) => passage.state === state)
      .map((passage) => passage.passageId),
  );
  return after.references.passages.filter(
    (passage) => passage.state === state && !wasInState.has(passage.passageId),
  ).length;
}

function buildConversation(session: SopSession): ModelConversationItem[] {
  return session.messages
    .slice(-MAX_CONVERSATION_MESSAGES)
    .filter((message) => message.role === "user" || message.text.length > 0)
    .map((message) => ({ kind: "message", role: message.role, text: message.text }));
}

/**
 * Runs one complete agent turn as a transaction over a working copy of the session. Nothing here
 * touches the caller's session: on any failure the caller simply discards the result, and a retry
 * starts again from the same starting session. That is what makes falling back to another model
 * safe when tool calls have side effects and part of the reply has already been streamed.
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const { client, model, userMessageId, context, signal, onTextDelta } = input;

  let working = input.session;
  const conversation = buildConversation(input.session);
  const recordedCalls: RecordedToolCall[] = [];
  let assistantText = "";
  let separatorPending = false;

  const stats = createEmptyTurnStats();
  let withdrawalsSoFar = 0;
  let conflictResolutionsSoFar = 0;
  let workingStateSize = measureStateItem(working);
  // Each review runs at most once a turn, and only when the claims have changed since the last one.
  // The claim-depth review tracks the exact candidate basis it last attempted, not just a boolean
  // "have I tried this turn": a session can already have unasked candidates before this turn's own
  // tool calls even run (carried over from an earlier turn, or a session that predates this
  // feature), so a plain once-per-turn flag would review only the old candidates and then block a
  // second, later attempt within the same turn once this turn's own new steps are recorded — the
  // person would never get a same-reply question for a step they just described. Comparing the
  // basis instead re-attempts whenever the candidate set genuinely changes, while still never
  // retrying forever: a rebase that had to be skipped for size (see below) still records what was
  // attempted, so that specific candidate set is not retried again this same turn either.
  let lastAttemptedClaimDepthBasis: string | null = null;
  // The same for the consistency review: a claim this turn writes after the review ran leaves that
  // review stale, and a stale review offers nothing, so a review made before a write would
  // otherwise lose its question (a restatement_mismatch included) on every turn that writes.
  let lastAttemptedConsistencyBasis: string | null = null;
  let offeredQuestion: ConsistencyQuestion | null = null;
  let offeredDepthQuestion: ClaimDepthQuestion | null = null;
  // Every passage any step's state showed: the reply that puts one to the user can be streamed in
  // an earlier step than the last, whose state may show another.
  const shownPassageIds = new Set<string>();

  const forwardTextDelta = (delta: string) => {
    if (delta.length === 0) return;
    if (separatorPending) {
      assistantText += "\n\n";
      onTextDelta("\n\n");
      separatorPending = false;
    }
    assistantText += delta;
    onTextDelta(delta);
  };

  for (let step = 1; ; step += 1) {
    const allowToolCalls = step <= MAX_TOOL_ROUNDS;
    separatorPending = assistantText.length > 0;

    const claimDepthBasisNow = claimDepthBasisOf(working);
    if (claimDepthBasisNow !== lastAttemptedClaimDepthBasis && needsClaimDepthReview(working)) {
      lastAttemptedClaimDepthBasis = claimDepthBasisNow;
      const depthReview = await runClaimDepthReview({
        client,
        model,
        session: working,
        context,
        signal,
      });
      // The call is billed whether or not its answer held up.
      stats.inputTokens += depthReview.inputTokens;
      stats.cachedInputTokens += depthReview.cachedInputTokens;
      stats.outputTokens += depthReview.outputTokens;
      // Unlike a consistencyQuestion (whose only large part, aboutClaims, buildStateItem can blank
      // as a last resort), a claimDepthQuestion's own question text is never dropped by the render
      // cascade, so there is no render-time fallback that can shrink a fresh, oversized finding.
      // The guard has to sit here instead, at the point the finding is accepted, mirroring the
      // ordinary tool-call write guard below: a result that would not leave room for what the rest
      // of the turn still needs to add is treated the same as a failed review, not applied.
      if (
        depthReview.status === "ran" &&
        measureStateItem(depthReview.session) <= MAX_STATE_ITEM_LENGTH - STATE_ITEM_WRITE_MARGIN
      ) {
        working = depthReview.session;
        // "ran" sticks for the rest of the turn even if a later attempt fails: this now runs as
        // many times as the candidate basis changes (see above), and a turn where it succeeded at
        // least once genuinely did produce or update real data, which "failed" would misreport.
        stats.claimDepthReview = "ran";
        // Accumulated, not assigned: a later attempt in the same turn carries earlier findings
        // forward (not "raised" again) while raising its own new ones, so summing each attempt's
        // own raisedCount is what keeps this turn-level count accurate across repeats.
        stats.claimDepthFindingsRaised += depthReview.raisedCount;
      } else {
        // The rebase itself adds a little (a fresh basis hash, or a brand-new claimDepthReview
        // object where none existed before), so it needs the same guard: if a session already
        // sitting right at the write margin would be pushed past it by even that much, skip the
        // rebase entirely rather than commit something the very next turn's upfront check would
        // then refuse. The next turn simply retries the review, the same as any other skip.
        const kept = keepClaimDepthReviewForCurrentClaims(working, context);
        if (measureStateItem(kept) <= MAX_STATE_ITEM_LENGTH - STATE_ITEM_WRITE_MARGIN) {
          working = kept;
        }
        if (stats.claimDepthReview !== "ran") stats.claimDepthReview = "failed";
      }
    }
    // Run even when a claim-depth question is already waiting: only this review can find a
    // restatement_mismatch, and a mismatch outranks a claim-depth question (selectReviewQuestions).
    const consistencyBasisNow = consistencyBasisOf(working);
    if (consistencyBasisNow !== lastAttemptedConsistencyBasis && needsConsistencyReview(working)) {
      lastAttemptedConsistencyBasis = consistencyBasisNow;
      const review = await runConsistencyReview({
        client,
        model,
        session: working,
        context,
        signal,
      });
      // The call is billed whether or not its answer held up.
      stats.inputTokens += review.inputTokens;
      stats.cachedInputTokens += review.cachedInputTokens;
      stats.outputTokens += review.outputTokens;
      // As with the claim-depth review: "ran" sticks once any attempt this turn succeeded, and the
      // raised count is summed, since a later attempt carries earlier findings rather than raising
      // them again.
      if (review.status === "ran") {
        working = review.session;
        stats.consistencyReview = "ran";
        stats.consistencyFindingsRaised += review.raisedCount;
      } else {
        working = keepConsistencyReviewForCurrentClaims(working, context);
        if (stats.consistencyReview !== "ran") stats.consistencyReview = "failed";
      }
    }
    ({ claimDepthQuestion: offeredDepthQuestion, consistencyQuestion: offeredQuestion } =
      selectReviewQuestions(working));
    const rendered = renderStateItem({ session: working, allowToolCalls });
    const stateItem = rendered.text;
    // Only what the state actually showed can have been put to the user: near the size limit it
    // holds one passage of the two selected.
    for (const passageId of rendered.shownDocumentPassageIds) shownPassageIds.add(passageId);
    stats.stateItemChars = stateItem.length;

    const result = await client.runStep({
      model,
      instructions: INSTRUCTIONS,
      conversation,
      stateItem,
      tools: AGENT_TOOLS,
      allowToolCalls,
      onTextDelta: forwardTextDelta,
      signal,
    });

    stats.modelSteps += 1;
    stats.inputTokens += result.inputTokens;
    stats.cachedInputTokens += result.cachedInputTokens;
    stats.outputTokens += result.outputTokens;

    if (result.toolCalls.length === 0 || !allowToolCalls) break;

    stats.toolRounds += 1;
    for (const item of result.providerItems) {
      conversation.push({ kind: "provider_item", item });
    }

    for (const call of result.toolCalls) {
      stats.toolCallsAttempted += 1;
      if (recordedCalls.length >= MAX_TOOL_CALLS_PER_MESSAGE) {
        stats.toolCallsDropped += 1;
        conversation.push({
          kind: "tool_result",
          callId: call.callId,
          output: JSON.stringify({ ok: false, error: "tool_call_limit_reached" }),
        });
        continue;
      }

      const outcome = executeToolCall({
        session: working,
        call,
        sourceMessageId: userMessageId,
        withdrawalsSoFar,
        conflictResolutionsSoFar,
        context,
      });

      // A write that would push the state past its limit is refused, so the committed session can
      // always take another turn. Writes that shrink the state, such as a withdrawal, always pass.
      const grownStateSize = outcome.applied ? measureStateItem(outcome.session) : workingStateSize;
      const isTooLarge =
        grownStateSize > workingStateSize &&
        grownStateSize > MAX_STATE_ITEM_LENGTH - STATE_ITEM_WRITE_MARGIN;
      if (isTooLarge) {
        stats.toolCallsRejected += 1;
        stats.rejectionCodes.push("session_limit_reached");
        recordedCalls.push({
          ...outcome.record,
          outcome: { ok: false, code: "session_limit_reached" },
        });
        conversation.push({
          kind: "tool_result",
          callId: call.callId,
          output: JSON.stringify({
            ok: false,
            error: "session_limit_reached",
            message:
              "The SOP has reached its size limit, so nothing more can be added. Tell the user, and suggest removing something or starting a new chat.",
          }),
        });
        continue;
      }

      working = outcome.session;
      workingStateSize = grownStateSize;
      recordedCalls.push(outcome.record);
      if (outcome.applied) {
        stats.toolCallsApplied += 1;
        countChange(stats, outcome);
        if (outcome.change === "withdrawn") withdrawalsSoFar += 1;
        if (outcome.toolName === "resolve_conflict") conflictResolutionsSoFar += 1;
      } else {
        stats.toolCallsRejected += 1;
        if (outcome.rejectionCode !== null) stats.rejectionCodes.push(outcome.rejectionCode);
        if (outcome.rejectionCode === "withdraw_limit_reached") stats.withdrawLimitHits += 1;
        if (outcome.rejectionCode === "conflict_resolution_limit_reached") {
          stats.conflictResolutionLimitHits += 1;
        }
      }
      conversation.push({ kind: "tool_result", callId: call.callId, output: outcome.modelResult });
    }

    if (step === MAX_TOOL_ROUNDS) stats.toolRoundCapHit = true;
  }

  // The last step's state item carried the question, so it counts as asked once, whatever the reply
  // says. Only one kind is ever marked: when both are present the prompt tells the agent to
  // ask the depth question first (a restatement_mismatch never shares the state with one, see
  // selectReviewQuestions), so a consistency question that lost that priority fight was never
  // actually put to the person this turn, and must not silently consume its one-time offer — it
  // stays available to be asked, and marked offered, on a later turn instead.
  // Document passages rank between the two: never shown beside a depth question or a mismatch
  // (selectDocumentPassages), and ahead of a consistency question about an omission, which is
  // therefore left unmarked, to be asked on a later turn, whenever passages were shown.
  // A passage counts as asked only when the reply actually put it to the user: the agent can ask
  // something else instead, and a passage marked offered then was never raised again. Passages are
  // settled whatever the last step's state held: one shown and asked in an earlier step stays asked
  // even when a write in between brought a depth question into the last step.
  // A consistency question loses to a passage only when the reply actually asked one: a reply that
  // passed over every passage it was shown asked the consistency question, or nothing, instead.
  const replyText = assistantText.trim();
  const settled = settleShownDocumentPassages(working, [...shownPassageIds], replyText);
  working = settled.session;
  stats.documentPassagesOffered = settled.askedIds.length;
  stats.documentPassagesNotAsked = settled.notAskedIds.length;
  if (offeredDepthQuestion !== null) {
    working = markClaimDepthQuestionOffered(working, offeredDepthQuestion.findingId, context);
    stats.claimDepthQuestionFocus = offeredDepthQuestion.focus;
  } else if (settled.askedIds.length === 0 && offeredQuestion !== null) {
    working = markConsistencyQuestionOffered(working, offeredQuestion.findingId, context);
    stats.consistencyQuestionCategory = offeredQuestion.category;
  }
  stats.documentPassagesUsed = passagesNewlyIn(input.session, working, "used");
  stats.documentPassagesDeclined = passagesNewlyIn(input.session, working, "declined");
  stats.referenceConflictsRaised = passagesNewlyIn(input.session, working, "in_conflict");
  stats.claimDepthFindingsWaiting = currentClaimDepthReview(working)?.findings.length ?? 0;
  stats.consistencyFindingsWaiting =
    currentConsistencyReview(working)?.findings.filter((finding) => !finding.wasOffered).length ??
    0;

  if (replyText.length === 0) {
    throw new ModelOutputError("The model produced no reply.");
  }
  if (replyText.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
    throw new ModelOutputError("The model reply is too long.");
  }

  const assistantMessage: AssistantMessage = {
    id: context.newId(),
    role: "assistant",
    createdAt: context.now(),
    text: replyText,
    model,
    toolCalls: recordedCalls,
  };
  const finalSession: SopSession = {
    ...working,
    updatedAt: assistantMessage.createdAt,
    messages: [...working.messages, assistantMessage],
  };

  stats.historyEntriesWritten =
    finalSession.claimHistory.length - input.session.claimHistory.length;

  // A last line of defense: never hand the caller a session that the schema would reject.
  const validated = sopSessionSchema.safeParse(finalSession);
  if (!validated.success) {
    throw new Error("The agent turn produced an invalid session.");
  }

  return { session: validated.data, assistantMessage, stats };
}
