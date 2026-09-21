import { z } from "zod";
import {
  MAX_DOCUMENT_LOCATION_LENGTH,
  MAX_DOCUMENT_NAME_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_QUOTE_LENGTH,
  MAX_STATEMENT_LENGTH,
  MIN_QUOTE_LENGTH,
} from "./limits.ts";
import { SOP_FIELD_NAMES } from "./sopFields.ts";

export const CLAIM_STATUSES = [
  "confirmed",
  "observed",
  "proposed",
  "unknown",
  "conflict",
  "extracted",
] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * The only statuses the agent may write. The model-facing tool schemas and the permission matrix
 * both derive from this constant, so they cannot drift apart.
 */
export const AGENT_WRITABLE_STATUSES = [
  "observed",
  "proposed",
  "unknown",
] as const satisfies readonly ClaimStatus[];

export type AgentWritableStatus = (typeof AGENT_WRITABLE_STATUSES)[number];

/** A claim in one of these statuses leaves its field unresolved, which creates a gap. */
export const UNRESOLVED_STATUSES = [
  "unknown",
  "conflict",
  "extracted",
] as const satisfies readonly ClaimStatus[];

export const CREATOR_TYPES = ["agent", "user", "extraction"] as const;
export type CreatorType = (typeof CREATOR_TYPES)[number];

/** Where a claim's authority comes from. `unknown` is for a claim that has no source authority. */
export const AUTHORITY_TIERS = [
  "official_policy",
  "management_directive",
  "observed_practice",
  "proposed",
  "unknown",
] as const;

export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];

/** Where a claim came from. `policy_document` is a claim read from an uploaded document. */
export const SOURCE_TYPES = ["employee_statement", "agent_suggestion", "policy_document"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const CLAIM_WRITE_ERROR_CODES = [
  "session_approved",
  "status_not_allowed_for_creator",
  "wrong_command_for_status",
  "value_required",
  "invalid_value",
  "note_required",
  "source_message_not_found",
  "target_claim_not_found",
  "status_transition_not_allowed",
  "anchor_not_found",
  "anchor_not_applicable",
  "session_limit_reached",
  "already_recorded",
  "review_action_not_allowed",
  "confirmation_required",
] as const;

export type ClaimWriteErrorCode = (typeof CLAIM_WRITE_ERROR_CODES)[number];

export const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
export const timestampSchema = z.iso.datetime();
export const calendarDateSchema = z.iso.date();

const valueText = z.string().min(1).max(MAX_STATEMENT_LENGTH);

/**
 * A claim's value. Every field holds a plain statement except `procedure`, where each claim is one
 * step. The kind is fixed by the field (see the rule in `claimSchema`). Steps have no position of
 * their own: their order lives in the session's `procedureOrder`.
 */
export const claimValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("statement"), text: valueText }),
  z.object({ kind: z.literal("step"), text: valueText }),
]);

export type ClaimValue = z.infer<typeof claimValueSchema>;

/**
 * A citation into an uploaded document. The file itself is never kept, so the citation is the whole
 * of the evidence: the API proved the quote exists in the cited section before a claim was written.
 */
export const documentCitationSchema = z.object({
  /** The uploaded file's name, sanitized. Shown to a person and never sent to a model. */
  documentName: z.string().min(1).max(MAX_DOCUMENT_NAME_LENGTH),
  /** The section that holds the quote, such as "p.4" or "§ Approval authority". Set by code. */
  location: z.string().min(1).max(MAX_DOCUMENT_LOCATION_LENGTH),
  /** Verbatim text from that section. */
  quote: z.string().min(MIN_QUOTE_LENGTH).max(MAX_QUOTE_LENGTH),
});

export type DocumentCitation = z.infer<typeof documentCitationSchema>;

const claimSourceSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  reference: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("message"), messageId: identifierSchema }),
    z.object({ kind: z.literal("document"), citation: documentCitationSchema }),
  ]),
});

export type ClaimSource = z.infer<typeof claimSourceSchema>;

/**
 * Every persisted field uses null, never an optional property: JSON.stringify silently drops
 * `undefined`, which would break the requirement that a session survives a JSON round trip.
 *
 * A corrected claim keeps its `claimId` and `createdAt`; `updatedAt` moves. Its earlier versions
 * live in the session's history.
 */
export const claimSchema = z
  .object({
    claimId: identifierSchema,
    field: z.enum(SOP_FIELD_NAMES),
    /** Null if and only if the status is `unknown`. What is unknown goes in `note`. */
    value: claimValueSchema.nullable(),
    status: z.enum(CLAIM_STATUSES),
    source: claimSourceSchema,
    authority: z.enum(AUTHORITY_TIERS),
    effectiveDate: calendarDateSchema.nullable(),
    note: z.string().max(MAX_NOTE_LENGTH).nullable(),
    createdByType: z.enum(CREATOR_TYPES),
    /**
     * The other half of a conflict pair. Set if and only if the status is `conflict`. A conflicting
     * claim keeps its own value, source and authority, so both sides can be shown as they were.
     */
    conflictsWithClaimId: identifierSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((claim, context) => {
    const addIssue = (message: string, path: string[]) =>
      context.addIssue({ code: "custom", message, path });

    if (claim.status === "unknown") {
      if (claim.value !== null) addIssue("An unknown claim must have no value.", ["value"]);
      if (claim.authority !== "unknown") {
        addIssue("An unknown claim must have unknown authority.", ["authority"]);
      }
    } else {
      if (claim.value === null) addIssue("Only an unknown claim may have no value.", ["value"]);
      if (claim.authority === "unknown") {
        addIssue("Only an unknown claim may have unknown authority.", ["authority"]);
      }
    }

    if (claim.value !== null) {
      const isStep = claim.value.kind === "step";
      if (isStep !== (claim.field === "procedure")) {
        addIssue("Only a procedure claim holds a step, and every procedure claim does.", ["value"]);
      }
    }

    if (claim.status === "confirmed" && claim.authority === "proposed") {
      // A person vouching for a suggestion raises its authority, so a confirmed claim never keeps
      // the authority of an unreviewed suggestion.
      addIssue("A confirmed claim cannot carry the authority of an unreviewed suggestion.", [
        "authority",
      ]);
    }

    const isDocumentSource = claim.source.type === "policy_document";
    if (isDocumentSource !== (claim.source.reference.kind === "document")) {
      addIssue("A document source cites a document, and every other source cites a message.", [
        "source",
      ]);
    }

    if (claim.status === "extracted") {
      if (
        !isDocumentSource ||
        claim.authority !== "official_policy" ||
        claim.createdByType !== "extraction"
      ) {
        addIssue(
          "An extracted claim comes from a document, by extraction, with policy authority.",
          ["status"],
        );
      }
    }

    if ((claim.status === "conflict") !== (claim.conflictsWithClaimId !== null)) {
      addIssue("A claim points at its conflict partner if and only if it is in conflict.", [
        "conflictsWithClaimId",
      ]);
    }

    if (claim.status === "observed") {
      if (claim.source.type !== "employee_statement" || claim.authority !== "observed_practice") {
        addIssue("An observed claim comes from an employee statement.", ["status"]);
      }
    }
    if (claim.status === "proposed") {
      if (claim.source.type !== "agent_suggestion" || claim.authority !== "proposed") {
        addIssue("A proposed claim comes from an agent suggestion.", ["status"]);
      }
    }
  });

export type Claim = z.infer<typeof claimSchema>;

function citationTextLength(claim: Claim): number {
  const { reference } = claim.source;
  return reference.kind === "document"
    ? reference.citation.quote.length +
        reference.citation.location.length +
        reference.citation.documentName.length
    : 0;
}

/** The text that active claims, their notes and their citations hold together, for the session-wide cap. */
export function totalClaimTextLength(claims: readonly Claim[]): number {
  return claims.reduce(
    (total, claim) =>
      total +
      (claim.value?.text.length ?? 0) +
      (claim.note?.length ?? 0) +
      citationTextLength(claim),
    0,
  );
}
