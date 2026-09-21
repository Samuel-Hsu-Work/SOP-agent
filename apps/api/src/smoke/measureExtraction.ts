/**
 * Measures document extraction on the real model, over every sample in fixtures/documents/, the
 * clean ones and the harder ones (columns, a table, a hyphenated line break, a 40-page handbook, a
 * messy Word file, and a document that gives instructions to whoever reads it).
 *
 *   pnpm measure:extraction
 *
 * Needs OPENAI_API_KEY (read from the repository root .env). It calls the primary model directly.
 * It spends a few cents. It prints one line per document and writes a JSON report that holds every
 * claim for a person to read: that report contains document text, so it stays in the git-ignored
 * `evals/runs/` folder and is never logged anywhere else.
 *
 * What it tells you that the tests cannot: how many returned claims survive the quote check, whether
 * the field labels are right (against `expected-fields.json`), and how long a document takes and
 * costs. Quote verification only proves a quote is real, not that its label is right.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaimDraft } from "@sop-agent/sop-core";
import OpenAI from "openai";
import { DocumentParseError } from "../documents/documentParseError.ts";
import { extractClaimDrafts } from "../documents/extractClaimDrafts.ts";
import { parseDocument } from "../documents/parseDocument.ts";
import { normalizeForQuoteMatching } from "../documents/verifyQuote.ts";
import type { ModelFailureKind } from "../logging.ts";
import { readModelsFromEnvironment } from "../model/modelFallback.ts";
import { createOpenAiModelClient } from "../model/openaiModelClient.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = path.resolve(here, "../../../../fixtures/documents");
const reportDirectory = path.resolve(here, "../../evals/runs");

interface ExpectedEntry {
  field: string;
  quoteContains: string;
}

const expected = JSON.parse(
  await readFile(path.join(fixturesDirectory, "expected-fields.json"), "utf8"),
) as { files: Record<string, ExpectedEntry[]> };

/** Whether each expected passage was quoted by a verified claim, and whether that claim's field was right. */
function scoreFields(fileName: string, drafts: readonly ClaimDraft[]) {
  const entries = expected.files[fileName] ?? [];
  let quoted = 0;
  let rightField = 0;
  const misses: string[] = [];
  for (const entry of entries) {
    const needle = normalizeForQuoteMatching(entry.quoteContains);
    const matching = drafts.filter((draft) =>
      normalizeForQuoteMatching(draft.citation.quote).includes(needle),
    );
    if (matching.length === 0) {
      misses.push(`not extracted: ${entry.quoteContains.slice(0, 50)}`);
      continue;
    }
    quoted += 1;
    if (matching.some((draft) => draft.field === entry.field)) rightField += 1;
    else {
      misses.push(
        `wrong field (${matching.map((draft) => draft.field).join("/")} instead of ${entry.field}): ${entry.quoteContains.slice(0, 50)}`,
      );
    }
  }
  return { expectedCount: entries.length, quoted, rightField, misses };
}

const client = createOpenAiModelClient(new OpenAI());
const model = readModelsFromEnvironment()[0] ?? "";
const files = (await readdir(fixturesDirectory))
  .filter((name) => /\.(pdf|docx|md|txt)$/i.test(name))
  .sort();

console.log(`Measuring extraction on ${files.length} documents with ${model}\n`);

const report: Record<string, unknown>[] = [];
let totalVerified = 0;
let totalProposed = 0;

for (const fileName of files) {
  const bytes = await readFile(path.join(fixturesDirectory, fileName));
  const entry: Record<string, unknown> = { fileName };
  try {
    const parseStarted = Date.now();
    const parsed = await parseDocument({ bytes, fileName });
    const parseMs = Date.now() - parseStarted;

    const modelStarted = Date.now();
    const failedAttempts: { model: string; kind: ModelFailureKind }[] = [];
    const outcome = await extractClaimDrafts({
      client,
      models: [model],
      sections: parsed.sections,
      documentName: fileName,
      signal: new AbortController().signal,
      failedAttempts,
    });
    const modelMs = Date.now() - modelStarted;

    totalProposed += outcome.proposedCount;
    totalVerified += outcome.drafts.length;
    const fields = scoreFields(fileName, outcome.drafts);
    console.log(
      `${fileName.padEnd(34)} sections ${String(parsed.sections.length).padStart(3)} | proposed ${String(outcome.proposedCount).padStart(3)} verified ${String(outcome.drafts.length).padStart(3)} rejected ${String(outcome.rejected.count).padStart(2)} | tokens ${outcome.inputTokens}/${outcome.outputTokens} | parse ${parseMs} ms, model ${modelMs} ms` +
        (fields.expectedCount > 0
          ? ` | expected passages quoted ${fields.quoted}/${fields.expectedCount}, right field ${fields.rightField}/${fields.expectedCount}`
          : ""),
    );
    for (const miss of fields.misses) console.log(`    ${miss}`);
    Object.assign(entry, {
      sections: parsed.sections.length,
      proposed: outcome.proposedCount,
      verified: outcome.drafts.length,
      rejected: outcome.rejected,
      tokens: { input: outcome.inputTokens, output: outcome.outputTokens },
      parseMs,
      modelMs,
      fieldScore: fields,
      claims: outcome.drafts.map((draft) => ({
        field: draft.field,
        statement: draft.statement,
        location: draft.citation.location,
        quote: draft.citation.quote,
      })),
    });
  } catch (error) {
    // A document the parser refuses is a result too: the category says why.
    const reason =
      error instanceof DocumentParseError
        ? `refused (${error.category})`
        : `failed (${error instanceof Error ? error.name : "error"})`;
    console.log(`${fileName.padEnd(34)} ${reason}`);
    entry.outcome = reason;
  }
  report.push(entry);
}

const rate = totalProposed === 0 ? 1 : totalVerified / totalProposed;
console.log(
  `\nTotal: ${totalVerified} of ${totalProposed} returned claims verified (${(rate * 100).toFixed(1)}%). ` +
    "Read the claims in the report for the hostile document: it must yield only ordinary extracted rules.",
);

mkdirSync(reportDirectory, { recursive: true });
const reportPath = path.join(
  reportDirectory,
  `extraction-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
writeFileSync(reportPath, JSON.stringify({ model, report }, null, 2));
console.log(`Report written to ${path.relative(process.cwd(), reportPath)}`);
