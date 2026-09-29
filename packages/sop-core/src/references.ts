import type { ClaimWriteErrorCode } from "./claim.ts";
import { type ClaimWriteError, checkSessionLimits } from "./claimWriteSupport.ts";
import { raiseReferenceConflicts } from "./detectConflicts.ts";
import type { DocumentFileKind } from "./documentFile.ts";
import { type PassageDraft, passageDraftSchema } from "./documentWire.ts";
import { MAX_REFERENCE_DOCUMENTS, MAX_REFERENCE_PASSAGES } from "./limits.ts";
import { findPassage, isPassageStale } from "./referenceQueries.ts";
import {
  MAX_TARGET_CLAIMS,
  MAX_TIMES_NOT_ASKED,
  type ReferencePassage,
  updatePassage,
} from "./referenceSchema.ts";
import type { SopSession } from "./session.ts";
import { isStatedClaim } from "./sessionQueries.ts";
import { statesTheSameThing, usesPassageWording } from "./statementComparison.ts";
import { normalizeStatement } from "./text.ts";
import type { WriteContext } from "./writeContext.ts";

/*
 * Reference material: what uploaded documents hold for the SOP being written. A passage is kept
 * outside the SOP. It becomes SOP content only when the person says it applies, and then as their
 * own statement; if it disagrees with what they said, conflict detection puts both sides to them.
 */

/**
 * What the SOP is about, in the person's own words: their stated purpose and scope. A document is
 * read against this, so it cannot be read before the person has said what the SOP covers.
 */
export function sopTargetOf(session: SopSession): {
  purpose: string[];
  scope: string[];
  claimIds: string[];
} {
  const stated = session.claims.filter(
    (claim) => isStatedClaim(claim) && (claim.field === "purpose" || claim.field === "scope"),
  );
  const textsOf = (field: "purpose" | "scope") =>
    stated.filter((claim) => claim.field === field).map((claim) => claim.value?.text ?? "");
  return {
    purpose: textsOf("purpose"),
    scope: textsOf("scope"),
    claimIds: stated.map((claim) => claim.claimId),
  };
}

export function hasSopTarget(session: SopSession): boolean {
  return sopTargetOf(session).claimIds.length > 0;
}

/** A passage the SOP already says: the same words, or a claim in its field that already covers it. */
export function isAlreadyStated(session: SopSession, passage: PassageDraft | ReferencePassage) {
  return session.claims.some(
    (claim) =>
      isStatedClaim(claim) &&
      claim.field === passage.field &&
      statesTheSameThing(passage.statement, claim.value?.text ?? ""),
  );
}

export const ADD_REFERENCE_ERROR_CODES = [
  "session_approved",
  "no_target",
  "reference_limit_reached",
  "invalid_passage",
  "session_limit_reached",
] as const;
export type AddReferenceErrorCode = (typeof ADD_REFERENCE_ERROR_CODES)[number];

export type AddReferenceDocumentResult =
  | {
      ok: true;
      session: SopSession;
      added: number;
      alreadyThere: number;
      conflictsRaised: number;
    }
  | { ok: false; error: { code: AddReferenceErrorCode; message: string } };

export interface AddReferenceDocumentInput {
  document: { fileName: string; fileKind: DocumentFileKind };
  passages: readonly PassageDraft[];
}

/** The same passage from the same place: a second upload of the same file adds nothing. */
function isSamePassage(existing: ReferencePassage, draft: PassageDraft): boolean {
  return (
    existing.field === draft.field &&
    existing.citation.documentName === draft.citation.documentName &&
    existing.citation.location === draft.citation.location &&
    normalizeStatement(existing.statement) === normalizeStatement(draft.statement)
  );
}

/**
 * Keeps the passages an upload returned, all or nothing, then raises a conflict for any that
 * disagrees with what the person said or with another document. It writes no other claim: a passage
 * is put to the person in the interview, never added to the SOP by the upload.
 */
export function addReferenceDocument(
  session: SopSession,
  input: AddReferenceDocumentInput,
  context: WriteContext,
): AddReferenceDocumentResult {
  const refuse = (code: AddReferenceErrorCode, message: string): AddReferenceDocumentResult => ({
    ok: false,
    error: { code, message },
  });
  if (session.status === "approved") {
    return refuse("session_approved", "The SOP is approved, so it can no longer be changed.");
  }
  const target = sopTargetOf(session);
  if (target.claimIds.length === 0) {
    return refuse("no_target", "Say what this SOP covers before adding a document.");
  }

  const drafts: PassageDraft[] = [];
  for (const draft of input.passages) {
    const parsed = passageDraftSchema.safeParse(draft);
    if (!parsed.success || parsed.data.citation.documentName !== input.document.fileName) {
      return refuse("invalid_passage", "A passage from the document is not in the expected form.");
    }
    drafts.push(parsed.data);
  }

  const { references } = session;
  const targetClaimIds = target.claimIds.slice(0, MAX_TARGET_CLAIMS);
  const unique = drafts.filter(
    (draft, index) => drafts.findIndex((other) => isSameDraft(other, draft)) === index,
  );
  const fresh = unique.filter(
    (draft) => !references.passages.some((existing) => isSamePassage(existing, draft)),
  );
  // Uploading a document again is how a passage read for an earlier target is read for the current
  // one: a stale passage nobody answered yet is opened again under the new target. One the person
  // already used, declined or settled stays as it is.
  const revivedIds = new Set(
    references.passages
      .filter(
        (existing) =>
          (existing.state === "open" || existing.state === "offered") &&
          isPassageStale(session, existing) &&
          unique.some((draft) => isSamePassage(existing, draft)),
      )
      .map((existing) => existing.passageId),
  );
  const alreadyThere = drafts.length - fresh.length - revivedIds.size;
  if (fresh.length === 0 && revivedIds.size === 0) {
    return { ok: true, session, added: 0, alreadyThere, conflictsRaised: 0 };
  }

  const existingDocument = references.documents.find(
    (document) => document.documentName === input.document.fileName,
  );
  if (existingDocument === undefined && references.documents.length >= MAX_REFERENCE_DOCUMENTS) {
    return refuse(
      "reference_limit_reached",
      `A session can hold reference material from at most ${MAX_REFERENCE_DOCUMENTS} documents.`,
    );
  }
  if (references.passages.length + fresh.length > MAX_REFERENCE_PASSAGES) {
    return refuse(
      "reference_limit_reached",
      `A session can hold at most ${MAX_REFERENCE_PASSAGES} passages from documents.`,
    );
  }

  const timestamp = context.now();
  const document = existingDocument ?? {
    documentId: context.newId(),
    documentName: input.document.fileName,
    fileKind: input.document.fileKind,
    addedAt: timestamp,
  };
  const passages: ReferencePassage[] = fresh.map((draft) => ({
    passageId: context.newId(),
    documentId: document.documentId,
    field: draft.field,
    statement: draft.statement,
    effectiveDate: draft.effectiveDate,
    citation: draft.citation,
    // Staleness needs only a few of them: any one gone means the target has moved.
    targetClaimIds,
    state: "open",
    offeredSequence: null,
    timesNotAsked: 0,
    claimIds: [],
  }));
  const withPassages: SopSession = {
    ...session,
    updatedAt: timestamp,
    references: {
      ...references,
      documents:
        existingDocument === undefined ? [...references.documents, document] : references.documents,
      passages: [
        ...references.passages.map((existing) =>
          revivedIds.has(existing.passageId)
            ? {
                ...existing,
                targetClaimIds,
                state: "open" as const,
                offeredSequence: null,
                timesNotAsked: 0,
              }
            : existing,
        ),
        ...passages,
      ],
    },
  };

  // The passages count toward the session's text cap, whether or not they raise a conflict.
  const limitError = checkSessionLimits(session, {
    claims: session.claims,
    procedureOrder: session.procedureOrder,
    claimHistory: session.claimHistory,
    references: withPassages.references,
  });
  if (limitError !== null) return refuse("session_limit_reached", limitError.message);

  const raised = raiseReferenceConflicts(
    withPassages,
    [...revivedIds, ...passages.map((passage) => passage.passageId)],
    context,
  );
  if (!raised.ok) return refuse("session_limit_reached", raised.error.message);
  return {
    ok: true,
    session: raised.session,
    added: passages.length + revivedIds.size,
    alreadyThere,
    conflictsRaised: raised.raised,
  };
}

function isSameDraft(first: PassageDraft, second: PassageDraft): boolean {
  return (
    first.field === second.field &&
    first.citation.location === second.citation.location &&
    normalizeStatement(first.statement) === normalizeStatement(second.statement)
  );
}

/** Passages that may still be put to the person: not yet offered, and judged against the current target. */
export function isPassageOpen(session: SopSession, passage: ReferencePassage): boolean {
  return passage.state === "open" && !isPassageStale(session, passage);
}

/**
 * The reply names a document, as the agent is told to when it puts a passage to the person ("Your
 * uploaded handbook says..."). Word overlap alone counts a general question as asking the passage:
 * "Who approves refunds?" shares most words with "The manager approves refunds" and says nothing of it.
 */
const DOCUMENT_CUE = /\b(document|policy|handbook|manual|guide|memo|upload(?:ed)?|file)s?\b/i;

/**
 * Settles the passages handed to the agent this turn, once its reply is known. A passage the reply
 * put to the person (it names a document and uses the passage's wording) is offered, so their answer can rest on it. One it did not is left open, to be
 * handed over again, behind the passages not yet handed over; after `MAX_TIMES_NOT_ASKED` turns it
 * is no longer handed over. Marking every handed-over passage as offered instead lost one for good
 * when the agent asked a general question in its place: nothing offers an offered passage again.
 */
export function settleShownDocumentPassages(
  session: SopSession,
  shownPassageIds: readonly string[],
  replyText: string,
): { session: SopSession; askedIds: string[]; notAskedIds: string[] } {
  const askedIds: string[] = [];
  const notAskedIds: string[] = [];
  const citesADocument = DOCUMENT_CUE.test(replyText);
  for (const passageId of shownPassageIds) {
    const passage = findPassage(session, passageId);
    if (passage === undefined || passage.state !== "open") continue;
    const wasPut = citesADocument && usesPassageWording(replyText, passage.statement);
    (wasPut ? askedIds : notAskedIds).push(passageId);
  }
  const offered = markDocumentPassagesOffered(session, askedIds);
  if (notAskedIds.length === 0) return { session: offered, askedIds, notAskedIds };
  return {
    session: {
      ...offered,
      references: {
        ...offered.references,
        passages: offered.references.passages.map((passage) =>
          notAskedIds.includes(passage.passageId)
            ? {
                ...passage,
                timesNotAsked: Math.min(passage.timesNotAsked + 1, MAX_TIMES_NOT_ASKED),
              }
            : passage,
        ),
      },
    },
    askedIds,
    notAskedIds,
  };
}

/** Marks the passages handed to the agent this turn as offered, numbering each offer. */
export function markDocumentPassagesOffered(
  session: SopSession,
  passageIds: readonly string[],
): SopSession {
  if (passageIds.length === 0) return session;
  let { offeredTotal } = session.references;
  const passages = session.references.passages.map((passage) => {
    if (!passageIds.includes(passage.passageId) || passage.state !== "open") return passage;
    offeredTotal += 1;
    return { ...passage, state: "offered" as const, offeredSequence: offeredTotal };
  });
  return { ...session, references: { ...session.references, passages, offeredTotal } };
}

/**
 * A passage is turned down: the person said it does not apply to this SOP, or it is not a rule of
 * the process at all (a document that tells the reader what to do). Nothing is recorded: the
 * person's own answer, if they gave one, is recorded as usual. The passage is not put to them again.
 *
 * Unlike an agreement, which needs a passage put to the person on an earlier turn, a decline also
 * takes one handed to the agent this turn and not yet asked about: the agent must be able to drop a
 * passage it should never repeat, the moment it sees it. It writes no SOP content, the upload panel
 * shows it as left out, and the agent can only name a passage the state showed it.
 */
export interface DeclineDocumentPassageCommand {
  kind: "declineDocumentPassage";
  createdByType: "agent";
  passageId: string;
}

export type DeclineDocumentPassageResult =
  | { ok: true; session: SopSession; passage: ReferencePassage }
  | { ok: false; error: ClaimWriteError };

export function declineDocumentPassage(
  session: SopSession,
  command: DeclineDocumentPassageCommand,
  context: WriteContext,
): DeclineDocumentPassageResult {
  const refuse = (code: ClaimWriteErrorCode, message: string): DeclineDocumentPassageResult => ({
    ok: false,
    error: { code, message },
  });
  if (session.status === "approved") {
    return refuse("session_approved", "The SOP is approved, so it can no longer be changed.");
  }
  const passage = findPassage(session, command.passageId);
  if (passage === undefined) {
    return refuse("passage_not_found", "There is no document passage with that id.");
  }
  if (passage.state === "declined") return { ok: true, session, passage };
  const isShownOrOffered = passage.state === "open" || passage.state === "offered";
  if (!isShownOrOffered || isPassageStale(session, passage)) {
    return refuse(
      "passage_not_offered",
      'Only a passage in "documentPassages" or "pendingDocumentPassages" can be declined.',
    );
  }
  const declined: ReferencePassage = { ...passage, state: "declined" };
  return {
    ok: true,
    passage: declined,
    session: {
      ...session,
      updatedAt: context.now(),
      references: updatePassage(session.references, passage.passageId, () => declined),
    },
  };
}
