import type { SopDocument, SopDocumentItem, SopDocumentSection } from "@sop-agent/sop-core";
import PDFDocument from "pdfkit";
import { toPrintableText } from "./toPrintableText.ts";

export interface RenderedSopPdf {
  bytes: Buffer;
  pageCount: number;
  /** Characters the font cannot draw, printed as `<U+XXXX>` markers. A count only. */
  replacedCharacters: number;
}

const MARGIN_SIDE = 56;
const MARGIN_TOP = 56;
/** Larger than the sides: the footer lives in this band and body text must not reach it. */
const MARGIN_BOTTOM = 72;
const FOOTER_OFFSET_FROM_PAGE_BOTTOM = 40;
const ITEM_INDENT = 14;
const SECTION_MIN_SPACE = 70;

const FONT_REGULAR = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_ITALIC = "Helvetica-Oblique";
const COLOR_TEXT = "#000000";
const COLOR_MUTED = "#444444";

/** What one item prints: its body and its source line, already made safe for the font. */
interface PreparedItem {
  item: SopDocumentItem;
  body: string;
  sourceLine: string;
}

interface PreparedSection {
  section: SopDocumentSection;
  notice: string | null;
  resolved: PreparedItem[];
  open: PreparedItem[];
}

/**
 * Every string that can hold user text is made safe before any layout, so the number of replaced
 * characters is known when the first page (which reports it) is drawn.
 */
function prepareSections(document: SopDocument): {
  sections: PreparedSection[];
  replacedCharacters: number;
} {
  let replacedCharacters = 0;
  const printable = (text: string): string => {
    const result = toPrintableText(text);
    replacedCharacters += result.replacedCharacters;
    return result.text;
  };

  const sections = document.sections.map((section): PreparedSection => {
    const prepared = section.items.map(
      (item): PreparedItem => ({
        item,
        // An unknown item has no text: its note says what is not known.
        body: printable(item.text ?? item.note ?? "not known"),
        sourceLine: printable(item.sourceLine),
      }),
    );
    return {
      section,
      notice: section.gapNotice,
      resolved: prepared.filter((entry) => !entry.item.isUnresolved),
      open: prepared.filter((entry) => entry.item.isUnresolved),
    };
  });
  return { sections, replacedCharacters };
}

/** `2026-09-20T14:32:07.000Z` as `2026-09-20 14:32 UTC`, so the time is the same in every locale. */
function formatUtcTime(isoTimestamp: string): string {
  return `${isoTimestamp.slice(0, 10)} ${isoTimestamp.slice(11, 16)} UTC`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Prints the SOP document model as a PDF, in memory. It takes the model and not a session, so it
 * cannot re-derive anything and cannot disagree with the on-screen preview about order or tags.
 * The bytes depend only on the document: the creation date is the approval time, not the clock.
 */
export function renderSopPdf(document: SopDocument): Promise<RenderedSopPdf> {
  return new Promise((resolve, reject) => {
    try {
      if (document.approvedAt === null) {
        throw new Error("Only an approved SOP can be rendered as a PDF.");
      }
      const approvedAt = document.approvedAt;
      const { sections, replacedCharacters } = prepareSections(document);

      const pdf = new PDFDocument({
        size: "A4",
        margins: {
          top: MARGIN_TOP,
          bottom: MARGIN_BOTTOM,
          left: MARGIN_SIDE,
          right: MARGIN_SIDE,
        },
        bufferPages: true,
        info: {
          Title: document.title,
          Creator: "SOP agent",
          Producer: "SOP agent",
          CreationDate: new Date(approvedAt),
        },
      });

      const chunks: Buffer[] = [];
      pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
      pdf.on("error", reject);

      const contentWidth = pdf.page.width - MARGIN_SIDE * 2;
      const pageBottom = () => pdf.page.height - MARGIN_BOTTOM;
      const ensureSpace = (height: number) => {
        if (pdf.y + height > pageBottom()) pdf.addPage();
      };
      const resetTextStyle = () => pdf.fillColor(COLOR_TEXT).font(FONT_REGULAR).fontSize(10);

      // Document control.
      pdf.font(FONT_BOLD).fontSize(20).text(document.title);
      pdf.moveDown(0.5).font(FONT_REGULAR).fontSize(10);
      pdf.text(`Version: ${document.version}`);
      pdf.text("Status: Approved");
      pdf.text(`Approved at: ${formatUtcTime(approvedAt)}`);
      pdf.text(
        `Claims: ${document.counts.confirmedClaims} confirmed of ${document.counts.totalClaims}`,
      );
      pdf.text(
        `Gaps: ${plural(document.counts.blockingGaps, "blocking gap", "blocking gaps")}, ${plural(
          document.counts.advisoryGaps,
          "advisory gap",
          "advisory gaps",
        )}`,
      );
      if (replacedCharacters > 0) {
        pdf.moveDown(0.5).font(FONT_ITALIC);
        pdf.text(
          `${plural(replacedCharacters, "character", "characters")} outside this PDF's supported ` +
            "font set are shown as Unicode code-point markers.",
        );
        resetTextStyle();
      }

      // Legend.
      if (document.legend.length > 0) {
        pdf.moveDown(1).font(FONT_BOLD).fontSize(11).text("How to read the tags");
        pdf.moveDown(0.3).fontSize(9);
        for (const entry of document.legend) {
          pdf.font(FONT_BOLD).text(`${entry.tag} `, { continued: true });
          pdf.font(FONT_REGULAR).text(entry.meaning);
        }
        resetTextStyle();
      }

      const drawItem = (prepared: PreparedItem, indent: number, stepLabel: string) => {
        ensureSpace(36);
        const x = MARGIN_SIDE + indent;
        const width = contentWidth - indent;
        pdf.fillColor(COLOR_TEXT).fontSize(10);
        pdf.font(FONT_BOLD).text(`${stepLabel}${prepared.item.provenanceTag} `, x, pdf.y, {
          continued: true,
          width,
        });
        pdf.font(prepared.item.text === null ? FONT_ITALIC : FONT_REGULAR).text(prepared.body);
        pdf.fillColor(COLOR_MUTED).font(FONT_REGULAR).fontSize(8);
        pdf.text(prepared.sourceLine, x + ITEM_INDENT, pdf.y, { width: width - ITEM_INDENT });
        pdf.moveDown(0.4);
        resetTextStyle();
      };

      // Sections, in the model's order.
      for (const prepared of sections) {
        const { section } = prepared;
        pdf.x = MARGIN_SIDE;
        pdf.moveDown(1);
        ensureSpace(SECTION_MIN_SPACE);

        pdf
          .font(FONT_BOLD)
          .fontSize(13)
          .text(section.heading, MARGIN_SIDE, pdf.y, {
            continued: section.gapLabel !== null,
          });
        if (section.gapLabel !== null) {
          pdf.font(FONT_REGULAR).fontSize(9).text(`   ${section.gapLabel}`);
        }
        pdf.moveDown(0.2);
        if (prepared.notice !== null) {
          pdf.font(FONT_ITALIC).fontSize(9).fillColor(COLOR_MUTED).text(prepared.notice);
          pdf.moveDown(0.2);
        }
        resetTextStyle();

        for (const entry of prepared.resolved) {
          const stepLabel = entry.item.position === null ? "" : `${entry.item.position}. `;
          drawItem(entry, 0, stepLabel);
        }

        if (prepared.open.length > 0) {
          ensureSpace(SECTION_MIN_SPACE);
          pdf.moveDown(0.3);
          const ruleY = pdf.y;
          pdf
            .moveTo(MARGIN_SIDE, ruleY)
            .lineTo(MARGIN_SIDE + contentWidth, ruleY)
            .lineWidth(0.5)
            .strokeColor(COLOR_MUTED)
            .stroke();
          pdf.moveDown(0.3);
          pdf
            .font(FONT_BOLD)
            .fontSize(9)
            .text("Open items in this section — these are not instructions.", MARGIN_SIDE, pdf.y);
          pdf.moveDown(0.3);
          resetTextStyle();
          for (const entry of prepared.open) {
            const stepLabel = entry.item.position === null ? "" : `Step ${entry.item.position}: `;
            drawItem(entry, ITEM_INDENT, stepLabel);
          }
        }
      }

      // Footers go on last, when the number of pages is known.
      const { count: pageCount } = pdf.bufferedPageRange();
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        pdf.switchToPage(pageIndex);
        const footerY = pdf.page.height - FOOTER_OFFSET_FROM_PAGE_BOTTOM;
        // Text below the bottom margin would start a new page, so the margin is lifted for the footer.
        const bottomMargin = pdf.page.margins.bottom;
        pdf.page.margins.bottom = 0;
        pdf.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_MUTED);
        pdf.text(`${document.title}, version ${document.version}`, MARGIN_SIDE, footerY, {
          width: contentWidth / 2,
          lineBreak: false,
        });
        pdf.text(`Page ${pageIndex + 1} of ${pageCount}`, MARGIN_SIDE, footerY, {
          width: contentWidth,
          align: "right",
          lineBreak: false,
        });
        pdf.page.margins.bottom = bottomMargin;
      }

      pdf.on("end", () => {
        resolve({ bytes: Buffer.concat(chunks), pageCount, replacedCharacters });
      });
      pdf.end();
    } catch (error) {
      reject(error);
    }
  });
}
