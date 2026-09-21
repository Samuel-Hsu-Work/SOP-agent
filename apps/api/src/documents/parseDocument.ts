import { createRequire } from "node:module";
import path from "node:path";
import { DOCUMENT_EXTENSIONS, type DocumentFileKind } from "@sop-agent/sop-core";
import mammoth from "mammoth";
import { type HTMLElement, type Node, parse } from "node-html-parser";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  MAX_DOCUMENT_CHARACTERS,
  MAX_PDF_PAGES,
  MAX_SECTIONS,
  PARSE_BUDGET_MS,
} from "./documentLimits.ts";
import { DocumentParseError } from "./documentParseError.ts";
import {
  type MarkedLine,
  splitLongSections,
  splitMarkdownIntoSections,
  splitMarkedLinesIntoSections,
  type TextSection,
} from "./headedText.ts";
import { layoutPageText, type PositionedText } from "./pdfLayout.ts";
import { checkZipBounds } from "./zipBounds.ts";

export interface ParsedSection {
  /** An opaque id the model cites. Nothing about it comes from the document. */
  sectionId: string;
  /** What a person sees: "p.4" or "§ Approval authority". Built by code from a page number or heading. */
  location: string;
  text: string;
}

export interface ParsedDocument {
  fileKind: DocumentFileKind;
  sections: ParsedSection[];
  /** Pages for a PDF, otherwise null. */
  pageCount: number | null;
  characterCount: number;
}

export interface ParseDocumentInput {
  bytes: Uint8Array;
  /** Only the extension is read: it says which kind to expect, and the bytes must agree. */
  fileName: string;
  /** For tests; defaults to the real clock. */
  now?: () => number;
  budgetMs?: number;
}

/** pdfjs needs its bundled font files to read PDFs that use the standard 14 fonts. */
const pdfjsStandardFontsUrl = `${path.join(
  path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
  "standard_fonts",
)}/`;

const PDF_SIGNATURE = "%PDF-";
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const BINARY_SNIFF_LENGTH = 8_192;

function detectFileKind(bytes: Buffer, fileName: string): DocumentFileKind {
  const kind = DOCUMENT_EXTENSIONS[path.extname(fileName).toLowerCase()];
  if (kind === undefined) throw new DocumentParseError("unsupported_type");

  switch (kind) {
    case "pdf":
      if (!bytes.subarray(0, 1_024).toString("latin1").includes(PDF_SIGNATURE)) {
        throw new DocumentParseError("unsupported_type");
      }
      return kind;
    case "docx":
      if (!bytes.subarray(0, 4).equals(ZIP_SIGNATURE))
        throw new DocumentParseError("unsupported_type");
      return kind;
    case "markdown":
    case "text":
      // A text file has no NUL bytes and is valid UTF-8; anything else is a binary file renamed.
      if (bytes.subarray(0, BINARY_SNIFF_LENGTH).includes(0)) {
        throw new DocumentParseError("unsupported_type");
      }
      return kind;
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    throw new DocumentParseError("unsupported_type");
  }
}

function makeBudget(input: ParseDocumentInput): () => void {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? PARSE_BUDGET_MS);
  return () => {
    if (now() > deadline) throw new DocumentParseError("parse_timeout");
  };
}

async function parsePdf(
  bytes: Buffer,
  checkBudget: () => void,
): Promise<{
  sections: TextSection[];
  pageCount: number;
}> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: pdfjsStandardFontsUrl,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    let pdf: Awaited<typeof loadingTask.promise>;
    try {
      pdf = await loadingTask.promise;
    } catch (error) {
      const name = (error as { name?: string }).name;
      throw new DocumentParseError(name === "PasswordException" ? "encrypted" : "corrupt");
    }
    if (pdf.numPages > MAX_PDF_PAGES) throw new DocumentParseError("too_large");

    const sections: TextSection[] = [];
    let characterTotal = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      checkBudget();
      let items: PositionedText[];
      try {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        items = content.items.flatMap((item) =>
          "str" in item
            ? [
                {
                  text: item.str,
                  x: item.transform[4] ?? 0,
                  y: item.transform[5] ?? 0,
                  width: item.width,
                  height: item.height || Math.abs(item.transform[3] ?? 0) || 10,
                },
              ]
            : [],
        );
      } catch {
        throw new DocumentParseError("corrupt");
      }
      const text = layoutPageText(items).trim();
      // Stop as soon as the document holds more text than may be read, not after every page.
      characterTotal += text.length;
      if (characterTotal > MAX_DOCUMENT_CHARACTERS) throw new DocumentParseError("too_much_text");
      // Blank pages are skipped, but the numbering of the rest is kept.
      if (text.length > 0) sections.push({ location: `p.${pageNumber}`, text });
    }
    return { sections, pageCount: pdf.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

/** Plain text lines from Mammoth's HTML, headings marked and table cells joined by " | ". */
function htmlToLines(html: string): MarkedLine[] {
  const lines: MarkedLine[] = [];
  let inline = "";
  const flush = () => {
    const line = inline.replace(/\s+/g, " ").trim();
    if (line.length > 0) lines.push({ heading: null, line });
    inline = "";
  };
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        inline += (child as unknown as { text: string }).text;
        continue;
      }
      const element = child as HTMLElement;
      const tag = element.rawTagName?.toLowerCase() ?? "";
      if (/^h[1-6]$/.test(tag)) {
        flush();
        const heading = element.text.replace(/\s+/g, " ").trim();
        if (heading.length > 0) lines.push({ heading, line: heading });
      } else if (tag === "tr") {
        flush();
        const cells = element
          .querySelectorAll("td, th")
          .map((cell) => cell.text.replace(/\s+/g, " ").trim())
          .filter((cell) => cell.length > 0);
        if (cells.length > 0) lines.push({ heading: null, line: cells.join(" | ") });
      } else if (tag === "br") {
        flush();
      } else if (["p", "li", "div", "blockquote"].includes(tag)) {
        flush();
        walk(element);
        flush();
      } else {
        walk(element);
      }
    }
  };
  walk(parse(html));
  flush();
  return lines;
}

async function parseDocx(bytes: Buffer): Promise<TextSection[]> {
  const entryNames = checkZipBounds(bytes);
  if (!entryNames.includes("word/document.xml")) throw new DocumentParseError("unsupported_type");
  let html: string;
  try {
    html = (
      await mammoth.convertToHtml(
        { buffer: bytes },
        // Only the text is wanted. By default an embedded image is inlined as base64, which can
        // make the HTML many times the size of the text for nothing.
        { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
      )
    ).value;
  } catch {
    throw new DocumentParseError("corrupt");
  }
  return splitMarkedLinesIntoSections(htmlToLines(html));
}

/**
 * Reads an uploaded document from memory into sections a claim can cite. Everything here is
 * bounded, and every failure is a `DocumentParseError` with a fixed category: nothing a library
 * says about the file leaves this function. The bytes are never written anywhere.
 */
export async function parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const checkBudget = makeBudget(input);
  const fileKind = detectFileKind(bytes, input.fileName);

  let rawSections: TextSection[];
  let pageCount: number | null = null;
  switch (fileKind) {
    case "pdf": {
      const parsed = await parsePdf(bytes, checkBudget);
      rawSections = parsed.sections;
      pageCount = parsed.pageCount;
      break;
    }
    case "docx":
      rawSections = await parseDocx(bytes);
      break;
    case "markdown":
      rawSections = splitMarkdownIntoSections(decodeUtf8(bytes));
      break;
    case "text": {
      const text = decodeUtf8(bytes).trim();
      rawSections = text.length > 0 ? [{ location: "full text", text }] : [];
      break;
    }
  }
  checkBudget();

  const sections = splitLongSections(rawSections);
  const characterCount = sections.reduce((total, section) => total + section.text.length, 0);
  if (characterCount === 0) throw new DocumentParseError("no_text_layer");
  if (characterCount > MAX_DOCUMENT_CHARACTERS) throw new DocumentParseError("too_much_text");
  if (sections.length > MAX_SECTIONS) throw new DocumentParseError("too_many_sections");

  return {
    fileKind,
    pageCount,
    characterCount,
    sections: sections.map((section, index) => ({ sectionId: `s${index + 1}`, ...section })),
  };
}
