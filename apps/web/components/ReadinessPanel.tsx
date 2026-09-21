import type { SopSession } from "@sop-agent/sop-core";
import {
  buildClaimsView,
  type ClaimVersionView,
  type ClaimView,
  type ConflictPairView,
  type FieldClaimsView,
} from "../lib/claimsView.ts";

function statusOf(field: FieldClaimsView): { label: string; className: string } {
  if (field.isSuggestionOnly && field.gap === null) {
    return { label: "Suggested", className: "status-suggested" };
  }
  if (field.gap === null) return { label: "Complete", className: "status-complete" };
  if (field.gap.severity === "blocking") return { label: "Blocking", className: "status-blocking" };
  return field.isGapAcknowledged
    ? { label: "Acknowledged", className: "status-acknowledged" }
    : { label: "Advisory", className: "status-advisory" };
}

function detailOf(field: FieldClaimsView): string {
  if (field.state === "empty") return "Nothing recorded yet";
  const count = field.claimCount;
  const claims = `${count} ${count === 1 ? "claim" : "claims"}`;
  return field.state === "unresolved" ? `${claims}, some unresolved` : claims;
}

/** What one earlier version looked like: its words, its date, and the status it had then. */
function VersionText({ version }: { version: ClaimVersionView }) {
  return (
    <>
      <span className="history-reason">{version.reasonLabel}:</span> {version.text ?? "Unknown"}
      <span className="claim-note">
        {" "}
        ({version.statusLabel}
        {version.effectiveDate === null ? "" : `, effective ${version.effectiveDate}`}
        {version.note === null ? "" : `, ${version.note}`}
        {version.changeNote === null ? "" : `, ${version.changeNote}`})
      </span>
    </>
  );
}

/** Where a claim from a document came from, so a person can check it against the source. */
function Citation({ claim }: { claim: ClaimView }) {
  if (claim.citation === null) return null;
  return (
    <figure className="citation">
      <blockquote>{claim.citation.quote}</blockquote>
      <figcaption>
        {claim.citation.documentName} · {claim.citation.location}
      </figcaption>
    </figure>
  );
}

function PreviousVersions({ versions }: { versions: ClaimVersionView[] }) {
  if (versions.length === 0) return null;
  return (
    <details className="claim-history">
      <summary>Earlier versions ({versions.length})</summary>
      <ul>
        {versions.map((version) => (
          <li key={version.entryId}>
            <VersionText version={version} />
          </li>
        ))}
      </ul>
    </details>
  );
}

interface ClaimItemProps {
  claim: ClaimView;
  isLocked: boolean;
  onConfirm: (claimId: string) => void;
  onReject: (claimId: string) => void;
  onDescribeChange: () => void;
}

function ClaimItem({ claim, isLocked, onConfirm, onReject, onDescribeChange }: ClaimItemProps) {
  return (
    <li className="claim">
      <div className="claim-body">
        {claim.stepNumber === null ? null : <span className="claim-step">{claim.stepNumber}.</span>}
        <span className={claim.text === null ? "claim-text claim-text-unknown" : "claim-text"}>
          {claim.text ?? "Unknown"}
        </span>
      </div>
      <div className="claim-meta">
        <span className={`claim-status claim-status-${claim.status}`}>{claim.statusLabel}</span>
        {claim.effectiveDate === null ? null : <span>Effective {claim.effectiveDate}</span>}
        {claim.note === null ? null : <span className="claim-note">{claim.note}</span>}
      </div>
      <Citation claim={claim} />
      <div className="claim-actions">
        {claim.canConfirm ? (
          <button
            type="button"
            className="small"
            disabled={isLocked}
            onClick={() => onConfirm(claim.claimId)}
          >
            Confirm
          </button>
        ) : null}
        {claim.canReject ? (
          <button
            type="button"
            className="small secondary"
            disabled={isLocked}
            onClick={() => onReject(claim.claimId)}
          >
            {claim.rejectLabel}
          </button>
        ) : null}
        <button type="button" className="small link" disabled={isLocked} onClick={onDescribeChange}>
          Describe a change in chat
        </button>
      </div>
      <PreviousVersions versions={claim.previousVersions} />
    </li>
  );
}

/**
 * Two claims that disagree, side by side. There are no confirm or reject buttons: which side is
 * right is for the user to say in chat, and their answer replaces both.
 */
function ConflictPair({
  pair,
  isLocked,
  onDescribeChange,
}: {
  pair: ConflictPairView;
  isLocked: boolean;
  onDescribeChange: () => void;
}) {
  return (
    <li className="conflict">
      <p className="conflict-title">
        These two disagree. Tell the assistant the final answer in chat.
      </p>
      <div className="conflict-sides">
        {pair.sides.map((side) => (
          <div key={side.claimId} className="conflict-side">
            <p className="conflict-source">{side.sourceLabel}</p>
            <p className="claim-text">{side.text}</p>
            {side.effectiveDate === null ? null : (
              <p className="claim-note">Effective {side.effectiveDate}</p>
            )}
            <Citation claim={side} />
          </div>
        ))}
      </div>
      <button type="button" className="small link" disabled={isLocked} onClick={onDescribeChange}>
        Answer in chat
      </button>
    </li>
  );
}

function RemovedClaims({ removed }: { removed: ClaimVersionView[] }) {
  if (removed.length === 0) return null;
  return (
    <details className="claim-history removed-claims">
      <summary>Removed or replaced ({removed.length})</summary>
      <ul>
        {removed.map((version) => (
          <li key={version.entryId}>
            <VersionText version={version} />
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface ReadinessPanelProps {
  session: SopSession;
  /** A chat turn is in flight. A review click would be overwritten by its commit, so it is refused. */
  isBusy: boolean;
  onConfirm: (claimId: string) => void;
  onReject: (claimId: string) => void;
  /** Moves the cursor to the chat, where every change to a claim is made. */
  onDescribeChange: () => void;
}

/**
 * The review panel: one expandable section per SOP field, with each claim's history and the review
 * actions. Review never edits what a claim says: confirming verifies it, and rejecting undoes one
 * step of endorsement. Changes to the words are made by telling the agent in the chat.
 */
export function ReadinessPanel(props: ReadinessPanelProps) {
  const { session, isBusy, onConfirm, onReject, onDescribeChange } = props;
  const fields = buildClaimsView(session);
  const isLocked = isBusy || session.status === "approved";
  const blockingCount = fields.filter((field) => field.gap?.severity === "blocking").length;
  const advisoryCount = fields.filter(
    (field) => field.gap?.severity === "advisory" && !field.isGapAcknowledged,
  ).length;
  const acknowledgedCount = fields.filter((field) => field.isGapAcknowledged).length;
  const suggestionOnlyCount = fields.filter((field) => field.isSuggestionOnly).length;

  return (
    <section className="panel readiness" aria-labelledby="readiness-heading">
      <header className="panel-header">
        <h2 id="readiness-heading">Review</h2>
        <p className="summary">
          <strong>{blockingCount}</strong> blocking · <strong>{advisoryCount}</strong> advisory
          {acknowledgedCount === 0 ? null : (
            <>
              {" "}
              · <strong>{acknowledgedCount}</strong> acknowledged
            </>
          )}
          {suggestionOnlyCount === 0 ? null : (
            <>
              {" "}
              · <strong>{suggestionOnlyCount}</strong> suggested only
            </>
          )}
        </p>
      </header>
      <ul className="field-list">
        {fields.map((field) => {
          const status = statusOf(field);
          const hasDetails =
            field.claims.length > 0 ||
            field.conflictPairs.length > 0 ||
            field.removedClaims.length > 0;
          const heading = (
            <>
              <div>
                <span className="field-label">{field.label}</span>
                <span className="field-detail">{detailOf(field)}</span>
              </div>
              <span className={`status ${status.className}`}>{status.label}</span>
            </>
          );
          return (
            <li key={field.field} className="field-item">
              {hasDetails ? (
                <details>
                  <summary className="field-row">{heading}</summary>
                  <div className="field-claims">
                    {field.claims.length === 0 && field.conflictPairs.length === 0 ? null : (
                      <ul className="claim-list">
                        {field.conflictPairs.map((pair) => (
                          <ConflictPair
                            key={pair.sides[0].claimId}
                            pair={pair}
                            isLocked={isLocked}
                            onDescribeChange={onDescribeChange}
                          />
                        ))}
                        {field.claims.map((claim) => (
                          <ClaimItem
                            key={claim.claimId}
                            claim={claim}
                            isLocked={isLocked}
                            onConfirm={onConfirm}
                            onReject={onReject}
                            onDescribeChange={onDescribeChange}
                          />
                        ))}
                      </ul>
                    )}
                    <RemovedClaims removed={field.removedClaims} />
                  </div>
                </details>
              ) : (
                <div className="field-row">{heading}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
