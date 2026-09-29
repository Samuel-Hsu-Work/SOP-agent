import { isWorthTryingAnotherModel } from "./modelErrors.ts";

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
