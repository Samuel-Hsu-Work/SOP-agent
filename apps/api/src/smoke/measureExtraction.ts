/**
 * Measures document reading on the real model, over every sample in fixtures/documents/, the clean
 * ones and the harder ones (columns, a table, a hyphenated line break, a 40-page handbook, a messy
 * Word file, and a document that gives instructions to whoever reads it).
 *
 *   pnpm measure:extraction
 *
 * Needs OPENAI_API_KEY (read from the repository root .env). It calls the primary model directly.
 * It spends a few cents. It prints one line per document and writes a JSON report that holds every
 * passage for a person to read: that report contains document text, so it stays in the git-ignored
 * `evals/runs/` folder and is never logged anywhere else.
 *
 * A document is always read for an SOP. The first pass reads each sample for an SOP about the
 * process the document itself covers, and tells you what the tests cannot: how many returned
 * passages survive the quote and number checks, whether the field labels are right (against
 * `expected-fields.json`), and how long a document takes and costs. The second pass reads a broad
 * store policy for two narrower SOPs (against `relevance-key.json`), and tells you whether the
 * reader keeps what that SOP needs and leaves out the rest.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PassageDraft } from "@sop-agent/sop-core";
import { createDeterministicContext, createSessionWithTarget } from "@sop-agent/sop-core/testing";
import OpenAI from "openai";
import { DocumentParseError } from "../documents/documentParseError.ts";
import { parseDocument } from "../documents/parseDocument.ts";
import { readReferencePassages } from "../documents/readReferencePassages.ts";
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

/** An SOP about the process the document itself covers: the broadest reading of any sample. */
const WHOLE_DOCUMENT_TARGET = createSessionWithTarget(createDeterministicContext(), {
  purpose: ["Describe the whole process this document governs, from start to finish."],
  scope: ["Applies to everyone and every case this document covers."],
});

/** Whether each expected passage was quoted by a kept passage, and whether its field was right. */
function scoreFields(fileName: string, drafts: readonly PassageDraft[]) {
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
    const outcome = await readReferencePassages({
      client,
      models: [model],
      sections: parsed.sections,
      documentName: fileName,
      session: WHOLE_DOCUMENT_TARGET,
      signal: new AbortController().signal,
      failedAttempts,
    });
    const modelMs = Date.now() - modelStarted;

    totalProposed += outcome.proposedCount;
    totalVerified += outcome.passages.length;
    const fields = scoreFields(fileName, outcome.passages);
    console.log(
      `${fileName.padEnd(34)} sections ${String(parsed.sections.length).padStart(3)} | proposed ${String(outcome.proposedCount).padStart(3)} kept ${String(outcome.passages.length).padStart(3)} rejected ${String(outcome.rejected.count).padStart(2)} | tokens ${outcome.inputTokens}/${outcome.outputTokens} | parse ${parseMs} ms, model ${modelMs} ms` +
        (fields.expectedCount > 0
          ? ` | expected passages quoted ${fields.quoted}/${fields.expectedCount}, right field ${fields.rightField}/${fields.expectedCount}`
          : ""),
    );
    for (const miss of fields.misses) console.log(`    ${miss}`);
    Object.assign(entry, {
      sections: parsed.sections.length,
      proposed: outcome.proposedCount,
      kept: outcome.passages.length,
      rejected: outcome.rejected,
      truncated: outcome.truncatedCount,
      tokens: { input: outcome.inputTokens, output: outcome.outputTokens },
      parseMs,
      modelMs,
      fieldScore: fields,
      passages: outcome.passages.map((draft) => ({
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
  `\nTotal: ${totalVerified} of ${totalProposed} returned passages kept (${(rate * 100).toFixed(1)}%; the rest failed a check or were over the cap). ` +
    "Read the passages in the report for the hostile document: it must yield only ordinary rules.",
);

interface RelevanceTarget {
  target: string;
  purpose: string[];
  scope: string[];
  needed: string[];
  notRelevant: string[];
  aboutTheDocument: string[];
}

const relevanceKey = JSON.parse(
  await readFile(path.join(fixturesDirectory, "relevance-key.json"), "utf8"),
) as { files: Record<string, RelevanceTarget[]> };

/** How many passages of each kind in the key a kept quote contains. */
function scoreRelevance(target: RelevanceTarget, quotes: readonly string[]) {
  const kept = quotes.map(normalizeForQuoteMatching);
  const keptAny = (needles: readonly string[]) =>
    needles.filter((needle) =>
      kept.some((quote) => quote.includes(normalizeForQuoteMatching(needle))),
    );
  const needed = keptAny(target.needed);
  return {
    kept: quotes.length,
    needed: needed.length,
    neededOf: target.needed.length,
    missedNeeded: target.needed.filter((needle) => !needed.includes(needle)),
    notRelevant: keptAny(target.notRelevant),
    aboutTheDocument: keptAny(target.aboutTheDocument),
  };
}

console.log("\nRelevance to the SOP being written (reads each document once per target)\n");
const relevanceReport: Record<string, unknown>[] = [];
for (const [fileName, targets] of Object.entries(relevanceKey.files)) {
  const parsed = await parseDocument({
    bytes: await readFile(path.join(fixturesDirectory, fileName)),
    fileName,
  });
  for (const target of targets) {
    const outcome = await readReferencePassages({
      client,
      models: [model],
      sections: parsed.sections,
      documentName: fileName,
      session: createSessionWithTarget(createDeterministicContext(), target),
      signal: new AbortController().signal,
      failedAttempts: [],
    });
    const score = scoreRelevance(
      target,
      outcome.passages.map((draft) => draft.citation.quote),
    );
    console.log(
      `${fileName} → ${target.target.padEnd(16)} kept ${String(score.kept).padStart(3)} | needed ${score.needed}/${score.neededOf} | not relevant ${score.notRelevant.length} | about the document ${score.aboutTheDocument.length}`,
    );
    for (const needle of score.missedNeeded) console.log(`    missed: ${needle}`);
    for (const needle of [...score.notRelevant, ...score.aboutTheDocument]) {
      console.log(`    kept but should not be: ${needle}`);
    }
    relevanceReport.push({
      fileName,
      target: target.target,
      score,
      passages: outcome.passages.map((draft) => ({
        field: draft.field,
        statement: draft.statement,
        quote: draft.citation.quote,
      })),
    });
  }
}

mkdirSync(reportDirectory, { recursive: true });
const reportPath = path.join(
  reportDirectory,
  `extraction-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
writeFileSync(reportPath, JSON.stringify({ model, report, relevanceReport }, null, 2));
console.log(`Report written to ${path.relative(process.cwd(), reportPath)}`);
