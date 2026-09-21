/**
 * Helpers for tests in this package and in the apps. Exposed as `@sop-agent/sop-core/testing` so
 * they are not part of the main entry point.
 */
import type { Claim } from "./claim.ts";
import { createEmptySession, type SopSession, type UserMessage } from "./session.ts";
import type { WriteContext } from "./writeContext.ts";

/** A fixed clock and a counting id generator, so every test run produces the same ids. */
export function createDeterministicContext(): WriteContext {
  let counter = 0;
  return {
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => {
      counter += 1;
      return `id-${counter}`;
    },
  };
}

export function createUserMessage(id: string, text = "A user statement."): UserMessage {
  return { id, role: "user", createdAt: "2026-01-01T00:00:00.000Z", text };
}

/** An empty draft session that already holds one user message, so claims have something to cite. */
export function createSessionWithUserMessage(
  context: WriteContext,
  text?: string,
): { session: SopSession; messageId: string } {
  const empty = createEmptySession(context);
  const messageId = context.newId();
  return {
    session: { ...empty, messages: [createUserMessage(messageId, text)] },
    messageId,
  };
}

/** Builds a claim directly, bypassing `applyClaim`, for states that nothing can create yet. */
export function buildClaim(overrides: Partial<Claim> & Pick<Claim, "claimId" | "field">): Claim {
  const status = overrides.status ?? "observed";
  const isUnknown = status === "unknown";
  const isExtracted = status === "extracted";
  const valueKind = overrides.field === "procedure" ? "step" : "statement";
  return {
    value: isUnknown ? null : { kind: valueKind, text: "A statement." },
    status,
    // An extracted claim comes from a document. Everything else here cites the first test message.
    source: isExtracted
      ? {
          type: "policy_document",
          reference: {
            kind: "document",
            citation: {
              documentName: "policy.md",
              location: "§ Rules",
              quote: "A verbatim quote from the policy.",
            },
          },
        }
      : { type: "employee_statement", reference: { kind: "message", messageId: "message-1" } },
    authority: isUnknown ? "unknown" : isExtracted ? "official_policy" : "observed_practice",
    effectiveDate: null,
    note: null,
    createdByType: isExtracted ? "extraction" : "agent",
    // A conflict names its partner. Tests that need a real pair build it through `applyClaim`.
    conflictsWithClaimId: status === "conflict" ? "unpaired-partner" : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
