import {
  disagreesWithWhatWasSaid,
  isAlreadyStated,
  MAX_PASSAGES_PER_UPLOAD,
  type PassageDraft,
  type QuoteRejectionReason,
  type SopSession,
  sopTargetOf,
  statedClaimsInReadingOrder,
} from "@sop-agent/sop-core";
import { classifyModelError, type ModelFailureKind } from "../logging.ts";
import type { ModelClient } from "../model/modelClient.ts";
import { runWithModelFallback } from "../model/modelFallback.ts";
import { EXTRACTION_MAX_OUTPUT_TOKENS, EXTRACTION_TIMEOUT_MS } from "./documentLimits.ts";
import { EXTRACTION_INSTRUCTIONS, renderDocumentInput } from "./extractionPrompt.ts";
import { EXTRACTION_SCHEMA_NAME, extractionOutputSchema } from "./extractionSchema.ts";
import type { ParsedSection } from "./parseDocument.ts";
import { verifyCandidates } from "./verifyQuote.ts";

export interface ReadingOutcome {
  passages: PassageDraft[];
  rejected: { count: number; reasons: Partial<Record<QuoteRejectionReason, number>> };
  /** Verified passages dropped because the SOP already says the same thing. */
  alreadyKnownCount: number;
  /** Verified passages dropped because one upload keeps at most `MAX_PASSAGES_PER_UPLOAD`. */
  truncatedCount: number;
  /** Kept passages that disagree with what the person said, and will be raised as conflicts. */
  potentialConflictCount: number;
  /** How many candidates the model proposed, before verification. */
  proposedCount: number;
  servedByModel: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ReadReferencePassagesInput {
  client: ModelClient;
  models: readonly string[];
  sections: readonly ParsedSection[];
  documentName: string;
  /** The session the passages are read for: its purpose and scope, and what it already says. */
  session: SopSession;
  signal: AbortSignal;
  /**
   * Filled with each attempt that failed, by model and category, so the caller has it even when
   * every model fails. The error's own text is never kept: it can quote the document.
   */
  failedAttempts: { model: string; kind: ModelFailureKind }[];
}

/**
 * A passage that disagrees with what the person said comes first: the SOP cannot be finished until
 * they settle it, so it must never be the one a cap drops. The rest keep the reader's own order,
 * which it was asked to give with the passages this SOP needs most first. Ranking them by their
 * field instead would favour a passage the reader filed under the wrong field: a manual test kept
 * general rules mislabelled as procedure steps and dropped the closing and clock-out times.
 */
function needRank(session: SopSession, passage: PassageDraft): number {
  return disagreesWithWhatWasSaid(session, passage) ? 0 : 1;
}

/**
 * Asks the model for the passages of a parsed document that the session's SOP needs, and keeps only
 * those whose quote code can prove, whose numbers the quote holds, and that the SOP does not already
 * say. The whole reading is what falls back to the second model, as a chat turn does: a failed
 * attempt leaves nothing behind. Each attempt has its own time limit.
 */
export async function readReferencePassages(
  input: ReadReferencePassagesInput,
): Promise<ReadingOutcome> {
  const target = sopTargetOf(input.session);
  const alreadyStated = statedClaimsInReadingOrder(input.session).map((claim) => ({
    field: claim.field,
    statement: claim.value?.text ?? "",
  }));
  const readerInput = renderDocumentInput({
    purpose: target.purpose,
    scope: target.scope,
    alreadyStated,
    sections: input.sections,
  });

  const { value, servedByModel } = await runWithModelFallback([...input.models], async (model) => {
    try {
      return await input.client.runStructuredOutput({
        model,
        instructions: EXTRACTION_INSTRUCTIONS,
        input: readerInput,
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

  const verified = verifyCandidates(value.output.passages, input.sections, input.documentName);
  const unknown = verified.drafts.filter((draft) => !isAlreadyStated(input.session, draft));
  const ranked = unknown
    .map((draft, index) => ({ draft, index, rank: needRank(input.session, draft) }))
    .sort((first, second) => first.rank - second.rank || first.index - second.index);
  const kept = ranked.slice(0, MAX_PASSAGES_PER_UPLOAD);
  return {
    passages: kept.map(({ draft }) => draft),
    rejected: verified.rejected,
    alreadyKnownCount: verified.drafts.length - unknown.length,
    truncatedCount: unknown.length - kept.length,
    potentialConflictCount: kept.filter(({ rank }) => rank === 0).length,
    proposedCount: value.output.passages.length,
    servedByModel,
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
  };
}
