import cors from "@fastify/cors";
import { type HttpErrorCode, systemWriteContext, type WriteContext } from "@sop-agent/sop-core";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  LogController,
} from "fastify";
import pino from "pino";
import type { ModelClient } from "./model/modelClient.ts";
import { registerChatRoute } from "./routes/chat.ts";

/**
 * One megabyte. A session is bounded by its own schema, and slice 5 will need to raise this along
 * with the document upload limit, since parsed document sections travel inside the session.
 */
export const REQUEST_BODY_LIMIT_BYTES = 1_048_576;

export interface ServerDependencies {
  modelClient: ModelClient;
  /** The primary model first, then the fallback. */
  models: readonly string[];
  webOrigin: string;
  logLevel?: string;
  /** Where log lines go. Defaults to standard output; tests capture them here. */
  logStream?: NodeJS.WritableStream;
  context?: WriteContext;
}

const ERROR_MESSAGES: Record<HttpErrorCode, string> = {
  invalid_request: "The request is not valid.",
  session_approved: "The SOP is approved, so the chat is read-only.",
  payload_too_large: "The request is too large.",
  unsupported_media_type: "The request must be JSON.",
  internal_error: "Something went wrong on the server.",
};

/** Builds the server without starting it, so tests can send requests to it directly. */
export async function buildServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const logger: FastifyBaseLogger = pino({ level: deps.logLevel ?? "info" }, deps.logStream);
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
    // One log line per chat turn replaces the default request and response lines.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // With no cookies and no login, CORS here is a browser convenience, not an access control.
  await app.register(cors, {
    origin: deps.webOrigin,
    methods: ["POST", "OPTIONS", "GET"],
    allowedHeaders: ["content-type"],
    credentials: false,
  });

  // Errors are reported by category. The error's own text is never echoed or logged, because it
  // can quote the request.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    const code: HttpErrorCode =
      statusCode === 413
        ? "payload_too_large"
        : statusCode === 415
          ? "unsupported_media_type"
          : statusCode < 500
            ? "invalid_request"
            : "internal_error";
    request.log.warn({ event: "request_error", statusCode, errorCode: error.code });
    return reply.status(statusCode).send({ error: { code, message: ERROR_MESSAGES[code] } });
  });

  // The one request line: method, path, status, and time. The query string is dropped because it
  // could carry user text. A streamed chat reply does not reach this hook (it takes over the
  // response), so the `chat_turn` line covers that route instead.
  app.addHook("onResponse", (request, reply, done) => {
    request.log.info({
      event: "request",
      method: request.method,
      path: request.url.split("?")[0],
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
    done();
  });

  app.get("/health", async () => ({ status: "ok" }));

  registerChatRoute(app, {
    modelClient: deps.modelClient,
    models: deps.models,
    context: deps.context ?? systemWriteContext,
  });

  return app;
}
