import type { SopSession } from "./session.ts";
import type { WriteContext } from "./writeContext.ts";

export type MarkDownloadedResult =
  | { ok: true; session: SopSession; change: "updated" | "unchanged" }
  | { ok: false; error: { code: "sop_not_approved"; message: string } };

/**
 * Records that the browser received the approved SOP's PDF and started the download. It is the one
 * write an approved session allows, and it does not weaken "an approved SOP is immutable": it is
 * not a claim write and never touches a claim, the history, an acknowledgement, or the approval
 * time. It changes only `downloadedAt` (and `updatedAt` with it), which is a fact about the export
 * and not part of the SOP.
 *
 * The first download time is kept: a second download returns the same session untouched.
 */
export function markSopDownloaded(
  session: SopSession,
  context: WriteContext,
): MarkDownloadedResult {
  if (session.status !== "approved") {
    return {
      ok: false,
      error: {
        code: "sop_not_approved",
        message: "Only an approved SOP can be downloaded.",
      },
    };
  }
  if (session.downloadedAt !== null) return { ok: true, session, change: "unchanged" };

  const timestamp = context.now();
  return {
    ok: true,
    change: "updated",
    session: { ...session, downloadedAt: timestamp, updatedAt: timestamp },
  };
}
