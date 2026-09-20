import { describe, expect, it } from "vitest";
import { markSopDownloaded } from "./download.ts";
import { createEmptySession, type SopSession, sopSessionSchema } from "./session.ts";
import { createDeterministicContext } from "./testing.ts";
import type { WriteContext } from "./writeContext.ts";

const DOWNLOADED_AT = "2026-01-03T09:30:00.000Z";
const LATER_CONTEXT: WriteContext = { now: () => DOWNLOADED_AT, newId: () => "unused" };

function buildApprovedSession(): SopSession {
  return {
    ...createEmptySession(createDeterministicContext()),
    status: "approved",
    approvedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("markSopDownloaded", () => {
  it("refuses a draft and leaves it alone", () => {
    const draft = createEmptySession(createDeterministicContext());
    const result = markSopDownloaded(draft, createDeterministicContext());
    expect(result).toMatchObject({ ok: false, error: { code: "sop_not_approved" } });
    expect(draft.downloadedAt).toBeNull();
  });

  it("records the first download on an approved session and changes nothing else", () => {
    const approved = buildApprovedSession();
    const result = markSopDownloaded(approved, LATER_CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toBe("updated");
    expect(result.session).toEqual({
      ...approved,
      downloadedAt: DOWNLOADED_AT,
      updatedAt: DOWNLOADED_AT,
    });
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("keeps the first download time when the SOP is downloaded again", () => {
    const first = markSopDownloaded(buildApprovedSession(), LATER_CONTEXT);
    if (!first.ok) throw new Error("setup failed");

    const secondContext: WriteContext = { now: () => "2026-01-04T00:00:00.000Z", newId: () => "x" };
    const second = markSopDownloaded(first.session, secondContext);
    expect(second).toEqual({ ok: true, session: first.session, change: "unchanged" });
    if (second.ok) expect(second.session).toBe(first.session);
  });
});
