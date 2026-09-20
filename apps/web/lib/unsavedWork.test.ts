import {
  applyClaim,
  createEmptySession,
  type SopSession,
  systemWriteContext,
} from "@sop-agent/sop-core";
import { createSessionWithUserMessage } from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import { wouldLoseWork } from "./unsavedWork.ts";

const empty = createEmptySession(systemWriteContext);
const withMessage = createSessionWithUserMessage(systemWriteContext).session;
const approved = (downloadedAt: string | null): SopSession => ({
  ...empty,
  status: "approved",
  approvedAt: "2026-01-02T00:00:00.000Z",
  downloadedAt,
});

describe("wouldLoseWork", () => {
  it("is false for an empty draft", () => {
    expect(wouldLoseWork(empty, false)).toBe(false);
  });

  it("is true for a draft with a message", () => {
    expect(wouldLoseWork(withMessage, false)).toBe(true);
  });

  it("is true for a draft with a claim", () => {
    const { session, messageId } = createSessionWithUserMessage(systemWriteContext);
    const result = applyClaim(
      { ...session, messages: session.messages },
      {
        kind: "record",
        createdByType: "agent",
        field: "purpose",
        status: "observed",
        statement: "Handle refunds.",
        note: null,
        effectiveDate: null,
        sourceMessageId: messageId,
        insertBeforeClaimId: null,
      },
      systemWriteContext,
    );
    if (!result.ok) throw new Error("setup failed");
    expect(wouldLoseWork({ ...result.session, messages: [] }, false)).toBe(true);
  });

  it("is true for an empty draft while its first turn is still in flight", () => {
    expect(wouldLoseWork(empty, true)).toBe(true);
  });

  it("is true for an approved SOP that has not been downloaded", () => {
    expect(wouldLoseWork(approved(null), false)).toBe(true);
  });

  it("is false for an approved SOP once its download has started", () => {
    expect(wouldLoseWork(approved("2026-01-03T00:00:00.000Z"), false)).toBe(false);
  });
});
