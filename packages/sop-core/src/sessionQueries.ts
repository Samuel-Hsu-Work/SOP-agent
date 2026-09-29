import type { Claim } from "./claims/claim.ts";
import type { SopSession } from "./session.ts";

/*
 * Reading a session: what the person said and what they stand behind. Every rule that needs one of
 * these asks here, so "stated" and "the user's latest message" mean the same thing everywhere.
 */

/** A claim the person stands behind: something they said, or something they confirmed. */
export function isStatedClaim(claim: Claim): boolean {
  return claim.value !== null && (claim.status === "observed" || claim.status === "confirmed");
}

/**
 * The claims the person stands behind, as a reader meets them: what the person stated (observed or confirmed), with the
 * procedure's steps in their real order. A suggestion is not the person's word, an unknown has no
 * text, and a passage from an upload is not a claim at all until the person agrees with it, when it
 * is their own statement.
 */
export function statedClaimsInReadingOrder(session: SopSession): Claim[] {
  const stated = session.claims.filter(isStatedClaim);
  const byId = new Map(stated.map((claim) => [claim.claimId, claim]));
  const orderedSteps = session.procedureOrder.flatMap((claimId) => {
    const step = byId.get(claimId);
    return step === undefined ? [] : [step];
  });
  const stepIds = new Set(orderedSteps.map((step) => step.claimId));
  return [
    ...orderedSteps,
    ...stated.filter((claim) => claim.field !== "procedure" || !stepIds.has(claim.claimId)),
  ];
}

/** The text of the latest user message, or empty when there is none. */
export function lastUserMessageText(session: SopSession): string {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

/** Whether the session holds this user message: every write must cite one. */
export function hasUserMessage(session: SopSession, messageId: string): boolean {
  return session.messages.some((message) => message.role === "user" && message.id === messageId);
}

/** The text of the user message a write cites, or "" when there is none. */
export function userMessageText(session: SopSession, messageId: string): string {
  return session.messages.find((message) => message.id === messageId)?.text ?? "";
}

/**
 * What a person says when they want the questions to stop. Deliberately narrow, and in the first
 * person: "there is no time limit for appeals" and "appeals filed out of time go to Legal" are statements about the process, not requests. A
 * false positive costs one consistency question that is not asked, and nothing else, because the
 * ordinary agenda never reads this.
 */
const OUT_OF_TIME_PATTERN =
  /\b(?:i'?m|i am|we'?re|we are)(?: (?:really|totally|just|almost))? (?:out of|running out of) time\b|\bi (?:have|got) no (?:more )?time|\bi (?:don'?t|do not) have (?:much |any |more |the )?time|no more questions|stop asking|that'?s (?:all|everything)|that is (?:all|everything)|i'?m done|i am done/i;

export function statesOutOfTime(userMessage: string): boolean {
  return OUT_OF_TIME_PATTERN.test(userMessage);
}
