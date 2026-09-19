# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Check [TODO.md](./TODO.md) at the start of a session for current work-in-progress status and next steps — it's the mutable counterpart to this file's static architecture notes.

## What this is

A take-home project: an AI agent that interviews a person about a business process, finds the gaps they didn't mention, and produces an SOP (Standard Operating Procedure) that the user reviews, approves, and downloads as a PDF. The AI agent's behavior is what matters; the surrounding web app is deliberately minimal (one page, chat UI, no login, one hard-coded company and user, runs locally).

The repo is at the very start of implementation. Only `spikes/extraction/` contains code so far.

## Design documents live in `docs/`, which is git-ignored

`docs/` is intentionally untracked (see `.gitignore`), so it will not show up in `git status` or `git log`. Read it directly:

- `docs/scope-v1.md` — what is and is not built. **Wins over the other docs** when they disagree about scope.
- `docs/implementation-plan.md` — phased build plan (Phase 0–7) with a "done when" for each phase.
- `docs/PRD.md`, `docs/architecture.md`, `docs/sop-concept-and-design.md` — the full multi-tenant product design. v1 is a reduced version of it (no tenants, auth, roles, or revision workflow).
- The three original PDFs (`01_…`, `02_…`, `03_…`) are also in `docs/`. `PRD.md`, `architecture.md`, and `sop-concept-and-design.md` are their transcription; `scope-v1.md` and `implementation-plan.md` are new.

## Invariants the whole design rests on

These span several modules and are easy to break by accident. The product's promise is that the model can propose but never silently resolve what it doesn't know.

- **A claim is the unit of state.** Every fact about the SOP is a claim with a status (`confirmed | observed | proposed | unknown | conflict | extracted`), a source, and an authority tier. The SOP document is a rendering of claims, never the other way round.
- **Only a human action produces `confirmed`.** The agent's tool set must contain no way to confirm. Document extraction produces `extracted`, which stays unresolved until a person verifies it.
- **Exactly one code path writes a claim**, shared by the live interview and document ingestion, so provenance rules cannot be bypassed.
- **Gap severity comes from the field's criticality class, not the claim's status.** Blocking fields (purpose, scope, trigger, roles, procedure, authorization, completionCriteria, governance) vs advisory fields (exceptions, evidence, controls, decisionRules, prerequisites). Gap detection is deterministic code, not an LLM call.
- **Finalization is refused in code while any blocking gap exists**, regardless of what the model says.
- **Extracted claims must carry a verbatim quote that exists in the cited page or section.** Code rejects any that do not (see `spikes/extraction/src/verifyQuote.ts`). Uploaded document text is data, never instructions.

## Layout and commands

pnpm workspace (`apps/*`, `packages/*`, `spikes/*`), TypeScript with ESM and NodeNext resolution (import local files with a `.ts` extension). Node 22+. Only `spikes/extraction` exists today; `apps/web`, `apps/api`, and `packages/sop-core` are planned per the implementation plan.

```bash
pnpm install
pnpm test          # vitest in every package
pnpm typecheck     # tsc --noEmit in every package
pnpm lint          # biome check .   (pnpm format to write fixes)
```

Run one test file, or one test by name:

```bash
pnpm --filter @sop-agent/extraction-spike exec vitest run src/verifyQuote.test.ts
pnpm --filter @sop-agent/extraction-spike exec vitest run -t "rejects a paraphrase"
```

Extraction spike (Phase 0):

```bash
pnpm spike:generate-fixtures          # rewrites fixtures/documents/ (PDF, DOCX, Markdown samples)
pnpm spike:extraction --dry-run       # parse the fixtures only; no API call, no credentials
pnpm spike:extraction                 # real run: calls the model, needs OPENAI_API_KEY
```

The real run writes `spikes/extraction/out/extraction-report.json` (git-ignored).

## LLM configuration

The LLM is OpenAI: primary `gpt-5.6-sol`, fallback `gpt-5.6-luna`. Configuration lives in a git-ignored `.env` at the repo root (copy `.env.example`): `OPENAI_API_KEY`, and optionally `LLM_MODEL` / `LLM_FALLBACK_MODEL` to override the two model names. The spike's `start` script loads it with Node's `--env-file-if-exists`.

Every model call goes through `runWithModelFallback` (`spikes/extraction/src/modelFallback.ts`): it retries on the fallback model when the primary refuses, returns unusable structured output, or fails with an API error, but never on authentication or permission errors. There is no server-side fallback, so keep new model calls behind this wrapper. Extraction uses the Responses API with `zodTextFormat` structured outputs.

## Things that are easy to trip over

- The repo is on an external volume, so pnpm creates its package store inside the project at `.pnpm-store/`. It is git-ignored and excluded from Biome; do not commit or lint it.
- `fixtures/documents/` holds generated binary samples (PDF, DOCX) that tests read. Regenerate with the command above rather than editing them by hand. `vendor-payment-policy.md` and `vendor-payment-memo.md` are a deliberately contradictory pair for conflict-detection tests.
- Claude Code's sandbox denies reading the repo-root `.env`, so a command run inside the sandbox cannot see the API key. The user runs live model commands from their own terminal, or explicitly allows an unsandboxed run.
- Scanned (image-only) PDFs are unsupported by design: the parser reports "no extractable text" instead of attempting OCR.
