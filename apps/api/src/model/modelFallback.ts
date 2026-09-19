import OpenAI from "openai";

export const DEFAULT_PRIMARY_MODEL = "gpt-5.6-sol";
export const DEFAULT_FALLBACK_MODEL = "gpt-5.6-luna";

/** Ordered list of models to try: the primary first, then the fallback. */
export function readModelsFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): string[] {
  return [
    environment.LLM_MODEL || DEFAULT_PRIMARY_MODEL,
    environment.LLM_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL,
  ];
}

/** The model declined to answer. Trying another model may succeed. */
export class ModelRefusalError extends Error {}

/** The model answered, but not with usable structured output (cut off, or did not match the schema). */
export class ModelOutputError extends Error {}

export interface FailedModelAttempt {
  model: string;
  reason: string;
}

export interface FallbackResult<T> {
  value: T;
  servedByModel: string;
  failedAttempts: FailedModelAttempt[];
}

/**
 * Errors that another model cannot fix: bad credentials or permissions apply to the whole account,
 * and the SDK has already retried transient failures by the time an error reaches this code.
 */
function isWorthTryingAnotherModel(error: unknown): boolean {
  if (error instanceof ModelRefusalError || error instanceof ModelOutputError) return true;
  if (error instanceof OpenAI.AuthenticationError) return false;
  if (error instanceof OpenAI.PermissionDeniedError) return false;
  return error instanceof OpenAI.APIError;
}

/**
 * Runs `attemptWithModel` against each model in order and returns the first success.
 * Throws the last error if every model fails, or the first error that another model cannot fix.
 */
export async function runWithModelFallback<T>(
  models: string[],
  attemptWithModel: (model: string) => Promise<T>,
): Promise<FallbackResult<T>> {
  const failedAttempts: FailedModelAttempt[] = [];
  let lastError: unknown;

  for (const model of models) {
    try {
      const value = await attemptWithModel(model);
      return { value, servedByModel: model, failedAttempts };
    } catch (error) {
      if (!isWorthTryingAnotherModel(error)) throw error;
      lastError = error;
      failedAttempts.push({
        model,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError ?? new Error("No models were configured.");
}
