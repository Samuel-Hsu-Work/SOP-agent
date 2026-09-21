import { describe, expect, it } from "vitest";
import {
  applyClaim,
  type ClaimWriteCommand,
  type CorrectClaimCommand,
  type MarkUnknownCommand,
  type RecordClaimCommand,
  STATUSES_WRITABLE_BY,
  type WithdrawClaimCommand,
} from "./applyClaim.ts";
import { AGENT_WRITABLE_STATUSES, CLAIM_STATUSES, type ClaimStatus } from "./claim.ts";
import {
  MAX_CLAIMS,
  MAX_HISTORY_ENTRIES,
  MAX_NOTE_LENGTH,
  MAX_STATEMENT_LENGTH,
  MAX_TOTAL_CLAIM_TEXT,
} from "./limits.ts";
import { type SopSession, sopSessionSchema } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import { buildClaim, createDeterministicContext, createSessionWithUserMessage } from "./testing.ts";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A session with one user message and builders for the four commands, all citing that message. */
function setup() {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context);
  const record = (overrides: Partial<RecordClaimCommand> = {}): RecordClaimCommand => ({
    kind: "record",
    createdByType: "agent",
    field: "purpose",
    status: "observed",
    statement: "Handle customer refunds.",
    note: null,
    effectiveDate: null,
    sourceMessageId: messageId,
    insertBeforeClaimId: null,
    ...overrides,
  });
  const correct = (
    claimId: string,
    overrides: Partial<CorrectClaimCommand> = {},
  ): CorrectClaimCommand => ({
    kind: "correct",
    createdByType: "agent",
    claimId,
    statement: "Handle refunds and exchanges.",
    note: null,
    effectiveDate: null,
    sourceMessageId: messageId,
    ...overrides,
  });
  const markUnknown = (
    field: SopFieldName,
    claimId: string | null,
    overrides: Partial<MarkUnknownCommand> = {},
  ): MarkUnknownCommand => ({
    kind: "markUnknown",
    createdByType: "agent",
    field,
    claimId,
    note: "The user does not know.",
    sourceMessageId: messageId,
    ...overrides,
  });
  const withdraw = (
    claimId: string,
    overrides: Partial<WithdrawClaimCommand> = {},
  ): WithdrawClaimCommand => ({
    kind: "withdraw",
    createdByType: "agent",
    claimId,
    note: "The user said it does not apply.",
    sourceMessageId: messageId,
    ...overrides,
  });

  /** Applies a command that must succeed and returns the new session and the claim it touched. */
  const applyOk = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result;
  };
  return { context, session, messageId, record, correct, markUnknown, withdraw, applyOk };
}

function expectFailure(result: ReturnType<typeof applyClaim>, code: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

function procedureStepTexts(session: SopSession): string[] {
  return session.procedureOrder.map((claimId) => {
    const claim = session.claims.find((candidate) => candidate.claimId === claimId);
    return claim?.value?.text ?? "";
  });
}

describe("applyClaim: recording", () => {
  it("records an observed claim with provenance derived in code", () => {
    const { context, session, messageId, record } = setup();
    const result = applyClaim(session, record(), context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toBe("created");
    expect(result.claim).toMatchObject({
      field: "purpose",
      value: { kind: "statement", text: "Handle customer refunds." },
      status: "observed",
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
      authority: "observed_practice",
      createdByType: "agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.session.claims).toEqual([result.claim]);
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("records a proposed claim as an agent suggestion", () => {
    const { context, session, record } = setup();
    const result = applyClaim(session, record({ status: "proposed" }), context);
    expect(result.ok && result.claim).toMatchObject({
      status: "proposed",
      source: { type: "agent_suggestion" },
      authority: "proposed",
    });
  });

  it("sends an unknown to mark_claim_unknown instead", () => {
    const { context, session, record } = setup();
    expectFailure(
      applyClaim(session, record({ status: "unknown" }), context),
      "wrong_command_for_status",
    );
  });

  it("trims the statement and turns a blank note into null", () => {
    const { context, session, record } = setup();
    const result = applyClaim(
      session,
      record({ statement: "  Handle refunds.  ", note: "   " }),
      context,
    );
    expect(result.ok && result.claim.value?.text).toBe("Handle refunds.");
    expect(result.ok && result.claim.note).toBeNull();
  });

  it("never mutates its input session", () => {
    const { context, session, record } = setup();
    const frozen = deepFreeze(JSON.parse(JSON.stringify(session)) as SopSession);
    const result = applyClaim(frozen, record(), context);
    expect(result.ok).toBe(true);
    expect(frozen.claims).toHaveLength(0);
  });

  it("treats the same claim recorded twice as unchanged", () => {
    const { context, session, record, applyOk } = setup();
    const first = applyOk(session, record());
    const again = applyClaim(
      first.session,
      record({ statement: "  handle CUSTOMER refunds. " }),
      context,
    );

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.change).toBe("unchanged");
    expect(again.claim.claimId).toBe(first.claim.claimId);
    expect(again.session).toBe(first.session);
  });

  it("refuses the same words with a different note or date instead of dropping the new detail", () => {
    const { context, session, record, applyOk } = setup();
    const first = applyOk(session, record({ note: "Per the handbook." }));

    const differentNote = applyClaim(first.session, record({ note: "Per the wiki." }), context);
    expectFailure(differentNote, "already_recorded");
    expect(!differentNote.ok && differentNote.error.message).toContain(first.claim.claimId);

    expectFailure(
      applyClaim(
        first.session,
        record({ note: "Per the handbook.", effectiveDate: "2025-03-01" }),
        context,
      ),
      "already_recorded",
    );
    const same = applyClaim(first.session, record({ note: "Per the handbook." }), context);
    expect(same.ok && same.change).toBe("unchanged");
  });

  it("does not treat the same text with another status as a duplicate", () => {
    const { session, record, applyOk } = setup();
    const observed = applyOk(session, record());
    const proposed = applyOk(observed.session, record({ status: "proposed" }));
    expect(proposed.change).toBe("created");
    expect(proposed.session.claims).toHaveLength(2);
  });

  it("does not close an unknown when another claim is recorded in the same field", () => {
    const { session, record, markUnknown, applyOk } = setup();
    const unknown = applyOk(session, markUnknown("purpose", null));
    const other = applyOk(unknown.session, record());

    expect(other.session.claims.map((claim) => claim.status)).toEqual(["unknown", "observed"]);
    expect(other.session.claimHistory).toEqual([]);
    expect(sopSessionSchema.safeParse(other.session).success).toBe(true);
  });
});

describe("applyClaim: the agent cannot confirm", () => {
  const forbiddenStatuses = CLAIM_STATUSES.filter(
    (status) => !(AGENT_WRITABLE_STATUSES as readonly ClaimStatus[]).includes(status),
  );

  it.each(forbiddenStatuses)("refuses to write a claim with status %s", (status) => {
    const { context, session, record } = setup();
    expectFailure(
      applyClaim(session, record({ status }), context),
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

  it("never leaves a claim confirmed after a correction", () => {
    const { context, session, messageId, correct } = setup();
    const confirmed = buildClaim({
      claimId: "confirmed-1",
      field: "purpose",
      status: "confirmed",
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
    });
    const result = applyClaim({ ...session, claims: [confirmed] }, correct("confirmed-1"), context);
    expect(result.ok && result.claim.status).toBe("observed");
    expect(result.ok && result.session.claimHistory[0]?.previousClaim.status).toBe("confirmed");
  });
});

describe("applyClaim: the agent and a confirmed claim", () => {
  function confirmedSession() {
    const { context, session, messageId, markUnknown, withdraw, correct } = setup();
    const claim = buildClaim({
      claimId: "confirmed-1",
      field: "purpose",
      status: "confirmed",
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
    });
    return { context, session: { ...session, claims: [claim] }, markUnknown, withdraw, correct };
  }

  it("refuses to withdraw or mark unknown a confirmed claim, and says how to proceed", () => {
    const { context, session, markUnknown, withdraw } = confirmedSession();
    const withdrawn = applyClaim(session, withdraw("confirmed-1"), context);
    const blanked = applyClaim(session, markUnknown("purpose", "confirmed-1"), context);

    for (const result of [withdrawn, blanked]) {
      expectFailure(result, "confirmation_required");
      expect(!result.ok && result.error.message).toContain("review panel");
      expect(!result.ok && result.error.message).toContain("correct_claim");
    }
  });

  it("still lets the agent correct a confirmed claim, which drops it to observed with history", () => {
    const { context, session, correct } = confirmedSession();
    const result = applyClaim(session, correct("confirmed-1"), context);
    expect(result.ok && result.claim.status).toBe("observed");
    expect(result.ok && result.session.claimHistory[0]).toMatchObject({
      reason: "corrected",
      previousClaim: { status: "confirmed" },
    });
  });
});

describe("applyClaim: an approved session is immutable", () => {
  it("refuses all four commands, and checks this before anything else", () => {
    const { context, session, record, correct, markUnknown, withdraw } = setup();
    const approved: SopSession = { ...session, status: "approved" };
    expectFailure(applyClaim(approved, record(), context), "session_approved");
    expectFailure(
      applyClaim(approved, record({ status: "confirmed" }), context),
      "session_approved",
    );
    expectFailure(applyClaim(approved, correct("any"), context), "session_approved");
    expectFailure(applyClaim(approved, markUnknown("purpose", null), context), "session_approved");
    expectFailure(applyClaim(approved, withdraw("any"), context), "session_approved");
  });
});

describe("applyClaim: values", () => {
  it("requires a non-blank statement", () => {
    const { context, session, record } = setup();
    expectFailure(applyClaim(session, record({ statement: "   " }), context), "value_required");
  });

  it("rejects over-long statements and notes and malformed dates", () => {
    const { context, session, record } = setup();
    expectFailure(
      applyClaim(session, record({ statement: "x".repeat(MAX_STATEMENT_LENGTH + 1) }), context),
      "invalid_value",
    );
    expectFailure(
      applyClaim(session, record({ note: "x".repeat(MAX_NOTE_LENGTH + 1) }), context),
      "invalid_value",
    );
    expectFailure(
      applyClaim(session, record({ effectiveDate: "next Tuesday" }), context),
      "invalid_value",
    );
  });

  it("accepts a calendar date as the effective date", () => {
    const { context, session, record } = setup();
    const result = applyClaim(session, record({ effectiveDate: "2025-03-01" }), context);
    expect(result.ok && result.claim.effectiveDate).toBe("2025-03-01");
  });

  it("requires the cited message to be an existing user message, for every command", () => {
    const { context, session, record, correct, markUnknown, withdraw, applyOk } = setup();
    const existing = applyOk(session, record());
    const withAssistant: SopSession = {
      ...existing.session,
      messages: [
        ...existing.session.messages,
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
    const claimId = existing.claim.claimId;
    for (const sourceMessageId of ["missing", "assistant-1"]) {
      for (const command of [
        record({ statement: "Another one.", sourceMessageId }),
        correct(claimId, { sourceMessageId }),
        markUnknown("scope", null, { sourceMessageId }),
        withdraw(claimId, { sourceMessageId }),
      ]) {
        expectFailure(applyClaim(withAssistant, command, context), "source_message_not_found");
      }
    }
  });

  it("stops at the maximum number of claims", () => {
    const { context, session, messageId, record } = setup();
    const claims = Array.from({ length: MAX_CLAIMS }, (_, index) =>
      buildClaim({
        claimId: `claim-${index}`,
        field: "purpose",
        value: { kind: "statement", text: `Statement ${index}.` },
        source: { type: "employee_statement", reference: { kind: "message", messageId } },
      }),
    );
    expectFailure(applyClaim({ ...session, claims }, record(), context), "session_limit_reached");
  });

  it("stops when the claims would hold too much text, but still allows a shrinking change", () => {
    const { context, session, messageId, record, correct } = setup();
    const source = {
      type: "employee_statement" as const,
      reference: { kind: "message" as const, messageId },
    };
    const perClaim = MAX_STATEMENT_LENGTH;
    const claimCount = Math.floor(MAX_TOTAL_CLAIM_TEXT / perClaim);
    const claims = Array.from({ length: claimCount }, (_, index) =>
      buildClaim({
        claimId: `claim-${index}`,
        field: "purpose",
        value: { kind: "statement", text: "x".repeat(perClaim) },
        source,
      }),
    );
    const full = { ...session, claims };
    expectFailure(
      applyClaim(full, record({ statement: "One more sentence." }), context),
      "session_limit_reached",
    );
    const shrunk = applyClaim(full, correct("claim-0", { statement: "Short." }), context);
    expect(shrunk.ok).toBe(true);
  });
});

describe("applyClaim: correcting", () => {
  it("keeps the id and the creation time, moves the update time, and archives the old claim", () => {
    const { session, record, correct, applyOk, messageId } = setup();
    const recorded = applyOk(session, record({ status: "proposed", note: "Suggested." }));
    const laterMessage = {
      ...session.messages[0],
      id: "message-2",
    } as SopSession["messages"][number];
    const context = {
      now: () => "2026-02-02T00:00:00.000Z",
      newId: () => "history-1",
    };
    const withSecondMessage: SopSession = {
      ...recorded.session,
      messages: [...recorded.session.messages, laterMessage],
    };
    const result = applyClaim(
      withSecondMessage,
      correct(recorded.claim.claimId, {
        sourceMessageId: "message-2",
        effectiveDate: "2025-03-01",
      }),
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toBe("updated");
    expect(result.claim).toMatchObject({
      claimId: recorded.claim.claimId,
      field: "purpose",
      status: "observed",
      value: { kind: "statement", text: "Handle refunds and exchanges." },
      source: { type: "employee_statement", reference: { messageId: "message-2" } },
      authority: "observed_practice",
      effectiveDate: "2025-03-01",
      note: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-02T00:00:00.000Z",
    });
    expect(result.session.claims).toEqual([result.claim]);
    expect(result.session.claimHistory).toHaveLength(1);
    expect(result.session.claimHistory[0]).toEqual({
      entryId: "history-1",
      claimId: recorded.claim.claimId,
      changedAt: "2026-02-02T00:00:00.000Z",
      changedBy: "agent",
      sourceMessageId: "message-2",
      reason: "corrected",
      changeNote: null,
      previousClaim: recorded.claim,
    });
    expect(messageId).toBe((recorded.claim.source.reference as { messageId: string }).messageId);
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("answers an unknown claim under the same id and says so in the history", () => {
    const { session, markUnknown, correct, applyOk } = setup();
    const unknown = applyOk(session, markUnknown("authorization", null));
    const answered = applyOk(
      unknown.session,
      correct(unknown.claim.claimId, { statement: "A manager approves." }),
    );

    expect(answered.claim).toMatchObject({
      claimId: unknown.claim.claimId,
      status: "observed",
      authority: "observed_practice",
    });
    expect(answered.session.claimHistory[0]?.reason).toBe("answered_unknown");
  });

  it("treats restating an observed claim as unchanged", () => {
    const { context, session, record, correct, applyOk } = setup();
    const recorded = applyOk(session, record());
    const result = applyClaim(
      recorded.session,
      correct(recorded.claim.claimId, { statement: "handle customer refunds." }),
      context,
    );
    expect(result.ok && result.change).toBe("unchanged");
    expect(result.ok && result.session.claimHistory).toHaveLength(0);
  });

  it("makes a proposed claim observed even when the text is the same", () => {
    const { session, record, correct, applyOk } = setup();
    const proposed = applyOk(session, record({ status: "proposed" }));
    const confirmedByUser = applyOk(
      proposed.session,
      correct(proposed.claim.claimId, { statement: "Handle customer refunds." }),
    );
    expect(confirmedByUser.change).toBe("updated");
    expect(confirmedByUser.claim.status).toBe("observed");
  });

  it("keeps a corrected step in its slot", () => {
    const { session, record, correct, applyOk } = setup();
    let current = applyOk(
      session,
      record({ field: "procedure", statement: "Receive request." }),
    ).session;
    current = applyOk(current, record({ field: "procedure", statement: "Check policy." })).session;
    current = applyOk(current, record({ field: "procedure", statement: "Issue refund." })).session;
    const middleId = current.procedureOrder[1] ?? "";

    const corrected = applyOk(current, correct(middleId, { statement: "Check the order age." }));
    expect(procedureStepTexts(corrected.session)).toEqual([
      "Receive request.",
      "Check the order age.",
      "Issue refund.",
    ]);
  });

  it("refuses an unknown target, and conflict or extracted claims", () => {
    const { context, session, messageId, correct } = setup();
    expectFailure(applyClaim(session, correct("nope"), context), "target_claim_not_found");

    const source = {
      type: "employee_statement" as const,
      reference: { kind: "message" as const, messageId },
    };
    for (const status of ["conflict", "extracted"] as const) {
      const claim = buildClaim({ claimId: "c1", field: "roles", status, source });
      expectFailure(
        applyClaim({ ...session, claims: [claim] }, correct("c1"), context),
        "status_transition_not_allowed",
      );
    }
  });

  it("refuses when the history is full", () => {
    const { context, session, record, correct, applyOk } = setup();
    const recorded = applyOk(session, record());
    const entry = {
      entryId: "h",
      claimId: "x",
      changedAt: "2026-01-01T00:00:00.000Z",
      changedBy: "agent" as const,
      sourceMessageId: (recorded.claim.source.reference as { messageId: string }).messageId,
      reason: "corrected" as const,
      changeNote: null,
      previousClaim: recorded.claim,
    };
    const full: SopSession = {
      ...recorded.session,
      claimHistory: Array.from({ length: MAX_HISTORY_ENTRIES }, (_, index) => ({
        ...entry,
        entryId: `h-${index}`,
      })),
    };
    expectFailure(
      applyClaim(full, correct(recorded.claim.claimId), context),
      "session_limit_reached",
    );
  });
});

describe("applyClaim: marking unknown", () => {
  it("turns an existing claim unknown under the same id, archives it, and keeps a step's slot", () => {
    const { session, record, markUnknown, applyOk } = setup();
    let current = applyOk(
      session,
      record({ field: "procedure", statement: "Receive request." }),
    ).session;
    current = applyOk(current, record({ field: "procedure", statement: "Check policy." })).session;
    current = applyOk(current, record({ field: "procedure", statement: "Issue refund." })).session;
    const middleId = current.procedureOrder[1] ?? "";

    const result = applyOk(
      current,
      markUnknown("procedure", middleId, { note: "Not sure who checks." }),
    );
    expect(result.change).toBe("updated");
    expect(result.claim).toMatchObject({
      claimId: middleId,
      status: "unknown",
      value: null,
      authority: "unknown",
      note: "Not sure who checks.",
    });
    expect(result.session.procedureOrder[1]).toBe(middleId);
    expect(result.session.claimHistory[0]).toMatchObject({
      reason: "marked_unknown",
      previousClaim: { status: "observed", value: { text: "Check policy." } },
    });
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("records a new unknown when no claim is targeted, and does nothing when it is repeated as it was", () => {
    const { context, session, markUnknown, applyOk } = setup();
    const first = applyOk(
      session,
      markUnknown("authorization", null, { note: "Who approves large refunds." }),
    );
    expect(first.change).toBe("created");
    expect(first.claim).toMatchObject({ field: "authorization", status: "unknown", value: null });

    const second = applyClaim(
      first.session,
      markUnknown("authorization", null, { note: "Who approves large refunds." }),
      context,
    );
    expect(second.ok && second.change).toBe("unchanged");
    expect(second.ok && second.session.claims).toHaveLength(1);
    expect(second.ok && second.session.claimHistory).toHaveLength(0);
  });

  it("keeps a more precise note when the same unknown is marked again, and archives the old one", () => {
    const { session, markUnknown, applyOk } = setup();
    const first = applyOk(session, markUnknown("authorization", null, { note: "Who approves." }));

    const refined = applyOk(
      first.session,
      markUnknown("authorization", null, { note: "Who approves refunds above $1000." }),
    );
    expect(refined.change).toBe("updated");
    expect(refined.claim).toMatchObject({
      claimId: first.claim.claimId,
      status: "unknown",
      note: "Who approves refunds above $1000.",
    });
    expect(refined.session.claims).toHaveLength(1);
    expect(refined.session.claimHistory).toHaveLength(1);
    expect(refined.session.claimHistory[0]).toMatchObject({
      reason: "marked_unknown",
      previousClaim: { note: "Who approves." },
    });
    expect(sopSessionSchema.safeParse(refined.session).success).toBe(true);

    // The same holds when the unknown is targeted by its id.
    const byId = applyOk(
      refined.session,
      markUnknown("authorization", first.claim.claimId, {
        note: "Who approves refunds over $1000, and who backs them up.",
      }),
    );
    expect(byId.change).toBe("updated");
    expect(byId.session.claimHistory).toHaveLength(2);
  });

  it("does nothing when the targeted claim is already unknown", () => {
    const { context, session, markUnknown, applyOk } = setup();
    const first = applyOk(session, markUnknown("authorization", null));
    const again = applyClaim(
      first.session,
      markUnknown("authorization", first.claim.claimId),
      context,
    );
    expect(again.ok && again.change).toBe("unchanged");
  });

  it("requires a note", () => {
    const { context, session, markUnknown } = setup();
    expectFailure(
      applyClaim(session, markUnknown("scope", null, { note: "  " }), context),
      "note_required",
    );
  });

  it("refuses an unknown target, a target in another field, and conflict or extracted claims", () => {
    const { context, session, messageId, record, markUnknown, applyOk } = setup();
    expectFailure(
      applyClaim(session, markUnknown("purpose", "nope"), context),
      "target_claim_not_found",
    );

    const recorded = applyOk(session, record());
    expectFailure(
      applyClaim(recorded.session, markUnknown("scope", recorded.claim.claimId), context),
      "target_claim_not_found",
    );

    const source = {
      type: "employee_statement" as const,
      reference: { kind: "message" as const, messageId },
    };
    const conflict = buildClaim({ claimId: "c1", field: "roles", status: "conflict", source });
    expectFailure(
      applyClaim({ ...session, claims: [conflict] }, markUnknown("roles", "c1"), context),
      "status_transition_not_allowed",
    );
  });
});

describe("applyClaim: withdrawing", () => {
  it("removes the claim and its slot, and archives the whole claim with the reason", () => {
    const { session, record, withdraw, applyOk } = setup();
    let current = applyOk(
      session,
      record({ field: "procedure", statement: "Receive request." }),
    ).session;
    current = applyOk(current, record({ field: "procedure", statement: "Check policy." })).session;
    const firstId = current.procedureOrder[0] ?? "";

    const result = applyOk(current, withdraw(firstId, { note: "Not part of this process." }));
    expect(result.change).toBe("withdrawn");
    expect(result.claim.claimId).toBe(firstId);
    expect(result.session.claims.map((claim) => claim.claimId)).not.toContain(firstId);
    expect(procedureStepTexts(result.session)).toEqual(["Check policy."]);
    expect(result.session.claimHistory[0]).toMatchObject({
      claimId: firstId,
      reason: "withdrawn",
      changeNote: "Not part of this process.",
      previousClaim: { value: { text: "Receive request." } },
    });
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("requires a note and an existing claim", () => {
    const { context, session, record, withdraw, applyOk } = setup();
    const recorded = applyOk(session, record());
    expectFailure(
      applyClaim(recorded.session, withdraw(recorded.claim.claimId, { note: "" }), context),
      "note_required",
    );
    expectFailure(
      applyClaim(recorded.session, withdraw("nope"), context),
      "target_claim_not_found",
    );
  });

  it("can withdraw an unknown claim", () => {
    const { session, markUnknown, withdraw, applyOk } = setup();
    const unknown = applyOk(session, markUnknown("scope", null));
    const result = applyOk(unknown.session, withdraw(unknown.claim.claimId));
    expect(result.session.claims).toHaveLength(0);
  });
});

describe("applyClaim: procedure steps", () => {
  it("stores each step as a step value and appends by default", () => {
    const { session, record, applyOk } = setup();
    const first = applyOk(session, record({ field: "procedure", statement: "Receive request." }));
    const second = applyOk(
      first.session,
      record({ field: "procedure", statement: "Check policy." }),
    );
    expect(first.claim.value).toEqual({ kind: "step", text: "Receive request." });
    expect(procedureStepTexts(second.session)).toEqual(["Receive request.", "Check policy."]);
  });

  it("inserts before a named step, at the front and in the middle", () => {
    const { session, record, applyOk } = setup();
    let current = applyOk(session, record({ field: "procedure", statement: "B" })).session;
    current = applyOk(current, record({ field: "procedure", statement: "D" })).session;
    const [bId, dId] = current.procedureOrder;

    current = applyOk(
      current,
      record({ field: "procedure", statement: "A", insertBeforeClaimId: bId ?? null }),
    ).session;
    current = applyOk(
      current,
      record({ field: "procedure", statement: "C", insertBeforeClaimId: dId ?? null }),
    ).session;
    expect(procedureStepTexts(current)).toEqual(["A", "B", "C", "D"]);
    expect(sopSessionSchema.safeParse(current).success).toBe(true);
  });

  it("keeps the same action at two places in the procedure, but treats a retried call as a repeat", () => {
    const { session, record, applyOk } = setup();
    const step = (statement: string, insertBeforeClaimId: string | null = null) =>
      record({ field: "procedure", statement, insertBeforeClaimId });

    let current = applyOk(session, step("Notify the customer.")).session;
    current = applyOk(current, step("Check the order.")).session;

    // The same action again, later in the process, is a second step and not a duplicate.
    const repeated = applyOk(current, step("Notify the customer."));
    expect(repeated.change).toBe("created");
    expect(procedureStepTexts(repeated.session)).toEqual([
      "Notify the customer.",
      "Check the order.",
      "Notify the customer.",
    ]);

    // The very same call repeated is a retry: the step before the insertion point already says it.
    const retried = applyOk(repeated.session, step("Notify the customer."));
    expect(retried.change).toBe("unchanged");
    expect(procedureStepTexts(retried.session)).toHaveLength(3);

    // Same for an insertion before a named step.
    const anchorId = repeated.session.procedureOrder[1] ?? null;
    const inserted = applyOk(repeated.session, step("Verify identity.", anchorId));
    const insertedAgain = applyOk(inserted.session, step("Verify identity.", anchorId));
    expect(insertedAgain.change).toBe("unchanged");
    expect(procedureStepTexts(insertedAgain.session)).toHaveLength(4);
  });

  it("refuses an anchor on another field or one that is not a step", () => {
    const { context, session, record, applyOk } = setup();
    const step = applyOk(session, record({ field: "procedure", statement: "Receive request." }));
    expectFailure(
      applyClaim(
        step.session,
        record({ field: "scope", insertBeforeClaimId: step.claim.claimId }),
        context,
      ),
      "anchor_not_applicable",
    );
    expectFailure(
      applyClaim(
        step.session,
        record({ field: "procedure", statement: "Other", insertBeforeClaimId: "nope" }),
        context,
      ),
      "anchor_not_found",
    );
  });

  it("gives a field-level procedure unknown no slot, and a step that answers it joins the end", () => {
    const { session, markUnknown, correct, applyOk } = setup();
    const unknown = applyOk(session, markUnknown("procedure", null));
    expect(unknown.session.procedureOrder).toEqual([]);

    const answered = applyOk(
      unknown.session,
      correct(unknown.claim.claimId, { statement: "Receive request." }),
    );
    expect(answered.claim.value).toEqual({ kind: "step", text: "Receive request." });
    expect(answered.session.procedureOrder).toEqual([unknown.claim.claimId]);
    expect(sopSessionSchema.safeParse(answered.session).success).toBe(true);
  });

  it("does not close a step-level unknown when another step is recorded", () => {
    const { session, record, markUnknown, applyOk } = setup();
    const step = applyOk(session, record({ field: "procedure", statement: "Receive request." }));
    const unknownStep = applyOk(step.session, markUnknown("procedure", step.claim.claimId));
    const next = applyOk(
      unknownStep.session,
      record({ field: "procedure", statement: "Issue refund." }),
    );
    expect(next.session.claims.map((claim) => claim.status)).toEqual(["unknown", "observed"]);
  });
});
