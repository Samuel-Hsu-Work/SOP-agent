import { Writable } from "node:stream";
import {
  buildSopDocument,
  createEmptySession,
  type SopSession,
  systemWriteContext,
} from "@sop-agent/sop-core";
import { buildClaim } from "@sop-agent/sop-core/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, REQUEST_BODY_LIMIT_BYTES } from "../server.ts";
import { buildApprovedSession } from "../testing/approvedSession.ts";
import { createScriptedModelClient } from "../testing/fakeModelClient.ts";
import { collapseWhitespace, readPdfPages } from "../testing/readPdfText.ts";

const WEB_ORIGIN = "http://localhost:3000";
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function createApp() {
  const logLines: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(chunk.toString());
      callback();
    },
  });
  const client = createScriptedModelClient([]);
  const app = await buildServer({
    modelClient: client,
    models: ["primary-model", "fallback-model"],
    webOrigin: WEB_ORIGIN,
    logStream,
    logLevel: "info",
  });
  openApps.push(app);
  return { app, client, logLines };
}

const postPdf = (app: FastifyInstance, body: unknown) =>
  app.inject({ method: "POST", url: "/sops/pdf", payload: body as object });

/** A session that only says it is approved: the content is checked by the route, not trusted. */
const forgeApproved = (session: SopSession): SopSession => ({
  ...session,
  status: "approved",
  approvedAt: "2026-01-02T00:00:00.000Z",
});

function loggedEvents(logLines: string[], event: string): Record<string, unknown>[] {
  return logLines
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

describe("POST /sops/pdf", () => {
  it("returns the approved SOP as a PDF, with a fixed file name and no caching", async () => {
    const { app, client } = await createApp();
    const session = buildApprovedSession();
    const response = await postPdf(app, { session });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="standard-operating-procedure-2026-01-01-0000.pdf"',
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(client.requests).toHaveLength(0);

    // What was printed matches the claims, each with its own tag.
    const text = collapseWhitespace((await readPdfPages(response.rawPayload)).join(" "));
    const document = buildSopDocument(session);
    for (const section of document.sections) {
      for (const item of section.items) {
        expect(text).toContain(`${item.provenanceTag} ${item.text ?? item.note}`);
      }
    }
  });

  it("lets the web origin read the response, and nobody else", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/sops/pdf",
      payload: { session: buildApprovedSession() },
      headers: { origin: WEB_ORIGIN },
    });
    expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
  });

  it("refuses a draft with 409, even one that is ready to approve", async () => {
    const { app } = await createApp();
    const draft = createEmptySession(systemWriteContext);
    const response = await postPdf(app, { session: draft });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("sop_not_approved");
  });

  it("does not trust a session that says it is approved but has a blocking gap", async () => {
    const { app } = await createApp();
    const response = await postPdf(app, {
      session: forgeApproved(createEmptySession(systemWriteContext)),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("sop_not_approved");
  });

  it("does not trust an approved session with an advisory gap nobody acknowledged", async () => {
    const { app } = await createApp();
    const session = { ...buildApprovedSession(), advisoryAcknowledgements: [] };
    const response = await postPdf(app, { session });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("sop_not_approved");
  });

  it("does not trust an approved session that holds a suggestion nobody reviewed", async () => {
    const { app } = await createApp();
    const approved = buildApprovedSession();
    const messageId = approved.messages[0]?.id ?? "";
    const suggestion = buildClaim({
      claimId: "unreviewed-suggestion",
      field: "scope",
      status: "proposed",
      authority: "proposed",
      source: { type: "agent_suggestion", reference: { kind: "message", messageId } },
    });
    const response = await postPdf(app, {
      session: { ...approved, claims: [...approved.claims, suggestion] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("sop_not_approved");
  });

  it("rejects a session that does not parse, reporting paths and codes but never values", async () => {
    const { app } = await createApp();
    const session = { ...buildApprovedSession(), status: "SENTINEL-STATUS-8c1d" };
    const response = await postPdf(app, { session });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(response.json().error.issues.length).toBeGreaterThan(0);
    expect(response.body).not.toContain("SENTINEL-STATUS-8c1d");

    expect((await postPdf(app, {})).statusCode).toBe(400);
  });

  it("rejects a body that is not JSON with 415", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/sops/pdf",
      payload: "hello",
      headers: { "content-type": "application/xml" },
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("unsupported_media_type");
  });

  it("rejects a body over the size limit with 413", async () => {
    const { app } = await createApp();
    const response = await postPdf(app, {
      session: buildApprovedSession(),
      padding: "x".repeat(REQUEST_BODY_LIMIT_BYTES + 1),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("payload_too_large");
  });

  describe("logs", () => {
    it("record one line of counts on success, and none of the SOP's text", async () => {
      const { app, logLines } = await createApp();
      const session: SopSession = {
        ...buildApprovedSession({
          purposeText: "SENTINEL-PURPOSE-a1b2 中文",
          noteText: "SENTINEL-NOTE-c3d4",
        }),
        sessionId: "SENTINEL-SESSION-ID-e5f6",
      };
      const response = await postPdf(app, { session });
      expect(response.statusCode).toBe(200);

      const [entry] = loggedEvents(logLines, "sop_pdf");
      expect(entry).toMatchObject({
        outcome: "rendered",
        refusalReason: null,
        sessionId: null,
        claimCount: session.claims.length,
        replacedCharacters: 2,
      });
      expect(typeof entry?.pageCount).toBe("number");
      expect(typeof entry?.byteLength).toBe("number");
      expect(typeof entry?.durationMs).toBe("number");

      const allLogs = logLines.join("");
      for (const secret of [
        "SENTINEL-PURPOSE-a1b2",
        "SENTINEL-NOTE-c3d4",
        "SENTINEL-SESSION-ID-e5f6",
        "standard-operating-procedure",
      ]) {
        expect(allLogs).not.toContain(secret);
      }
      expect(allLogs).not.toContain("中文");
      expect(allLogs).toContain('"path":"/sops/pdf"');
    });

    it("record the refusal category on a refusal, and none of the SOP's text", async () => {
      const { app, logLines } = await createApp();
      const empty = createEmptySession(systemWriteContext);
      const messageId = "SENTINEL-MESSAGE-ID-0a9b";
      const withClaim = {
        ...forgeApproved(empty),
        sessionId: "SENTINEL-SESSION-ID-77aa",
        messages: [
          {
            id: messageId,
            role: "user" as const,
            createdAt: empty.createdAt,
            text: "SENTINEL-USER-TEXT-33cc",
          },
        ],
        claims: [
          buildClaim({
            claimId: "c1",
            field: "purpose",
            value: { kind: "statement", text: "SENTINEL-CLAIM-44dd" },
            source: { type: "employee_statement", reference: { kind: "message", messageId } },
          }),
        ],
      };
      const response = await postPdf(app, { session: withClaim });
      expect(response.statusCode).toBe(409);

      const [entry] = loggedEvents(logLines, "sop_pdf");
      expect(entry).toMatchObject({
        outcome: "refused",
        refusalReason: "blocking_gap",
        sessionId: null,
        claimCount: 1,
        pageCount: null,
        byteLength: null,
      });
      const allLogs = logLines.join("");
      for (const secret of [
        "SENTINEL-MESSAGE-ID-0a9b",
        "SENTINEL-SESSION-ID-77aa",
        "SENTINEL-USER-TEXT-33cc",
        "SENTINEL-CLAIM-44dd",
      ]) {
        expect(allLogs).not.toContain(secret);
      }
    });

    it("name a draft as not approved", async () => {
      const { app, logLines } = await createApp();
      await postPdf(app, { session: createEmptySession(systemWriteContext) });
      expect(loggedEvents(logLines, "sop_pdf")[0]).toMatchObject({
        outcome: "refused",
        refusalReason: "not_approved",
      });
    });
  });
});
