import {
  applyClaim,
  buildSopDocument,
  type Claim,
  type SopDocument,
  type SopSession,
} from "@sop-agent/sop-core";
import {
  buildClaim,
  createDeterministicContext,
  createSessionWithUserMessage,
} from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import { buildApprovedSession } from "../testing/approvedSession.ts";
import { collapseWhitespace, readPdfPages } from "../testing/readPdfText.ts";
import { renderSopPdf } from "./renderSopPdf.ts";

const APPROVED_AT = "2026-09-20T14:32:07.000Z";

/** The renderer does not gate: any session can be shown as approved to test how it prints. */
function asApprovedDocument(session: SopSession): SopDocument {
  return buildSopDocument({ ...session, status: "approved", approvedAt: APPROVED_AT });
}

async function renderToText(document: SopDocument) {
  const rendered = await renderSopPdf(document);
  const pages = await readPdfPages(rendered.bytes);
  return { rendered, pages, text: collapseWhitespace(pages.join(" ")) };
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

function sessionWithClaims(claims: Claim[]): SopSession {
  const context = createDeterministicContext();
  const { session } = createSessionWithUserMessage(context);
  return { ...session, claims };
}

describe("renderSopPdf", () => {
  it("prints a real PDF whose document control comes from the document model", async () => {
    const document = buildSopDocument(buildApprovedSession());
    const { rendered, pages, text } = await renderToText(document);

    expect(rendered.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pages[0]).toContain("Standard Operating Procedure");
    expect(text).toContain("Version: 1.0");
    expect(text).toContain("Status: Approved");
    expect(text).toContain("Approved at: 2026-01-01 00:00 UTC");
    expect(text).toContain(`Claims: ${document.counts.confirmedClaims} confirmed of`);
    expect(text).toContain("Gaps: 0 blocking gaps, 5 advisory gaps");
  });

  it("refuses a document that is not approved", async () => {
    const draft = buildSopDocument(sessionWithClaims([]));
    await expect(renderSopPdf(draft)).rejects.toThrow("approved");
  });

  it("prints every claim's text next to its own provenance tag", async () => {
    const document = buildSopDocument(buildApprovedSession());
    const { text } = await renderToText(document);

    let expectedTagCount = 0;
    for (const section of document.sections) {
      for (const item of section.items) {
        expectedTagCount += 1;
        const body = item.text ?? item.note ?? "not known";
        expect(text).toContain(`${item.provenanceTag} ${body}`);
      }
    }
    expect(expectedTagCount).toBe(document.counts.totalClaims);
    for (const tag of ["[confirmed]", "[observed]", "[unknown]", "[conflict]", "[extracted]"]) {
      const inClaims = document.sections
        .flatMap((section) => section.items)
        .filter((item) => item.provenanceTag === tag).length;
      // The legend prints each tag once more.
      expect(occurrences(text, tag)).toBe(inClaims + 1);
    }
  });

  it("prints a suggestion with its tag as well", async () => {
    const context = createDeterministicContext();
    const { session, messageId } = createSessionWithUserMessage(context);
    const result = applyClaim(
      session,
      {
        kind: "record",
        createdByType: "agent",
        field: "controls",
        status: "proposed",
        statement: "Audit the refunds monthly.",
        note: "Suggested by the interviewer at the user's request.",
        effectiveDate: null,
        sourceMessageId: messageId,
        insertBeforeClaimId: null,
      },
      context,
    );
    if (!result.ok) throw new Error("setup failed");
    const { text } = await renderToText(asApprovedDocument(result.session));

    expect(text).toContain("[proposed] Audit the refunds monthly.");
    expect(text).toContain("Suggested by the interviewer at the user's request.");
    expect(text).not.toContain("suggested by the assistant, Suggested");
  });

  it("prints a legend with only the tags that appear", async () => {
    const document = buildSopDocument(buildApprovedSession());
    const { text } = await renderToText(document);
    expect(text).toContain("How to read the tags");
    for (const entry of document.legend) expect(text).toContain(`${entry.tag} ${entry.meaning}`);
    expect(text).not.toContain("[proposed]");
  });

  it("prints all 13 headings, the gap labels, and the gap notices", async () => {
    const document = buildSopDocument(buildApprovedSession());
    const { text } = await renderToText(document);

    for (const section of document.sections) expect(text).toContain(section.heading);
    expect(text).toContain("Exceptions gap acknowledged");
    expect(text).toContain("Nothing has been recorded for this section.");
    expect(text).toContain("Part of this section is still open.");
  });

  it("prints an unresolved item under its own heading, and keeps its step number", async () => {
    const context = createDeterministicContext();
    const { session, messageId } = createSessionWithUserMessage(context);
    const step = applyClaim(
      session,
      {
        kind: "record",
        createdByType: "agent",
        field: "procedure",
        status: "observed",
        statement: "Receive the request.",
        note: null,
        effectiveDate: null,
        sourceMessageId: messageId,
        insertBeforeClaimId: null,
      },
      context,
    );
    if (!step.ok) throw new Error("setup failed");
    const conflictingStep = buildClaim({
      claimId: "conflicting-step",
      field: "procedure",
      status: "conflict",
      value: { kind: "step", text: "Refund within 14 days." },
    });
    const withConflict: SopSession = {
      ...step.session,
      claims: [...step.session.claims, conflictingStep],
      procedureOrder: [...step.session.procedureOrder, conflictingStep.claimId],
    };
    const { text } = await renderToText(asApprovedDocument(withConflict));

    expect(text).toContain("1. [observed] Receive the request.");
    expect(text).toContain("Open items in this section — these are not instructions.");
    expect(text).toContain("Step 2: [conflict] Refund within 14 days.");
    expect(text.indexOf("1. [observed]")).toBeLessThan(text.indexOf("Open items in this section"));
  });

  it("shows every character the font cannot draw as a code-point marker, and never as other text", async () => {
    const claim = buildClaim({
      claimId: "mixed",
      field: "purpose",
      value: {
        kind: "statement",
        text: "Refund — the customer’s “choice” … €50 • café; 中文 → ✓ 😀 Łódź",
      },
    });
    const { text, rendered } = await renderToText(asApprovedDocument(sessionWithClaims([claim])));

    expect(text).toContain(
      "[observed] Refund — the customer’s “choice” … €50 • café; <U+4E2D><U+6587> <U+2192> <U+2713> <U+1F600> <U+0141>ód<U+017A>",
    );
    expect(rendered.replacedCharacters).toBe(7);
    expect(text).toContain("7 characters outside this PDF's supported font set");
  });

  it("prints no notice when nothing had to be replaced", async () => {
    const { text, rendered } = await renderToText(buildSopDocument(buildApprovedSession()));
    expect(rendered.replacedCharacters).toBe(0);
    expect(text).not.toContain("supported font set");
  });

  it("numbers every page as 'Page X of Y'", async () => {
    const claims = Array.from({ length: 120 }, (_, index) =>
      buildClaim({
        claimId: `claim-${index}`,
        field: "controls",
        value: { kind: "statement", text: `Control statement number ${index}.` },
      }),
    );
    const { pages, rendered } = await renderToText(asApprovedDocument(sessionWithClaims(claims)));

    expect(rendered.pageCount).toBeGreaterThan(2);
    expect(pages).toHaveLength(rendered.pageCount);
    pages.forEach((page, index) => {
      expect(collapseWhitespace(page)).toContain(`Page ${index + 1} of ${rendered.pageCount}`);
    });
  });

  it("carries a long procedure across pages without losing or repeating a step", async () => {
    const context = createDeterministicContext();
    let { session, messageId } = createSessionWithUserMessage(context);
    for (let step = 1; step <= 80; step += 1) {
      const result = applyClaim(
        session,
        {
          kind: "record",
          createdByType: "agent",
          field: "procedure",
          status: "observed",
          statement: `Do step ${step}.`,
          note: null,
          effectiveDate: null,
          sourceMessageId: messageId,
          insertBeforeClaimId: null,
        },
        context,
      );
      if (!result.ok) throw new Error("setup failed");
      session = result.session;
    }
    const { text, rendered } = await renderToText(asApprovedDocument(session));

    expect(rendered.pageCount).toBeGreaterThan(1);
    for (let step = 1; step <= 80; step += 1) {
      expect(occurrences(text, `${step}. [observed] Do step ${step}. `)).toBe(1);
    }
  });

  it("wraps a maximum-length unbroken word without losing a character", async () => {
    const longWord = "x".repeat(2000);
    const claim = buildClaim({
      claimId: "long",
      field: "purpose",
      value: { kind: "statement", text: longWord },
    });
    const { pages } = await renderToText(asApprovedDocument(sessionWithClaims([claim])));
    const xCount = pages
      .join("")
      .split("")
      .filter((character) => character === "x").length;
    // The word, plus the x in "Exceptions", "Prerequisites" and similar headings and sentences.
    expect(xCount).toBeGreaterThanOrEqual(2000);
  });

  it("renders a session at the limits in bounded time and size", async () => {
    const claims: Claim[] = [];
    const fields = ["purpose", "scope", "trigger", "roles", "controls"] as const;
    for (let index = 0; index < 500; index += 1) {
      claims.push(
        buildClaim({
          claimId: `claim-${index}`,
          field: fields[index % fields.length] ?? "purpose",
          value: { kind: "statement", text: `Statement ${index}: ${"word ".repeat(14)}` },
        }),
      );
    }
    const started = Date.now();
    const rendered = await renderSopPdf(asApprovedDocument(sessionWithClaims(claims)));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(rendered.pageCount).toBeLessThan(80);
    expect(rendered.bytes.length).toBeLessThan(2_000_000);
  });

  it("gives identical bytes for the same document", async () => {
    const document = buildSopDocument(buildApprovedSession());
    const first = await renderSopPdf(document);
    const second = await renderSopPdf(document);
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });
});
