import { z } from "zod";
import { MAX_IDENTIFIER_LENGTH, MAX_NOTE_LENGTH, MAX_STATEMENT_LENGTH } from "./limits.ts";
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
 * The only statuses the agent may write. The model-facing tool schema and the permission matrix
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

/** Slice 1 knows conversational sources only. Document sources join in slice 5. */
export const SOURCE_TYPES = ["employee_statement", "agent_suggestion"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const CLAIM_WRITE_ERROR_CODES = [
  "session_approved",
  "status_not_allowed_for_creator",
  "value_required",
  "value_not_allowed",
  "invalid_value",
  "source_message_not_found",
  "replace_target_not_found",
  "replace_field_mismatch",
  "replace_target_not_unknown",
  "session_limit_reached",
] as const;

export type ClaimWriteErrorCode = (typeof CLAIM_WRITE_ERROR_CODES)[number];

export const identifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);
export const timestampSchema = z.iso.datetime();
export const calendarDateSchema = z.iso.date();

/**
 * Discriminated from the start so later slices can add value shapes (for example a procedure step)
 * without rewriting stored sessions.
 */
export const claimValueSchema = z.object({
  kind: z.literal("statement"),
  text: z.string().min(1).max(MAX_STATEMENT_LENGTH),
});

export type ClaimValue = z.infer<typeof claimValueSchema>;

const claimSourceSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  reference: z.object({
    kind: z.literal("message"),
    messageId: identifierSchema,
  }),
});

/**
 * Every persisted field uses null, never an optional property: JSON.stringify silently drops
 * `undefined`, which would break the requirement that a session survives a JSON round trip.
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
    createdAt: timestampSchema,
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
