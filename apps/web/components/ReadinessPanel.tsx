import { computeGaps, type FieldReadiness, type SopSession } from "@sop-agent/sop-core";

function statusOf(readiness: FieldReadiness): { label: string; className: string } {
  if (readiness.gap === null) return { label: "Complete", className: "status-complete" };
  return readiness.gap.severity === "blocking"
    ? { label: "Blocking", className: "status-blocking" }
    : { label: "Advisory", className: "status-advisory" };
}

function detailOf(readiness: FieldReadiness): string {
  if (readiness.state === "empty") return "Nothing recorded yet";
  const claims = `${readiness.claimCount} ${readiness.claimCount === 1 ? "claim" : "claims"}`;
  return readiness.state === "unresolved" ? `${claims}, some unresolved` : claims;
}

/**
 * Readiness is computed here, in the browser, by the same function the API uses to brief the agent.
 * It never reads readiness values from the API.
 */
export function ReadinessPanel({ session }: { session: SopSession }) {
  const report = computeGaps(session);

  return (
    <section className="panel readiness" aria-labelledby="readiness-heading">
      <header className="panel-header">
        <h2 id="readiness-heading">Readiness</h2>
        <p className="summary">
          <strong>{report.blockingGapCount}</strong> blocking ·{" "}
          <strong>{report.advisoryGapCount}</strong> advisory
        </p>
      </header>
      <ul className="field-list">
        {report.fields.map((readiness) => {
          const status = statusOf(readiness);
          return (
            <li key={readiness.field} className="field-row">
              <div>
                <span className="field-label">{readiness.label}</span>
                <span className="field-detail">{detailOf(readiness)}</span>
              </div>
              <span className={`status ${status.className}`}>{status.label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
