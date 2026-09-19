import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import PDFDocument from "pdfkit";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = path.resolve(here, "../../../fixtures/documents");

interface FixtureSection {
  heading: string;
  paragraphs: string[];
}

const refundPolicyPages: { title?: string; sections: FixtureSection[] }[] = [
  {
    title: "Acme Retail - Customer Refund Policy (v3.2, effective 2025-03-01)",
    sections: [
      {
        heading: "1. Purpose",
        paragraphs: [
          "This policy defines how customer refund requests are reviewed, approved and recorded so that every customer receives a consistent outcome.",
        ],
      },
      {
        heading: "2. Scope",
        paragraphs: [
          "This policy applies to all refund requests for online orders handled by the Customer Support team. It does not apply to wholesale orders or to chargebacks raised by a bank.",
        ],
      },
      {
        heading: "3. Refund eligibility",
        paragraphs: [
          "A refund may be issued when the customer requests it within 30 days of delivery and provides the original order number or receipt.",
        ],
      },
    ],
  },
  {
    sections: [
      {
        heading: "4. Approval authority",
        paragraphs: [
          "Support agents may approve refunds of up to $200 on their own authority.",
          "Refunds above $200 and up to $1,000 must be approved by the Support Team Lead before payment.",
          "Refunds above $1,000 must be approved by the Customer Operations Manager, and Finance must be notified the same day.",
        ],
      },
      {
        heading: "5. Exceptions",
        paragraphs: [
          "If an item arrives damaged, the receipt requirement is waived when the customer supplies a photograph of the damage.",
          "If a request shows signs of fraud, the agent must stop processing and escalate the case to the Risk team instead of refunding.",
        ],
      },
    ],
  },
  {
    sections: [
      {
        heading: "6. Records",
        paragraphs: [
          "For every refund the agent records the ticket ID, the reason code and the approver's name in the refund system within 24 hours.",
        ],
      },
      {
        heading: "7. Quality control",
        paragraphs: [
          "The QA team audits a random 5% sample of completed refunds each month and reports deviations to the Customer Operations Manager.",
        ],
      },
    ],
  },
];

const expenseHandbookSections: FixtureSection[] = [
  {
    heading: "Expense Reimbursement",
    paragraphs: ["Employee Handbook, chapter 7. Last reviewed 2025-01-10."],
  },
  {
    heading: "Purpose",
    paragraphs: [
      "This chapter explains how employees are reimbursed for business expenses they pay for personally.",
    ],
  },
  {
    heading: "Who this applies to",
    paragraphs: ["All full-time and part-time employees. Contractors follow their own agreements."],
  },
  {
    heading: "Submitting an expense",
    paragraphs: [
      "Submit the expense report in the finance portal within 30 days of the purchase.",
      "Attach a receipt for every item above $25.",
    ],
  },
  {
    heading: "Approval limits",
    paragraphs: [
      "The employee's direct manager approves reports up to $500.",
      "A Director must approve reports above $500 and up to $5,000.",
      "A Vice President must approve reports above $5,000.",
    ],
  },
  {
    heading: "Lost receipts",
    paragraphs: [
      "If a receipt is lost, the employee must sign a lost-receipt statement, and the manager must countersign it before the claim can be paid.",
    ],
  },
  {
    heading: "Record retention",
    paragraphs: ["Finance keeps approved expense reports and receipts for seven years."],
  },
];

const incidentEscalationGuide = `# On-Call Incident Escalation Guide

## Purpose

This guide describes how the on-call engineer handles a production incident from the first alert to closure.

## Trigger

Start this procedure when a monitoring alert with severity "critical" fires, or when a customer reports a full outage.

## Steps

1. The on-call engineer acknowledges the alert within 5 minutes.
2. The engineer opens an incident ticket and records the start time.
3. The engineer posts a status update in the incident channel every 30 minutes until resolved.

## Who decides

The on-call engineer may roll back the latest release without approval.
Any database restore must be approved by the Engineering Manager.

## Closure

An incident is closed when the service has been healthy for 60 minutes. A written post-incident review is due within 5 business days.
`;

const vendorPaymentPolicy = `# Vendor Payment Policy

Version 1.0, effective 2024-01-01.

## Purpose

This policy controls how payments to external vendors are authorized.

## Approval authority

Every vendor payment above $10,000 requires the written approval of two people: the budget owner and the CFO.

## Records

Finance stores the invoice, the purchase order and both approvals for seven years.
`;

const vendorPaymentMemo = `# Management Memo: Vendor Payment Thresholds

Issued by the CFO, effective 2025-06-15.

## Approval authority

Effective immediately, vendor payments up to $25,000 need the approval of the Finance Director only.
Payments above $25,000 still require both the budget owner and the CFO.

This memo replaces the $10,000 threshold in the Vendor Payment Policy.
`;

async function writeRefundPolicyPdf(): Promise<void> {
  const outputPath = path.join(fixturesDirectory, "refund-policy.pdf");
  const pdf = new PDFDocument({ margin: 60 });
  const finished = new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outputPath);
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    pdf.pipe(stream);
  });

  refundPolicyPages.forEach((page, pageIndex) => {
    if (pageIndex > 0) pdf.addPage();
    if (page.title) pdf.font("Helvetica-Bold").fontSize(16).text(page.title).moveDown();
    for (const section of page.sections) {
      pdf.font("Helvetica-Bold").fontSize(12).text(section.heading).moveDown(0.3);
      for (const paragraph of section.paragraphs) {
        pdf.font("Helvetica").fontSize(11).text(paragraph).moveDown(0.5);
      }
      pdf.moveDown();
    }
  });

  pdf.end();
  await finished;
}

async function writeExpenseHandbookDocx(): Promise<void> {
  const children = expenseHandbookSections.flatMap((section) => [
    new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }),
    ...section.paragraphs.map((text) => new Paragraph({ text })),
  ]);
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  await writeFile(path.join(fixturesDirectory, "expense-handbook.docx"), buffer);
}

await mkdir(fixturesDirectory, { recursive: true });
await writeRefundPolicyPdf();
await writeExpenseHandbookDocx();
await writeFile(
  path.join(fixturesDirectory, "incident-escalation-guide.md"),
  incidentEscalationGuide,
);
await writeFile(path.join(fixturesDirectory, "vendor-payment-policy.md"), vendorPaymentPolicy);
await writeFile(path.join(fixturesDirectory, "vendor-payment-memo.md"), vendorPaymentMemo);
console.log(`Fixtures written to ${fixturesDirectory}`);
