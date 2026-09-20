import {
  applyClaim,
  approveSession,
  type ClaimWriteCommand,
  SOP_FIELD_NAMES,
  type SopFieldName,
  type SopSession,
  setAdvisoryAcknowledgement,
} from "@sop-agent/sop-core";
import {
  createDeterministicContext,
  createSessionWithUserMessage,
} from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import { buildApprovalView } from "./approvalView.ts";

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
      statement: `About ${field}.`,
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    });
  const withBlockingDone = () => {
    let current = session;
    for (const field of SOP_FIELD_NAMES.slice(0, 8)) current = record(current, field).session;
    return current;
  };
  const acknowledge = (current: SopSession, field: SopFieldName) => {
    const result = setAdvisoryAcknowledgement(current, { field, acknowledged: true }, context);
    if (!result.ok) throw new Error("setup failed");
    return result.session;
  };
  return { context, session, record, withBlockingDone, acknowledge };
}

describe("buildApprovalView", () => {
  it("lists what is in the way for an empty session, in plain sentences", () => {
    const { session } = setup();
    const view = buildApprovalView(session);

    expect(view.canApprove).toBe(false);
    expect(view.isApproved).toBe(false);
    expect(view.blockingGapLabels).toHaveLength(8);
    expect(view.reasons[0]).toBe(
      "8 blocking gaps remain: Purpose, Scope, Trigger, Roles, Procedure, Authorization, Completion criteria, Governance.",
    );
    expect(view.reasons[1]).toBe(
      "5 advisory gaps need to be acknowledged: Exceptions, Evidence, Controls, Decision rules, Prerequisites.",
    );
    expect(view.advisoryChecklist.map((item) => [item.label, item.isAcknowledged])).toEqual([
      ["Exceptions", false],
      ["Evidence", false],
      ["Controls", false],
      ["Decision rules", false],
      ["Prerequisites", false],
    ]);
  });

  it("uses the singular for one gap, and shows a ticked checkbox for an acknowledged field", () => {
    const { withBlockingDone, acknowledge } = setup();
    let current = withBlockingDone();
    for (const field of ["evidence", "controls", "decisionRules", "prerequisites"] as const) {
      current = acknowledge(current, field);
    }
    const view = buildApprovalView(current);
    expect(view.reasons).toEqual(["1 advisory gap needs to be acknowledged: Exceptions."]);
    expect(view.advisoryChecklist.find((item) => item.field === "evidence")?.isAcknowledged).toBe(
      true,
    );
    expect(view.advisoryChecklist.find((item) => item.field === "exceptions")?.isAcknowledged).toBe(
      false,
    );
  });

  it("names the suggestions still to review, and keeps them out of the gap list", () => {
    const { withBlockingDone, record, acknowledge } = setup();
    const suggested = record(withBlockingDone(), "controls", "proposed");
    let current = suggested.session;
    for (const field of ["exceptions", "evidence", "decisionRules", "prerequisites"] as const) {
      current = acknowledge(current, field);
    }
    const view = buildApprovalView(current);

    expect(view.canApprove).toBe(false);
    expect(view.reasons).toEqual(["1 suggestion needs to be confirmed or rejected."]);
    expect(view.unreviewedSuggestions).toEqual([
      { claimId: suggested.claim.claimId, fieldLabel: "Controls", text: "About controls." },
    ]);
    expect(view.advisoryChecklist.map((item) => item.field)).not.toContain("controls");
  });

  it("can approve a session with nothing in the way, and has no reasons", () => {
    const { withBlockingDone, acknowledge } = setup();
    let current = withBlockingDone();
    for (const field of [
      "exceptions",
      "evidence",
      "controls",
      "decisionRules",
      "prerequisites",
    ] as const) {
      current = acknowledge(current, field);
    }
    expect(buildApprovalView(current)).toMatchObject({ canApprove: true, reasons: [] });
  });

  it("reports an approved session as approved, with the time and no reasons", () => {
    const { context, withBlockingDone, acknowledge } = setup();
    let current = withBlockingDone();
    for (const field of [
      "exceptions",
      "evidence",
      "controls",
      "decisionRules",
      "prerequisites",
    ] as const) {
      current = acknowledge(current, field);
    }
    const approved = approveSession(current, context);
    if (!approved.ok) throw new Error("setup failed");
    expect(buildApprovalView(approved.session)).toMatchObject({
      isApproved: true,
      canApprove: false,
      approvedAt: "2026-01-01T00:00:00.000Z",
      reasons: [],
    });
  });
});
