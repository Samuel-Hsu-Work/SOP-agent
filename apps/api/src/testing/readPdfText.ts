import { createRequire } from "node:module";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** pdfjs needs its bundled font files to read PDFs that use the standard 14 fonts. */
const pdfjsStandardFontsUrl = `${path.join(
  path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
  "standard_fonts",
)}/`;

/**
 * Reads a PDF back as text, one string per page, for tests that check what was actually printed.
 * Text is joined as pdfjs reports it; compare with `collapseWhitespace` so line wrapping does not
 * make an assertion fragile.
 */
export async function readPdfPages(bytes: Uint8Array): Promise<string[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: pdfjsStandardFontsUrl,
  });
  try {
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
          .join(""),
      );
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
