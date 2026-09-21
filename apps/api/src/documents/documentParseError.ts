/**
 * Why a document could not be read, as a fixed category. The category is all that leaves this
 * module: a library's own error text can quote the file, so it is never kept or shown.
 */
export const DOCUMENT_FAILURE_CATEGORIES = [
  "unsupported_type",
  "no_text_layer",
  "encrypted",
  "corrupt",
  "too_large",
  "too_many_sections",
  "too_much_text",
  "parse_timeout",
] as const;

export type DocumentFailureCategory = (typeof DOCUMENT_FAILURE_CATEGORIES)[number];

export class DocumentParseError extends Error {
  readonly category: DocumentFailureCategory;

  constructor(category: DocumentFailureCategory) {
    super(category);
    this.name = "DocumentParseError";
    this.category = category;
  }
}
