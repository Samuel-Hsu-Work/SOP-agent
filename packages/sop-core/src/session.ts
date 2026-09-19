import { z } from "zod";
import {
  CLAIM_STATUSES,
  CLAIM_WRITE_ERROR_CODES,
  CREATOR_TYPES,
  claimSchema,
  identifierSchema,
  timestampSchema,
} from "./claim.ts";
import {
  MAX_ASSISTANT_MESSAGE_LENGTH,
  MAX_CLAIMS,
  MAX_HISTORY_ENTRIES,
  MAX_MESSAGES,
  MAX_TOOL_CALLS_PER_MESSAGE,
  MAX_USER_MESSAGE_LENGTH,
} from "./limits.ts";
import { SOP_FIELD_NAMES } from "./sopFields.ts";
import type { WriteContext } from "./writeContext.ts";

export const RECORD_CLAIM_TOOL_NAME = "record_claim";

/** Outcome codes a tool call can report: any claim-write error, or a problem before the write. */
export const TOOL_OUTCOME_ERROR_CODES = [
  ...CLAIM_WRITE_ERROR_CODES,
  "invalid_arguments",
  "unknown_tool",
] as const;

export type ToolOutcomeErrorCode = (typeof TOOL_OUTCOME_ERROR_CODES)[number];

/** Provenance of one tool call in a turn. It records what happened, not a copy of the content. */
export const recordedToolCallSchema = z.object({
  callId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(100),
  /** Null when the arguments did not parse. */
  field: z.enum(SOP_FIELD_NAMES).nullable(),
  requestedStatus: z.enum(CLAIM_STATUSES).nullable(),
  outcome: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), claimId: identifierSchema }),
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

/** Append-only. Slice 1 writes one entry when an unknown claim is replaced. */
export const claimHistoryEntrySchema = z.object({
  entryId: identifierSchema,
  claimId: identifierSchema,
  changedAt: timestampSchema,
  changedBy: z.enum([...CREATOR_TYPES, "system"] as const),
  reason: z.enum(["replaced"]),
  previousClaim: claimSchema,
});

export type ClaimHistoryEntry = z.infer<typeof claimHistoryEntrySchema>;

export const SESSION_STATUSES = ["draft", "approved"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_SCHEMA_VERSION = 1;

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
    claimHistory: z.array(claimHistoryEntrySchema).max(MAX_HISTORY_ENTRIES),
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
      if (!userMessageIds.has(claim.source.reference.messageId)) {
        addIssue("A claim must cite an existing user message.", [
          "claims",
          index,
          "source",
          "reference",
          "messageId",
        ]);
      }
    });
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
    claimHistory: [],
  };
}
