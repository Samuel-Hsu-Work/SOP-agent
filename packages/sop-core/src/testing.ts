/**
 * Helpers for tests in this package and in the apps. Exposed as `@sop-agent/sop-core/testing` so
 * they are not part of the main entry point.
 */
import { applyClaim } from "./applyClaim.ts";
import type { Claim } from "./claim.ts";
import type { PassageDraft } from "./documentWire.ts";
import type { ReferenceMaterial, ReferencePassage } from "./referenceSchema.ts";
import type { AddReferenceDocumentInput } from "./references.ts";
import { createEmptySession, type SopSession, type UserMessage } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import type { WriteContext } from "./writeContext.ts";

/** A fixed clock and a counting id generator, so every test run produces the same ids. */
export function createDeterministicContext(): WriteContext {
  let counter = 0;
  return {
    now: () => "2026-01-01T00:00:00.000Z",
    newId: () => {
      counter += 1;
      return `id-${counter}`;
    },
  };
}

export function createUserMessage(id: string, text = "A user statement."): UserMessage {
  return { id, role: "user", createdAt: "2026-01-01T00:00:00.000Z", text };
}

/** An empty draft session that already holds one user message, so claims have something to cite. */
export function createSessionWithUserMessage(
  context: WriteContext,
  text?: string,
): { session: SopSession; messageId: string } {
  const empty = createEmptySession(context);
  const messageId = context.newId();
  return {
    session: { ...empty, messages: [createUserMessage(messageId, text)] },
    messageId,
  };
}

/**
 * A draft session in which the person has said what the SOP is about: one purpose and one scope
 * claim, recorded through `applyClaim` from one user message. A document is read against these.
 */
export function createSessionWithTarget(
  context: WriteContext,
  target: { purpose: readonly string[]; scope: readonly string[] },
): SopSession {
  const { session, messageId } = createSessionWithUserMessage(
    context,
    [...target.purpose, ...target.scope].join(" "),
  );
  const statements: [SopFieldName, string][] = [
    ...target.purpose.map((text): [SopFieldName, string] => ["purpose", text]),
    ...target.scope.map((text): [SopFieldName, string] => ["scope", text]),
  ];
  return statements.reduce((current, [field, statement]) => {
    const result = applyClaim(
      current,
      {
        kind: "record",
        createdByType: "agent",
        field,
        status: "observed",
        statement,
        note: null,
        effectiveDate: null,
        sourceMessageId: messageId,
        insertBeforeClaimId: null,
      },
      context,
    );
    if (!result.ok) throw new Error(`could not record the target: ${result.error.code}`);
    return result.session;
  }, session);
}

/** Builds a claim directly, bypassing `applyClaim`, for states that nothing can create yet. */
export function buildClaim(overrides: Partial<Claim> & Pick<Claim, "claimId" | "field">): Claim {
  const status = overrides.status ?? "observed";
  const isUnknown = status === "unknown";
  const valueKind = overrides.field === "procedure" ? "step" : "statement";
  return {
    value: isUnknown ? null : { kind: valueKind, text: "A statement." },
    status,
    source: { type: "employee_statement", reference: { kind: "message", messageId: "message-1" } },
    authority: isUnknown ? "unknown" : "observed_practice",
    effectiveDate: null,
    note: null,
    createdByType: "agent",
    // A conflict names its partner. Tests that need a real pair build it through `applyClaim`.
    conflictsWithClaimId: status === "conflict" ? "unpaired-partner" : null,
    basedOnPassageId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const TEST_CITATION = {
  documentName: "policy.md",
  location: "§ Rules",
  quote: "A verbatim quote from the policy.",
};

/** A reference passage built directly, for states an upload and an interview would take turns to reach. */
export function buildPassage(
  overrides: Partial<ReferencePassage> & Pick<ReferencePassage, "passageId">,
): ReferencePassage {
  return {
    documentId: "document-1",
    field: "authorization",
    statement: "A rule from the policy.",
    effectiveDate: null,
    citation: TEST_CITATION,
    targetClaimIds: ["target-1"],
    state: "open",
    offeredSequence: null,
    timesNotAsked: 0,
    claimIds: [],
    ...overrides,
  };
}

/** Reference material holding these passages, with one listed document for each document id. */
export function referencesWith(passages: ReferencePassage[]): ReferenceMaterial {
  const documents = new Map<string, string>();
  for (const passage of passages) {
    documents.set(passage.documentId, passage.citation.documentName);
  }
  return {
    documents: [...documents].map(([documentId, documentName]) => ({
      documentId,
      documentName,
      fileKind: "markdown",
      addedAt: "2026-01-01T00:00:00.000Z",
    })),
    passages,
    offeredTotal: passages.filter((passage) => passage.offeredSequence !== null).length,
  };
}

/** The document side of a conflict, raised from passage "p1" unless overridden. */
export function buildDocumentSide(
  overrides: Partial<Claim> & Pick<Claim, "claimId" | "field">,
): Claim {
  return buildClaim({
    status: "conflict",
    source: { type: "policy_document", reference: { kind: "document", citation: TEST_CITATION } },
    authority: "official_policy",
    createdByType: "extraction",
    basedOnPassageId: "p1",
    ...overrides,
  });
}

/**
 * A document upload's response, as the API would send it: the file and passages drafted from it.
 * Each passage's quote defaults to its statement, which is what a verbatim passage looks like.
 */
export function buildReferenceUpload(
  fileName: string,
  passages: readonly {
    field: SopFieldName;
    statement: string;
    quote?: string;
    location?: string;
    effectiveDate?: string | null;
  }[],
): AddReferenceDocumentInput {
  return {
    document: { fileName, fileKind: "markdown" },
    passages: passages.map(
      (passage): PassageDraft => ({
        field: passage.field,
        statement: passage.statement,
        effectiveDate: passage.effectiveDate ?? null,
        citation: {
          documentName: fileName,
          location: passage.location ?? "§ Rules",
          quote: passage.quote ?? passage.statement,
        },
      }),
    ),
  };
}
