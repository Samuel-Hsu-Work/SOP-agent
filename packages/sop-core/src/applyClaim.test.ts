import { describe, expect, it } from "vitest";
import { applyClaim, type RecordClaimCommand, STATUSES_WRITABLE_BY } from "./applyClaim.ts";
import { AGENT_WRITABLE_STATUSES, CLAIM_STATUSES, type ClaimStatus } from "./claim.ts";
import { MAX_CLAIMS, MAX_NOTE_LENGTH, MAX_STATEMENT_LENGTH } from "./limits.ts";
import type { SopSession } from "./session.ts";
import { buildClaim, createDeterministicContext, createSessionWithUserMessage } from "./testing.ts";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function setup() {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context);
  const command = (overrides: Partial<RecordClaimCommand> = {}): RecordClaimCommand => ({
    kind: "record",
    createdByType: "agent",
    field: "purpose",
    status: "observed",
    statement: "Handle customer refunds.",
    note: null,
    effectiveDate: null,
    sourceMessageId: messageId,
    replacesClaimId: null,
    ...overrides,
  });
  return { context, session, messageId, command };
}

function expectFailure(result: ReturnType<typeof applyClaim>, code: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("applyClaim: recording", () => {
  it("records an observed claim with provenance derived in code", () => {
    const { context, session, messageId, command } = setup();
    const result = applyClaim(session, command(), context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claim).toMatchObject({
      field: "purpose",
      value: { kind: "statement", text: "Handle customer refunds." },
      status: "observed",
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
      authority: "observed_practice",
      createdByType: "agent",
    });
    expect(result.session.claims).toEqual([result.claim]);
    expect(result.session.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("records a proposed claim as an agent suggestion", () => {
    const { context, session, command } = setup();
    const result = applyClaim(session, command({ status: "proposed" }), context);
    expect(result.ok && result.claim).toMatchObject({
      status: "proposed",
      source: { type: "agent_suggestion" },
      authority: "proposed",
    });
  });

  it("records an unknown claim with no value and unknown authority", () => {
    const { context, session, command } = setup();
    const result = applyClaim(
      session,
      command({ status: "unknown", statement: null, note: "Who approves large refunds." }),
      context,
    );
    expect(result.ok && result.claim).toMatchObject({
      status: "unknown",
      value: null,
      authority: "unknown",
      note: "Who approves large refunds.",
    });
  });

  it("trims the statement and turns a blank note into null", () => {
    const { context, session, command } = setup();
    const result = applyClaim(
      session,
      command({ statement: "  Handle refunds.  ", note: "   " }),
      context,
    );
    expect(result.ok && result.claim.value?.text).toBe("Handle refunds.");
    expect(result.ok && result.claim.note).toBeNull();
  });

  it("never mutates its input session", () => {
    const { context, session, command } = setup();
    const frozen = deepFreeze(JSON.parse(JSON.stringify(session)) as SopSession);
    const result = applyClaim(frozen, command(), context);
    expect(result.ok).toBe(true);
    expect(frozen.claims).toHaveLength(0);
  });
});

describe("applyClaim: the agent cannot confirm", () => {
  const forbiddenStatuses = CLAIM_STATUSES.filter(
    (status) => !(AGENT_WRITABLE_STATUSES as readonly ClaimStatus[]).includes(status),
  );

  it.each(forbiddenStatuses)("refuses to write a claim with status %s", (status) => {
    const { context, session, command } = setup();
    expectFailure(
      applyClaim(session, command({ status }), context),
      "status_not_allowed_for_creator",
    );
  });

  it("lists confirmed as writable by a person only, and conflict by nobody", () => {
    expect(STATUSES_WRITABLE_BY.agent).not.toContain("confirmed");
    expect(STATUSES_WRITABLE_BY.extraction).not.toContain("confirmed");
    expect(STATUSES_WRITABLE_BY.user).toContain("confirmed");
    for (const statuses of Object.values(STATUSES_WRITABLE_BY)) {
      expect(statuses).not.toContain("conflict");
    }
  });
});

describe("applyClaim: an approved session is immutable", () => {
  it("refuses every write, and checks this before anything else", () => {
    const { context, session, command } = setup();
    const approved: SopSession = { ...session, status: "approved" };
    expectFailure(applyClaim(approved, command(), context), "session_approved");
    expectFailure(
      applyClaim(approved, command({ status: "confirmed" }), context),
      "session_approved",
    );
  });
});

describe("applyClaim: values", () => {
  it("requires a statement unless the status is unknown", () => {
    const { context, session, command } = setup();
    expectFailure(applyClaim(session, command({ statement: null }), context), "value_required");
    expectFailure(applyClaim(session, command({ statement: "   " }), context), "value_required");
  });

  it("forbids a statement on an unknown claim", () => {
    const { context, session, command } = setup();
    expectFailure(
      applyClaim(session, command({ status: "unknown", statement: "Something" }), context),
      "value_not_allowed",
    );
  });

  it("rejects over-long statements and notes and malformed dates", () => {
    const { context, session, command } = setup();
    expectFailure(
      applyClaim(session, command({ statement: "x".repeat(MAX_STATEMENT_LENGTH + 1) }), context),
      "invalid_value",
    );
    expectFailure(
      applyClaim(session, command({ note: "x".repeat(MAX_NOTE_LENGTH + 1) }), context),
      "invalid_value",
    );
    expectFailure(
      applyClaim(session, command({ effectiveDate: "next Tuesday" }), context),
      "invalid_value",
    );
  });

  it("accepts a calendar date as the effective date", () => {
    const { context, session, command } = setup();
    const result = applyClaim(session, command({ effectiveDate: "2025-03-01" }), context);
    expect(result.ok && result.claim.effectiveDate).toBe("2025-03-01");
  });

  it("requires the cited message to be an existing user message", () => {
    const { context, session, command } = setup();
    expectFailure(
      applyClaim(session, command({ sourceMessageId: "missing" }), context),
      "source_message_not_found",
    );
    const withAssistant: SopSession = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: "assistant-1",
          role: "assistant",
          createdAt: "2026-01-01T00:00:00.000Z",
          text: "Hello",
          model: "test-model",
          toolCalls: [],
        },
      ],
    };
    expectFailure(
      applyClaim(withAssistant, command({ sourceMessageId: "assistant-1" }), context),
      "source_message_not_found",
    );
  });

  it("stops at the maximum number of claims", () => {
    const { context, session, messageId, command } = setup();
    const claims = Array.from({ length: MAX_CLAIMS }, (_, index) =>
      buildClaim({
        claimId: `claim-${index}`,
        field: "purpose",
        source: { type: "employee_statement", reference: { kind: "message", messageId } },
      }),
    );
    expectFailure(applyClaim({ ...session, claims }, command(), context), "session_limit_reached");
  });
});

describe("applyClaim: replacing an unknown claim", () => {
  function sessionWithUnknown() {
    const { context, session, messageId, command } = setup();
    const first = applyClaim(
      session,
      command({ field: "authorization", status: "unknown", statement: null }),
      context,
    );
    if (!first.ok) throw new Error("setup failed");
    return {
      context,
      session: first.session,
      unknownClaimId: first.claim.claimId,
      command,
      messageId,
    };
  }

  it("removes the unknown claim, adds the new one, and archives the old one", () => {
    const { context, session, unknownClaimId, command } = sessionWithUnknown();
    const result = applyClaim(
      session,
      command({
        field: "authorization",
        statement: "A manager approves refunds above $200.",
        replacesClaimId: unknownClaimId,
      }),
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.claims).toEqual([result.claim]);
    expect(result.session.claimHistory).toHaveLength(1);
    expect(result.session.claimHistory[0]).toMatchObject({
      claimId: unknownClaimId,
      changedBy: "agent",
      reason: "replaced",
      previousClaim: { status: "unknown", claimId: unknownClaimId },
    });
  });

  it("resolves the gap once the unknown is replaced", () => {
    const { context, session, unknownClaimId, command } = sessionWithUnknown();
    const result = applyClaim(
      session,
      command({ field: "authorization", replacesClaimId: unknownClaimId }),
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.claims.some((claim) => claim.status === "unknown")).toBe(false);
  });

  it("rejects a missing target, a target in another field, and a target that is not unknown", () => {
    const { context, session, unknownClaimId, command, messageId } = sessionWithUnknown();
    expectFailure(
      applyClaim(session, command({ field: "authorization", replacesClaimId: "nope" }), context),
      "replace_target_not_found",
    );
    expectFailure(
      applyClaim(session, command({ field: "purpose", replacesClaimId: unknownClaimId }), context),
      "replace_field_mismatch",
    );

    const observed = buildClaim({
      claimId: "observed-1",
      field: "authorization",
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
    });
    expectFailure(
      applyClaim(
        { ...session, claims: [observed] },
        command({ field: "authorization", replacesClaimId: "observed-1" }),
        context,
      ),
      "replace_target_not_unknown",
    );
  });
});
