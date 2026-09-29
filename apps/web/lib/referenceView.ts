import {
  type DocumentCitation,
  getFieldDefinition,
  isPassageStale,
  type PassageState,
  type SopSession,
} from "@sop-agent/sop-core";

/** Where a passage stands, in the words a person uses. */
const STATE_LABELS: Record<PassageState, string> = {
  open: "Not discussed yet",
  offered: "Asked about in chat",
  used: "In the SOP, as your answer",
  declined: "Left out",
  in_conflict: "Disagrees with what you said",
  settled: "Settled by your answer",
};

const STALE_LABEL = "Read for an earlier scope: upload again to check it";

export interface ReferencePassageView {
  passageId: string;
  fieldLabel: string;
  statement: string;
  citation: DocumentCitation;
  stateLabel: string;
  /** Read for a purpose or scope that has since been removed, so it is no longer put to the user. */
  isStale: boolean;
}

export interface ReferenceDocumentView {
  documentId: string;
  documentName: string;
  passages: ReferencePassageView[];
  /** Passages still waiting for the user's answer, shown while the list is collapsed. */
  notYetAnsweredCount: number;
}

/**
 * The reference material from uploaded documents, one entry per document, each passage with its
 * quote and where it stands. Read-only and pure: a passage enters the SOP only through the user's
 * answer in chat, never from this list.
 */
export function buildReferenceView(session: SopSession): ReferenceDocumentView[] {
  return session.references.documents.map((document) => {
    let notYetAnsweredCount = 0;
    const passages = session.references.passages
      .filter((passage) => passage.documentId === document.documentId)
      .map((passage) => {
        const isUnanswered = passage.state === "open" || passage.state === "offered";
        const isStale = isUnanswered && isPassageStale(session, passage);
        if (isUnanswered && !isStale) notYetAnsweredCount += 1;
        return {
          passageId: passage.passageId,
          fieldLabel: getFieldDefinition(passage.field).label,
          statement: passage.statement,
          citation: passage.citation,
          stateLabel: isStale ? STALE_LABEL : STATE_LABELS[passage.state],
          isStale,
        };
      });
    return {
      documentId: document.documentId,
      documentName: document.documentName,
      passages,
      notYetAnsweredCount,
    };
  });
}
