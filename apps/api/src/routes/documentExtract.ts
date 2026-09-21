import path from "node:path";
import multipart from "@fastify/multipart";
import {
  type DocumentExtractResponse,
  type DocumentFileKind,
  type HttpErrorCode,
  MAX_UPLOAD_BYTES,
} from "@sop-agent/sop-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import OpenAI from "openai";
import { MAX_CONCURRENT_EXTRACTIONS } from "../documents/documentLimits.ts";
import { DocumentParseError } from "../documents/documentParseError.ts";
import { extractClaimDrafts } from "../documents/extractClaimDrafts.ts";
import { type ParsedDocument, parseDocument } from "../documents/parseDocument.ts";
import { sanitizeFileName } from "../documents/sanitizeFileName.ts";
import type { DocumentExtractLog, DocumentRefusalReason, ModelFailureKind } from "../logging.ts";
import type { ModelClient } from "../model/modelClient.ts";
import { ModelOutputError, ModelRefusalError } from "../model/modelFallback.ts";
import { HTTP_ERROR_MESSAGES, httpError } from "./httpError.ts";

export interface DocumentExtractRouteDependencies {
  modelClient: ModelClient;
  /** The primary model first, then the fallback. */
  models: readonly string[];
}

/** Room for the multipart framing around a file of the largest allowed size. */
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

function isModelUnavailable(error: unknown): boolean {
  return (
    error instanceof ModelRefusalError ||
    error instanceof ModelOutputError ||
    error instanceof OpenAI.APIError
  );
}

function fileKindOf(fileName: string): DocumentFileKind | "unknown" {
  return FILE_KIND_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? "unknown";
}

interface ReadUpload {
  bytes: Buffer;
  rawFileName: string;
}

/**
 * Reads the one file of the upload into memory, and nothing else. There is no temporary file: the
 * bytes exist only in this request. A second file, a text field, or a file over the limit is
 * refused.
 */
async function readUpload(request: FastifyRequest): Promise<ReadUpload | "invalid" | "too_large"> {
  let upload: ReadUpload | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type !== "file" || upload !== undefined) return "invalid";
      upload = { bytes: await part.toBuffer(), rawFileName: part.filename };
    }
  } catch (error) {
    return (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE" ? "too_large" : "invalid";
  }
  return upload === undefined || upload.bytes.length === 0 ? "invalid" : upload;
}

/**
 * `POST /documents/extract`: reads an uploaded policy or handbook and returns the rules in it as
 * claim drafts with proven citations. It is stateless and holds no session: the request is one
 * file, and the reply is plain data with no status, id, source or authority. The browser turns the
 * drafts into claims through `applyClaim`, so a document has no session to change here.
 *
 * Nothing is written to disk and no document text is logged. It is the first unauthenticated route
 * that spends model money, so its resource use is bounded, and rate limiting is slice 6's job.
 */
export async function registerDocumentExtractRoute(
  app: FastifyInstance,
  deps: DocumentExtractRouteDependencies,
): Promise<void> {
  // The multipart parser lives in its own scope, so it does not change how /chat reads its body.
  await app.register(async (scope) => {
    await scope.register(multipart, {
      throwFileSizeLimit: true,
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 2 },
    });

    let activeExtractions = 0;

    scope.post(
      "/documents/extract",
      { bodyLimit: MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES },
      async (request, reply) => {
        if (!request.isMultipart()) {
          return reply
            .status(415)
            .send(httpError("unsupported_media_type", "The request must be a file upload."));
        }

        const startedAt = performance.now();
        const log: DocumentExtractLog = {
          event: "document_extract",
          outcome: "failed",
          refusalReason: null,
          fileKind: "unknown",
          byteLength: 0,
          pageCount: null,
          sectionCount: null,
          characterCount: null,
          claimsProposed: 0,
          claimsVerified: 0,
          claimsRejected: 0,
          rejectionReasons: {},
          claimsTruncated: 0,
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
            "Upload exactly one file and nothing else.",
          );
        }
        const fileName = sanitizeFileName(upload.rawFileName);
        log.byteLength = upload.bytes.length;
        log.fileKind = fileKindOf(fileName);

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
          let outcome: Awaited<ReturnType<typeof extractClaimDrafts>>;
          try {
            outcome = await extractClaimDrafts({
              client: deps.modelClient,
              models: deps.models,
              sections: parsed.sections,
              documentName: fileName,
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
          log.claimsProposed = outcome.proposedCount;
          log.claimsVerified = outcome.drafts.length;
          log.claimsRejected = outcome.rejected.count;
          log.rejectionReasons = outcome.rejected.reasons;
          log.claimsTruncated = outcome.truncatedCount;
          log.inputTokens = outcome.inputTokens;
          log.cachedInputTokens = outcome.cachedInputTokens;
          log.outputTokens = outcome.outputTokens;

          const body: DocumentExtractResponse = {
            document: {
              fileName,
              fileKind: parsed.fileKind,
              sectionCount: parsed.sections.length,
              characterCount: parsed.characterCount,
            },
            claims: outcome.drafts,
            rejected: outcome.rejected,
            truncatedCount: outcome.truncatedCount,
          };
          log.outcome = "extracted";
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
