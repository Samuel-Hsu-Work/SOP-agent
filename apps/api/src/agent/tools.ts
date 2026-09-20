import {
  AGENT_TOOL_NAMES,
  type AgentClaimCommand,
  type AgentToolName,
  type AgentWritableStatus,
  type ApplyClaimResult,
  applyClaim,
  buildInterviewAgenda,
  CLAIM_STATUSES,
  type ClaimChange,
  CORRECT_CLAIM_TOOL_NAME,
  MARK_CLAIM_UNKNOWN_TOOL_NAME,
  RECORD_CLAIM_TOOL_NAME,
  type RecordedToolCall,
  SOP_FIELD_NAMES,
  type SopSession,
  type ToolOutcomeErrorCode,
  WITHDRAW_CLAIM_TOOL_NAME,
  type WriteContext,
} from "@sop-agent/sop-core";
import { z } from "zod";
import type { ModelToolCall, ModelToolSpec } from "../model/modelClient.ts";

/** How many claims one turn may remove. A wrongly withdrawn claim stays visible in the history. */
export const MAX_WITHDRAWALS_PER_TURN = 3;

/*
 * What the model sees. Every property is required and the optional ones are nullable, because
 * strict function calling forbids optional properties. Status lists come from the same constant as
 * the permission matrix, so a tool cannot offer a status the agent may not write. Provenance
 * (source, authority, creator) is not here: code derives it.
 */
/** The statuses `record_claim` offers. An unknown goes through `mark_claim_unknown`. */
const RECORDABLE_STATUSES = [
  "observed",
  "proposed",
] as const satisfies readonly AgentWritableStatus[];

const fieldSchema = z.enum(SOP_FIELD_NAMES).describe("Which SOP field the fact belongs to.");
const effectiveDateSchema = z
  .string()
  .nullable()
  .describe("The date the fact takes effect, as YYYY-MM-DD, or null.");

const recordClaimToolSchema = z.object({
  field: fieldSchema,
  status: z
    .enum(RECORDABLE_STATUSES)
    .describe(
      "observed: the user says this is how things are actually done. proposed: your own suggestion, only when the user asked for one.",
    ),
  statement: z
    .string()
    .describe(
      "One plain sentence stating a single fact. For the procedure field, one step, written as an action.",
    ),
  effectiveDate: effectiveDateSchema,
  note: z
    .string()
    .nullable()
    .describe("A short remark, such as where the user says the rule is written down, or null."),
  insertBeforeClaimId: z
    .string()
    .nullable()
    .describe(
      "Procedure only: the id of the step this new step comes before, or null to add it at the end.",
    ),
});

const correctClaimToolSchema = z.object({
  claimId: z.string().describe("The id of the existing claim the user is correcting or answering."),
  statement: z.string().describe("The full corrected statement, replacing the old one."),
  effectiveDate: z
    .string()
    .nullable()
    .describe(
      "The claim's effective date as YYYY-MM-DD. Repeat the current one from the state unless the user changed it. Null clears it.",
    ),
  note: z
    .string()
    .nullable()
    .describe("A short remark. Repeat the current note unless the user changed it, or null."),
});

const markClaimUnknownToolSchema = z.object({
  field: fieldSchema,
  claimId: z
    .string()
    .nullable()
    .describe(
      "The id of an existing claim the user now says they do not know, or null when nothing is recorded for that yet.",
    ),
  note: z.string().describe("What exactly is not known."),
});

const withdrawClaimToolSchema = z.object({
  claimId: z.string().describe("The id of the claim that should not be there."),
  note: z.string().describe("Why the user says it should be removed."),
});

/*
 * What the handlers accept. Status is deliberately wider than the model's schema: if a model ever
 * asks for `confirmed` or `unknown`, the request must reach `applyClaim` and be refused there with
 * a message it can read, rather than being dropped as malformed.
 */
const recordClaimArgumentsSchema = recordClaimToolSchema.extend({ status: z.enum(CLAIM_STATUSES) });

export const AGENT_TOOLS: readonly ModelToolSpec[] = [
  {
    name: RECORD_CLAIM_TOOL_NAME,
    description:
      "Record one new fact the user stated about the SOP. Call it once per fact. Do not use it to change or answer a claim that is already recorded.",
    parameters: recordClaimToolSchema,
  },
  {
    name: CORRECT_CLAIM_TOOL_NAME,
    description:
      "Change a recorded claim because the user corrected it, restated it, or answered a question that was recorded as unknown. The claim keeps its id and the old version is kept in the history.",
    parameters: correctClaimToolSchema,
  },
  {
    name: MARK_CLAIM_UNKNOWN_TOOL_NAME,
    description:
      "Record that the user does not know something, either for a claim that is already recorded or for a field with nothing recorded. Not available for a confirmed claim.",
    parameters: markClaimUnknownToolSchema,
  },
  {
    name: WITHDRAW_CLAIM_TOOL_NAME,
    description: `Remove a claim the user says should not be there at all. Prefer correct_claim when the user gives a replacement. Not available for a confirmed claim. At most ${MAX_WITHDRAWALS_PER_TURN} per turn.`,
    parameters: withdrawClaimToolSchema,
  },
];

export interface ToolCallOutcome {
  session: SopSession;
  record: RecordedToolCall;
  /** A compact JSON string returned to the model as the tool result. */
  modelResult: string;
  applied: boolean;
  /** What the write did, when it was applied. */
  change: ClaimChange | null;
  toolName: AgentToolName | null;
  rejectionCode: ToolOutcomeErrorCode | null;
}

function recordedCallBase(call: ModelToolCall) {
  return {
    callId: call.callId.slice(0, 200) || "unknown",
    toolName: call.name.slice(0, 100) || "unknown",
  };
}

function rejected(
  session: SopSession,
  call: ModelToolCall,
  toolName: AgentToolName | null,
  field: RecordedToolCall["field"],
  requestedStatus: RecordedToolCall["requestedStatus"],
  code: ToolOutcomeErrorCode,
  message: string,
): ToolCallOutcome {
  return {
    session,
    applied: false,
    change: null,
    toolName,
    rejectionCode: code,
    record: {
      ...recordedCallBase(call),
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
  /** How many claims this turn has already withdrawn. */
  withdrawalsSoFar: number;
  context: WriteContext;
}

interface ParsedCall {
  toolName: AgentToolName;
  command: AgentClaimCommand;
  requestedField: RecordedToolCall["field"];
  requestedStatus: RecordedToolCall["requestedStatus"];
}

function isAgentToolName(name: string): name is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

/** Turns a validated tool call into a claim write command. Returns null when the arguments are invalid. */
function parseToolCall(
  session: SopSession,
  toolName: AgentToolName,
  argumentsValue: unknown,
  sourceMessageId: string,
): ParsedCall | null {
  const fieldOfClaim = (claimId: string) =>
    session.claims.find((claim) => claim.claimId === claimId)?.field ?? null;

  switch (toolName) {
    case "record_claim": {
      const parsed = recordClaimArgumentsSchema.safeParse(argumentsValue);
      if (!parsed.success) return null;
      const args = parsed.data;
      return {
        toolName,
        requestedField: args.field,
        requestedStatus: args.status,
        command: {
          kind: "record",
          createdByType: "agent",
          field: args.field,
          status: args.status,
          statement: args.statement,
          note: args.note,
          effectiveDate: args.effectiveDate,
          sourceMessageId,
          insertBeforeClaimId: args.insertBeforeClaimId,
        },
      };
    }
    case "correct_claim": {
      const parsed = correctClaimToolSchema.safeParse(argumentsValue);
      if (!parsed.success) return null;
      const args = parsed.data;
      return {
        toolName,
        requestedField: fieldOfClaim(args.claimId),
        requestedStatus: "observed",
        command: {
          kind: "correct",
          createdByType: "agent",
          claimId: args.claimId,
          statement: args.statement,
          note: args.note,
          effectiveDate: args.effectiveDate,
          sourceMessageId,
        },
      };
    }
    case "mark_claim_unknown": {
      const parsed = markClaimUnknownToolSchema.safeParse(argumentsValue);
      if (!parsed.success) return null;
      const args = parsed.data;
      return {
        toolName,
        requestedField: args.field,
        requestedStatus: "unknown",
        command: {
          kind: "markUnknown",
          createdByType: "agent",
          field: args.field,
          claimId: args.claimId,
          note: args.note,
          sourceMessageId,
        },
      };
    }
    case "withdraw_claim": {
      const parsed = withdrawClaimToolSchema.safeParse(argumentsValue);
      if (!parsed.success) return null;
      const args = parsed.data;
      return {
        toolName,
        requestedField: fieldOfClaim(args.claimId),
        requestedStatus: null,
        command: {
          kind: "withdraw",
          createdByType: "agent",
          claimId: args.claimId,
          note: args.note,
          sourceMessageId,
        },
      };
    }
  }
}

/**
 * The unknown claims that sit in the same field as a claim that was just recorded. A model that
 * meant to answer one of them has used the wrong tool, and this is how it finds out while it can
 * still fix the call. Ids and notes only, no claim text, and they are the model's own data.
 */
function openUnknownsBesides(session: SopSession, claim: { claimId: string; field: string }) {
  return session.claims
    .filter(
      (other) =>
        other.field === claim.field &&
        other.status === "unknown" &&
        other.claimId !== claim.claimId,
    )
    .map((other) => ({ claimId: other.claimId, note: other.note }));
}

function acceptedOutcome(
  call: ModelToolCall,
  parsed: ParsedCall,
  result: Extract<ApplyClaimResult, { ok: true }>,
): ToolCallOutcome {
  const agenda = buildInterviewAgenda(result.session);
  const openUnknowns =
    parsed.command.kind === "record" &&
    (result.change === "created" || result.change === "unchanged")
      ? openUnknownsBesides(result.session, result.claim)
      : [];
  return {
    session: result.session,
    applied: true,
    change: result.change,
    toolName: parsed.toolName,
    rejectionCode: null,
    record: {
      ...recordedCallBase(call),
      field: result.claim.field,
      requestedStatus: parsed.requestedStatus,
      outcome: { ok: true, claimId: result.claim.claimId, change: result.change },
    },
    modelResult: JSON.stringify({
      ok: true,
      change: result.change,
      claimId: result.claim.claimId,
      field: result.claim.field,
      status: result.change === "withdrawn" ? "withdrawn" : result.claim.status,
      blockingGapsRemaining: agenda.blockingGapsRemaining,
      advisoryGapsRemaining: agenda.advisoryGapsRemaining,
      nextAskableFields: agenda.askNext.map((question) => question.field),
      ...(openUnknowns.length === 0
        ? {}
        : {
            openUnknownsInThisField: openUnknowns,
            warning:
              "This field still has an unknown claim. If the claim you just recorded answers it, call correct_claim on the unknown's id with the same statement, then withdraw_claim the claim you just recorded. If it is a different fact, leave both.",
          }),
    }),
  };
}

/**
 * Runs one tool call against the working session. A failure is returned to the model as a compact
 * tool result so it can recover, instead of aborting the turn.
 */
export function executeToolCall(input: ExecuteToolCallInput): ToolCallOutcome {
  const { session, call, sourceMessageId, withdrawalsSoFar, context } = input;

  if (!isAgentToolName(call.name)) {
    return rejected(session, call, null, null, null, "unknown_tool", "There is no such tool.");
  }
  const toolName = call.name;

  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.argumentsJson);
  } catch {
    return rejected(
      session,
      call,
      toolName,
      null,
      null,
      "invalid_arguments",
      "The arguments are not JSON.",
    );
  }
  const parsed = parseToolCall(session, toolName, argumentsValue, sourceMessageId);
  if (parsed === null) {
    return rejected(
      session,
      call,
      toolName,
      null,
      null,
      "invalid_arguments",
      "The arguments are not valid.",
    );
  }

  if (parsed.command.kind === "withdraw" && withdrawalsSoFar >= MAX_WITHDRAWALS_PER_TURN) {
    return rejected(
      session,
      call,
      toolName,
      parsed.requestedField,
      parsed.requestedStatus,
      "withdraw_limit_reached",
      `At most ${MAX_WITHDRAWALS_PER_TURN} claims can be withdrawn in one turn. Ask the user to confirm before removing more.`,
    );
  }

  const result = applyClaim(session, parsed.command, context);
  if (!result.ok) {
    return rejected(
      session,
      call,
      toolName,
      parsed.requestedField,
      parsed.requestedStatus,
      result.error.code,
      result.error.message,
    );
  }
  return acceptedOutcome(call, parsed, result);
}
