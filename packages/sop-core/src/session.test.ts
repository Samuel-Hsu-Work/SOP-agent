import { describe, expect, it } from "vitest";
import { applyClaim, type ClaimWriteCommand, type RecordClaimCommand } from "./applyClaim.ts";
import { computeGaps } from "./computeGaps.ts";
import { MAX_MESSAGES, MAX_STATEMENT_LENGTH } from "./limits.ts";
import { createEmptySession, type SopSession, sopSessionSchema } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import { buildClaim, createDeterministicContext, createSessionWithUserMessage } from "./testing.ts";

/** A session that exercises every nullable field, every history reason and both value kinds. */
function buildRichSession(): SopSession {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context, "We refund within 30 days.");
  const shared = { createdByType: "agent", sourceMessageId: messageId } as const;
  const record = (
    field: SopFieldName,
    statement: string,
    overrides: Partial<RecordClaimCommand> = {},
  ): RecordClaimCommand => ({
    kind: "record",
    ...shared,
    field,
    status: "observed",
    statement,
    note: null,
    effectiveDate: null,
    insertBeforeClaimId: null,
    ...overrides,
  });
  const applyOk = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result;
  };

  let current = applyOk(session, record("purpose", "Handle refunds.")).session;
  current = applyOk(
    current,
    record("scope", "Online orders only.", {
      status: "proposed",
      note: "Suggested.",
      effectiveDate: "2025-03-01",
    }),
  ).session;
  const first = applyOk(current, record("procedure", "Receive the request."));
  const second = applyOk(first.session, record("procedure", "Check the policy."));
  const third = applyOk(second.session, record("procedure", "Issue the refund."));
  current = third.session;

  const purpose = applyOk(current, {
    kind: "correct",
    ...shared,
    claimId: current.claims[0]?.claimId ?? "",
    statement: "Handle refunds and exchanges.",
    note: null,
    effectiveDate: null,
  });
  current = purpose.session;

  const unknown = applyOk(current, {
    kind: "markUnknown",
    ...shared,
    field: "authorization",
    claimId: null,
    note: "Approver unclear.",
  });
  current = applyOk(unknown.session, {
    kind: "correct",
    ...shared,
    claimId: unknown.claim.claimId,
    statement: "A lead approves.",
    note: null,
    effectiveDate: null,
  }).session;
  current = applyOk(current, {
    kind: "markUnknown",
    ...shared,
    field: "procedure",
    claimId: second.claim.claimId,
    note: "Not sure who checks.",
  }).session;
  current = applyOk(current, {
    kind: "withdraw",
    ...shared,
    claimId: first.claim.claimId,
    note: "Not part of this process.",
  }).session;

  return {
    ...current,
    messages: [
      ...current.messages,
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
            outcome: { ok: true, claimId: "id-3", change: "created" },
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
    expect(new Set(session.claimHistory.map((entry) => entry.reason))).toEqual(
      new Set(["corrected", "answered_unknown", "marked_unknown", "withdrawn"]),
    );
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

  it("rejects a stored version-1 session, and other wrong versions and malformed timestamps", () => {
    const session = createEmptySession(createDeterministicContext());
    expect(sopSessionSchema.safeParse({ ...session, schemaVersion: 1 }).success).toBe(false);
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

  it("rejects a broken procedure order", () => {
    const session = buildRichSession();
    const [firstId, secondId] = session.procedureOrder;
    if (firstId === undefined || secondId === undefined) throw new Error("setup failed");
    const purposeId = session.claims.find((claim) => claim.field === "purpose")?.claimId ?? "";
    const withOrder = (procedureOrder: string[]) =>
      sopSessionSchema.safeParse({ ...session, procedureOrder }).success;

    expect(withOrder([firstId, secondId])).toBe(true);
    expect(withOrder([secondId, firstId])).toBe(true);
    expect(withOrder([firstId, firstId])).toBe(false); // repeats a step
    expect(withOrder([firstId])).toBe(false); // leaves an active step unlisted
    expect(withOrder([firstId, secondId, purposeId])).toBe(false); // lists a non-procedure claim
    expect(withOrder([firstId, secondId, "missing"])).toBe(false); // lists no claim at all
  });

  it("rejects a step outside the procedure field and a statement inside it", () => {
    const session = buildRichSession();
    const purpose = session.claims.find((claim) => claim.field === "purpose");
    if (purpose === undefined) throw new Error("setup failed");
    const asStep = { ...purpose, value: { kind: "step", text: "A step." } };
    expect(
      sopSessionSchema.safeParse({
        ...session,
        claims: session.claims.map((claim) => (claim === purpose ? asStep : claim)),
      }).success,
    ).toBe(false);

    const step = session.claims.find((claim) => claim.value?.kind === "step");
    if (step === undefined) throw new Error("setup failed");
    const asStatement = { ...step, value: { kind: "statement", text: "Not a step." } };
    expect(
      sopSessionSchema.safeParse({
        ...session,
        claims: session.claims.map((claim) => (claim === step ? asStatement : claim)),
      }).success,
    ).toBe(false);
  });

  it("rejects a history entry that cites a missing message", () => {
    const session = buildRichSession();
    const entry = session.claimHistory[0];
    if (entry === undefined) throw new Error("setup failed");
    const dangling = { ...entry, sourceMessageId: "missing" };
    expect(sopSessionSchema.safeParse({ ...session, claimHistory: [dangling] }).success).toBe(
      false,
    );
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
