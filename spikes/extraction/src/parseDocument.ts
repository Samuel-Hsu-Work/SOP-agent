import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** A citable slice of a document: one PDF page, or one heading's body for DOCX and Markdown. */
export interface DocumentSection {
  location: string;
  text: string;
}

export interface ParsedDocument {
  fileName: string;
  sections: DocumentSection[];
}

export const SUPPORTED_DOCUMENT_EXTENSIONS = [".pdf", ".docx", ".md", ".txt"] as const;

export class UnsupportedDocumentError extends Error {}

/** pdfjs needs its bundled font files to read PDFs that use the standard 14 fonts. */
const pdfjsStandardFontsUrl = `${path.join(
  path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
  "standard_fonts",
)}/`;

export async function parseDocument(filePath: string): Promise<ParsedDocument> {
  const fileName = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".pdf":
      return { fileName, sections: await parsePdfIntoPages(filePath) };
    case ".docx":
      return { fileName, sections: await parseDocxIntoHeadingSections(filePath) };
    case ".md":
      return {
        fileName,
        sections: splitHeadedTextIntoSections(await readFile(filePath, "utf8"), /^#{1,6}\s+(.*)$/),
      };
    case ".txt":
      return {
        fileName,
        sections: [{ location: "full text", text: await readFile(filePath, "utf8") }],
      };
    default:
      throw new UnsupportedDocumentError(
        `Unsupported file type "${extension}". Supported: ${SUPPORTED_DOCUMENT_EXTENSIONS.join(", ")}`,
      );
  }
}

async function parsePdfIntoPages(filePath: string): Promise<DocumentSection[]> {
  const fileBytes = new Uint8Array(await readFile(filePath));
  const loadingTask = getDocument({ data: fileBytes, standardFontDataUrl: pdfjsStandardFontsUrl });
  const pdf = await loadingTask.promise;
  const pages: DocumentSection[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .trim();
      if (text.length > 0) pages.push({ location: `p.${pageNumber}`, text });
    }
  } finally {
    await loadingTask.destroy();
  }

  if (pages.length === 0) {
    throw new UnsupportedDocumentError(
      "This PDF has no extractable text. It may be a scanned image; OCR is not supported.",
    );
  }
  return pages;
}

async function parseDocxIntoHeadingSections(filePath: string): Promise<DocumentSection[]> {
  const { value: html } = await mammoth.convertToHtml({ path: filePath });
  const textWithHeadingMarkers = html
    .replace(/<h[1-6]>(.*?)<\/h[1-6]>/g, (_match, heading: string) => `\n# ${heading}\n`)
    .replace(/<\/p>|<br\s*\/?>|<\/li>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return splitHeadedTextIntoSections(decodeBasicHtmlEntities(textWithHeadingMarkers), /^#\s+(.*)$/);
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Splits text at heading lines; each section's text starts with its own heading line. */
function splitHeadedTextIntoSections(text: string, headingPattern: RegExp): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const seenHeadingCounts = new Map<string, number>();
  let currentLocation = "preamble";
  let currentLines: string[] = [];

  const closeCurrentSection = () => {
    const sectionText = currentLines.join("\n").trim();
    if (sectionText.length > 0) sections.push({ location: currentLocation, text: sectionText });
  };

  for (const line of text.split("\n")) {
    const headingMatch = headingPattern.exec(line);
    if (headingMatch?.[1] !== undefined) {
      closeCurrentSection();
      const heading = headingMatch[1].trim();
      const previousCount = seenHeadingCounts.get(heading) ?? 0;
      seenHeadingCounts.set(heading, previousCount + 1);
      currentLocation =
        previousCount === 0 ? `§ ${heading}` : `§ ${heading} (${previousCount + 1})`;
      currentLines = [heading];
    } else {
      currentLines.push(line);
    }
  }
  closeCurrentSection();
  return sections;
}
