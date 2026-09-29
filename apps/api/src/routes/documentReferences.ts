import path from "node:path";
import multipart from "@fastify/multipart";
import {
  DOCUMENT_REFERENCES_PATH,
  DOCUMENT_UPLOAD_FILE_FIELD,
  DOCUMENT_UPLOAD_SESSION_FIELD,
  type DocumentFileKind,
  type DocumentReferencesResponse,
  type HttpErrorCode,
  hasSopTarget,
  MAX_SESSION_TRANSPORT_BYTES,
  MAX_UPLOAD_BYTES,
  type SopSession,
  sopSessionSchema,
} from "@sop-agent/sop-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MAX_CONCURRENT_EXTRACTIONS } from "../documents/documentLimits.ts";
import { DocumentParseError } from "../documents/documentParseError.ts";
import { type ParsedDocument, parseDocument } from "../documents/parseDocument.ts";
import { readReferencePassages } from "../documents/readReferencePassages.ts";
import { sanitizeFileName } from "../documents/sanitizeFileName.ts";
import {
  type DocumentReferencesLog,
  type DocumentRefusalReason,
  type ModelFailureKind,
  sessionIdForLog,
} from "../logging.ts";
import type { ModelClient } from "../model/modelClient.ts";
import { isModelUnavailable } from "../model/modelErrors.ts";
import { HTTP_ERROR_MESSAGES, httpError } from "./httpError.ts";

export interface DocumentReferencesRouteDependencies {
  modelClient: ModelClient;
  /** The primary model first, then the fallback. */
  models: readonly string[];
}

/** Room for the multipart framing around a file and a session of the largest allowed sizes. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const FILE_KIND_BY_EXTENSION: Readonly<Record<string, DocumentFileKind>> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".md": "markdown",
  ".txt": "text",
};

/** How each way a document can fail to be read is reported: status, code, and a message a person can act on. */
const PARSE_FAILURES: Readonly<
  Record<DocumentParseError["category"], { status: number; code: HttpErrorCode; message?: string }>
> = {
  unsupported_type: { status: 415, code: "unsupported_document_type" },
  no_text_layer: { status: 422, code: "document_has_no_text" },
  encrypted: { status: 422, code: "document_unreadable" },
  corrupt: { status: 422, code: "document_unreadable" },
  parse_timeout: { status: 422, code: "document_unreadable" },
  too_large: {
    status: 413,
    code: "payload_too_large",
    message: "That document is too large or too complex to read.",
  },
  too_many_sections: {
    status: 413,
    code: "payload_too_large",
    message: "That document has too many sections to read.",
  },
  too_much_text: {
    status: 413,
    code: "payload_too_large",
    message: "That document has too much text to read.",
  },
};

function fileKindOf(fileName: string): DocumentFileKind | "unknown" {
  return FILE_KIND_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? "unknown";
}

interface ReadUpload {
  sessionText: string;
  bytes: Buffer;
  rawFileName: string;
}

/**
 * Reads the upload into memory: the session field, then the one file, and nothing else. There is
 * no temporary file: the bytes exist only in this request. A missing or repeated part, a part under
 * another name, or a file or session over its limit is refused.
 */
async function readUpload(request: FastifyRequest): Promise<ReadUpload | "invalid" | "too_large"> {
  let sessionText: string | undefined;
  let file: { bytes: Buffer; rawFileName: string } | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (part.fieldname !== DOCUMENT_UPLOAD_SESSION_FIELD || sessionText !== undefined) {
          return "invalid";
        }
        if (part.valueTruncated) return "too_large";
        if (typeof part.value !== "string") return "invalid";
        sessionText = part.value;
        continue;
      }
      if (part.fieldname !== DOCUMENT_UPLOAD_FILE_FIELD || file !== undefined) return "invalid";
      file = { bytes: await part.toBuffer(), rawFileName: part.filename };
    }
  } catch (error) {
    return (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE" ? "too_large" : "invalid";
  }
  if (sessionText === undefined || file === undefined || file.bytes.length === 0) return "invalid";
  return { sessionText, ...file };
}

function parseSession(text: string): SopSession | null {
  try {
    const parsed = sopSessionSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * `POST /documents/references`: reads an uploaded policy or handbook for the SOP the session is
 * writing, and returns the passages that SOP needs, each with a proven citation. The session says
 * what the SOP is about and what it already states; the route returns plain data with no id, state,
 * status or authority, and holds nothing afterwards. The browser keeps the passages as reference
 * material, outside the SOP, so a document has no SOP to change here.
 *
 * Nothing is written to disk and no document or session text is logged. It spends model money
 * without a login, so its resource use is bounded.
 */
export async function registerDocumentReferencesRoute(
  app: FastifyInstance,
  deps: DocumentReferencesRouteDependencies,
): Promise<void> {
  // The multipart parser lives in its own scope, so it does not change how /chat reads its body.
  await app.register(async (scope) => {
    await scope.register(multipart, {
      throwFileSizeLimit: true,
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        fieldSize: MAX_SESSION_TRANSPORT_BYTES,
        files: 1,
        fields: 1,
        parts: 2,
      },
    });

    let activeExtractions = 0;

    scope.post(
      DOCUMENT_REFERENCES_PATH,
      { bodyLimit: MAX_UPLOAD_BYTES + MAX_SESSION_TRANSPORT_BYTES + MULTIPART_OVERHEAD_BYTES },
      async (request, reply) => {
        if (!request.isMultipart()) {
          return reply
            .status(415)
            .send(httpError("unsupported_media_type", "The request must be a file upload."));
        }

        const startedAt = performance.now();
        const log: DocumentReferencesLog = {
          event: "document_references",
          outcome: "failed",
          refusalReason: null,
          sessionId: null,
          fileKind: "unknown",
          byteLength: 0,
          pageCount: null,
          sectionCount: null,
          characterCount: null,
          passagesProposed: 0,
          passagesRejected: 0,
          rejectionReasons: {},
          passagesAlreadyKnown: 0,
          passagesTruncated: 0,
          passagesKept: 0,
          potentialConflicts: 0,
          servedByModel: null,
          failedAttempts: [],
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          parseMs: 0,
          modelMs: 0,
          durationMs: 0,
        };
        const refuse = (
          reply: FastifyReply,
          reason: DocumentRefusalReason,
          status: number,
          code: HttpErrorCode,
          message: string,
        ) => {
          log.outcome = "refused";
          log.refusalReason = reason;
          log.durationMs = Math.round(performance.now() - startedAt);
          request.log.info(log);
          return reply.status(status).send(httpError(code, message));
        };

        const upload = await readUpload(request);
        if (upload === "too_large") {
          return refuse(
            reply,
            "upload_too_large",
            413,
            "payload_too_large",
            "That file is too large to upload.",
          );
        }
        if (upload === "invalid") {
          return refuse(
            reply,
            "invalid_upload",
            400,
            "invalid_request",
            "Upload exactly one file, with the session.",
          );
        }
        const fileName = sanitizeFileName(upload.rawFileName);
        log.byteLength = upload.bytes.length;
        log.fileKind = fileKindOf(fileName);

        // The session is untrusted input, checked before the document is read or a model called.
        const session = parseSession(upload.sessionText);
        if (session === null) {
          return refuse(
            reply,
            "invalid_session",
            400,
            "invalid_request",
            "The session sent with the document is not valid.",
          );
        }
        log.sessionId = sessionIdForLog(session.sessionId);
        if (session.status === "approved") {
          return refuse(
            reply,
            "session_approved",
            409,
            "session_approved",
            "The SOP is approved, so documents can no longer be added.",
          );
        }
        if (!hasSopTarget(session)) {
          return refuse(
            reply,
            "no_target",
            409,
            "sop_target_missing",
            HTTP_ERROR_MESSAGES.sop_target_missing,
          );
        }

        if (activeExtractions >= MAX_CONCURRENT_EXTRACTIONS) {
          return refuse(reply, "busy", 503, "extraction_busy", HTTP_ERROR_MESSAGES.extraction_busy);
        }
        activeExtractions += 1;
        try {
          // Reading stops if the browser goes away, so a closed tab does not keep paying for a model.
          // The response is what closes with the connection: the request has already been read to
          // its end by now, and its own close event can have fired before this line.
          const controller = new AbortController();
          reply.raw.once("close", () => {
            if (!reply.raw.writableFinished) controller.abort();
          });

          let parsed: ParsedDocument;
          const parseStartedAt = performance.now();
          try {
            parsed = await parseDocument({ bytes: upload.bytes, fileName });
          } catch (error) {
            log.parseMs = Math.round(performance.now() - parseStartedAt);
            if (error instanceof DocumentParseError) {
              const failure = PARSE_FAILURES[error.category];
              return refuse(
                reply,
                error.category,
                failure.status,
                failure.code,
                failure.message ?? HTTP_ERROR_MESSAGES[failure.code],
              );
            }
            throw error;
          }
          log.parseMs = Math.round(performance.now() - parseStartedAt);
          log.fileKind = parsed.fileKind;
          log.pageCount = parsed.pageCount;
          log.sectionCount = parsed.sections.length;
          log.characterCount = parsed.characterCount;

          const failedAttempts: { model: string; kind: ModelFailureKind }[] = [];
          const modelStartedAt = performance.now();
          let outcome: Awaited<ReturnType<typeof readReferencePassages>>;
          try {
            outcome = await readReferencePassages({
              client: deps.modelClient,
              models: deps.models,
              sections: parsed.sections,
              documentName: fileName,
              session,
              signal: controller.signal,
              failedAttempts,
            });
          } catch (error) {
            log.modelMs = Math.round(performance.now() - modelStartedAt);
            log.failedAttempts = failedAttempts;
            if (controller.signal.aborted) {
              log.durationMs = Math.round(performance.now() - startedAt);
              request.log.info(log);
              return reply;
            }
            if (isModelUnavailable(error) || error instanceof DOMException) {
              return refuse(
                reply,
                "model_unavailable",
                503,
                "model_unavailable",
                HTTP_ERROR_MESSAGES.model_unavailable,
              );
            }
            throw error;
          }
          log.modelMs = Math.round(performance.now() - modelStartedAt);
          log.failedAttempts = failedAttempts;
          log.servedByModel = outcome.servedByModel;
          log.passagesProposed = outcome.proposedCount;
          log.passagesRejected = outcome.rejected.count;
          log.rejectionReasons = outcome.rejected.reasons;
          log.passagesAlreadyKnown = outcome.alreadyKnownCount;
          log.passagesTruncated = outcome.truncatedCount;
          log.passagesKept = outcome.passages.length;
          log.potentialConflicts = outcome.potentialConflictCount;
          log.inputTokens = outcome.inputTokens;
          log.cachedInputTokens = outcome.cachedInputTokens;
          log.outputTokens = outcome.outputTokens;

          const body: DocumentReferencesResponse = {
            document: {
              fileName,
              fileKind: parsed.fileKind,
              sectionCount: parsed.sections.length,
              characterCount: parsed.characterCount,
            },
            passages: outcome.passages,
            rejected: outcome.rejected,
            alreadyKnownCount: outcome.alreadyKnownCount,
            truncatedCount: outcome.truncatedCount,
          };
          log.outcome = "read";
          log.durationMs = Math.round(performance.now() - startedAt);
          request.log.info(log);
          return reply.header("cache-control", "no-store").send(body);
        } catch (error) {
          log.outcome = "failed";
          log.durationMs = Math.round(performance.now() - startedAt);
          request.log.error(log);
          // The shared error handler reports this as a generic 500 without echoing the error.
          throw error;
        } finally {
          activeExtractions -= 1;
        }
      },
    );
  });
}
