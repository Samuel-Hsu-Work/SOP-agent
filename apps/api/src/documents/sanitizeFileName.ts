import path from "node:path";
import { MAX_DOCUMENT_NAME_LENGTH } from "@sop-agent/sop-core";

const FALLBACK_NAME = "Uploaded document";

/**
 * Control characters, and the characters that reorder or hide text on screen: the zero-width and
 * direction marks, the embedding and isolate controls, and the byte order mark.
 */
function isUnsafeCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/**
 * The name a person sees beside every claim from this document. It is the one piece of text the
 * uploader fully controls, so it is cleaned before anything keeps it: no path, no control or
 * direction-changing characters, one line, and a length limit that keeps the extension. It is never
 * sent to a model and never logged.
 */
export function sanitizeFileName(rawName: string): string {
  const withoutPath = rawName.split(/[\\/]/).pop() ?? "";
  const visible = Array.from(withoutPath.normalize("NFC"), (character) =>
    isUnsafeCodePoint(character.codePointAt(0) ?? 0) ? " " : character,
  ).join("");
  const cleaned = visible.replace(/\s+/g, " ").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return FALLBACK_NAME;
  if (cleaned.length <= MAX_DOCUMENT_NAME_LENGTH) return cleaned;

  const extension = path.extname(cleaned).slice(0, 10);
  return `${cleaned.slice(0, MAX_DOCUMENT_NAME_LENGTH - extension.length)}${extension}`;
}
