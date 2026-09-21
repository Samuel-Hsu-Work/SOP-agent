/**
 * Bounds for reading an uploaded document. An upload is unauthenticated input that costs memory,
 * time and model money, so each of these is checked before the work it guards, and a document over
 * a bound is refused with a named category, never truncated.
 */
export { MAX_EXTRACTED_CLAIMS_PER_DOCUMENT, MAX_UPLOAD_BYTES } from "@sop-agent/sop-core";

export const MAX_PDF_PAGES = 60;
export const MAX_SECTIONS = 200;
/** A longer section is split into parts, so one section never dominates a prompt. */
export const MAX_SECTION_CHARACTERS = 20_000;
export const MAX_DOCUMENT_CHARACTERS = 100_000;

/** DOCX is a zip. These bound what unzipping it may cost, whatever the archive claims about itself. */
export const MAX_ZIP_ENTRIES = 500;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;

/** A soft budget for reading a file, checked between pages and sections. A hard limit needs a worker (slice 6). */
export const PARSE_BUDGET_MS = 10_000;

/** The model call: per attempt, and the room it has to write its answer. */
export const EXTRACTION_TIMEOUT_MS = 60_000;
export const EXTRACTION_MAX_OUTPUT_TOKENS = 8_000;

/** How many documents may be read at once. Resource protection, not a per-user rate limit. */
export const MAX_CONCURRENT_EXTRACTIONS = 2;

/** The longest file name kept. Longer names are cut, never rejected. */
export const MAX_FILE_NAME_LENGTH = 200;
