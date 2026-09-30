/*
 * The errors a `ModelClient` throws, whatever the provider behind it. The OpenAI adapter translates
 * the SDK's own errors into these, so the fallback, the logs and the routes classify a failure
 * without importing the SDK. A provider error keeps the provider's own error only as its `cause`,
 * never in its message, which can quote the conversation. A refusal's message is the model's own
 * refusal text: it is never logged, and the logs classify every failure by kind only.
 */

/** The model declined to answer. Trying another model may succeed. */
export class ModelRefusalError extends Error {}

/** The model answered, but not with usable structured output (cut off, or did not match the schema). */
export class ModelOutputError extends Error {}

/**
 * The request was aborted before the model answered: the caller's signal, or an attempt's own time
 * limit. Another model may still answer when it was the time limit.
 */
export class ModelAbortedError extends Error {}

/**
 * The provider failed the request. `authentication` and `permission` apply to the whole account, so
 * no other model and no retry can fix them; `unavailable` is anything else the provider returned
 * (the SDK has already retried transient failures by then).
 */
export type ModelProviderFailure = "authentication" | "permission" | "unavailable";

export class ModelProviderError extends Error {
  readonly failure: ModelProviderFailure;

  /**
   * `cause` keeps the provider's own error for a developer tool (the live smoke test prints it). It
   * is never logged: the logs classify with `failure` only.
   */
  constructor(failure: ModelProviderFailure, status?: number, cause?: unknown) {
    super(
      `The model provider failed (${failure}${status === undefined ? "" : `, HTTP ${status}`}).`,
      { cause },
    );
    this.failure = failure;
  }
}

function isAccountFailure(error: unknown): boolean {
  return error instanceof ModelProviderError && error.failure !== "unavailable";
}

/** A failure another model can be tried for: everything but an account-wide one. */
export function isWorthTryingAnotherModel(error: unknown): boolean {
  return (
    error instanceof ModelRefusalError ||
    error instanceof ModelOutputError ||
    error instanceof ModelAbortedError ||
    (error instanceof ModelProviderError && !isAccountFailure(error))
  );
}

/** The model could not serve the request, as opposed to a bug in this server. */
export function isModelUnavailable(error: unknown): boolean {
  return (
    error instanceof ModelRefusalError ||
    error instanceof ModelOutputError ||
    error instanceof ModelAbortedError ||
    error instanceof ModelProviderError
  );
}

/** Bad credentials or permissions will not fix themselves, so asking the user to retry is pointless. */
export function isRetryableModelFailure(error: unknown): boolean {
  return !isAccountFailure(error);
}
