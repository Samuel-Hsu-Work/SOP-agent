import { describe, expect, it } from "vitest";
import { applyClaim, type ClaimWriteCommand } from "./applyClaim.ts";
import type { Claim, ClaimStatus } from "./claim.ts";
import { computeGaps } from "./computeGaps.ts";
import { MAX_HISTORY_ENTRIES } from "./limits.ts";
import { REJECTED_NOTE, type ReviewClaimCommand, reviewActionsFor } from "./reviewClaim.ts";
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

/** A session with one user message, and builders for review commands and hand-made claims. */
function setup() {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context);
  const source = (type: "employee_statement" | "agent_suggestion") => ({
    type,
    reference: { kind: "message" as const, messageId },
  });

  const confirm = (claimId: string): ReviewClaimCommand => ({
    kind: "confirm",
    createdByType: "user",
    claimId,
  });
  const reject = (claimId: string): ReviewClaimCommand => ({
    kind: "reject",
    createdByType: "user",
    claimId,
  });

  /** A session holding one claim of the given status, built by hand for states nothing can make yet. */
  const withClaim = (
    status: ClaimStatus,
    overrides: Partial<Claim> = {},
  ): { session: SopSession; claim: Claim } => {
    const isSuggestion = status === "proposed";
    const claim = buildClaim({
      claimId: "claim-1",
      field: "roles",
      status,
      source: source(isSuggestion ? "agent_suggestion" : "employee_statement"),
      authority: status === "unknown" ? "unknown" : isSuggestion ? "proposed" : "observed_practice",
      ...overrides,
    });
    return { session: { ...session, claims: [claim] }, claim };
  };

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

  return { context, session, messageId, confirm, reject, withClaim, apply, record };
}

function expectFailure(result: ReturnType<typeof applyClaim>, code: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("review: confirming", () => {
  it("makes an observed claim confirmed and changes nothing else about it", () => {
    const { context, session, record, confirm } = setup();
    const observed = record(session, "purpose", "Handle refunds.");
    const result = applyClaim(observed.session, confirm(observed.claim.claimId), context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toBe("updated");
    expect(result.claim).toEqual({ ...observed.claim, status: "confirmed" });
    expect(result.session.claims).toEqual([result.claim]);
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("raises a suggestion's authority when a person confirms it, and keeps its source", () => {
    const { context, session, record, confirm } = setup();
    const suggested = record(session, "controls", "Audit monthly.", "proposed");
    const result = applyClaim(suggested.session, confirm(suggested.claim.claimId), context);

    expect(result.ok && result.claim).toMatchObject({
      status: "confirmed",
      authority: "observed_practice",
      source: { type: "agent_suggestion" },
      createdByType: "agent",
      value: suggested.claim.value,
    });
    if (result.ok) expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("confirms an extracted claim without weakening a real authority", () => {
    const { context, withClaim, confirm } = setup();
    const { session } = withClaim("extracted", { authority: "official_policy" });
    const result = applyClaim(session, confirm("claim-1"), context);
    expect(result.ok && result.claim).toMatchObject({
      status: "confirmed",
      authority: "official_policy",
    });
  });

  it("is a no-op for a claim that is already confirmed: no history, same session", () => {
    const { context, session, record, confirm } = setup();
    const observed = record(session, "purpose", "Handle refunds.");
    const confirmed = applyClaim(observed.session, confirm(observed.claim.claimId), context);
    if (!confirmed.ok) throw new Error("setup failed");

    const again = applyClaim(confirmed.session, confirm(observed.claim.claimId), context);
    expect(again.ok && again.change).toBe("unchanged");
    expect(again.ok && again.session).toBe(confirmed.session);
  });

  it.each(["unknown", "conflict"] as const)("refuses to confirm a claim that is %s", (status) => {
    const { context, withClaim, confirm } = setup();
    const { session } = withClaim(status);
    expectFailure(applyClaim(session, confirm("claim-1"), context), "review_action_not_allowed");
  });
});

describe("review: rejecting", () => {
  it("removes a suggestion, so its field is empty and the agent can ask about it again", () => {
    const { context, session, record, reject } = setup();
    const suggested = record(session, "controls", "Audit monthly.", "proposed");
    const result = applyClaim(suggested.session, reject(suggested.claim.claimId), context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toBe("withdrawn");
    expect(result.session.claims).toEqual([]);
    const controls = computeGaps(result.session).fields.find((entry) => entry.field === "controls");
    expect(controls).toMatchObject({ state: "empty", askable: true });
    expect(result.session.claimHistory[0]).toMatchObject({
      reason: "rejected",
      previousClaim: { claimId: suggested.claim.claimId, status: "proposed" },
    });
  });

  it("removes a rejected suggestion from the procedure order too", () => {
    const { context, session, record, reject } = setup();
    const first = record(session, "procedure", "Receive the request.", "proposed");
    const second = record(first.session, "procedure", "Issue the refund.", "proposed");
    const result = applyClaim(second.session, reject(first.claim.claimId), context);
    expect(result.ok && result.session.procedureOrder).toEqual([second.claim.claimId]);
    if (result.ok) expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("steps a confirmed statement back to observed, and a confirmed suggestion back to proposed", () => {
    const { context, session, record, confirm, reject } = setup();
    const observed = record(session, "purpose", "Handle refunds.");
    const suggested = record(observed.session, "controls", "Audit monthly.", "proposed");
    let current = suggested.session;
    for (const claim of [observed.claim, suggested.claim]) {
      const confirmed = applyClaim(current, confirm(claim.claimId), context);
      if (!confirmed.ok) throw new Error("setup failed");
      current = confirmed.session;
    }

    const stepBackStatement = applyClaim(current, reject(observed.claim.claimId), context);
    expect(stepBackStatement.ok && stepBackStatement.claim).toMatchObject({
      status: "observed",
      authority: "observed_practice",
    });
    const stepBackSuggestion = applyClaim(current, reject(suggested.claim.claimId), context);
    expect(stepBackSuggestion.ok && stepBackSuggestion.claim).toMatchObject({
      status: "proposed",
      authority: "proposed",
    });
    for (const result of [stepBackStatement, stepBackSuggestion]) {
      expect(result.ok && result.session.claimHistory.at(-1)).toMatchObject({
        reason: "rejected",
        previousClaim: { status: "confirmed" },
      });
      if (result.ok) expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
    }
  });

  it("puts a confirmed extracted claim back to extracted, with its authority, when the confirmation is withdrawn", () => {
    const { context, withClaim, confirm, reject } = setup();
    const { session } = withClaim("extracted", { authority: "official_policy", field: "controls" });
    const confirmed = applyClaim(session, confirm("claim-1"), context);
    if (!confirmed.ok) throw new Error("setup failed");

    const withdrawn = applyClaim(confirmed.session, reject("claim-1"), context);
    expect(withdrawn.ok && withdrawn.claim).toMatchObject({
      status: "extracted",
      authority: "official_policy",
    });
    // The field still awaits review, as it did before the confirmation.
    if (!withdrawn.ok) throw new Error("expected success");
    const controls = computeGaps(withdrawn.session).fields.find(
      (entry) => entry.field === "controls",
    );
    expect(controls?.state).toBe("unresolved");
    expect(withdrawn.session.claimHistory.map((entry) => entry.reason)).toEqual([
      "confirmed",
      "rejected",
    ]);
  });

  it("falls back to what the source implies for a confirmed claim that has no confirmation in the history", () => {
    const { context, withClaim, reject } = setup();
    const suggestion = withClaim("confirmed", {
      source: { type: "agent_suggestion", reference: { kind: "message", messageId: "message-1" } },
      authority: "observed_practice",
    });
    const result = applyClaim(suggestion.session, reject("claim-1"), context);
    expect(result.ok && result.claim).toMatchObject({ status: "proposed", authority: "proposed" });
  });

  it("returns a rejected extracted claim to unknown, keeps a procedure step's slot, and drops the value", () => {
    const { context, session, messageId, reject } = setup();
    const step = buildClaim({
      claimId: "step-1",
      field: "procedure",
      status: "extracted",
      authority: "official_policy",
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
      effectiveDate: "2025-03-01",
    });
    const withStep: SopSession = { ...session, claims: [step], procedureOrder: ["step-1"] };
    const result = applyClaim(withStep, reject("step-1"), context);

    expect(result.ok && result.claim).toMatchObject({
      status: "unknown",
      value: null,
      authority: "unknown",
      effectiveDate: null,
      note: REJECTED_NOTE,
    });
    expect(result.ok && result.session.procedureOrder).toEqual(["step-1"]);
    if (result.ok) expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("does not offer a reject for the user's own statement", () => {
    const { context, session, record, reject } = setup();
    const observed = record(session, "purpose", "Handle refunds.");
    const result = applyClaim(observed.session, reject(observed.claim.claimId), context);
    expectFailure(result, "review_action_not_allowed");
    expect(!result.ok && result.error.message).toContain("chat");
  });

  it.each(["unknown", "conflict"] as const)("refuses to reject a claim that is %s", (status) => {
    const { context, withClaim, reject } = setup();
    const { session } = withClaim(status);
    expectFailure(applyClaim(session, reject("claim-1"), context), "review_action_not_allowed");
  });
});

describe("review: every action", () => {
  it("writes a history entry attributed to the user, with no message and the whole previous claim", () => {
    const { context, session, record, confirm } = setup();
    const observed = record(session, "purpose", "Handle refunds.");
    const result = applyClaim(observed.session, confirm(observed.claim.claimId), context);

    expect(result.ok && result.session.claimHistory).toHaveLength(1);
    expect(result.ok && result.session.claimHistory[0]).toMatchObject({
      claimId: observed.claim.claimId,
      changedBy: "user",
      sourceMessageId: null,
      reason: "confirmed",
      changeNote: null,
      previousClaim: observed.claim,
    });
  });

  it("refuses an unknown claim id", () => {
    const { context, session, confirm, reject } = setup();
    expectFailure(applyClaim(session, confirm("nope"), context), "target_claim_not_found");
    expectFailure(applyClaim(session, reject("nope"), context), "target_claim_not_found");
  });

  it("refuses an approved session before anything else", () => {
    const { context, session, record, confirm, reject } = setup();
    const observed = record(session, "purpose", "Handle refunds.");
    const approved: SopSession = {
      ...observed.session,
      status: "approved",
      approvedAt: "2026-01-02T00:00:00.000Z",
    };
    expectFailure(
      applyClaim(approved, confirm(observed.claim.claimId), context),
      "session_approved",
    );
    expectFailure(applyClaim(approved, reject("nope"), context), "session_approved");
  });

  it("never mutates its input, and clears the acknowledgements only when something changed", () => {
    const { context, session, record, confirm } = setup();
    const observed = record(session, "purpose", "Handle refunds.");
    const acknowledged: SopSession = {
      ...observed.session,
      advisoryAcknowledgements: [
        { field: "exceptions", acknowledgedAt: "2026-01-02T00:00:00.000Z" },
      ],
    };
    const frozen = deepFreeze(JSON.parse(JSON.stringify(acknowledged)) as SopSession);

    const confirmed = applyClaim(frozen, confirm(observed.claim.claimId), context);
    expect(confirmed.ok && confirmed.session.advisoryAcknowledgements).toEqual([]);
    expect(frozen.advisoryAcknowledgements).toHaveLength(1);
    expect(frozen.claims[0]?.status).toBe("observed");

    if (!confirmed.ok) throw new Error("setup failed");
    const acknowledgedAgain: SopSession = {
      ...confirmed.session,
      advisoryAcknowledgements: [
        { field: "exceptions", acknowledgedAt: "2026-01-02T00:00:00.000Z" },
      ],
    };
    const noOp = applyClaim(acknowledgedAgain, confirm(observed.claim.claimId), context);
    expect(noOp.ok && noOp.change).toBe("unchanged");
    expect(noOp.ok && noOp.session.advisoryAcknowledgements).toHaveLength(1);
  });

  it("refuses when the history is full", () => {
    const { context, session, record, confirm } = setup();
    const observed = record(session, "purpose", "Handle refunds.");
    const entry = {
      entryId: "h",
      claimId: "x",
      changedAt: "2026-01-01T00:00:00.000Z",
      changedBy: "user" as const,
      sourceMessageId: null,
      reason: "confirmed" as const,
      changeNote: null,
      previousClaim: observed.claim,
    };
    const full: SopSession = {
      ...observed.session,
      claimHistory: Array.from({ length: MAX_HISTORY_ENTRIES }, (_, index) => ({
        ...entry,
        entryId: `h-${index}`,
      })),
    };
    expectFailure(
      applyClaim(full, confirm(observed.claim.claimId), context),
      "session_limit_reached",
    );
  });
});

describe("reviewActionsFor", () => {
  it("offers exactly the actions that the write path accepts", () => {
    const { context, withClaim, confirm, reject } = setup();
    const statuses: ClaimStatus[] = [
      "confirmed",
      "observed",
      "proposed",
      "unknown",
      "conflict",
      "extracted",
    ];
    for (const status of statuses) {
      const { session, claim } = withClaim(status);
      const actions = reviewActionsFor(claim);

      const confirmResult = applyClaim(session, confirm("claim-1"), context);
      const confirmOffered = confirmResult.ok && confirmResult.change !== "unchanged";
      expect(actions.canConfirm, `confirm on ${status}`).toBe(confirmOffered);

      const rejectResult = applyClaim(session, reject("claim-1"), context);
      expect(actions.canReject, `reject on ${status}`).toBe(rejectResult.ok);
    }
  });
});
