import {
  AGENT_WRITABLE_STATUSES,
  applyClaim,
  CLAIM_STATUSES,
  computeGaps,
  RECORD_CLAIM_TOOL_NAME,
  type RecordedToolCall,
  SOP_FIELD_NAMES,
  type SopSession,
  type ToolOutcomeErrorCode,
  type WriteContext,
} from "@sop-agent/sop-core";
import { z } from "zod";
import type { ModelToolCall, ModelToolSpec } from "../model/modelClient.ts";

/**
 * What the model sees. Every property is required and the optional ones are nullable, because
 * strict function calling forbids optional properties. The status list comes from the same
 * constant as the permission matrix, so the tool cannot offer a status the agent may not write.
 * Provenance (source, authority, creator) is not here: code derives it.
 */
const recordClaimToolSchema = z.object({
  field: z.enum(SOP_FIELD_NAMES).describe("Which SOP field the fact belongs to."),
  status: z
    .enum(AGENT_WRITABLE_STATUSES)
    .describe(
      "observed: the user says this is how things are actually done. proposed: your own suggestion, only when the user asked for one. unknown: the user says they do not know.",
    ),
  statement: z
    .string()
    .nullable()
    .describe("One plain sentence stating a single fact. Must be null when status is unknown."),
  effectiveDate: z
    .string()
    .nullable()
    .describe("The date the fact takes effect, as YYYY-MM-DD, or null."),
  note: z
    .string()
    .nullable()
    .describe("For unknown, what exactly is not known. Otherwise a short remark, or null."),
  replacesClaimId: z
    .string()
    .nullable()
    .describe(
      "The id of an existing claim with status unknown in the same field that this claim answers, or null.",
    ),
});

/**
 * What the handler accepts. Status is deliberately wider than the model's schema: if a model ever
 * asks for `confirmed`, the request must reach `applyClaim` and be refused by the permission
 * matrix there, rather than being dropped as malformed.
 */
const recordClaimArgumentsSchema = recordClaimToolSchema.extend({
  status: z.enum(CLAIM_STATUSES),
});

export const RECORD_CLAIM_TOOL: ModelToolSpec = {
  name: RECORD_CLAIM_TOOL_NAME,
  description:
    "Record one fact the user stated about the SOP. Call it once per fact, before relying on the fact.",
  parameters: recordClaimToolSchema,
};

export const AGENT_TOOLS: readonly ModelToolSpec[] = [RECORD_CLAIM_TOOL];

export interface ToolCallOutcome {
  session: SopSession;
  record: RecordedToolCall;
  /** A compact JSON string returned to the model as the tool result. */
  modelResult: string;
  applied: boolean;
  rejectionCode: ToolOutcomeErrorCode | null;
}

function rejected(
  session: SopSession,
  call: ModelToolCall,
  field: RecordedToolCall["field"],
  requestedStatus: RecordedToolCall["requestedStatus"],
  code: ToolOutcomeErrorCode,
  message: string,
): ToolCallOutcome {
  return {
    session,
    applied: false,
    rejectionCode: code,
    record: {
      callId: call.callId.slice(0, 200) || "unknown",
      toolName: call.name.slice(0, 100) || "unknown",
      field,
      requestedStatus,
      outcome: { ok: false, code },
    },
    modelResult: JSON.stringify({ ok: false, error: code, message }),
  };
}

export interface ExecuteToolCallInput {
  session: SopSession;
  call: ModelToolCall;
  /** The user message of this turn, which every claim from the turn cites. */
  sourceMessageId: string;
  context: WriteContext;
}

/**
 * Runs one tool call against the working session. A failure is returned to the model as a compact
 * tool result so it can recover, instead of aborting the turn.
 */
export function executeToolCall(input: ExecuteToolCallInput): ToolCallOutcome {
  const { session, call, sourceMessageId, context } = input;

  if (call.name !== RECORD_CLAIM_TOOL_NAME) {
    return rejected(session, call, null, null, "unknown_tool", "There is no such tool.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(call.argumentsJson);
  } catch {
    return rejected(session, call, null, null, "invalid_arguments", "The arguments are not JSON.");
  }
  const parsed = recordClaimArgumentsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return rejected(session, call, null, null, "invalid_arguments", "The arguments are not valid.");
  }
  const args = parsed.data;

  const result = applyClaim(
    session,
    {
      kind: "record",
      createdByType: "agent",
      field: args.field,
      status: args.status,
      statement: args.statement,
      note: args.note,
      effectiveDate: args.effectiveDate,
      sourceMessageId,
      replacesClaimId: args.replacesClaimId,
    },
    context,
  );

  if (!result.ok) {
    return rejected(
      session,
      call,
      args.field,
      args.status,
      result.error.code,
      result.error.message,
    );
  }

  const report = computeGaps(result.session);
  const nextBlockingFields = report.gaps
    .filter((entry) => entry.gap?.severity === "blocking")
    .slice(0, 3)
    .map((entry) => entry.field);

  return {
    session: result.session,
    applied: true,
    rejectionCode: null,
    record: {
      callId: call.callId.slice(0, 200) || "unknown",
      toolName: call.name,
      field: args.field,
      requestedStatus: args.status,
      outcome: { ok: true, claimId: result.claim.claimId },
    },
    modelResult: JSON.stringify({
      ok: true,
      claimId: result.claim.claimId,
      field: args.field,
      status: args.status,
      blockingGapsRemaining: report.blockingGapCount,
      advisoryGapsRemaining: report.advisoryGapCount,
      nextBlockingFields,
    }),
  };
}
