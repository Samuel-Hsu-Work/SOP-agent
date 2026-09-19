import { describe, expect, it } from "vitest";
import { applyClaim } from "./applyClaim.ts";
import { computeGaps } from "./computeGaps.ts";
import { MAX_MESSAGES, MAX_STATEMENT_LENGTH } from "./limits.ts";
import { createEmptySession, type SopSession, sopSessionSchema } from "./session.ts";
import { buildClaim, createDeterministicContext, createSessionWithUserMessage } from "./testing.ts";

/** A session that exercises every nullable field in both of its states. */
function buildRichSession(): SopSession {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context, "We refund within 30 days.");
  const base = {
    kind: "record",
    createdByType: "agent",
    sourceMessageId: messageId,
    replacesClaimId: null,
  } as const;

  const steps = [
    {
      field: "purpose",
      status: "observed",
      statement: "Handle refunds.",
      note: null,
      effectiveDate: null,
    },
    {
      field: "scope",
      status: "proposed",
      statement: "Online orders only.",
      note: "Suggested.",
      effectiveDate: "2025-03-01",
    },
    {
      field: "authorization",
      status: "unknown",
      statement: null,
      note: "Approver unclear.",
      effectiveDate: null,
    },
  ] as const;

  let current = session;
  let unknownId = "";
  for (const step of steps) {
    const result = applyClaim(current, { ...base, ...step }, context);
    if (!result.ok) throw new Error("setup failed");
    current = result.session;
    if (step.status === "unknown") unknownId = result.claim.claimId;
  }
  const replaced = applyClaim(
    current,
    {
      ...base,
      field: "authorization",
      status: "observed",
      statement: "A lead approves.",
      note: null,
      effectiveDate: null,
      replacesClaimId: unknownId,
    },
    context,
  );
  if (!replaced.ok) throw new Error("setup failed");

  return {
    ...replaced.session,
    messages: [
      ...replaced.session.messages,
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:00.000Z",
        text: "Thanks. Who approves large refunds?",
        model: "gpt-5.6-sol",
        toolCalls: [
          {
            callId: "call_1",
            toolName: "record_claim",
            field: "purpose",
            requestedStatus: "observed",
            outcome: { ok: true, claimId: "id-3" },
          },
          {
            callId: "call_2",
            toolName: "record_claim",
            field: null,
            requestedStatus: null,
            outcome: { ok: false, code: "invalid_arguments" },
          },
        ],
      },
    ],
  };
}

describe("sopSessionSchema", () => {
  it("accepts a new empty session and reports 13 gaps for it", () => {
    const session = createEmptySession(createDeterministicContext());
    const parsed = sopSessionSchema.parse(session);
    expect(parsed).toEqual(session);
    expect(parsed.status).toBe("draft");
    expect(computeGaps(parsed).gaps).toHaveLength(13);
  });

  it("survives a JSON round trip without loss", () => {
    const session = buildRichSession();
    expect(session.claimHistory).toHaveLength(1);
    const roundTripped = sopSessionSchema.parse(JSON.parse(JSON.stringify(session)));
    expect(roundTripped).toEqual(session);
  });

  it("strips unknown keys instead of passing them through", () => {
    const session = buildRichSession();
    const tampered = {
      ...JSON.parse(JSON.stringify(session)),
      injected: "top level",
    };
    tampered.claims[0].injected = "nested";
    const parsed = sopSessionSchema.parse(tampered) as Record<string, unknown>;
    expect(parsed.injected).toBeUndefined();
    expect((parsed.claims as Record<string, unknown>[])[0]?.injected).toBeUndefined();
  });

  it("rejects a wrong schema version and malformed timestamps", () => {
    const session = createEmptySession(createDeterministicContext());
    expect(sopSessionSchema.safeParse({ ...session, schemaVersion: 2 }).success).toBe(false);
    expect(sopSessionSchema.safeParse({ ...session, createdAt: "yesterday" }).success).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const session = buildRichSession();
    const claim = session.claims[0];
    if (claim === undefined) throw new Error("setup failed");
    expect(sopSessionSchema.safeParse({ ...session, claims: [claim, claim] }).success).toBe(false);

    const message = session.messages[0];
    if (message === undefined) throw new Error("setup failed");
    expect(sopSessionSchema.safeParse({ ...session, messages: [message, message] }).success).toBe(
      false,
    );
  });

  it("rejects a claim that cites a missing message or an assistant message", () => {
    const session = buildRichSession();
    const claim = session.claims[0];
    if (claim === undefined) throw new Error("setup failed");
    for (const messageId of ["missing", "assistant-1"]) {
      const dangling = {
        ...claim,
        source: { ...claim.source, reference: { kind: "message" as const, messageId } },
      };
      expect(sopSessionSchema.safeParse({ ...session, claims: [dangling] }).success).toBe(false);
    }
  });

  it("rejects claims that break the value and authority rules", () => {
    const session = createSessionWithUserMessage(createDeterministicContext());
    const messageId = session.messageId;
    const source = {
      type: "employee_statement" as const,
      reference: { kind: "message" as const, messageId },
    };
    const withClaim = (claim: unknown) =>
      sopSessionSchema.safeParse({ ...session.session, claims: [claim] });

    const unknownWithValue = buildClaim({
      claimId: "c1",
      field: "roles",
      status: "unknown",
      source,
    });
    expect(
      withClaim({ ...unknownWithValue, value: { kind: "statement", text: "x" } }).success,
    ).toBe(false);

    const observed = buildClaim({ claimId: "c2", field: "roles", status: "observed", source });
    expect(withClaim({ ...observed, value: null }).success).toBe(false);
    expect(withClaim({ ...observed, authority: "proposed" }).success).toBe(false);
    expect(withClaim(observed).success).toBe(true);
  });

  it("rejects oversized arrays and oversized text", () => {
    const session = createEmptySession(createDeterministicContext());
    const message = (index: number) => ({
      id: `m-${index}`,
      role: "user" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      text: "hello",
    });
    const tooMany = Array.from({ length: MAX_MESSAGES + 1 }, (_, index) => message(index));
    expect(sopSessionSchema.safeParse({ ...session, messages: tooMany }).success).toBe(false);

    const rich = buildRichSession();
    const claim = rich.claims[0];
    if (claim === undefined) throw new Error("setup failed");
    const longClaim = {
      ...claim,
      value: { kind: "statement" as const, text: "x".repeat(MAX_STATEMENT_LENGTH + 1) },
    };
    expect(sopSessionSchema.safeParse({ ...rich, claims: [longClaim] }).success).toBe(false);
  });
});
