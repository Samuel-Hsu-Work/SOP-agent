import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument, UnsupportedDocumentError } from "./parseDocument.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (fileName: string) => path.resolve(here, "../../../fixtures/documents", fileName);

describe("parseDocument", () => {
  it("splits a PDF into one section per page with page locations", async () => {
    const { sections } = await parseDocument(fixture("refund-policy.pdf"));
    expect(sections.map((section) => section.location)).toEqual(["p.1", "p.2", "p.3"]);
    expect(sections[1]?.text).toContain("Support agents may approve refunds of up to $200");
    expect(sections[2]?.text).toContain("QA team audits");
  });

  it("splits a DOCX at its headings", async () => {
    const { sections } = await parseDocument(fixture("expense-handbook.docx"));
    const locations = sections.map((section) => section.location);
    expect(locations).toContain("§ Approval limits");
    expect(locations).toContain("§ Lost receipts");
    const approvalLimits = sections.find((section) => section.location === "§ Approval limits");
    expect(approvalLimits?.text).toContain("A Director must approve reports above $500");
  });

  it("splits Markdown at its headings", async () => {
    const { sections } = await parseDocument(fixture("incident-escalation-guide.md"));
    const locations = sections.map((section) => section.location);
    expect(locations).toEqual(
      expect.arrayContaining(["§ Purpose", "§ Trigger", "§ Steps", "§ Who decides", "§ Closure"]),
    );
  });

  it("rejects an unsupported file type with a clear error", async () => {
    await expect(parseDocument(fixture("photo.png"))).rejects.toBeInstanceOf(
      UnsupportedDocumentError,
    );
  });
});
