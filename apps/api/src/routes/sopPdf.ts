import {
  buildSopDocument,
  canExportApprovedSop,
  SOP_PDF_MEDIA_TYPE,
  sopPdfFileName,
  sopPdfRequestSchema,
} from "@sop-agent/sop-core";
import type { FastifyInstance } from "fastify";
import { type SopPdfLog, sessionIdForLog } from "../logging.ts";
import { renderSopPdf } from "../pdf/renderSopPdf.ts";
import { httpError } from "./httpError.ts";

/**
 * `POST /sops/pdf`: renders the approved SOP as a PDF and returns it. Nothing is stored and no
 * model is called. The session is untrusted input: it is parsed with the schema, and the export
 * gate is recomputed from its claims on every request, because a forged session can claim to be
 * approved. What the gate guarantees is the shape of an approval, not that a person clicked.
 */
export function registerSopPdfRoute(app: FastifyInstance): void {
  app.post("/sops/pdf", async (request, reply) => {
    const startedAt = performance.now();

    const parsed = sopPdfRequestSchema.safeParse(request.body);
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

    const { session } = parsed.data;
    const logLine = (fields: Partial<SopPdfLog> & Pick<SopPdfLog, "outcome">): SopPdfLog => ({
      event: "sop_pdf",
      refusalReason: null,
      sessionId: sessionIdForLog(session.sessionId),
      claimCount: session.claims.length,
      pageCount: null,
      byteLength: null,
      replacedCharacters: null,
      durationMs: Math.round(performance.now() - startedAt),
      ...fields,
    });

    const check = canExportApprovedSop(session);
    if (!check.ok) {
      request.log.info(logLine({ outcome: "refused", refusalReason: check.reason }));
      // One code for every reason: a person can only reach this with a session that is out of
      // step, and naming the failed condition would tell a forger what to fix next.
      return reply
        .status(409)
        .send(
          httpError(
            "sop_not_approved",
            "This SOP cannot be exported. It must be approved, with every gap and suggestion resolved.",
          ),
        );
    }

    let rendered: Awaited<ReturnType<typeof renderSopPdf>>;
    try {
      rendered = await renderSopPdf(buildSopDocument(session));
    } catch (error) {
      request.log.error(logLine({ outcome: "failed" }));
      // The shared error handler reports this as a generic 500 without echoing the error.
      throw error;
    }

    request.log.info(
      logLine({
        outcome: "rendered",
        pageCount: rendered.pageCount,
        byteLength: rendered.bytes.length,
        replacedCharacters: rendered.replacedCharacters,
      }),
    );
    // `approvedAt` is not null here: the gate only passes an approved session.
    const fileName = sopPdfFileName(session.approvedAt ?? "");
    return reply
      .type(SOP_PDF_MEDIA_TYPE)
      .header("content-disposition", `attachment; filename="${fileName}"`)
      .header("cache-control", "no-store")
      .send(rendered.bytes);
  });
}
