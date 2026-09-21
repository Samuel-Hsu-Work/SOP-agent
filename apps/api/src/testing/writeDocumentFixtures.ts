import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEncryptedPdf,
  buildExpenseHandbookDocx,
  buildHyphenatedPdf,
  buildLongHandbookPdf,
  buildMessyDocx,
  buildRefundPolicyPdf,
  buildScannedPdf,
  buildTablePdf,
  buildTwoColumnPdf,
  HOSTILE_MARKDOWN,
  INCIDENT_ESCALATION_GUIDE_MD,
  VENDOR_PAYMENT_MEMO_MD,
  VENDOR_PAYMENT_POLICY_MD,
} from "./documentFixtures.ts";

/** Writes the sample documents to `fixtures/documents/`. Run with `pnpm fixtures:documents`. */
const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(here, "../../../../fixtures/documents");

await mkdir(directory, { recursive: true });
const write = (name: string, data: Buffer | string) => writeFile(path.join(directory, name), data);

await write("refund-policy.pdf", await buildRefundPolicyPdf());
await write("expense-handbook.docx", await buildExpenseHandbookDocx());
await write("incident-escalation-guide.md", INCIDENT_ESCALATION_GUIDE_MD);
await write("vendor-payment-policy.md", VENDOR_PAYMENT_POLICY_MD);
await write("vendor-payment-memo.md", VENDOR_PAYMENT_MEMO_MD);

// The harder cases, for the live extraction measurement.
await write("hard-two-column.pdf", (await buildTwoColumnPdf()).bytes);
await write("hard-table.pdf", (await buildTablePdf()).bytes);
await write("hard-hyphenated.pdf", (await buildHyphenatedPdf()).bytes);
await write("hard-long-handbook.pdf", (await buildLongHandbookPdf(40)).bytes);
await write("hard-messy.docx", await buildMessyDocx());
await write("hard-hostile-instructions.md", HOSTILE_MARKDOWN);
await write("hard-scanned.pdf", await buildScannedPdf());
await write("hard-encrypted.pdf", await buildEncryptedPdf());

console.log(`Fixtures written to ${directory}`);
