import {
  addReferenceDocument,
  applyClaim,
  createEmptySession,
  markDocumentPassagesOffered,
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
    if (step.kind === "reference") {
      session = seedReference(session, step, context);
      continue;
    }
    const result = applyClaim(
      session,
      step.kind === "record" || step.kind === "confirmed"
        ? {
            kind: "record",
            createdByType: "agent",
            field: step.field,
            status: step.kind === "record" ? (step.status ?? "observed") : "observed",
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

    if (step.kind === "confirmed") {
      // A person's review action, the only thing that produces a confirmed claim.
      const confirmed = applyClaim(
        session,
        { kind: "confirm", createdByType: "user", claimId: result.claim.claimId },
        context,
      );
      if (!confirmed.ok) throw new Error(`Could not confirm the seed: ${confirmed.error.code}`);
      session = confirmed.session;
    }
  }
  return session;
}

/** Keeps one passage through the real upload path, and marks it offered when the step says so. */
function seedReference(
  session: SopSession,
  step: Extract<SeedStep, { kind: "reference" }>,
  context: WriteContext,
): SopSession {
  const documentName = step.documentName ?? "policy-document.md";
  const result = addReferenceDocument(
    session,
    {
      document: { fileName: documentName, fileKind: "markdown" },
      passages: [
        {
          field: step.field,
          statement: step.statement,
          effectiveDate: null,
          citation: { documentName, location: "§ Rules", quote: step.quote ?? step.statement },
        },
      ],
    },
    context,
  );
  if (!result.ok) throw new Error(`Could not seed the passage: ${result.error.code}`);
  if (step.offered !== true) return result.session;
  const passage = result.session.references.passages.at(-1);
  if (passage === undefined) throw new Error("Could not seed the passage.");
  return markDocumentPassagesOffered(result.session, [passage.passageId]);
}
