import { describe, expect, it } from "vitest";
import { applyClaim, type ClaimWriteCommand } from "./applyClaim.ts";
import {
  buildInterviewAgenda,
  orderProcedureSteps,
  recentQuestions,
  statesNewQuantity,
} from "./interviewAgenda.ts";
import type { SopSession } from "./session.ts";
import { SOP_FIELD_NAMES, type SopFieldName } from "./sopFields.ts";
import { buildClaim, createDeterministicContext, createSessionWithUserMessage } from "./testing.ts";

function setup() {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context);
  const apply = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result;
  };
  const record = (
    current: SopSession,
    field: SopFieldName,
    statement: string,
    status: "observed" | "proposed" = "observed",
  ) =>
    apply(current, {
      kind: "record",
      createdByType: "agent",
      field,
      status,
      statement,
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    });
  const markUnknown = (current: SopSession, field: SopFieldName) =>
    apply(current, {
      kind: "markUnknown",
      createdByType: "agent",
      field,
      claimId: null,
      note: "The user does not know.",
      sourceMessageId: messageId,
    });
  return { session, messageId, apply, record, markUnknown };
}

describe("buildInterviewAgenda", () => {
  it("starts an empty session with the first three blocking fields, in declared order", () => {
    const { session } = setup();
    const agenda = buildInterviewAgenda(session);
    expect(agenda.askNext.map((question) => question.field)).toEqual([
      "purpose",
      "scope",
      "trigger",
    ]);
    expect(agenda.askNext[0]).toMatchObject({ reason: "empty", label: "Purpose" });
    expect(agenda.askNext[0]?.probe.length).toBeGreaterThan(0);
    expect(agenda.doNotAsk).toEqual([]);
    expect(agenda.readyToReview).toBe(false);
    expect(agenda.blockingGapsRemaining).toBe(8);
    expect(agenda.advisoryGapsRemaining).toBe(5);
  });

  it("counts how often a field's question was already asked, even when the words differ a little", () => {
    const { session } = setup();
    const asked: SopSession = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: "a-1",
          role: "assistant",
          createdAt: "2026-01-01T00:00:00.000Z",
          text: "Which situations does this refund process cover, and which does it explicitly not cover?",
          model: "test-model",
          toolCalls: [],
        },
        {
          id: "a-2",
          role: "assistant",
          createdAt: "2026-01-01T00:00:00.000Z",
          text: "Thanks. Who approves refunds above $200?",
          model: "test-model",
          toolCalls: [],
        },
      ],
    };
    const agenda = buildInterviewAgenda(asked);
    const byField = Object.fromEntries(
      agenda.askNext.map((question) => [question.field, question]),
    );
    expect(byField.scope?.timesAskedBefore).toBe(1);
    expect(byField.purpose?.timesAskedBefore).toBe(0);
    expect(byField.trigger?.timesAskedBefore).toBe(0);
    expect(
      buildInterviewAgenda(session).askNext.map((question) => question.timesAskedBefore),
    ).toEqual([0, 0, 0]);
  });

  it("does not ask about a field once something resolved it, even a proposed claim", () => {
    const { session, record } = setup();
    const withPurpose = record(session, "purpose", "Handle refunds.").session;
    const withScope = record(withPurpose, "scope", "Online orders.", "proposed").session;
    const agenda = buildInterviewAgenda(withScope);
    expect(agenda.askNext.map((question) => question.field)).toEqual([
      "trigger",
      "roles",
      "procedure",
    ]);
  });

  it("stops asking about a field the user does not know, and says why", () => {
    const { session, markUnknown } = setup();
    const agenda = buildInterviewAgenda(markUnknown(session, "purpose").session);
    expect(agenda.askNext.map((question) => question.field)).not.toContain("purpose");
    expect(agenda.doNotAsk).toEqual([{ field: "purpose", why: "user_does_not_know" }]);
    expect(agenda.blockingGapsRemaining).toBe(8);
  });

  it("keeps asking about a field that has a conflict", () => {
    const { session, messageId } = setup();
    const conflict = buildClaim({
      claimId: "c1",
      field: "purpose",
      status: "conflict",
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
    });
    const agenda = buildInterviewAgenda({ ...session, claims: [conflict] });
    expect(agenda.askNext[0]).toMatchObject({ field: "purpose", reason: "unresolved" });
  });

  it("does not ask about a field that only awaits the review of an extracted claim", () => {
    const { session, messageId } = setup();
    const extracted = buildClaim({
      claimId: "c1",
      field: "purpose",
      status: "extracted",
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
    });
    const agenda = buildInterviewAgenda({ ...session, claims: [extracted] });
    expect(agenda.doNotAsk).toEqual([{ field: "purpose", why: "awaiting_review" }]);
  });

  it("asks blocking fields before advisory ones and is ready only at zero blocking gaps", () => {
    const { session, record, markUnknown } = setup();
    let current = session;
    for (const field of SOP_FIELD_NAMES.slice(0, 8)) {
      current = record(current, field, `A statement about ${field}.`).session;
    }
    const agenda = buildInterviewAgenda(current);
    expect(agenda.readyToReview).toBe(true);
    expect(agenda.blockingGapsRemaining).toBe(0);
    expect(agenda.askNext.map((question) => question.field)).toEqual([
      "exceptions",
      "evidence",
      "controls",
    ]);

    // A blocking unknown is still a blocking gap, so the SOP is not ready.
    const blocked = buildInterviewAgenda(markUnknown(session, "governance").session);
    expect(blocked.readyToReview).toBe(false);
  });

  it("returns no question when every gap is one the user does not know", () => {
    const { session, markUnknown } = setup();
    let current = session;
    for (const field of SOP_FIELD_NAMES) current = markUnknown(current, field).session;
    const agenda = buildInterviewAgenda(current);
    expect(agenda.askNext).toEqual([]);
    expect(agenda.doNotAsk).toHaveLength(13);
    expect(agenda.readyToReview).toBe(false);
  });
});

describe("statesNewQuantity", () => {
  function sessionWith(...texts: { role: "user" | "assistant"; text: string }[]): SopSession {
    const { session } = setup();
    return {
      ...session,
      messages: texts.map((entry, index) =>
        entry.role === "user"
          ? {
              id: `user-${index}`,
              role: "user" as const,
              createdAt: "2026-01-01T00:00:00.000Z",
              text: entry.text,
            }
          : {
              id: `assistant-${index}`,
              role: "assistant" as const,
              createdAt: "2026-01-01T00:00:00.000Z",
              text: entry.text,
              model: "test-model",
              toolCalls: [],
            },
      ),
    };
  }

  it.each([
    "Refunds over $200 need a manager.",
    "We reply within 2 days.",
    "About twenty people are involved.",
    "It is 5%.",
    "Finance handles anything above a thousand.",
  ])("finds a number in %j when nothing has been said about it", (text) => {
    expect(statesNewQuantity(sessionWith({ role: "user", text }))).toBe(true);
  });

  it.each([
    "A manager approves refunds.",
    "No one signs off on it.",
    "We check with one of the leads.",
  ])("finds no number in %j", (text) => {
    expect(statesNewQuantity(sessionWith({ role: "user", text }))).toBe(false);
  });

  it("does not count a number the agent already asked about, however it is written", () => {
    const session = sessionWith(
      { role: "user", text: "Agents approve up to $1,000." },
      { role: "assistant", text: "Is the $1,000 limit written policy or habit?" },
      { role: "user", text: "Sure. Also, the finance director approves refunds above $1000." },
    );
    expect(statesNewQuantity(session)).toBe(false);
  });

  it("counts a different number, even when another one was already discussed", () => {
    const session = sessionWith(
      { role: "assistant", text: "Is the $200 limit written policy or habit?" },
      { role: "user", text: "Correction: the limit is $300, not $200." },
    );
    expect(statesNewQuantity(session)).toBe(true);
  });

  it("looks only at the latest message, and only when it is the user's", () => {
    expect(
      statesNewQuantity(
        sessionWith(
          { role: "user", text: "Refunds over $200." },
          { role: "assistant", text: "Why?" },
        ),
      ),
    ).toBe(false);
    expect(statesNewQuantity(sessionWith())).toBe(false);
  });
});

describe("orderProcedureSteps", () => {
  it("lists steps in order with 1-based positions, and keeps an unknown step in its place", () => {
    const { session, messageId, apply, record } = setup();
    let current = record(session, "procedure", "Receive request.").session;
    const second = record(current, "procedure", "Check policy.");
    current = record(second.session, "procedure", "Issue refund.").session;
    current = apply(current, {
      kind: "markUnknown",
      createdByType: "agent",
      field: "procedure",
      claimId: second.claim.claimId,
      note: "Unsure who checks.",
      sourceMessageId: messageId,
    }).session;

    expect(orderProcedureSteps(current)).toEqual([
      expect.objectContaining({ position: 1, status: "observed", text: "Receive request." }),
      expect.objectContaining({
        position: 2,
        status: "unknown",
        text: null,
        note: "Unsure who checks.",
      }),
      expect.objectContaining({ position: 3, status: "observed", text: "Issue refund." }),
    ]);
  });

  it("is empty when there is no procedure", () => {
    expect(orderProcedureSteps(setup().session)).toEqual([]);
  });
});

describe("recentQuestions", () => {
  function withAssistantMessages(session: SopSession, texts: string[]): SopSession {
    return {
      ...session,
      messages: [
        ...session.messages,
        ...texts.map((text, index) => ({
          id: `assistant-${index}`,
          role: "assistant" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          text,
          model: "test-model",
          toolCalls: [],
        })),
      ],
    };
  }

  it("returns the last questions, oldest first, one per question mark", () => {
    const { session } = setup();
    const current = withAssistantMessages(session, [
      "Thanks. What starts the process? And who does it?",
      "Got it.",
      "Who approves large refunds?",
    ]);
    expect(recentQuestions(current, 2)).toEqual([
      "And who does it?",
      "Who approves large refunds?",
    ]);
    expect(recentQuestions(current, 10)).toHaveLength(3);
  });

  it("ignores user messages, and returns nothing for a count of zero", () => {
    const { session } = setup();
    expect(recentQuestions(session, 3)).toEqual([]);
    expect(recentQuestions(withAssistantMessages(session, ["Why?"]), 0)).toEqual([]);
  });
});
