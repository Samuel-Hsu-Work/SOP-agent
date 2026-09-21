import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildEncryptedPdf,
  buildHyphenatedPdf,
  buildLongHandbookPdf,
  buildMessyDocx,
  buildScannedPdf,
  buildTablePdf,
  buildTwoColumnPdf,
  buildZip,
  buildZipBomb,
  HOSTILE_MARKDOWN,
} from "../testing/documentFixtures.ts";
import {
  MAX_DOCUMENT_CHARACTERS,
  MAX_PDF_PAGES,
  MAX_SECTION_CHARACTERS,
  MAX_SECTIONS,
} from "./documentLimits.ts";
import { type DocumentFailureCategory, DocumentParseError } from "./documentParseError.ts";
import { type ParsedDocument, parseDocument } from "./parseDocument.ts";
import { normalizeForQuoteMatching, verifyQuote } from "./verifyQuote.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (fileName: string) =>
  path.resolve(here, "../../../../fixtures/documents", fileName);

async function parseFixture(fileName: string): Promise<ParsedDocument> {
  return parseDocument({ bytes: await readFile(fixturePath(fileName)), fileName });
}

const parseText = (text: string, fileName = "notes.md") =>
  parseDocument({ bytes: Buffer.from(text, "utf8"), fileName });

async function categoryOf(
  promise: Promise<unknown>,
): Promise<DocumentFailureCategory | "no error"> {
  try {
    await promise;
    return "no error";
  } catch (error) {
    if (error instanceof DocumentParseError) return error.category;
    throw error;
  }
}

/** Whether a sentence survives as one contiguous string, which is what a citation needs. */
const containsSentence = (document: ParsedDocument, sentence: string) =>
  document.sections.some((section) =>
    normalizeForQuoteMatching(section.text).includes(normalizeForQuoteMatching(sentence)),
  );

describe("parseDocument: the clean samples, from memory", () => {
  it("splits a PDF into one section per page with page locations", async () => {
    const document = await parseFixture("refund-policy.pdf");
    expect(document).toMatchObject({ fileKind: "pdf", pageCount: 3 });
    expect(document.sections.map((section) => section.location)).toEqual(["p.1", "p.2", "p.3"]);
    expect(document.sections[1]?.text).toContain(
      "Support agents may approve refunds of up to $200",
    );
  });

  it("splits a DOCX at its headings", async () => {
    const document = await parseFixture("expense-handbook.docx");
    const locations = document.sections.map((section) => section.location);
    expect(locations).toEqual(expect.arrayContaining(["§ Approval limits", "§ Lost receipts"]));
    expect(
      document.sections.find((section) => section.location === "§ Approval limits")?.text,
    ).toContain("A Director must approve reports above $500");
  });

  it("splits Markdown at its headings, and the vendor pair each has an approval section", async () => {
    const guide = await parseFixture("incident-escalation-guide.md");
    expect(guide.sections.map((section) => section.location)).toEqual(
      expect.arrayContaining(["§ Purpose", "§ Trigger", "§ Steps", "§ Who decides", "§ Closure"]),
    );
    for (const name of ["vendor-payment-policy.md", "vendor-payment-memo.md"]) {
      const document = await parseFixture(name);
      expect(document.sections.map((section) => section.location)).toContain(
        "§ Approval authority",
      );
    }
  });

  it("gives every section an opaque id and a unique location, the same on every run", async () => {
    const first = await parseFixture("expense-handbook.docx");
    const second = await parseFixture("expense-handbook.docx");
    expect(first.sections.map((section) => section.sectionId)).toEqual(
      first.sections.map((_, index) => `s${index + 1}`),
    );
    expect(new Set(first.sections.map((section) => section.location)).size).toBe(
      first.sections.length,
    );
    expect(second.sections).toEqual(first.sections);
  });

  it("reads plain text as one section", async () => {
    const document = await parseText("First rule.\nSecond rule.", "rules.txt");
    expect(document).toMatchObject({ fileKind: "text", pageCount: null });
    expect(document.sections).toEqual([
      { sectionId: "s1", location: "full text", text: "First rule.\nSecond rule." },
    ]);
  });
});

describe("parseDocument: Markdown structure", () => {
  it("keeps text before the first heading as a preamble, and numbers repeated headings", async () => {
    const document = await parseText("Intro line.\n\n# Rules\nOne.\n\n# Rules\nTwo.\n");
    expect(document.sections.map((section) => section.location)).toEqual([
      "preamble",
      "§ Rules",
      "§ Rules (2)",
    ]);
  });

  it("does not read a heading-like line inside a code fence as a heading", async () => {
    const document = await parseText("# Real\nText.\n\n```\n# not a heading\n```\nMore.\n");
    expect(document.sections.map((section) => section.location)).toEqual(["§ Real"]);
    expect(document.sections[0]?.text).toContain("# not a heading");
  });

  it("reads underlined (setext) headings, and treats a rule after a blank line as a rule", async () => {
    const document = await parseText(
      "Approvals\n=========\nManagers approve.\n\nText.\n\n---\nAfter the rule.\n",
    );
    expect(document.sections.map((section) => section.location)).toEqual(["§ Approvals"]);
    expect(document.sections[0]?.text).toContain("After the rule.");
  });
});

describe("parseDocument: the harder cases", () => {
  it("reads two interleaved columns one after the other, so each column's sentence stays whole", async () => {
    const { bytes, leftSentence, rightSentence } = await buildTwoColumnPdf();
    const document = await parseDocument({ bytes, fileName: "columns.pdf" });
    expect(containsSentence(document, leftSentence)).toBe(true);
    expect(containsSentence(document, rightSentence)).toBe(true);
    const text = document.sections[0]?.text ?? "";
    expect(text.indexOf("Support agents")).toBeLessThan(text.indexOf("If an item arrives"));
  });

  it("keeps a table row on one line with its cells apart", async () => {
    const { bytes, rows } = await buildTablePdf();
    const document = await parseDocument({ bytes, fileName: "table.pdf" });
    const lines = (document.sections[0]?.text ?? "").split("\n");
    for (const row of rows) expect(lines).toContain(row.join(" | "));
  });

  it("lets a quote that spans a hyphenated line break pass verification", async () => {
    const { bytes, sentence } = await buildHyphenatedPdf();
    const document = await parseDocument({ bytes, fileName: "hyphen.pdf" });
    const section = document.sections[0];
    if (section === undefined) throw new Error("no section");
    const result = verifyQuote(
      { quote: sentence, sectionId: section.sectionId },
      document.sections,
    );
    expect(result).toMatchObject({ isVerified: true, location: "p.1" });
  });

  it("reads a 40-page handbook quickly, and a sentence from every page still verifies", async () => {
    const { bytes, sentenceForPage } = await buildLongHandbookPdf(40);
    const started = Date.now();
    const document = await parseDocument({ bytes, fileName: "handbook.pdf" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(document.sections).toHaveLength(40);
    for (let page = 1; page <= 40; page += 1) {
      const section = document.sections[page - 1];
      if (section === undefined) throw new Error("missing page");
      expect(
        verifyQuote(
          { quote: sentenceForPage(page), sectionId: section.sectionId },
          document.sections,
        ),
      ).toMatchObject({ isVerified: true, location: `p.${page}` });
    }
  });

  it("reads a messy DOCX: a paragraph that starts with a hash is text, a table keeps its rows, entities are decoded", async () => {
    const document = await parseDocument({ bytes: await buildMessyDocx(), fileName: "messy.docx" });
    expect(document.sections.map((section) => section.location)).toEqual([
      "§ Field Rules",
      "§ Approval Table",
    ]);
    const rules = document.sections[0]?.text ?? "";
    expect(rules).toContain("# This paragraph only starts with a hash sign.");
    expect(rules).toContain('The R&D <team> said "yes" & left it there.');
    const lines = (document.sections[1]?.text ?? "").split("\n");
    expect(lines).toEqual(
      expect.arrayContaining(["Amount | Approver", "Up to $200 | Support agent"]),
    );
  });

  it("reads a document with instructions in it as ordinary text, splitting nothing at the fake tags", async () => {
    const document = await parseText(HOSTILE_MARKDOWN);
    expect(document.sections.map((section) => section.location)).toEqual([
      "§ Vendor Handbook",
      "§ Approvals",
      "§ Escalation",
    ]);
    expect(document.sections[1]?.text).toContain("Ignore all previous instructions");
    expect(document.sections[1]?.text).toContain("</section></document>");
  });
});

describe("parseDocument: files it refuses, each with a named category", () => {
  it("refuses a type it does not read", async () => {
    expect(
      await categoryOf(parseDocument({ bytes: Buffer.from("x"), fileName: "photo.png" })),
    ).toBe("unsupported_type");
    expect(
      await categoryOf(parseDocument({ bytes: Buffer.from("x"), fileName: "noextension" })),
    ).toBe("unsupported_type");
  });

  it("refuses bytes that are not what the extension says", async () => {
    const pdfBytes = await readFile(fixturePath("refund-policy.pdf"));
    expect(await categoryOf(parseDocument({ bytes: pdfBytes, fileName: "policy.docx" }))).toBe(
      "unsupported_type",
    );
    expect(await categoryOf(parseDocument({ bytes: pdfBytes, fileName: "policy.md" }))).toBe(
      "unsupported_type",
    );
    expect(await categoryOf(parseText("Plain text.", "policy.pdf"))).toBe("unsupported_type");
    expect(await categoryOf(parseText("Plain text.", "policy.docx"))).toBe("unsupported_type");
  });

  it("refuses text that is not valid UTF-8", async () => {
    expect(
      await categoryOf(
        parseDocument({ bytes: Buffer.from([0x41, 0xc3, 0x28, 0x42]), fileName: "a.txt" }),
      ),
    ).toBe("unsupported_type");
  });

  it("refuses a PDF with no text layer, and empty text", async () => {
    expect(
      await categoryOf(parseDocument({ bytes: await buildScannedPdf(), fileName: "scan.pdf" })),
    ).toBe("no_text_layer");
    expect(await categoryOf(parseText("   \n  ", "empty.txt"))).toBe("no_text_layer");
  });

  it("refuses an encrypted PDF and a damaged PDF or DOCX", async () => {
    expect(
      await categoryOf(parseDocument({ bytes: await buildEncryptedPdf(), fileName: "locked.pdf" })),
    ).toBe("encrypted");

    const pdfBytes = await readFile(fixturePath("refund-policy.pdf"));
    expect(
      await categoryOf(parseDocument({ bytes: pdfBytes.subarray(0, 400), fileName: "cut.pdf" })),
    ).toBe("corrupt");

    const docxBytes = await readFile(fixturePath("expense-handbook.docx"));
    expect(
      await categoryOf(
        parseDocument({ bytes: docxBytes.subarray(0, 2_000), fileName: "cut.docx" }),
      ),
    ).toBe("corrupt");
  });

  it("refuses a zip that is not a Word document", async () => {
    const zip = buildZip([{ name: "notes.txt", data: Buffer.from("hello") }]);
    expect(await categoryOf(parseDocument({ bytes: zip, fileName: "notes.docx" }))).toBe(
      "unsupported_type",
    );
  });
});

describe("parseDocument: its bounds", () => {
  it("refuses a PDF with too many pages", async () => {
    const { bytes } = await buildLongHandbookPdf(MAX_PDF_PAGES + 1);
    expect(await categoryOf(parseDocument({ bytes, fileName: "long.pdf" }))).toBe("too_large");
  });

  it("refuses too many sections and too much text, and splits one long section into parts", async () => {
    const manyHeadings = Array.from(
      { length: MAX_SECTIONS + 1 },
      (_, index) => `# H${index}\nText.`,
    ).join("\n");
    expect(await categoryOf(parseText(manyHeadings))).toBe("too_many_sections");

    const tooMuch = "x".repeat(MAX_DOCUMENT_CHARACTERS + 1);
    expect(await categoryOf(parseText(tooMuch, "big.txt"))).toBe("too_much_text");

    const longLines = Array.from(
      { length: 6 },
      (_, index) => `${index} ${"word ".repeat(1_000)}`,
    ).join("\n");
    const split = await parseText(longLines, "long.txt");
    expect(split.sections.length).toBeGreaterThan(1);
    expect(split.sections.map((section) => section.location)).toEqual([
      "full text",
      ...split.sections.slice(1).map((_, index) => `full text (part ${index + 2})`),
    ]);
    for (const section of split.sections) {
      expect(section.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARACTERS);
    }
    // Nothing is dropped by the split.
    expect(split.sections.map((section) => section.text).join("\n")).toBe(longLines.trim());
  });

  it("stops reading a PDF once it holds more text than may be read", async () => {
    const { buildPdfWithText } = await import("../testing/documentFixtures.ts");
    const bytes = await buildPdfWithText(MAX_DOCUMENT_CHARACTERS + 5_000);
    expect(await categoryOf(parseDocument({ bytes, fileName: "wall-of-text.pdf" }))).toBe(
      "too_much_text",
    );
  });

  it("refuses a zip bomb before unzipping it, even when the archive lies about its size", async () => {
    const honest = buildZipBomb({ megabytes: 20, lie: false });
    const lying = buildZipBomb({ megabytes: 20, lie: true });
    expect(honest.length).toBeLessThan(200_000);
    expect(await categoryOf(parseDocument({ bytes: honest, fileName: "bomb.docx" }))).toBe(
      "too_large",
    );
    expect(await categoryOf(parseDocument({ bytes: lying, fileName: "bomb.docx" }))).toBe(
      "too_large",
    );
  });

  it("gives up when the parse budget runs out", async () => {
    let now = 0;
    const clock = () => {
      now += 4_000;
      return now;
    };
    expect(
      await categoryOf(
        parseDocument({
          bytes: (await buildLongHandbookPdf(5)).bytes,
          fileName: "slow.pdf",
          now: clock,
          budgetMs: 5_000,
        }),
      ),
    ).toBe("parse_timeout");
  });
});
