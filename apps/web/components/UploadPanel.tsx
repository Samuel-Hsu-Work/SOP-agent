import { useRef } from "react";
import { FILE_INPUT_ACCEPT, SUPPORTED_FILE_HINT } from "../lib/extractDocument.ts";
import type { UploadReport } from "../lib/useSopSession.ts";

export interface UploadPanelProps {
  /** A chat turn, another upload, or a review action would collide with this one. */
  isDisabled: boolean;
  isUploading: boolean;
  report: UploadReport | null;
  onUpload: (file: File) => void;
}

/**
 * Adds the rules from a policy or handbook to the SOP as claims to review. The file is read by the
 * API and never kept; what comes back is checked against the document before it is added. Nothing
 * here confirms anything: every rule from a document waits for a person's review.
 */
export function UploadPanel({ isDisabled, isUploading, report, onUpload }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <section className="panel upload" aria-labelledby="upload-heading">
      <header className="panel-header">
        <h2 id="upload-heading">Documents</h2>
      </header>
      <div className="upload-body">
        <p className="upload-help">
          Upload a policy or handbook ({SUPPORTED_FILE_HINT}). Its rules are added as claims for you
          to check against the quote from the document.
        </p>
        <input
          ref={inputRef}
          id="document-file"
          className="visually-hidden"
          type="file"
          accept={FILE_INPUT_ACCEPT}
          disabled={isDisabled || isUploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clearing the value lets the same file be chosen again.
            event.target.value = "";
            if (file !== undefined) onUpload(file);
          }}
        />
        <button
          type="button"
          disabled={isDisabled || isUploading}
          onClick={() => inputRef.current?.click()}
        >
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
      </div>
    </section>
  );
}
