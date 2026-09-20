/**
 * Size limits for a session. The schema enforces them, so a tampered session cannot inflate the
 * prompt or the model bill. Nothing is ever silently truncated; over-limit input is rejected.
 */
export const MAX_USER_MESSAGE_LENGTH = 4_000;
export const MAX_ASSISTANT_MESSAGE_LENGTH = 8_000;
export const MAX_STATEMENT_LENGTH = 2_000;
export const MAX_NOTE_LENGTH = 1_000;
export const MAX_IDENTIFIER_LENGTH = 100;
export const MAX_MESSAGES = 200;
export const MAX_CLAIMS = 500;
export const MAX_HISTORY_ENTRIES = 500;
export const MAX_TOOL_CALLS_PER_MESSAGE = 16;

/**
 * The most text all active claims and notes may hold together. The per-item limits alone allow a
 * session far larger than any prompt should be, so this bounds it. A session over the cap is
 * refused, never truncated, because every claim has to stay addressable for corrections.
 */
export const MAX_TOTAL_CLAIM_TEXT = 40_000;
