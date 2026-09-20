import type { AdvisoryFieldName, SopSession } from "@sop-agent/sop-core";
import { buildApprovalView } from "../lib/approvalView.ts";

export interface ApprovalPanelProps {
  session: SopSession;
  /** A chat turn is in flight, so a local change would be overwritten by its commit. */
  isBusy: boolean;
  onAcknowledge: (field: AdvisoryFieldName, acknowledged: boolean) => void;
  onApprove: () => void;
  /** The PDF is being requested. */
  isDownloading: boolean;
  downloadError: string | null;
  onDownload: () => void;
}

function formatApprovalTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * The approval step: what still stands in the way, a checklist for the advisory gaps, and the
 * Approve button. The rules are `checkFinalization` in `sop-core`; this only shows them. Approval
 * is a browser-side action, so what it guarantees is the shape of an approval, not who clicked.
 */
export function ApprovalPanel({
  session,
  isBusy,
  onAcknowledge,
  onApprove,
  isDownloading,
  downloadError,
  onDownload,
}: ApprovalPanelProps) {
  const view = buildApprovalView(session);

  if (view.isApproved) {
    return (
      <section className="panel approval" aria-labelledby="approval-heading">
        <header className="panel-header">
          <h2 id="approval-heading">Approval</h2>
        </header>
        <div className="approval-body">
          <p className="approved-notice" role="status">
            <strong>Approved</strong>
            {view.approvedAt === null ? null : ` on ${formatApprovalTime(view.approvedAt)}`}. The
            SOP can no longer be changed. Start a new chat to write another one.
          </p>
          {view.downloadedAt === null ? (
            <p className="download-notice">
              <strong>Not downloaded yet.</strong> The PDF is the only lasting record: closing this
              tab or starting a new chat loses this SOP.
            </p>
          ) : (
            <p className="download-notice">
              PDF downloaded on {formatApprovalTime(view.downloadedAt)}. You can download it again.
            </p>
          )}
          <button type="button" onClick={onDownload} disabled={isDownloading}>
            {isDownloading ? "Preparing PDF…" : "Download PDF"}
          </button>
          {downloadError === null ? null : (
            <p className="download-error" role="alert">
              {downloadError}
            </p>
          )}
        </div>
      </section>
    );
  }

  const reasonsId = "approval-reasons";
  return (
    <section className="panel approval" aria-labelledby="approval-heading">
      <header className="panel-header">
        <h2 id="approval-heading">Approval</h2>
      </header>
      <div className="approval-body">
        {view.unreviewedSuggestions.length === 0 ? null : (
          <div className="suggestions-to-review">
            <p className="approval-label">Suggestions to confirm or reject in the review panel</p>
            <ul>
              {view.unreviewedSuggestions.map((suggestion) => (
                <li key={suggestion.claimId}>
                  <strong>{suggestion.fieldLabel}:</strong> {suggestion.text ?? "Unknown"}
                </li>
              ))}
            </ul>
          </div>
        )}

        {view.advisoryChecklist.length === 0 ? null : (
          <fieldset className="checklist" disabled={isBusy}>
            <legend>
              Acknowledge each advisory gap. Ticking a box accepts the gap; it does not fill it.
              Reviewing or changing any claim clears the ticks, so review first.
            </legend>
            {view.advisoryChecklist.map((item) => (
              <label key={item.field} className="checklist-item">
                <input
                  type="checkbox"
                  checked={item.isAcknowledged}
                  onChange={(event) => onAcknowledge(item.field, event.target.checked)}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </fieldset>
        )}

        {view.reasons.length === 0 ? null : (
          <ul id={reasonsId} className="approval-reasons">
            {view.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={onApprove}
          disabled={!view.canApprove || isBusy}
          aria-describedby={view.reasons.length === 0 ? undefined : reasonsId}
        >
          Approve SOP
        </button>
      </div>
    </section>
  );
}
