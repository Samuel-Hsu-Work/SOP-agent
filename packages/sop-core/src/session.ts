import { z } from "zod";
import {
  CLAIM_STATUSES,
  CLAIM_WRITE_ERROR_CODES,
  CREATOR_TYPES,
  claimSchema,
  identifierSchema,
  timestampSchema,
  totalClaimTextLength,
} from "./claim.ts";
import { consistencyReviewSchema } from "./consistencyReviewSchema.ts";
import {
  MAX_ASSISTANT_MESSAGE_LENGTH,
  MAX_CLAIMS,
  MAX_HISTORY_ENTRIES,
  MAX_MESSAGES,
  MAX_NOTE_LENGTH,
  MAX_TOOL_CALLS_PER_MESSAGE,
  MAX_TOTAL_CLAIM_TEXT,
  MAX_USER_MESSAGE_LENGTH,
} from "./limits.ts";
import { ADVISORY_FIELD_NAMES, SOP_FIELD_NAMES } from "./sopFields.ts";
import type { WriteContext } from "./writeContext.ts";

export const RECORD_CLAIM_TOOL_NAME = "record_claim";
export const CORRECT_CLAIM_TOOL_NAME = "correct_claim";
export const MARK_CLAIM_UNKNOWN_TOOL_NAME = "mark_claim_unknown";
export const WITHDRAW_CLAIM_TOOL_NAME = "withdraw_claim";
export const RESOLVE_CONFLICT_TOOL_NAME = "resolve_conflict";

export const AGENT_TOOL_NAMES = [
  RECORD_CLAIM_TOOL_NAME,
  CORRECT_CLAIM_TOOL_NAME,
  MARK_CLAIM_UNKNOWN_TOOL_NAME,
  WITHDRAW_CLAIM_TOOL_NAME,
  RESOLVE_CONFLICT_TOOL_NAME,
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** What a claim write did. `unchanged` means the exact same claim was already there. */
export const CLAIM_CHANGES = ["created", "updated", "unchanged", "withdrawn"] as const;
export type ClaimChange = (typeof CLAIM_CHANGES)[number];

/** Outcome codes a tool call can report: any claim-write error, or a problem before the write. */
export const TOOL_OUTCOME_ERROR_CODES = [
  ...CLAIM_WRITE_ERROR_CODES,
  "invalid_arguments",
  "unknown_tool",
  "withdraw_limit_reached",
  "conflict_resolution_limit_reached",
] as const;

export type ToolOutcomeErrorCode = (typeof TOOL_OUTCOME_ERROR_CODES)[number];

/** Provenance of one tool call in a turn. It records what happened, not a copy of the content. */
export const recordedToolCallSchema = z.object({
  callId: z.string().min(1).max(200),
  /** A name the model asked for. It can be one we do not offer, so it is not restricted here. */
  toolName: z.string().min(1).max(100),
  /** Null when the arguments did not parse. */
  field: z.enum(SOP_FIELD_NAMES).nullable(),
  requestedStatus: z.enum(CLAIM_STATUSES).nullable(),
  outcome: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      claimId: identifierSchema,
      change: z.enum(CLAIM_CHANGES),
    }),
    z.object({ ok: z.literal(false), code: z.enum(TOOL_OUTCOME_ERROR_CODES) }),
  ]),
});

export type RecordedToolCall = z.infer<typeof recordedToolCallSchema>;

const userMessageSchema = z.object({
  id: identifierSchema,
  role: z.literal("user"),
  createdAt: timestampSchema,
  text: z.string().min(1).max(MAX_USER_MESSAGE_LENGTH),
});

const assistantMessageSchema = z.object({
  id: identifierSchema,
  role: z.literal("assistant"),
  createdAt: timestampSchema,
  /** Empty when the model only called tools. */
  text: z.string().max(MAX_ASSISTANT_MESSAGE_LENGTH),
  /** The model that served this reply, for debugging. Not content. */
  model: z.string().min(1).max(100),
  toolCalls: z.array(recordedToolCallSchema).max(MAX_TOOL_CALLS_PER_MESSAGE),
});

export const chatMessageSchema = z.discriminatedUnion("role", [
  userMessageSchema,
  assistantMessageSchema,
]);

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type UserMessage = z.infer<typeof userMessageSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const HISTORY_REASONS = [
  "corrected",
  "answered_unknown",
  "marked_unknown",
  "withdrawn",
  "confirmed",
  "rejected",
  "conflict_detected",
  "conflict_resolved",
] as const;

export type HistoryReason = (typeof HISTORY_REASONS)[number];

/** The two reasons a person's review action writes. The agent's four commands write the rest. */
export const REVIEW_HISTORY_REASONS = [
  "confirmed",
  "rejected",
] as const satisfies readonly (typeof HISTORY_REASONS)[number][];

/**
 * Append-only. Every change to an existing claim writes one entry holding the whole previous claim,
 * so a change is never silent.
 *
 * An agent's change cites the user message that caused it. A person's review action (a button
 * click) has no message, so its entry is attributed to the user and cites none: inventing a
 * message would put words in the transcript, and citing the last one would blame a sentence that
 * did not cause it. Finding a conflict is the system's own act, with no message either.
 */
export const claimHistoryEntrySchema = z
  .object({
    entryId: identifierSchema,
    claimId: identifierSchema,
    changedAt: timestampSchema,
    changedBy: z.enum([...CREATOR_TYPES, "system"] as const),
    sourceMessageId: identifierSchema.nullable(),
    reason: z.enum(HISTORY_REASONS),
    /** Why the change happened, when the claim itself has no place for it: the reason for a withdrawal. */
    changeNote: z.string().max(MAX_NOTE_LENGTH).nullable(),
    previousClaim: claimSchema,
  })
  .superRefine((entry, context) => {
    const isReview = (REVIEW_HISTORY_REASONS as readonly string[]).includes(entry.reason);
    const isDetection = entry.reason === "conflict_detected";
    const addIssue = (message: string, path: string[]) =>
      context.addIssue({ code: "custom", message, path });

    if (isReview && (entry.changedBy !== "user" || entry.sourceMessageId !== null)) {
      addIssue("A review action is made by the user and cites no message.", ["reason"]);
    }
    if (isDetection && (entry.changedBy !== "system" || entry.sourceMessageId !== null)) {
      addIssue("Finding a conflict is made by the system and cites no message.", ["reason"]);
    }
    if (!isReview && !isDetection && (entry.changedBy === "user" || entry.changedBy === "system")) {
      addIssue("Only a review action or a found conflict has no agent behind it.", ["changedBy"]);
    }
    if (!isReview && !isDetection && entry.sourceMessageId === null) {
      addIssue("A change other than a review action must cite a message.", ["sourceMessageId"]);
    }
  });

export type ClaimHistoryEntry = z.infer<typeof claimHistoryEntrySchema>;

export const SESSION_STATUSES = ["draft", "approved"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Version 2 added claim `updatedAt`, step values, `procedureOrder`, and the richer history.
 * Version 3 added the approval time, the advisory-gap acknowledgements, and review history entries.
 * Version 4 added the download time of the approved SOP's PDF.
 * Version 5 added document sources with a citation, and the link between two conflicting claims.
 * Version 6 added the consistency review: questions about what the claims do not say together.
 */
export const SESSION_SCHEMA_VERSION = 6;

/** A person's statement that they saw an advisory gap and accept it. It carries no free text. */
export const advisoryAcknowledgementSchema = z.object({
  field: z.enum(ADVISORY_FIELD_NAMES),
  acknowledgedAt: timestampSchema,
});

export type AdvisoryAcknowledgement = z.infer<typeof advisoryAcknowledgementSchema>;

function findDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

/**
 * The whole session: one JSON document held in the browser's sessionStorage. The API treats it as
 * untrusted input and parses it with this schema on every request. Unknown keys are stripped, never
 * passed through, so a tampered session cannot smuggle extra data into what the browser stores.
 */
export const sopSessionSchema = z
  .object({
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    sessionId: identifierSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    status: z.enum(SESSION_STATUSES),
    messages: z.array(chatMessageSchema).max(MAX_MESSAGES),
    claims: z.array(claimSchema).max(MAX_CLAIMS),
    /** Claim ids of the active `procedure` claims, in the order the steps happen. */
    procedureOrder: z.array(identifierSchema).max(MAX_CLAIMS),
    claimHistory: z.array(claimHistoryEntrySchema).max(MAX_HISTORY_ENTRIES),
    /** Null while a draft, and set with the status when the SOP is approved. */
    approvedAt: timestampSchema.nullable(),
    /**
     * When the browser first received the approved SOP's PDF and started the download. Null until
     * then, and always null on a draft. It records the export, not the SOP, and (like the rest of
     * the session) dies with the tab.
     */
    downloadedAt: timestampSchema.nullable(),
    /** At most one per advisory field. Cleared by any change to a claim. */
    advisoryAcknowledgements: z
      .array(advisoryAcknowledgementSchema)
      .max(ADVISORY_FIELD_NAMES.length),
    /**
     * The latest consistency review, or null before the first one. It holds questions for the agent
     * to ask, never claims, and nothing in it gates an approval or reaches the PDF.
     */
    consistencyReview: consistencyReviewSchema.nullable(),
  })
  .superRefine((session, context) => {
    const addIssue = (message: string, path: (string | number)[]) =>
      context.addIssue({ code: "custom", message, path });

    if (findDuplicate(session.messages.map((message) => message.id)) !== undefined) {
      addIssue("Message ids must be unique.", ["messages"]);
    }
    if (findDuplicate(session.claims.map((claim) => claim.claimId)) !== undefined) {
      addIssue("Claim ids must be unique.", ["claims"]);
    }
    if (findDuplicate(session.claimHistory.map((entry) => entry.entryId)) !== undefined) {
      addIssue("History entry ids must be unique.", ["claimHistory"]);
    }

    const userMessageIds = new Set(
      session.messages.filter((message) => message.role === "user").map((message) => message.id),
    );
    session.claims.forEach((claim, index) => {
      const { reference } = claim.source;
      // A document claim cites its document, not a message, so only a message reference is checked.
      if (reference.kind === "message" && !userMessageIds.has(reference.messageId)) {
        addIssue("A claim must cite an existing user message.", [
          "claims",
          index,
          "source",
          "reference",
          "messageId",
        ]);
      }
    });
    session.claimHistory.forEach((entry, index) => {
      if (entry.sourceMessageId !== null && !userMessageIds.has(entry.sourceMessageId)) {
        addIssue("A history entry must cite an existing user message.", [
          "claimHistory",
          index,
          "sourceMessageId",
        ]);
      }
    });

    // A conflict is a pair: each claim names the other, they are in one field, and both are in conflict.
    const claimsById = new Map(session.claims.map((claim) => [claim.claimId, claim]));
    session.claims.forEach((claim, index) => {
      if (claim.conflictsWithClaimId === null) return;
      const partner = claimsById.get(claim.conflictsWithClaimId);
      if (
        partner === undefined ||
        partner.claimId === claim.claimId ||
        partner.field !== claim.field ||
        partner.conflictsWithClaimId !== claim.claimId
      ) {
        addIssue("A conflict must be a pair of claims in one field that name each other.", [
          "claims",
          index,
          "conflictsWithClaimId",
        ]);
      }
    });

    // Procedure order: unique ids, each an active procedure claim, and every step listed.
    if (findDuplicate(session.procedureOrder) !== undefined) {
      addIssue("Procedure order must not repeat a claim.", ["procedureOrder"]);
    }
    session.procedureOrder.forEach((claimId, index) => {
      if (claimsById.get(claimId)?.field !== "procedure") {
        addIssue("Procedure order may only list active procedure claims.", [
          "procedureOrder",
          index,
        ]);
      }
    });
    const listed = new Set(session.procedureOrder);
    session.claims.forEach((claim, index) => {
      if (claim.value?.kind === "step" && !listed.has(claim.claimId)) {
        addIssue("Every procedure step must appear in the procedure order.", ["claims", index]);
      }
    });

    if ((session.approvedAt !== null) !== (session.status === "approved")) {
      addIssue("An approved session has an approval time, and a draft has none.", ["approvedAt"]);
    }
    if (session.downloadedAt !== null && session.status !== "approved") {
      addIssue("Only an approved session can have been downloaded.", ["downloadedAt"]);
    }
    if (findDuplicate(session.advisoryAcknowledgements.map((entry) => entry.field)) !== undefined) {
      addIssue("An advisory field can be acknowledged once.", ["advisoryAcknowledgements"]);
    }

    if (totalClaimTextLength(session.claims) > MAX_TOTAL_CLAIM_TEXT) {
      addIssue("The claims hold more text than a session may.", ["claims"]);
    }
  });

export type SopSession = z.infer<typeof sopSessionSchema>;

/** A new session is always a draft with nothing recorded. */
export function createEmptySession(context: WriteContext): SopSession {
  const timestamp = context.now();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: context.newId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "draft",
    messages: [],
    claims: [],
    procedureOrder: [],
    claimHistory: [],
    approvedAt: null,
    downloadedAt: null,
    advisoryAcknowledgements: [],
    consistencyReview: null,
  };
}
