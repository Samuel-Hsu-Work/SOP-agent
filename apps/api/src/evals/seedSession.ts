import {
  applyClaim,
  createEmptySession,
  type SopSession,
  type UserMessage,
  type WriteContext,
} from "@sop-agent/sop-core";
import type { SeedStep } from "./evalTypes.ts";

const SEED_MESSAGE_TEXT = "Earlier statements from the expert.";

/** Builds the session a scenario starts from. The seeded claims cite one earlier user message. */
export function buildSeedSession(steps: readonly SeedStep[], context: WriteContext): SopSession {
  const empty = createEmptySession(context);
  if (steps.length === 0) return empty;

  const earlierMessage: UserMessage = {
    id: context.newId(),
    role: "user",
    createdAt: context.now(),
    text: SEED_MESSAGE_TEXT,
  };

  let session: SopSession = { ...empty, messages: [earlierMessage] };
  for (const step of steps) {
    const result = applyClaim(
      session,
      step.kind === "record"
        ? {
            kind: "record",
            createdByType: "agent",
            field: step.field,
            status: step.status ?? "observed",
            statement: step.statement,
            note: null,
            effectiveDate: null,
            sourceMessageId: earlierMessage.id,
            insertBeforeClaimId: null,
          }
        : {
            kind: "markUnknown",
            createdByType: "agent",
            field: step.field,
            claimId: null,
            note: step.note,
            sourceMessageId: earlierMessage.id,
          },
      context,
    );
    if (!result.ok) throw new Error(`Could not seed the scenario: ${result.error.code}`);
    session = result.session;
  }
  return session;
}
