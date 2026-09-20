import { createServer } from "node:net";
import { Writable } from "node:stream";
import {
  type ChatStreamEvent,
  chatStreamEventSchema,
  createEmptySession,
  MAX_CLAIMS,
  MAX_IDENTIFIER_LENGTH,
  MAX_MESSAGES,
  type SopSession,
  sopSessionSchema,
  systemWriteContext,
} from "@sop-agent/sop-core";
import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TOOL_ROUNDS } from "../agent/runTurn.ts";
import type { ModelClient } from "../model/modelClient.ts";
import { ModelRefusalError } from "../model/modelFallback.ts";
import { buildServer, REQUEST_BODY_LIMIT_BYTES } from "../server.ts";
import {
  createScriptedModelClient,
  failingStep,
  markClaimUnknownCall,
  recordClaimCall,
  type ScriptedStep,
  textStep,
  toolCallStep,
} from "../testing/fakeModelClient.ts";

const WEB_ORIGIN = "http://localhost:3000";

/** Some environments, such as a restrictive sandbox, do not allow listening on a port. */
const canListenOnLoopback = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(true)));
});
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function createApp(client: ModelClient) {
  const logLines: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(chunk.toString());
      callback();
    },
  });
  const app = await buildServer({
    modelClient: client,
    models: ["primary-model", "fallback-model"],
    webOrigin: WEB_ORIGIN,
    logStream,
    logLevel: "info",
  });
  openApps.push(app);
  return { app, logLines };
}

function parseEvents(body: string): ChatStreamEvent[] {
  return body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => chatStreamEventSchema.parse(JSON.parse(line)));
}

function postChat(app: FastifyInstance, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/chat",
    payload: payload as object,
    headers: { "content-type": "application/json", ...headers },
  });
}

function emptySession(): SopSession {
  return createEmptySession(systemWriteContext);
}

function commitOf(events: ChatStreamEvent[]): SopSession {
  const commits = events.filter((event) => event.type === "commit");
  expect(commits).toHaveLength(1);
  const commit = commits[0];
  if (commit?.type !== "commit") throw new Error("no commit");
  return commit.session;
}

function chatTurnLog(logLines: string[]): Record<string, unknown> {
  const line = logLines
    .map((entry) => JSON.parse(entry))
    .find((entry) => entry.event === "chat_turn");
  if (line === undefined) throw new Error("no chat_turn log line");
  return line;
}

describe("POST /chat: a normal turn", () => {
  it("streams the reply, records the claim, and ends with exactly one commit", async () => {
    const client = createScriptedModelClient([
      toolCallStep([recordClaimCall({ field: "purpose" })], "Thanks. "),
      textStep("Who approves refunds?"),
    ]);
    const { app } = await createApp(client);

    const response = await postChat(app, {
      session: emptySession(),
      message: "We handle refunds.",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    const events = parseEvents(response.body);
    expect(events[0]?.type).toBe("turn_started");
    expect(events.at(-1)?.type).toBe("commit");
    expect(events.filter((event) => event.type === "text_delta").length).toBeGreaterThan(0);

    const session = commitOf(events);
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(session.claims).toHaveLength(1);
    expect(session.claims[0]).toMatchObject({ field: "purpose", status: "observed" });
    const assistant = session.messages[1];
    expect(assistant?.role === "assistant" && assistant.text).toContain("Who approves refunds?");
    expect(assistant?.role === "assistant" && assistant.model).toBe("primary-model");
  });

  it("gives the model the four claim tools, fixed instructions, the user's message and the state last", async () => {
    const client = createScriptedModelClient([textStep("Hello.")]);
    const { app } = await createApp(client);
    await postChat(app, { session: emptySession(), message: "We handle refunds." });

    const request = client.requests[0];
    expect(request?.tools.map((tool) => tool.name)).toEqual([
      "record_claim",
      "correct_claim",
      "mark_claim_unknown",
      "withdraw_claim",
    ]);
    expect(request?.allowToolCalls).toBe(true);
    expect(request?.instructions).not.toContain("<sop_state>");
    expect(request?.stateItem).toContain("<sop_state>");
    expect(request?.conversation).toEqual([
      { kind: "message", role: "user", text: "We handle refunds." },
    ]);
  });

  it("sends CORS headers for the configured web origin only", async () => {
    const client = createScriptedModelClient([textStep("Hi.")]);
    const { app } = await createApp(client);
    const allowed = await postChat(
      app,
      { session: emptySession(), message: "Hi" },
      { origin: WEB_ORIGIN },
    );
    expect(allowed.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
  });

  it("answers the health check", async () => {
    const { app } = await createApp(createScriptedModelClient([]));
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });
});

describe("POST /chat: the model cannot confirm", () => {
  it("writes nothing when the model asks for confirmed, and tells the model why", async () => {
    const client = createScriptedModelClient([
      toolCallStep([recordClaimCall({ status: "confirmed" })]),
      textStep("I could not record that."),
    ]);
    const { app } = await createApp(client);

    const response = await postChat(app, { session: emptySession(), message: "It is approved." });
    const session = commitOf(parseEvents(response.body));

    expect(session.claims).toHaveLength(0);
    const assistant = session.messages[1];
    expect(assistant?.role === "assistant" && assistant.toolCalls[0]?.outcome).toEqual({
      ok: false,
      code: "status_not_allowed_for_creator",
    });
    const toolResult = client.requests[1]?.conversation.find((item) => item.kind === "tool_result");
    expect(toolResult?.kind === "tool_result" && toolResult.output).toContain(
      "status_not_allowed_for_creator",
    );
  });
});

describe("POST /chat: bad requests are refused before any model call", () => {
  it("rejects an invalid session without echoing its values", async () => {
    const client = createScriptedModelClient([]);
    const { app } = await createApp(client);

    const response = await postChat(app, {
      session: { ...emptySession(), status: "SECRET-VALUE" },
      message: "Hi",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(response.body).not.toContain("SECRET-VALUE");
    expect(client.requests).toHaveLength(0);
  });

  it("rejects an approved session with 409", async () => {
    const client = createScriptedModelClient([]);
    const { app } = await createApp(client);
    const response = await postChat(app, {
      session: { ...emptySession(), status: "approved" },
      message: "Hi",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("session_approved");
    expect(client.requests).toHaveLength(0);
  });

  it("rejects a body over the size limit with 413", async () => {
    const client = createScriptedModelClient([]);
    const { app } = await createApp(client);
    const response = await postChat(app, {
      session: emptySession(),
      message: "x".repeat(REQUEST_BODY_LIMIT_BYTES + 1),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("payload_too_large");
    expect(client.requests).toHaveLength(0);
  });

  it("rejects a full conversation with 413", async () => {
    const client = createScriptedModelClient([]);
    const { app } = await createApp(client);
    const messages = Array.from({ length: MAX_MESSAGES - 1 }, (_, index) => ({
      id: `m-${index}`,
      role: "user" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      text: "hello",
    }));
    const response = await postChat(app, {
      session: { ...emptySession(), messages },
      message: "Hi",
    });
    expect(response.statusCode).toBe(413);
    expect(client.requests).toHaveLength(0);
  });

  it("rejects a session whose state would be too large for the model with 413, before any call", async () => {
    const client = createScriptedModelClient([]);
    const { app } = await createApp(client);
    const session = emptySession();
    const claims = Array.from({ length: MAX_CLAIMS }, (_, index) => ({
      claimId: `claim-${index}`.padEnd(MAX_IDENTIFIER_LENGTH, "-"),
      field: "purpose" as const,
      value: { kind: "statement" as const, text: `${index}-`.padEnd(70, "x") },
      status: "observed" as const,
      source: {
        type: "employee_statement" as const,
        reference: { kind: "message" as const, messageId: "m-1" },
      },
      authority: "observed_practice" as const,
      effectiveDate: null,
      note: null,
      createdByType: "agent" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const oversized = {
      ...session,
      messages: [
        { id: "m-1", role: "user" as const, createdAt: "2026-01-01T00:00:00.000Z", text: "Hi" },
      ],
      claims,
    };
    // The schema's own caps must let this through, or the test would prove nothing about the state cap.
    expect(sopSessionSchema.safeParse(oversized).success).toBe(true);

    const response = await postChat(app, { session: oversized, message: "Hello" });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.message).toContain("too large to continue");
    expect(response.json().error.code).toBe("payload_too_large");
    expect(client.requests).toHaveLength(0);
  });

  it("rejects a body that is not JSON with 415", async () => {
    const client = createScriptedModelClient([]);
    const { app } = await createApp(client);
    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: "hello",
      headers: { "content-type": "application/xml" },
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("unsupported_media_type");
  });
});

describe("POST /chat: the tool loop is bounded", () => {
  it("stops after the round cap and asks for a closing reply without tools", async () => {
    const steps: ScriptedStep[] = [
      ...Array.from({ length: MAX_TOOL_ROUNDS }, (_, index) =>
        toolCallStep([recordClaimCall({ statement: `Fact number ${index}.` })]),
      ),
      textStep("Closing message."),
    ];
    const client = createScriptedModelClient(steps);
    const { app, logLines } = await createApp(client);

    const response = await postChat(app, { session: emptySession(), message: "Go." });
    const session = commitOf(parseEvents(response.body));

    expect(client.requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(client.requests.at(-1)?.allowToolCalls).toBe(false);
    expect(session.claims).toHaveLength(MAX_TOOL_ROUNDS);
    expect(chatTurnLog(logLines)).toMatchObject({
      toolRoundCapHit: true,
      toolRounds: MAX_TOOL_ROUNDS,
    });
  });
});

describe("POST /chat: falling back to the second model", () => {
  it("discards everything the failed attempt did and restarts from the same session", async () => {
    const client = createScriptedModelClient([
      // Primary: streams some text, records a claim, then is refused on the next step.
      toolCallStep([recordClaimCall({ field: "scope" })], "Partial reply. "),
      failingStep(new ModelRefusalError("declined")),
      // Fallback: a clean attempt.
      toolCallStep([recordClaimCall({ field: "purpose" })]),
      textStep("Fallback reply."),
    ]);
    const { app, logLines } = await createApp(client);

    const response = await postChat(app, {
      session: emptySession(),
      message: "We handle refunds.",
    });
    const events = parseEvents(response.body);
    const session = commitOf(events);

    const types = events.map((event) => event.type);
    const resetAt = types.indexOf("turn_reset");
    expect(resetAt).toBeGreaterThan(types.indexOf("text_delta"));
    expect(types.filter((type) => type === "turn_reset")).toHaveLength(1);

    expect(session.claims.map((claim) => claim.field)).toEqual(["purpose"]);
    const assistants = session.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.role === "assistant" && assistants[0].text).toBe("Fallback reply.");
    expect(assistants[0]?.role === "assistant" && assistants[0].model).toBe("fallback-model");
    expect(client.requests.map((request) => request.model)).toEqual([
      "primary-model",
      "primary-model",
      "fallback-model",
      "fallback-model",
    ]);
    expect(chatTurnLog(logLines)).toMatchObject({
      servedByModel: "fallback-model",
      failedAttempts: [{ model: "primary-model", kind: "refusal" }],
    });
  });

  it("does not fall back on an authentication error, and sends an error without a commit", async () => {
    const client = createScriptedModelClient([
      failingStep(new OpenAI.AuthenticationError(401, {}, "bad key", new Headers())),
    ]);
    const { app, logLines } = await createApp(client);

    const response = await postChat(app, { session: emptySession(), message: "Hi" });
    const events = parseEvents(response.body);

    expect(client.requests).toHaveLength(1);
    expect(events.some((event) => event.type === "commit")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "model_unavailable",
      retryable: false,
    });
    expect(chatTurnLog(logLines)).toMatchObject({ outcome: "failed" });
  });

  it("sends a retryable error and no commit when every model fails", async () => {
    const client = createScriptedModelClient([
      failingStep(new ModelRefusalError("no")),
      failingStep(new ModelRefusalError("no again")),
    ]);
    const { app } = await createApp(client);

    const response = await postChat(app, { session: emptySession(), message: "Hi" });
    const events = parseEvents(response.body);

    expect(events.some((event) => event.type === "commit")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
  });
});

describe("POST /chat: logs carry counts, never content", () => {
  it("never writes message text, claim text, or refusal text to the log", async () => {
    const message = "SENTINEL-MESSAGE-7f3a";
    const client = createScriptedModelClient([
      failingStep(new ModelRefusalError("SENTINEL-REFUSAL-91bc")),
      toolCallStep([recordClaimCall({ statement: "SENTINEL-CLAIM-c2d4" })]),
      textStep("SENTINEL-REPLY-55e0"),
    ]);
    const { app, logLines } = await createApp(client);

    await postChat(app, { session: emptySession(), message });

    const everything = logLines.join("");
    for (const sentinel of ["MESSAGE-7f3a", "REFUSAL-91bc", "CLAIM-c2d4", "REPLY-55e0"]) {
      expect(everything).not.toContain(sentinel);
    }
    expect(chatTurnLog(logLines)).toMatchObject({
      outcome: "committed",
      toolCallsApplied: 1,
      claimsRecorded: 1,
      claimsCorrected: 0,
      claimsMarkedUnknown: 0,
      claimsWithdrawn: 0,
      claimsUnchanged: 0,
      historyEntriesWritten: 0,
      withdrawLimitHits: 0,
      agendaTopField: "purpose",
      readyToReview: false,
      cachedInputTokens: 8,
      blockingGapsBefore: 8,
      blockingGapsAfter: 7,
      messageCount: 2,
      claimCount: 1,
    });
    expect(chatTurnLog(logLines).stateItemChars).toBeGreaterThan(0);
  });

  it("never writes claim ids, notes or questions from the model's tool traffic to the log", async () => {
    const client = createScriptedModelClient([
      toolCallStep([
        recordClaimCall({ statement: "SENTINEL-STATEMENT-11aa", note: "SENTINEL-NOTE-22bb" }),
        markClaimUnknownCall("scope", null, "SENTINEL-UNKNOWN-33cc"),
      ]),
      textStep("SENTINEL-QUESTION-44dd?"),
    ]);
    const { app, logLines } = await createApp(client);
    const response = await postChat(app, { session: emptySession(), message: "Hi" });
    const session = commitOf(parseEvents(response.body));

    const everything = logLines.join("");
    for (const sentinel of ["STATEMENT-11aa", "NOTE-22bb", "UNKNOWN-33cc", "QUESTION-44dd"]) {
      expect(everything).not.toContain(sentinel);
    }
    for (const claim of session.claims) expect(everything).not.toContain(claim.claimId);
  });
});

describe("POST /chat: the session id in the log", () => {
  it("logs a UUID session id but never one that carries text", async () => {
    const client = createScriptedModelClient([textStep("One."), textStep("Two.")]);
    const { app, logLines } = await createApp(client);

    const genuine = emptySession();
    await postChat(app, { session: genuine, message: "Hi" });
    await postChat(app, {
      session: { ...emptySession(), sessionId: "SENTINEL-SESSION-ID-4c8e" },
      message: "Hi",
    });

    expect(logLines.join("")).not.toContain("SENTINEL-SESSION-ID-4c8e");
    const turns = logLines
      .map((entry) => JSON.parse(entry))
      .filter((entry) => entry.event === "chat_turn");
    expect(turns.map((turn) => turn.sessionId)).toEqual([genuine.sessionId, null]);
  });
});

describe("POST /chat: cancellation", () => {
  it.skipIf(!canListenOnLoopback)(
    "aborts the upstream model request when the client disconnects",
    async () => {
      let upstreamAborted = false;
      let upstreamStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        upstreamStarted = resolve;
      });
      const client = createScriptedModelClient([
        (request) =>
          new Promise((_resolve, reject) => {
            request.onTextDelta("Working...");
            upstreamStarted();
            request.signal.addEventListener("abort", () => {
              upstreamAborted = true;
              reject(new Error("aborted"));
            });
          }),
      ]);
      const { app } = await createApp(client);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === "string") throw new Error("no address");

      const disconnect = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: emptySession(), message: "Hi" }),
        signal: disconnect.signal,
      });
      await response.body?.getReader().read();
      await started;
      disconnect.abort();

      for (let attempt = 0; attempt < 50 && !upstreamAborted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(upstreamAborted).toBe(true);
    },
  );
});
