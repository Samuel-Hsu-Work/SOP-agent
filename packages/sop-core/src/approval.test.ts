import { describe, expect, it } from "vitest";
import { applyClaim, type ClaimWriteCommand } from "./applyClaim.ts";
import {
  approveSession,
  canExportApprovedSop,
  checkFinalization,
  setAdvisoryAcknowledgement,
} from "./approval.ts";
import { type SopSession, sopSessionSchema } from "./session.ts";
import {
  ADVISORY_FIELD_NAMES,
  type AdvisoryFieldName,
  SOP_FIELD_NAMES,
  type SopFieldName,
} from "./sopFields.ts";
import { createDeterministicContext, createSessionWithUserMessage } from "./testing.ts";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const BLOCKING_FIELDS = SOP_FIELD_NAMES.slice(0, 8);

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
    status: "observed" | "proposed" = "observed",
  ) =>
    apply(current, {
      kind: "record",
      createdByType: "agent",
      field,
      status,
      statement: `A statement about ${field}.`,
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    });
  /** All eight blocking fields stated by the user, so only advisory questions remain. */
  const withBlockingDone = () => {
    let current = session;
    for (const field of BLOCKING_FIELDS) current = record(current, field).session;
    return current;
  };
  const acknowledge = (current: SopSession, field: AdvisoryFieldName, acknowledged = true) => {
    const result = setAdvisoryAcknowledgement(current, { field, acknowledged }, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result.session;
  };
  const acknowledgeAll = (current: SopSession) => {
    let next = current;
    for (const field of checkFinalization(current).advisoryGapFields)
      next = acknowledge(next, field);
    return next;
  };
  return {
    context,
    session,
    messageId,
    apply,
    record,
    withBlockingDone,
    acknowledge,
    acknowledgeAll,
  };
}

describe("checkFinalization", () => {
  it("lists every blocker for an empty session", () => {
    const { session } = setup();
    const check = checkFinalization(session);
    expect(check.canApprove).toBe(false);
    expect(check.blockers).toEqual(["blocking_gap", "advisory_gap_not_acknowledged"]);
    expect(check.blockingGapFields).toEqual(BLOCKING_FIELDS);
    expect(check.advisoryGapFields).toEqual([...ADVISORY_FIELD_NAMES]);
    expect(check.unacknowledgedAdvisoryFields).toEqual([...ADVISORY_FIELD_NAMES]);
  });

  it("asks for an acknowledgement of an empty advisory field, exceptions included", () => {
    const { withBlockingDone, acknowledge } = setup();
    let current = withBlockingDone();
    for (const field of ADVISORY_FIELD_NAMES.filter((name) => name !== "exceptions")) {
      current = acknowledge(current, field);
    }
    const check = checkFinalization(current);
    expect(check.unacknowledgedAdvisoryFields).toEqual(["exceptions"]);
    expect(check.canApprove).toBe(false);
  });

  it("is satisfied when nothing blocks and every advisory gap is acknowledged", () => {
    const { withBlockingDone, acknowledgeAll } = setup();
    const check = checkFinalization(acknowledgeAll(withBlockingDone()));
    expect(check).toMatchObject({
      canApprove: true,
      blockers: [],
      unacknowledgedAdvisoryFields: [],
    });
  });

  it("does not need an acknowledgement for an advisory field that has a claim", () => {
    const { withBlockingDone, record, acknowledgeAll } = setup();
    const withControls = record(withBlockingDone(), "controls").session;
    const check = checkFinalization(acknowledgeAll(withControls));
    expect(check.advisoryGapFields).not.toContain("controls");
    expect(check.canApprove).toBe(true);
  });

  it("blocks on a suggestion nobody reviewed, even though a suggestion creates no gap", () => {
    const { withBlockingDone, record, acknowledgeAll } = setup();
    const suggested = record(withBlockingDone(), "controls", "proposed");
    const ready = acknowledgeAll(suggested.session);
    const check = checkFinalization(ready);

    expect(check.advisoryGapFields).not.toContain("controls");
    expect(check.blockers).toEqual(["unreviewed_suggestion"]);
    expect(check.unreviewedSuggestionClaimIds).toEqual([suggested.claim.claimId]);
  });

  it("blocks on a suggestion in a blocking field too", () => {
    const { record, acknowledgeAll, withBlockingDone } = setup();
    const done = withBlockingDone();
    const suggestedInstead = {
      ...done,
      claims: done.claims.filter((claim) => claim.field !== "roles"),
    };
    const withSuggestion = record(suggestedInstead, "roles", "proposed").session;
    const check = checkFinalization(acknowledgeAll(withSuggestion));
    expect(check.blockingGapFields).toEqual([]);
    expect(check.blockers).toEqual(["unreviewed_suggestion"]);
  });

  it("ignores a stale acknowledgement for a field that has since been filled", () => {
    const { withBlockingDone, record, acknowledge } = setup();
    const acknowledged = acknowledge(withBlockingDone(), "controls");
    // Hand-built: a stale entry cannot occur through the functions, but a stored session may hold one.
    const filled = {
      ...acknowledged,
      claims: [...acknowledged.claims, record(acknowledged, "controls").claim],
    };
    expect(checkFinalization(filled).advisoryGapFields).not.toContain("controls");
    expect(checkFinalization(filled).unacknowledgedAdvisoryFields).not.toContain("controls");
  });
});

describe("setAdvisoryAcknowledgement", () => {
  it("records an acknowledgement with the time, and takes it back", () => {
    const { context, withBlockingDone } = setup();
    const draft = withBlockingDone();
    const checked = setAdvisoryAcknowledgement(
      draft,
      { field: "exceptions", acknowledged: true },
      context,
    );
    expect(checked.ok && checked.change).toBe("updated");
    expect(checked.ok && checked.session.advisoryAcknowledgements).toEqual([
      { field: "exceptions", acknowledgedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    if (!checked.ok) return;
    expect(sopSessionSchema.safeParse(checked.session).success).toBe(true);

    const unchecked = setAdvisoryAcknowledgement(
      checked.session,
      { field: "exceptions", acknowledged: false },
      context,
    );
    expect(unchecked.ok && unchecked.session.advisoryAcknowledgements).toEqual([]);
  });

  it("is idempotent in both directions", () => {
    const { context, withBlockingDone, acknowledge } = setup();
    const draft = withBlockingDone();
    const already = acknowledge(draft, "exceptions");
    const again = setAdvisoryAcknowledgement(
      already,
      { field: "exceptions", acknowledged: true },
      context,
    );
    expect(again.ok && again.change).toBe("unchanged");
    expect(again.ok && again.session).toBe(already);

    const notThere = setAdvisoryAcknowledgement(
      draft,
      { field: "evidence", acknowledged: false },
      context,
    );
    expect(notThere.ok && notThere.change).toBe("unchanged");
  });

  it("refuses a blocking field, a field with no gap, and an approved session", () => {
    const { context, withBlockingDone, record, acknowledgeAll } = setup();
    const draft = withBlockingDone();
    const blocking = setAdvisoryAcknowledgement(
      draft,
      { field: "purpose", acknowledged: true },
      context,
    );
    expect(!blocking.ok && blocking.error.code).toBe("not_an_advisory_field");

    const filled = record(draft, "controls").session;
    const noGap = setAdvisoryAcknowledgement(
      filled,
      { field: "controls", acknowledged: true },
      context,
    );
    expect(!noGap.ok && noGap.error.code).toBe("no_gap_to_acknowledge");

    const approved = approveSession(acknowledgeAll(draft), context);
    if (!approved.ok) throw new Error("setup failed");
    const afterApproval = setAdvisoryAcknowledgement(
      approved.session,
      { field: "exceptions", acknowledged: false },
      context,
    );
    expect(!afterApproval.ok && afterApproval.error.code).toBe("session_approved");
  });

  it("is cleared by any change to a claim, so it never outlives what it covered", () => {
    const { withBlockingDone, acknowledgeAll, record } = setup();
    const ready = acknowledgeAll(withBlockingDone());
    expect(checkFinalization(ready).canApprove).toBe(true);

    const changed = record(ready, "evidence").session;
    expect(changed.advisoryAcknowledgements).toEqual([]);
    expect(checkFinalization(changed).unacknowledgedAdvisoryFields).toEqual([
      "exceptions",
      "controls",
      "decisionRules",
      "prerequisites",
    ]);
  });

  it("never mutates its input", () => {
    const { context, withBlockingDone } = setup();
    const frozen = deepFreeze(JSON.parse(JSON.stringify(withBlockingDone())) as SopSession);
    const result = setAdvisoryAcknowledgement(
      frozen,
      { field: "exceptions", acknowledged: true },
      context,
    );
    expect(result.ok).toBe(true);
    expect(frozen.advisoryAcknowledgements).toEqual([]);
  });
});

describe("approveSession", () => {
  it("refuses while a blocking gap remains", () => {
    const { context, session } = setup();
    const result = approveSession(session, context);
    expect(!result.ok && result.error.code).toBe("blocking_gaps_remaining");
    expect(!result.ok && result.error.check.blockingGapFields).toEqual(BLOCKING_FIELDS);
  });

  it("refuses while an advisory gap is unacknowledged, and names it", () => {
    const { context, withBlockingDone, acknowledge } = setup();
    const almost = acknowledge(withBlockingDone(), "exceptions");
    const result = approveSession(almost, context);
    expect(!result.ok && result.error.code).toBe("advisory_gaps_unacknowledged");
    expect(!result.ok && result.error.check.unacknowledgedAdvisoryFields).toEqual([
      "evidence",
      "controls",
      "decisionRules",
      "prerequisites",
    ]);
  });

  it("refuses while a suggestion is unreviewed", () => {
    const { context, withBlockingDone, record, acknowledgeAll } = setup();
    const suggested = acknowledgeAll(record(withBlockingDone(), "controls", "proposed").session);
    const result = approveSession(suggested, context);
    expect(!result.ok && result.error.code).toBe("suggestions_unreviewed");
  });

  it("approves a ready session: status and approval time change together, and it parses", () => {
    const { context, withBlockingDone, acknowledgeAll } = setup();
    const ready = acknowledgeAll(withBlockingDone());
    const result = approveSession(ready, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session).toMatchObject({
      status: "approved",
      approvedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.session.claims).toEqual(ready.claims);
    expect(result.session.advisoryAcknowledgements).toEqual(ready.advisoryAcknowledgements);
    // The function and the schema agree about what an approved session is.
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("refuses to approve twice, and freezes every write afterwards", () => {
    const { context, withBlockingDone, acknowledgeAll, messageId } = setup();
    const approved = approveSession(acknowledgeAll(withBlockingDone()), context);
    if (!approved.ok) throw new Error("setup failed");

    const twice = approveSession(approved.session, context);
    expect(!twice.ok && twice.error.code).toBe("session_approved");
    expect(!twice.ok && twice.error.check.blockers).toEqual(["already_approved"]);

    const write = applyClaim(
      approved.session,
      {
        kind: "record",
        createdByType: "agent",
        field: "evidence",
        status: "observed",
        statement: "A late addition.",
        note: null,
        effectiveDate: null,
        sourceMessageId: messageId,
        insertBeforeClaimId: null,
      },
      context,
    );
    expect(!write.ok && write.error.code).toBe("session_approved");
  });

  it("never mutates its input", () => {
    const { context, withBlockingDone, acknowledgeAll } = setup();
    const frozen = deepFreeze(
      JSON.parse(JSON.stringify(acknowledgeAll(withBlockingDone()))) as SopSession,
    );
    expect(approveSession(frozen, context).ok).toBe(true);
    expect(frozen.status).toBe("draft");
  });
});

describe("canExportApprovedSop", () => {
  const forgeApproved = (session: SopSession): SopSession => ({
    ...session,
    status: "approved",
    approvedAt: "2026-01-02T00:00:00.000Z",
  });

  it("refuses a draft, even one that is ready to approve", () => {
    const { session, withBlockingDone, acknowledgeAll } = setup();
    expect(canExportApprovedSop(session)).toEqual({ ok: false, reason: "not_approved" });
    const ready = acknowledgeAll(withBlockingDone());
    expect(checkFinalization(ready).canApprove).toBe(true);
    expect(canExportApprovedSop(ready)).toEqual({ ok: false, reason: "not_approved" });
  });

  it("accepts a session that was properly approved, although canApprove is false for it", () => {
    const { context, withBlockingDone, acknowledgeAll } = setup();
    const approved = approveSession(acknowledgeAll(withBlockingDone()), context);
    if (!approved.ok) throw new Error("setup failed");

    expect(checkFinalization(approved.session).canApprove).toBe(false);
    expect(canExportApprovedSop(approved.session)).toEqual({ ok: true });
  });

  it("does not trust a session that only says it is approved", () => {
    const { session, withBlockingDone, acknowledgeAll, acknowledge, record } = setup();

    expect(canExportApprovedSop(forgeApproved(session))).toEqual({
      ok: false,
      reason: "blocking_gap",
    });
    expect(canExportApprovedSop(forgeApproved(withBlockingDone()))).toEqual({
      ok: false,
      reason: "advisory_gap_not_acknowledged",
    });

    const ready = acknowledgeAll(withBlockingDone());
    expect(canExportApprovedSop(forgeApproved(ready))).toEqual({ ok: true });
    const withSuggestion = acknowledge(
      record(withBlockingDone(), "controls", "proposed").session,
      "exceptions",
    );
    const everyGapAcknowledged = acknowledgeAll(withSuggestion);
    expect(canExportApprovedSop(forgeApproved(everyGapAcknowledged))).toEqual({
      ok: false,
      reason: "unreviewed_suggestion",
    });
  });
});
