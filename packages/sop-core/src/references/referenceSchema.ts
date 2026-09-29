import { z } from "zod";
import {
  calendarDateSchema,
  documentCitationSchema,
  identifierSchema,
  timestampSchema,
} from "../claims/claim.ts";
import {
  MAX_DOCUMENT_NAME_LENGTH,
  MAX_PASSAGE_STATEMENT_LENGTH,
  MAX_REFERENCE_DOCUMENTS,
  MAX_REFERENCE_PASSAGES,
} from "../limits.ts";
import { SOP_FIELD_NAMES } from "../sopFields.ts";
import { DOCUMENT_FILE_KINDS } from "./documentFile.ts";

/**
 * Where a passage stands:
 * - open: kept at upload, not yet put to the person;
 * - offered: handed to the agent to ask about;
 * - used: the person agreed and a claim of theirs rests on it;
 * - declined: the person said it does not apply, or answered differently;
 * - in_conflict: it disagrees with what the person said, and a conflict pair holds both sides;
 * - settled: the person's final answer to that conflict replaced it.
 */
export const PASSAGE_STATES = [
  "open",
  "offered",
  "used",
  "declined",
  "in_conflict",
  "settled",
] as const;
export type PassageState = (typeof PASSAGE_STATES)[number];

/** How many claims one passage may end up behind. Several steps can rest on one sentence. */
export const MAX_CLAIMS_PER_PASSAGE = 10;
/** The purpose and scope claims a passage was judged against, at most (the first ones stated). */
export const MAX_TARGET_CLAIMS = 20;
/**
 * How many times a passage is handed to the agent without being put to the person before it stops
 * being handed over. It then stays in the upload panel as not discussed, for the person to raise.
 */
export const MAX_TIMES_NOT_ASKED = 3;

export const referenceDocumentSchema = z.object({
  documentId: identifierSchema,
  /** The sanitized file name, shown to a person and never sent to a model. */
  documentName: z.string().min(1).max(MAX_DOCUMENT_NAME_LENGTH),
  fileKind: z.enum(DOCUMENT_FILE_KINDS),
  addedAt: timestampSchema,
});

export type ReferenceDocument = z.infer<typeof referenceDocumentSchema>;

/**
 * One passage an uploaded document holds for this SOP. It is reference material, not SOP content:
 * it fills no gap and is not printed. Only its `statement` ever reaches the agent; the citation is
 * for the person, and a quote or file name never reaches a model.
 */
export const referencePassageSchema = z.object({
  passageId: identifierSchema,
  documentId: identifierSchema,
  field: z.enum(SOP_FIELD_NAMES),
  statement: z.string().min(1).max(MAX_PASSAGE_STATEMENT_LENGTH),
  effectiveDate: calendarDateSchema.nullable(),
  citation: documentCitationSchema,
  /**
   * The purpose and scope claims the reader was told this SOP is about. If any of them is gone,
   * the SOP's target has changed since, and the passage is no longer put to the person.
   */
  targetClaimIds: z.array(identifierSchema).min(1).max(MAX_TARGET_CLAIMS),
  state: z.enum(PASSAGE_STATES),
  /** Set when the passage is offered, so the most recent ones can be told apart. */
  offeredSequence: z.number().int().min(1).nullable(),
  /**
   * How many turns the passage was handed to the agent and the reply did not put it to the person.
   * It stays open, so it is not lost, but goes behind the passages not yet handed over, and after
   * `MAX_TIMES_NOT_ASKED` it is no longer handed over at all. Defaults to 0 for a session stored
   * before this field existed.
   */
  timesNotAsked: z.number().int().min(0).max(MAX_TIMES_NOT_ASKED).default(0),
  /** The claims that rest on it: the person's statements, or the document side of a conflict. */
  claimIds: z.array(identifierSchema).max(MAX_CLAIMS_PER_PASSAGE),
});

export type ReferencePassage = z.infer<typeof referencePassageSchema>;

export const referenceMaterialSchema = z.object({
  documents: z.array(referenceDocumentSchema).max(MAX_REFERENCE_DOCUMENTS),
  passages: z.array(referencePassageSchema).max(MAX_REFERENCE_PASSAGES),
  /** How many passages have been offered in this session; numbers each offer. */
  offeredTotal: z.number().int().min(0),
});

export type ReferenceMaterial = z.infer<typeof referenceMaterialSchema>;

export const EMPTY_REFERENCE_MATERIAL: ReferenceMaterial = {
  documents: [],
  passages: [],
  offeredTotal: 0,
};

export function updatePassage(
  references: ReferenceMaterial,
  passageId: string,
  update: (passage: ReferencePassage) => ReferencePassage,
): ReferenceMaterial {
  return {
    ...references,
    passages: references.passages.map((passage) =>
      passage.passageId === passageId ? update(passage) : passage,
    ),
  };
}

/** The text reference material holds, counted toward the session-wide cap with the claims. */
export function totalReferenceTextLength(references: ReferenceMaterial): number {
  return references.passages.reduce(
    (total, passage) =>
      total +
      passage.statement.length +
      passage.citation.quote.length +
      passage.citation.location.length +
      passage.citation.documentName.length,
    0,
  );
}
