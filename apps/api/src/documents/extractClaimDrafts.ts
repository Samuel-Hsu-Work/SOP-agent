import {
  type ClaimDraft,
  MAX_EXTRACTED_CLAIMS_PER_DOCUMENT,
  type QuoteRejectionReason,
} from "@sop-agent/sop-core";
import { classifyModelError, type ModelFailureKind } from "../logging.ts";
import type { ModelClient } from "../model/modelClient.ts";
import { runWithModelFallback } from "../model/modelFallback.ts";
import { EXTRACTION_MAX_OUTPUT_TOKENS, EXTRACTION_TIMEOUT_MS } from "./documentLimits.ts";
import { EXTRACTION_INSTRUCTIONS, renderDocumentInput } from "./extractionPrompt.ts";
import { EXTRACTION_SCHEMA_NAME, extractionOutputSchema } from "./extractionSchema.ts";
import type { ParsedSection } from "./parseDocument.ts";
import { verifyCandidates } from "./verifyQuote.ts";

export interface ExtractionOutcome {
  drafts: ClaimDraft[];
  rejected: { count: number; reasons: Partial<Record<QuoteRejectionReason, number>> };
  /** Verified drafts dropped because the document already added the most a document may. */
  truncatedCount: number;
  /** How many candidates the model proposed, before verification. */
  proposedCount: number;
  servedByModel: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ExtractClaimDraftsInput {
  client: ModelClient;
  models: readonly string[];
  sections: readonly ParsedSection[];
  documentName: string;
  signal: AbortSignal;
  /**
   * Filled with each attempt that failed, by model and category, so the caller has it even when
   * every model fails. The error's own text is never kept: it can quote the document.
   */
  failedAttempts: { model: string; kind: ModelFailureKind }[];
}

/**
 * Asks the model for the rules in a parsed document and keeps only those whose quote code can
 * prove. The whole extraction is what falls back to the second model, as a chat turn does: a failed
 * attempt leaves nothing behind. Each attempt has its own time limit.
 */
export async function extractClaimDrafts(
  input: ExtractClaimDraftsInput,
): Promise<ExtractionOutcome> {
  const { value, servedByModel } = await runWithModelFallback([...input.models], async (model) => {
    try {
      return await input.client.runExtraction({
        model,
        instructions: EXTRACTION_INSTRUCTIONS,
        input: renderDocumentInput(input.sections),
        schema: extractionOutputSchema,
        schemaName: EXTRACTION_SCHEMA_NAME,
        maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(EXTRACTION_TIMEOUT_MS)]),
      });
    } catch (error) {
      input.failedAttempts.push({ model, kind: classifyModelError(error) });
      throw error;
    }
  });

  const verified = verifyCandidates(value.output.claims, input.sections, input.documentName);
  const kept = verified.drafts.slice(0, MAX_EXTRACTED_CLAIMS_PER_DOCUMENT);
  return {
    drafts: kept,
    rejected: verified.rejected,
    truncatedCount: verified.drafts.length - kept.length,
    proposedCount: value.output.claims.length,
    servedByModel,
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
  };
}
