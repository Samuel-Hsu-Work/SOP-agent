/**
 * Phase 0 spike: how many claims that a model extracts from sample documents carry a
 * quote that really appears in the cited page or section?
 *
 *   pnpm spike:extraction              parse, extract with the model, verify quotes
 *   pnpm spike:extraction --dry-run    parse only; no API call and no credentials needed
 *
 * Needs OPENAI_API_KEY. Models come from LLM_MODEL (default gpt-5.6-sol) and
 * LLM_FALLBACK_MODEL (default gpt-5.6-luna); the fallback runs only if the primary fails or refuses.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { extractClaimsFromDocument } from "./extractClaims.ts";
import type { ExtractedClaim } from "./extractionSchema.ts";
import { type FailedModelAttempt, readModelsFromEnvironment } from "./modelFallback.ts";
import {
  type ParsedDocument,
  parseDocument,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from "./parseDocument.ts";
import { verifyExtractedClaimQuote } from "./verifyQuote.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = path.resolve(here, "../../../fixtures/documents");
const reportDirectory = path.resolve(here, "../out");
const models = readModelsFromEnvironment();
const isDryRun = process.argv.includes("--dry-run");

interface DocumentReport {
  fileName: string;
  sectionCount: number;
  claimCount: number;
  verifiedClaimCount: number;
  rejectedClaims: { claim: ExtractedClaim; reason: string }[];
  verifiedClaims: ExtractedClaim[];
  servedByModel?: string;
  failedModelAttempts: FailedModelAttempt[];
  error?: string;
}

async function listFixtureFileNames(): Promise<string[]> {
  const fileNames = await readdir(fixturesDirectory);
  return fileNames
    .filter((fileName) =>
      SUPPORTED_DOCUMENT_EXTENSIONS.some((extension) => fileName.toLowerCase().endsWith(extension)),
    )
    .sort();
}

async function analyzeDocument(client: OpenAI | null, fileName: string): Promise<DocumentReport> {
  let document: ParsedDocument;
  try {
    document = await parseDocument(path.join(fixturesDirectory, fileName));
  } catch (error) {
    return emptyReport(fileName, 0, `parse failed: ${describeError(error)}`);
  }

  console.log(`\n${fileName}: ${document.sections.length} sections`);
  for (const section of document.sections) {
    console.log(`  ${section.location.padEnd(28)} ${section.text.length} chars`);
  }
  if (client === null) return emptyReport(fileName, document.sections.length);

  try {
    const { result, servedByModel, failedAttempts } = await extractClaimsFromDocument(
      client,
      document,
      models,
    );
    const verifiedClaims: ExtractedClaim[] = [];
    const rejectedClaims: DocumentReport["rejectedClaims"] = [];
    for (const claim of result.claims) {
      const verification = verifyExtractedClaimQuote(claim, document.sections);
      if (verification.isVerified) verifiedClaims.push(claim);
      else rejectedClaims.push({ claim, reason: verification.reason });
    }
    return {
      fileName,
      sectionCount: document.sections.length,
      claimCount: result.claims.length,
      verifiedClaimCount: verifiedClaims.length,
      verifiedClaims,
      rejectedClaims,
      servedByModel,
      failedModelAttempts: failedAttempts,
    };
  } catch (error) {
    return emptyReport(fileName, document.sections.length, describeError(error));
  }
}

function emptyReport(fileName: string, sectionCount: number, error?: string): DocumentReport {
  return {
    fileName,
    sectionCount,
    claimCount: 0,
    verifiedClaimCount: 0,
    verifiedClaims: [],
    rejectedClaims: [],
    failedModelAttempts: [],
    ...(error === undefined ? {} : { error }),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printReport(reports: DocumentReport[]): void {
  console.log(`\n=== Verified-quote rate (models: ${models.join(" -> ")}) ===`);
  for (const report of reports) {
    if (report.error !== undefined) {
      console.log(`${report.fileName.padEnd(30)} ERROR: ${report.error}`);
      continue;
    }
    const rate =
      report.claimCount === 0
        ? "n/a"
        : `${Math.round((100 * report.verifiedClaimCount) / report.claimCount)}%`;
    console.log(
      `${report.fileName.padEnd(30)} claims=${report.claimCount} verified=${report.verifiedClaimCount} rate=${rate} model=${report.servedByModel}`,
    );
    for (const { model, reason } of report.failedModelAttempts) {
      console.log(`    fallback: ${model} failed (${reason})`);
    }
    for (const claim of report.verifiedClaims) {
      console.log(`    ok       [${claim.field}] ${claim.location}: ${claim.summary}`);
    }
    for (const { claim, reason } of report.rejectedClaims) {
      console.log(`    REJECTED [${claim.field}] ${claim.location}: ${claim.summary} (${reason})`);
    }
  }
  const totalClaims = reports.reduce((sum, report) => sum + report.claimCount, 0);
  const totalVerified = reports.reduce((sum, report) => sum + report.verifiedClaimCount, 0);
  if (totalClaims > 0) {
    console.log(
      `\nOverall: ${totalVerified}/${totalClaims} verified (${Math.round((100 * totalVerified) / totalClaims)}%)`,
    );
  }
}

const client = isDryRun ? null : new OpenAI();
const reports: DocumentReport[] = [];
for (const fileName of await listFixtureFileNames()) {
  reports.push(await analyzeDocument(client, fileName));
}

if (isDryRun) {
  console.log("\nDry run: parsing only. Run without --dry-run to call the model.");
} else {
  printReport(reports);
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    path.join(reportDirectory, "extraction-report.json"),
    JSON.stringify({ models, reports }, null, 2),
  );
  const everyDocumentFailed = reports.every((report) => report.error !== undefined);
  if (everyDocumentFailed) {
    console.error(
      "\nEvery document failed. If the errors mention authentication, check OPENAI_API_KEY in your .env file.",
    );
    process.exitCode = 1;
  }
}
