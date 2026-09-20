import {
  buildInterviewAgenda,
  type ChatStreamEvent,
  chatRequestSchema,
  computeGaps,
  encodeChatStreamEvent,
  MAX_MESSAGES,
  type SopSession,
  type UserMessage,
  type WriteContext,
} from "@sop-agent/sop-core";
import type { FastifyInstance, FastifyReply } from "fastify";
import OpenAI from "openai";
import { buildStateItem, MAX_STATE_ITEM_LENGTH } from "../agent/prompt.ts";
import { createEmptyTurnStats, runAgentTurn } from "../agent/runTurn.ts";
import {
  type ChatTurnLog,
  classifyModelError,
  type ModelFailureKind,
  sessionIdForLog,
} from "../logging.ts";
import type { ModelClient } from "../model/modelClient.ts";
import {
  ModelOutputError,
  ModelRefusalError,
  runWithModelFallback,
} from "../model/modelFallback.ts";
import { httpError } from "./httpError.ts";

export interface ChatRouteDependencies {
  modelClient: ModelClient;
  /** The primary model first, then the fallback. */
  models: readonly string[];
  context: WriteContext;
}

function countConfirmedClaims(session: SopSession): number {
  return session.claims.filter((claim) => claim.status === "confirmed").length;
}

function isModelUnavailable(error: unknown): boolean {
  return (
    error instanceof ModelRefusalError ||
    error instanceof ModelOutputError ||
    error instanceof OpenAI.APIError
  );
}

/** Bad credentials or permissions will not fix themselves, so retrying is pointless. */
function isRetryable(error: unknown): boolean {
  return !(
    error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError
  );
}

function startNdjsonStream(reply: FastifyReply): {
  emit: (event: ChatStreamEvent) => void;
  end: () => void;
  signal: AbortSignal;
} {
  reply.hijack();
  const raw = reply.raw;
  // A hijacked reply skips Fastify's header handling, so the CORS headers are passed along here.
  const inheritedHeaders = Object.fromEntries(
    Object.entries(reply.getHeaders()).filter(
      (entry): entry is [string, string | number | string[]] => entry[1] !== undefined,
    ),
  );
  raw.writeHead(200, {
    ...inheritedHeaders,
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });

  const controller = new AbortController();
  raw.on("close", () => {
    if (!raw.writableFinished) controller.abort();
  });

  return {
    signal: controller.signal,
    emit: (event) => {
      if (raw.writable && !controller.signal.aborted) raw.write(encodeChatStreamEvent(event));
    },
    end: () => {
      if (!raw.writableEnded) raw.end();
    },
  };
}

export function registerChatRoute(app: FastifyInstance, deps: ChatRouteDependencies): void {
  const { modelClient, context } = deps;

  app.post("/chat", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      }));
      request.log.warn({
        event: "invalid_request",
        issueCount: parsed.error.issues.length,
        firstIssuePath: issues[0]?.path ?? "",
      });
      return reply
        .status(400)
        .send(httpError("invalid_request", "The request is not valid.", issues));
    }

    const { session, message } = parsed.data;
    if (session.status === "approved") {
      return reply
        .status(409)
        .send(httpError("session_approved", "The SOP is approved, so the chat is read-only."));
    }
    // The user message and the assistant reply both have to fit.
    if (session.messages.length + 2 > MAX_MESSAGES) {
      return reply
        .status(413)
        .send(httpError("payload_too_large", "The conversation is full. Start a new chat."));
    }

    // Refuse before spending anything on the model. The message is added first so the check sees
    // what the model would see.
    const turnId = context.newId();
    const userMessage: UserMessage = {
      id: context.newId(),
      role: "user",
      createdAt: context.now(),
      text: message,
    };
    const startingSession: SopSession = {
      ...session,
      updatedAt: userMessage.createdAt,
      messages: [...session.messages, userMessage],
    };
    if (
      buildStateItem({ session: startingSession, allowToolCalls: true }).length >
      MAX_STATE_ITEM_LENGTH
    ) {
      return reply
        .status(413)
        .send(
          httpError("payload_too_large", "The SOP is too large to continue. Start a new chat."),
        );
    }
    const gapsBefore = computeGaps(session);
    const agendaBefore = buildInterviewAgenda(session);

    const stream = startNdjsonStream(reply);
    const startedAt = performance.now();
    const failedAttempts: { model: string; kind: ModelFailureKind }[] = [];
    stream.emit({ type: "turn_started", turnId });

    const baseLog = {
      event: "chat_turn" as const,
      turnId,
      sessionId: sessionIdForLog(session.sessionId),
      agendaTopField: agendaBefore.askNext[0]?.field ?? null,
      blockingGapsBefore: gapsBefore.blockingGapCount,
      advisoryGapsBefore: gapsBefore.advisoryGapCount,
    };
    const writeLog = (log: Omit<ChatTurnLog, keyof typeof baseLog | "durationMs">) =>
      request.log.info({
        ...baseLog,
        durationMs: Math.round(performance.now() - startedAt),
        ...log,
      });

    let attemptNumber = 0;
    try {
      const outcome = await runWithModelFallback([...deps.models], async (model) => {
        stream.signal.throwIfAborted();
        attemptNumber += 1;
        // The primary attempt is discarded; the browser must drop the partial reply it showed.
        if (attemptNumber > 1) stream.emit({ type: "turn_reset" });
        try {
          return await runAgentTurn({
            client: modelClient,
            model,
            session: startingSession,
            userMessageId: userMessage.id,
            context,
            signal: stream.signal,
            onTextDelta: (text) => stream.emit({ type: "text_delta", text }),
          });
        } catch (error) {
          failedAttempts.push({ model, kind: classifyModelError(error) });
          throw error;
        }
      });

      const committed = outcome.value.session;
      const gapsAfter = computeGaps(committed);
      stream.emit({ type: "commit", session: committed });
      stream.end();
      writeLog({
        outcome: "committed",
        servedByModel: outcome.servedByModel,
        failedAttempts,
        ...outcome.value.stats,
        readyToReview: buildInterviewAgenda(committed).readyToReview,
        blockingGapsAfter: gapsAfter.blockingGapCount,
        advisoryGapsAfter: gapsAfter.advisoryGapCount,
        messageCount: committed.messages.length,
        claimCount: committed.claims.length,
        confirmedClaimCount: countConfirmedClaims(committed),
      });
    } catch (error) {
      const aborted = stream.signal.aborted;
      if (!aborted) {
        stream.emit({
          type: "error",
          code: isModelUnavailable(error) ? "model_unavailable" : "internal_error",
          retryable: isModelUnavailable(error) && isRetryable(error),
          message: isModelUnavailable(error)
            ? "The agent could not complete this turn."
            : "Something went wrong on the server.",
        });
      }
      stream.end();
      writeLog({
        outcome: aborted ? "aborted" : "failed",
        servedByModel: null,
        failedAttempts,
        ...createEmptyTurnStats(),
        readyToReview: null,
        blockingGapsAfter: null,
        advisoryGapsAfter: null,
        messageCount: startingSession.messages.length,
        claimCount: startingSession.claims.length,
        confirmedClaimCount: countConfirmedClaims(startingSession),
      });
    }

    return reply;
  });
}
