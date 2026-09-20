import type { SopSession } from "@sop-agent/sop-core";
import {
  buildClaimsView,
  type ClaimVersionView,
  type ClaimView,
  type FieldClaimsView,
} from "../lib/claimsView.ts";

function statusOf(field: FieldClaimsView): { label: string; className: string } {
  if (field.isSuggestionOnly && field.gap === null) {
    return { label: "Suggested", className: "status-suggested" };
  }
  if (field.gap === null) return { label: "Complete", className: "status-complete" };
  return field.gap.severity === "blocking"
    ? { label: "Blocking", className: "status-blocking" }
    : { label: "Advisory", className: "status-advisory" };
}

function detailOf(field: FieldClaimsView): string {
  if (field.state === "empty") return "Nothing recorded yet";
  const count = field.claims.length;
  const claims = `${count} ${count === 1 ? "claim" : "claims"}`;
  return field.state === "unresolved" ? `${claims}, some unresolved` : claims;
}

function PreviousVersions({ versions }: { versions: ClaimVersionView[] }) {
  if (versions.length === 0) return null;
  return (
    <details className="claim-history">
      <summary>Earlier versions ({versions.length})</summary>
      <ul>
        {versions.map((version) => (
          <li key={version.entryId}>
            <span className="history-reason">{version.reasonLabel}:</span>{" "}
            {version.text ?? "Unknown"}
            {version.note === null ? null : <span className="claim-note"> ({version.note})</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ClaimItem({ claim }: { claim: ClaimView }) {
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
      <PreviousVersions versions={claim.previousVersions} />
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
            <span className="history-reason">{version.reasonLabel}:</span>{" "}
            {version.text ?? "Unknown"}
            {version.changeNote === null ? null : (
              <span className="claim-note"> ({version.changeNote})</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The claims view, one expandable section per SOP field. Readiness comes from the same function the
 * API uses to brief the agent, through `buildClaimsView`; nothing is read back from the API. The
 * view is read-only: changes are made by telling the agent in the chat.
 */
export function ReadinessPanel({ session }: { session: SopSession }) {
  const fields = buildClaimsView(session);
  const blockingCount = fields.filter((field) => field.gap?.severity === "blocking").length;
  const advisoryCount = fields.filter((field) => field.gap?.severity === "advisory").length;
  const suggestionOnlyCount = fields.filter((field) => field.isSuggestionOnly).length;

  return (
    <section className="panel readiness" aria-labelledby="readiness-heading">
      <header className="panel-header">
        <h2 id="readiness-heading">Readiness</h2>
        <p className="summary">
          <strong>{blockingCount}</strong> blocking · <strong>{advisoryCount}</strong> advisory
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
          const hasDetails = field.claims.length > 0 || field.removedClaims.length > 0;
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
                    {field.claims.length === 0 ? null : (
                      <ul className="claim-list">
                        {field.claims.map((claim) => (
                          <ClaimItem key={claim.claimId} claim={claim} />
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
