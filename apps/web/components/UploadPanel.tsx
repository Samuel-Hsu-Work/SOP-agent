import { useRef } from "react";
import { FILE_INPUT_ACCEPT, SUPPORTED_FILE_HINT } from "../lib/extractDocument.ts";
import type { ReferenceDocumentView } from "../lib/referenceView.ts";
import type { UploadReport } from "../lib/useSopSession.ts";

function describePassageCount(document: ReferenceDocumentView): string {
  const total = `${document.passages.length} ${document.passages.length === 1 ? "passage" : "passages"}`;
  return document.notYetAnsweredCount === 0
    ? total
    : `${total} · ${document.notYetAnsweredCount} not answered yet`;
}

export interface UploadPanelProps {
  /** A chat turn, another upload, or a review action would collide with this one. */
  isDisabled: boolean;
  isUploading: boolean;
  /** Whether the user has said what the SOP covers. A document is read for that, so it waits until then. */
  hasTarget: boolean;
  report: UploadReport | null;
  documents: ReferenceDocumentView[];
  onUpload: (file: File) => void;
}

/**
 * Reads a policy or handbook for the SOP being written. The file is read by the API and never kept;
 * what comes back is a few passages, each checked against the document, kept here as reference
 * material. Nothing from a document enters the SOP from this panel: the assistant asks about each
 * passage in chat, and only the user's answer is recorded.
 */
export function UploadPanel({
  isDisabled,
  isUploading,
  hasTarget,
  report,
  documents,
  onUpload,
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isBlocked = isDisabled || isUploading || !hasTarget;

  return (
    <section className="panel upload" aria-labelledby="upload-heading">
      <header className="panel-header">
        <h2 id="upload-heading">Documents</h2>
      </header>
      <div className="upload-body">
        <p className="upload-help">
          {hasTarget
            ? `Upload a policy or handbook (${SUPPORTED_FILE_HINT}). The assistant reads it for this SOP and asks you about what it finds. Nothing is added until you answer.`
            : "Tell the assistant which process this SOP covers first. A document is read for that SOP."}
        </p>
        <input
          ref={inputRef}
          id="document-file"
          className="visually-hidden"
          type="file"
          accept={FILE_INPUT_ACCEPT}
          disabled={isBlocked}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clearing the value lets the same file be chosen again.
            event.target.value = "";
            if (file !== undefined) onUpload(file);
          }}
        />
        <button type="button" disabled={isBlocked} onClick={() => inputRef.current?.click()}>
          {isUploading ? "Reading document…" : "Upload document"}
        </button>
        {report === null ? null : (
          <p
            className={report.kind === "error" ? "upload-report upload-error" : "upload-report"}
            role={report.kind === "error" ? "alert" : "status"}
          >
            {report.message}
          </p>
        )}
        {/* Collapsed by default: the passages are asked about in chat, and a long list would push
            the review panel below the fold. */}
        {documents.map((document) => (
          <details
            key={document.documentId}
            className="reference-document"
            aria-label={`From ${document.documentName}`}
          >
            <summary className="reference-summary">
              <span className="reference-document-name">{document.documentName}</span>
              <span className="reference-count">{describePassageCount(document)}</span>
            </summary>
            <ul className="reference-list">
              {document.passages.map((passage) => (
                <li key={passage.passageId} className="reference-item">
                  <p className="reference-meta">
                    <span className="reference-field">{passage.fieldLabel}</span> ·{" "}
                    <span className={passage.isStale ? "reference-state stale" : "reference-state"}>
                      {passage.stateLabel}
                    </span>
                  </p>
                  <p className="reference-statement">{passage.statement}</p>
                  <figure className="citation">
                    <blockquote>{passage.citation.quote}</blockquote>
                    <figcaption>{passage.citation.location}</figcaption>
                  </figure>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}
