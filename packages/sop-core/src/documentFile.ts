/**
 * What an uploaded document can be. The stored reference material records it, and the upload's wire
 * format and the extension table both build on it; the API also checks the bytes, never the
 * extension alone.
 */
export const DOCUMENT_FILE_KINDS = ["pdf", "docx", "markdown", "text"] as const;
export type DocumentFileKind = (typeof DOCUMENT_FILE_KINDS)[number];
