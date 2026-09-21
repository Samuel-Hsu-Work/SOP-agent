import {
  applyClaim,
  type ClaimWriteCommand,
  type SopFieldName,
  type SopSession,
  setAdvisoryAcknowledgement,
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

  it("offers the review actions the write path accepts, with an honest name for undoing a confirmation", () => {
    const { session, apply } = setup();
    const suggest = (field: SopFieldName, statement: string, status: "observed" | "proposed") =>
      ({
        kind: "record",
        field,
        status,
        statement,
        note: null,
        effectiveDate: null,
        insertBeforeClaimId: null,
      }) as const;
    const stated = apply(session, suggest("purpose", "Handle refunds.", "observed"));
    const suggested = apply(stated.session, suggest("controls", "Audit monthly.", "proposed"));

    const observedClaim = viewOf(suggested.session, "purpose").claims[0];
    expect(observedClaim).toMatchObject({
      canConfirm: true,
      canReject: false,
      rejectLabel: "Reject",
    });
    const suggestedClaim = viewOf(suggested.session, "controls").claims[0];
    expect(suggestedClaim).toMatchObject({
      canConfirm: true,
      canReject: true,
      rejectLabel: "Reject",
    });

    const confirmed = applyClaim(
      suggested.session,
      { kind: "confirm", createdByType: "user", claimId: stated.claim.claimId },
      createDeterministicContext(),
    );
    if (!confirmed.ok) throw new Error("setup failed");
    const confirmedClaim = viewOf(confirmed.session, "purpose").claims[0];
    expect(confirmedClaim).toMatchObject({
      status: "confirmed",
      statusLabel: "Confirmed",
      canConfirm: false,
      canReject: true,
      rejectLabel: "Withdraw confirmation",
    });
  });

  it("shows a confirmation in the history of the claim, with the status it replaced", () => {
    const { session, record } = setup();
    const claim = record(session, "purpose", "Handle refunds.");
    const confirmed = applyClaim(
      claim.session,
      { kind: "confirm", createdByType: "user", claimId: claim.claim.claimId },
      createDeterministicContext(),
    );
    if (!confirmed.ok) throw new Error("setup failed");
    const [shown] = viewOf(confirmed.session, "purpose").claims;
    expect(shown?.previousVersions).toEqual([
      expect.objectContaining({
        reasonLabel: "Confirmed",
        statusLabel: "Stated by you",
        text: "Handle refunds.",
      }),
    ]);
  });

  it("keeps the effective date and the status of an earlier version, so a date-only change is visible", () => {
    const { session, apply } = setup();
    const dated = apply(session, {
      kind: "record",
      field: "authorization",
      status: "observed",
      statement: "Managers approve above $300.",
      note: null,
      effectiveDate: "2025-03-01",
      insertBeforeClaimId: null,
    });
    const moved = apply(dated.session, {
      kind: "correct",
      claimId: dated.claim.claimId,
      statement: "Managers approve above $300.",
      note: null,
      effectiveDate: "2025-06-01",
    });
    const [claim] = viewOf(moved.session, "authorization").claims;
    expect(claim).toMatchObject({
      text: "Managers approve above $300.",
      effectiveDate: "2025-06-01",
    });
    expect(claim?.previousVersions[0]).toMatchObject({
      text: "Managers approve above $300.",
      effectiveDate: "2025-03-01",
      statusLabel: "Stated by you",
    });
  });

  it("shows a rejected suggestion among the removed claims with the reason Rejected", () => {
    const { session, apply } = setup();
    const suggested = apply(session, {
      kind: "record",
      field: "controls",
      status: "proposed",
      statement: "Audit monthly.",
      note: null,
      effectiveDate: null,
      insertBeforeClaimId: null,
    });
    const rejected = applyClaim(
      suggested.session,
      { kind: "reject", createdByType: "user", claimId: suggested.claim.claimId },
      createDeterministicContext(),
    );
    if (!rejected.ok) throw new Error("setup failed");
    const view = viewOf(rejected.session, "controls");
    expect(view.claims).toEqual([]);
    expect(view.removedClaims).toEqual([
      expect.objectContaining({
        reasonLabel: "Rejected",
        statusLabel: "Suggested by the agent",
        text: "Audit monthly.",
      }),
    ]);
  });
});

describe("buildClaimsView acknowledgement", () => {
  it("marks an advisory gap as acknowledged only while its acknowledgement stands", () => {
    const { session } = setup();
    const context = createDeterministicContext();
    const acknowledged = setAdvisoryAcknowledgement(
      session,
      { field: "exceptions", acknowledged: true },
      context,
    );
    if (!acknowledged.ok) throw new Error("setup failed");

    expect(viewOf(acknowledged.session, "exceptions").isGapAcknowledged).toBe(true);
    expect(viewOf(acknowledged.session, "evidence").isGapAcknowledged).toBe(false);
    expect(viewOf(session, "exceptions").isGapAcknowledged).toBe(false);
  });

  it("is never true for a blocking field, or for an advisory field that has no gap", () => {
    const { session, record } = setup();
    const withControls = record(session, "controls", "Audit monthly.").session;
    const forced = {
      ...withControls,
      advisoryAcknowledgements: [
        { field: "controls" as const, acknowledgedAt: "2026-01-01T00:00:00.000Z" },
      ],
    };
    expect(viewOf(forced, "controls").isGapAcknowledged).toBe(false);
    expect(viewOf(forced, "purpose").isGapAcknowledged).toBe(false);
  });
});

describe("buildClaimsView with documents", () => {
  const POLICY =
    "Vendor payments above $10,000 require written approval from the budget owner and the CFO.";
  const CITATION = {
    documentName: "vendor-payment-policy.md",
    location: "§ Approval authority",
    quote: "Every vendor payment above $10,000 requires the written approval of two people.",
  };

  function withConflict() {
    const { session, apply, record } = setup();
    const ingested = apply(session, {
      kind: "ingestExtracted",
      createdByType: "extraction",
      field: "authorization",
      statement: POLICY,
      citation: CITATION,
      effectiveDate: null,
      note: null,
      sourceMessageId: undefined,
    } as never);
    const spoken = record(
      ingested.session,
      "authorization",
      "Payments up to $25,000 need only the Finance Director.",
    );
    return { session: spoken.session, ingested: ingested.claim, spoken: spoken.claim, apply };
  }

  it("gives an extracted claim its citation and the review actions of a document claim", () => {
    const { session, apply } = setup();
    const result = apply(session, {
      kind: "ingestExtracted",
      createdByType: "extraction",
      field: "scope",
      statement: "Applies to online orders.",
      citation: CITATION,
      effectiveDate: null,
      note: null,
    } as never);
    const claim = viewOf(result.session, "scope").claims[0];
    expect(claim).toMatchObject({
      status: "extracted",
      statusLabel: "Extracted from a document",
      citation: CITATION,
      canConfirm: true,
      canReject: true,
    });
  });

  it("shows two claims in conflict once, as a pair, and never as separate claims", () => {
    const { session, ingested, spoken } = withConflict();
    const view = viewOf(session, "authorization");

    expect(view.claims).toEqual([]);
    expect(view.claimCount).toBe(2);
    expect(view.conflictPairs).toHaveLength(1);
    const ids = view.conflictPairs[0]?.sides.map((side) => side.claimId).sort();
    expect(ids).toEqual([ingested.claimId, spoken.claimId].sort());
    // Neither side can be confirmed or rejected: only the user's answer in chat resolves it.
    for (const side of view.conflictPairs[0]?.sides ?? []) {
      expect(side).toMatchObject({ status: "conflict", canConfirm: false, canReject: false });
    }
    const documentSide = view.conflictPairs[0]?.sides.find((side) => side.citation !== null);
    expect(documentSide?.citation).toEqual(CITATION);
    expect(documentSide?.sourceLabel).toBe(`From ${CITATION.documentName}`);
    expect(
      view.conflictPairs[0]?.sides.find((side) => side.claimId === spoken.claimId)?.sourceLabel,
    ).toBe("What you said");
  });

  it("puts both sides in the removed list, with a label, once the user has answered", () => {
    const { session, spoken, apply } = withConflict();
    const messageId = session.messages[0]?.id ?? "";
    const resolved = apply(session, {
      kind: "resolveConflict",
      createdByType: "agent",
      claimId: spoken.claimId,
      statement: "The Finance Director up to $25,000, the CFO above.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
    });
    const view = viewOf(resolved.session, "authorization");
    expect(view.conflictPairs).toEqual([]);
    expect(view.claims).toHaveLength(1);
    // Newest first: the two resolutions, then the two times the conflict was found.
    expect(view.removedClaims.map((removed) => removed.reasonLabel)).toEqual([
      "Resolved by your answer",
      "Resolved by your answer",
      "Conflict found",
      "Conflict found",
    ]);
  });
});
