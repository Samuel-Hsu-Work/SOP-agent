import { buildSopDocument, type SopDocumentItem, type SopSession } from "@sop-agent/sop-core";

const SOURCE_LABELS: Record<SopDocumentItem["sourceType"], string> = {
  employee_statement: "from the interview",
  agent_suggestion: "suggested by the assistant",
};

/**
 * The SOP as a document, built only from `buildSopDocument`. It prints every claim with its tag,
 * so a reader can tell a confirmed instruction from a suggestion or an open item. The PDF in
 * slice 4 is built from the same model.
 */
export function SopPreview({ session }: { session: SopSession }) {
  const document = buildSopDocument(session);

  return (
    <section className="panel preview" aria-labelledby="preview-heading">
      <header className="panel-header">
        <h2 id="preview-heading">SOP preview</h2>
        <p className="summary">
          {document.status === "approved" ? "Approved" : "Draft"} · version {document.version}
        </p>
      </header>
      <div className="preview-body">
        <h3 className="document-title">{document.title}</h3>

        {document.legend.length === 0 ? null : (
          <dl className="legend-list">
            {document.legend.map((entry) => (
              <div key={entry.tag}>
                <dt>{entry.tag}</dt>
                <dd>{entry.meaning}</dd>
              </div>
            ))}
          </dl>
        )}

        {document.sections.map((section) => (
          <article key={section.field} className="document-section">
            <h4>
              {section.heading}
              {section.gap === null ? null : (
                <span className={`gap-flag gap-flag-${section.fieldClass}`}>
                  {section.fieldClass === "blocking"
                    ? "blocking gap"
                    : section.isGapAcknowledged
                      ? "gap acknowledged"
                      : "advisory gap"}
                </span>
              )}
            </h4>
            {section.gapNotice === null ? null : <p className="gap-notice">{section.gapNotice}</p>}
            {section.items.length === 0 ? null : (
              <ol className={section.field === "procedure" ? "steps" : "items"}>
                {section.items.map((item) => (
                  <li
                    key={item.claimId}
                    className={item.isUnresolved ? "document-item open-item" : "document-item"}
                    value={item.position ?? undefined}
                  >
                    <span className={`tag-chip tag-${item.status}`}>{item.provenanceTag}</span>{" "}
                    {item.text === null ? (
                      <em>Open item: {item.note ?? "not known"}</em>
                    ) : (
                      <span>{item.text}</span>
                    )}
                    <span className="item-source">
                      {" "}
                      {SOURCE_LABELS[item.sourceType]}
                      {item.effectiveDate === null ? "" : `, effective ${item.effectiveDate}`}
                      {item.text !== null && item.note !== null ? `, ${item.note}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
