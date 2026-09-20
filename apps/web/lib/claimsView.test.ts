import {
  applyClaim,
  type ClaimWriteCommand,
  type SopFieldName,
  type SopSession,
} from "@sop-agent/sop-core";
import {
  createDeterministicContext,
  createSessionWithUserMessage,
} from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import { buildClaimsView } from "./claimsView.ts";

function setup() {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context);
  const apply = (
    current: SopSession,
    command: Partial<ClaimWriteCommand> & { kind: ClaimWriteCommand["kind"] },
  ) => {
    const result = applyClaim(
      current,
      { createdByType: "agent", sourceMessageId: messageId, ...command } as ClaimWriteCommand,
      context,
    );
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result;
  };
  const record = (
    current: SopSession,
    field: SopFieldName,
    statement: string,
    insertBeforeClaimId: string | null = null,
  ) =>
    apply(current, {
      kind: "record",
      field,
      status: "observed",
      statement,
      note: null,
      effectiveDate: null,
      insertBeforeClaimId,
    });
  return { session, apply, record };
}

function viewOf(session: SopSession, field: SopFieldName) {
  const view = buildClaimsView(session).find((entry) => entry.field === field);
  if (view === undefined) throw new Error("no view");
  return view;
}

describe("buildClaimsView", () => {
  it("lists all 13 fields in readiness order, empty for a new session", () => {
    const view = buildClaimsView(setup().session);
    expect(view).toHaveLength(13);
    expect(view[0]).toMatchObject({
      field: "purpose",
      state: "empty",
      claims: [],
      removedClaims: [],
    });
    expect(view[0]?.gap).toMatchObject({ severity: "blocking", reason: "empty" });
    expect(view[12]?.field).toBe("prerequisites");
  });

  it("shows procedure steps in their real order, with step numbers", () => {
    const { session, record } = setup();
    const last = record(session, "procedure", "Issue the refund.");
    const first = record(last.session, "procedure", "Receive the request.", last.claim.claimId);
    const view = viewOf(first.session, "procedure");
    expect(view.claims.map((claim) => [claim.stepNumber, claim.text])).toEqual([
      [1, "Receive the request."],
      [2, "Issue the refund."],
    ]);
  });

  it("gives a claim outside the procedure no step number", () => {
    const { session, record } = setup();
    const view = viewOf(record(session, "purpose", "Handle refunds.").session, "purpose");
    expect(view.claims[0]).toMatchObject({
      stepNumber: null,
      statusLabel: "Stated by you",
      text: "Handle refunds.",
    });
  });

  it("attaches an earlier version to the claim that replaced it, newest first", () => {
    const { session, record, apply } = setup();
    const original = record(session, "authorization", "A lead approves refunds over $200.");
    const second = apply(original.session, {
      kind: "correct",
      claimId: original.claim.claimId,
      statement: "A lead approves refunds over $300.",
      note: null,
      effectiveDate: null,
    });
    const third = apply(second.session, {
      kind: "correct",
      claimId: original.claim.claimId,
      statement: "A manager approves refunds over $300.",
      note: null,
      effectiveDate: null,
    });

    const [claim] = viewOf(third.session, "authorization").claims;
    expect(claim?.text).toBe("A manager approves refunds over $300.");
    expect(claim?.previousVersions.map((version) => [version.reasonLabel, version.text])).toEqual([
      ["Corrected", "A lead approves refunds over $300."],
      ["Corrected", "A lead approves refunds over $200."],
    ]);
  });

  it("shows an unknown claim without text and keeps what was unknown in the note", () => {
    const { session, apply } = setup();
    const unknown = apply(session, {
      kind: "markUnknown",
      field: "governance",
      claimId: null,
      note: "Who may change the SOP.",
    });
    const view = viewOf(unknown.session, "governance");
    expect(view.state).toBe("unresolved");
    expect(view.claims[0]).toMatchObject({
      status: "unknown",
      statusLabel: "Unknown",
      text: null,
      note: "Who may change the SOP.",
    });
  });

  it("shows a withdrawn claim in the removed list, with the reason, and not as active", () => {
    const { session, record, apply } = setup();
    const claim = record(session, "scope", "In-store purchases are included.");
    const withdrawn = apply(claim.session, {
      kind: "withdraw",
      claimId: claim.claim.claimId,
      note: "Another team handles in-store purchases.",
    });
    const view = viewOf(withdrawn.session, "scope");
    expect(view.claims).toEqual([]);
    expect(view.state).toBe("empty");
    expect(view.removedClaims).toEqual([
      expect.objectContaining({
        reasonLabel: "Removed",
        text: "In-store purchases are included.",
        changeNote: "Another team handles in-store purchases.",
      }),
    ]);
  });

  it("keeps the history of one field out of another", () => {
    const { session, record, apply } = setup();
    const purpose = record(session, "purpose", "Handle refunds.");
    const scope = record(purpose.session, "scope", "Online orders.");
    const corrected = apply(scope.session, {
      kind: "correct",
      claimId: scope.claim.claimId,
      statement: "Online and phone orders.",
      note: null,
      effectiveDate: null,
    });
    expect(viewOf(corrected.session, "purpose").claims[0]?.previousVersions).toEqual([]);
    expect(viewOf(corrected.session, "scope").claims[0]?.previousVersions).toHaveLength(1);
  });

  it("shows a suggested claim as the agent's, not the user's", () => {
    const { session, apply } = setup();
    const proposed = apply(session, {
      kind: "record",
      field: "controls",
      status: "proposed",
      statement: "Audit a sample each quarter.",
      note: null,
      effectiveDate: null,
      insertBeforeClaimId: null,
    });
    expect(viewOf(proposed.session, "controls").claims[0]?.statusLabel).toBe(
      "Suggested by the agent",
    );
  });

  it("marks a field as suggestion-only when every claim in it is the agent's own suggestion", () => {
    const { session, apply } = setup();
    const suggest = (field: SopFieldName, statement: string) =>
      ({
        kind: "record",
        field,
        status: "proposed",
        statement,
        note: null,
        effectiveDate: null,
        insertBeforeClaimId: null,
      }) as const;

    const onlySuggested = apply(session, suggest("controls", "Audit monthly.")).session;
    expect(viewOf(onlySuggested, "controls").isSuggestionOnly).toBe(true);
    expect(viewOf(onlySuggested, "controls").gap).toBeNull();

    const mixed = apply(onlySuggested, {
      kind: "record",
      field: "controls",
      status: "observed",
      statement: "We also spot-check by hand.",
      note: null,
      effectiveDate: null,
      insertBeforeClaimId: null,
    }).session;
    expect(viewOf(mixed, "controls").isSuggestionOnly).toBe(false);

    expect(viewOf(session, "controls").isSuggestionOnly).toBe(false);
  });
});
