/**
 * Size limits for a session. The schema enforces them, so a tampered session cannot inflate the
 * prompt or the model bill. Nothing is ever silently truncated; over-limit input is rejected.
 */
/** Room to paste a long description, or the text of a short policy, into one message. */
export const MAX_USER_MESSAGE_LENGTH = 12_000;
export const MAX_ASSISTANT_MESSAGE_LENGTH = 8_000;
export const MAX_STATEMENT_LENGTH = 2_000;
export const MAX_NOTE_LENGTH = 1_000;
export const MAX_IDENTIFIER_LENGTH = 100;
export const MAX_MESSAGES = 200;
export const MAX_CLAIMS = 500;
export const MAX_HISTORY_ENTRIES = 500;

/**
 * The most claims the agent may write in answer to one message. Sized for a person who describes
 * the whole process at once: all 13 fields, a procedure of a couple of dozen steps, and several
 * roles, exceptions and controls. Calls past it are dropped and reported, never silently lost.
 */
export const MAX_TOOL_CALLS_PER_MESSAGE = 48;

/**
 * The most text all active claims and notes may hold together. The per-item limits alone allow a
 * session far larger than any prompt should be, so this bounds it. A session over the cap is
 * refused, never truncated, because every claim has to stay addressable for corrections. A document
 * claim's citation counts too.
 */
export const MAX_TOTAL_CLAIM_TEXT = 60_000;

/** The citation a document claim carries. The quote is verified against the document by the API. */
export const MIN_QUOTE_LENGTH = 15;
export const MAX_QUOTE_LENGTH = 300;
export const MAX_DOCUMENT_NAME_LENGTH = 200;
export const MAX_DOCUMENT_LOCATION_LENGTH = 120;

/**
 * The most a serialized session may weigh in the browser. Every chat and PDF request carries the
 * whole session and the API's body limit is 1 MiB, so a session past this would fit in storage but
 * could no longer be sent. Uploading a document is refused if it would cross it.
 */
export const MAX_SESSION_TRANSPORT_BYTES = 786_432;
