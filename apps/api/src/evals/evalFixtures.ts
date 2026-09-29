/**
 * Builds transcripts by hand for the unit tests of the assertions, so the assertion logic is
 * checked offline and for free. Real transcripts come from `runScenario`.
 */
import {
  applyClaim,
  type ClaimWriteCommand,
  declineDocumentPassage,
  type SopFieldName,
  type SopSession,
  selectDocumentPassages,
  settleShownDocumentPassages,
} from "@sop-agent/sop-core";
import { createDeterministicContext } from "@sop-agent/sop-core/testing";
import type { SeedStep, Transcript, TranscriptTurn } from "./evalTypes.ts";
import { buildSeedSession } from "./seedSession.ts";

export function createFixtureContext() {
  return createDeterministicContext();
}

export interface FixtureTurn {
  expertLine?: string;
  reply: string;
  /** Applied to the session in order, citing the turn's user message. */
  commands?: (Partial<ClaimWriteCommand> & { kind: ClaimWriteCommand["kind"] })[];
  /** Passages the agent declined this turn, by id, applied after the commands. */
  declinedPassageIds?: string[];
  failure?: string;
}

/** Plays fixture turns against the real `applyClaim`, so the sessions in the transcript are valid. */
export function buildTranscript(input: {
  seed?: SeedStep[];
  turns: FixtureTurn[];
  scenarioId?: string;
}): Transcript {
  const context = createFixtureContext();
  const seedSession = buildSeedSession(input.seed ?? [], context);
  let session: SopSession = seedSession;
  const turns: TranscriptTurn[] = [];

  for (const fixture of input.turns) {
    const messageId = context.newId();
    session = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: messageId,
          role: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
          text: fixture.expertLine ?? "An expert line.",
        },
      ],
    };
    // As a real turn does: the state shows passages before the writes and again after them.
    const shownPassageIds = new Set(
      selectDocumentPassages(session).map((passage) => passage.passageId),
    );
    for (const command of fixture.commands ?? []) {
      const result = applyClaim(
        session,
        { createdByType: "agent", sourceMessageId: messageId, ...command } as ClaimWriteCommand,
        context,
      );
      if (!result.ok) throw new Error(`fixture failed: ${result.error.code}`);
      session = result.session;
    }
    for (const passageId of fixture.declinedPassageIds ?? []) {
      const result = declineDocumentPassage(
        session,
        { kind: "declineDocumentPassage", createdByType: "agent", passageId },
        context,
      );
      if (!result.ok) throw new Error(`fixture failed: ${result.error.code}`);
      session = result.session;
    }
    for (const passage of selectDocumentPassages(session)) shownPassageIds.add(passage.passageId);
    // A passage shown to the agent counts as put to the expert only if the reply put it to them.
    session = settleShownDocumentPassages(
      session,
      [...shownPassageIds],
      fixture.failure === undefined ? fixture.reply : "",
    ).session;
    turns.push({
      expertLine: fixture.expertLine ?? "An expert line.",
      assistantText: fixture.failure === undefined ? fixture.reply : null,
      toolCalls: [],
      sessionAfter: session,
      stats: null,
      failure: fixture.failure ?? null,
    });
  }

  return {
    scenarioId: input.scenarioId ?? "fixture",
    model: "fixture-model",
    trial: 1,
    seedSession,
    turns,
  };
}

export function recordCommand(
  field: SopFieldName,
  statement: string,
  status: "observed" | "proposed" = "observed",
) {
  return {
    kind: "record" as const,
    field,
    status,
    statement,
    note: null,
    effectiveDate: null,
    insertBeforeClaimId: null,
  };
}
