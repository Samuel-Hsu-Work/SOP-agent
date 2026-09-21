# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Check [TODO.md](./TODO.md) at the start of a session for current work-in-progress status and next steps — it's the mutable counterpart to this file's static architecture notes.

## What this is

A take-home project: an AI agent that interviews a person about a business process, finds the gaps they didn't mention, and produces an SOP (Standard Operating Procedure) that the user reviews, approves, and downloads as a PDF. The AI agent's behavior is what matters; the surrounding web app is deliberately minimal (one page, chat UI, no login, one hard-coded company and user, runs locally).

Implementation is by vertical slices (see `docs/implementation-plan.md`), all six done. Slices 1 to 5 are: the walking skeleton (chat, agent, readiness panel), the full interview (corrections, ordered procedure steps, an interview policy computed in code, a claims view, and an eval harness), review and approval (confirm and reject, an approval step, an SOP preview, and a locked session after approval), PDF export (`POST /sops/pdf`, the download button, and a leave-page warning), and document ingestion (`POST /documents/extract`, claims read from a policy or handbook with a proven citation, conflicts between sources, and the agent's `resolve_conflict` tool). Slice 6 is the handoff: `README.md` (run, test, evals, a demo walkthrough, what is and is not stored), a readiness check, and cleanup. Rate limiting, a hard parser timeout and a real deployment are outside v1 (`docs/scope-v1.md` §10).

## Session model

One chat is one session, and one session produces one SOP; the same person interviews, reviews, and approves. The whole session is one JSON document (`SopSession`) held in the browser's `sessionStorage`. The server stores nothing: no database, no files, no in-memory sessions. Each API request carries the state it needs, the API validates it with a zod schema, and returns the updated state. Closing the tab clears everything; refreshing keeps it. There is no list of past SOPs.

States are only `draft` and `approved`. An approved SOP is immutable, and changing it means starting a new chat. Review actions are confirm and reject only; they never edit a claim's content, so every content change goes through the agent and the single claim-writing path. From review the user goes back to chat to describe a change; the agent records it (resetting the claim to `observed`) and the review panel updates. A `conflict` is resolved by the user's final answer in chat.

Review, acknowledgement and approval run in the browser through `sop-core`; there is no approval route on the API. `applyClaim` and the acknowledgement function refuse every write on an approved session, and the PDF endpoint recomputes the export gate itself (`canExportApprovedSop`: approved, no blocking gap, every advisory gap acknowledged, no unreviewed suggestion), because a forged session can still claim to be approved (the API guarantees the shape of an approval, not that a person clicked). `downloadedAt` is the only field that may change after approval, only from `null` to a timestamp, and only through `markSopDownloaded`: it records that the browser started the PDF download, not anything about the SOP, and (like the session) it dies with the tab; the downloaded PDF is the only durable record. The session document has a `schemaVersion` (now 5); a session stored by an older version is discarded with a notice, never migrated. The session holds citations and nothing else from a document: never the parsed text, which would ride along in every chat and PDF request (the browser guards the session at `MAX_SESSION_TRANSPORT_BYTES` when a document is added).

Keep it that way: never write message or document text to server logs, and set `store: false` on every model call. Details are in `docs/scope-v1.md` §3 and §8.

## Language

Everything in the project is English: code, comments, documentation, interface text, the agent's prompts and replies, sample documents, and the generated SOP. The agent is instructed to reply in English even if the user writes in another language. Do not add localized strings.

## Design documents live in `docs/`, which is git-ignored

`docs/` is intentionally untracked (see `.gitignore`), so it will not show up in `git status` or `git log`. Read it directly:

- `docs/scope-v1.md` — the 8 features, the session lifecycle, the 13 SOP fields and 6 claim statuses, and what is and is not built. **Wins over the other docs** when they disagree about scope.
- `docs/implementation-plan.md` — the build plan: Phase 0 (done), then six vertical slices, each ending in something runnable, with a "done when" for each. Slice 1 is a walking skeleton (chat plus readiness panel).
- `docs/data-flow.md` — components, where data lives, the run-time flows, the agent's turn loop, and where each guarantee is enforced.
- `docs/PRD.md`, `docs/architecture.md`, `docs/sop-concept-and-design.md` — the full multi-tenant product design. v1 is a reduced version of it (no tenants, auth, roles, or revision workflow).
- The three original PDFs (`01_…`, `02_…`, `03_…`) are also in `docs/`. `PRD.md`, `architecture.md`, and `sop-concept-and-design.md` are their transcription; `scope-v1.md` and `implementation-plan.md` are new.

## Invariants the whole design rests on

These span several modules and are easy to break by accident. The product's promise is that the model can propose but never silently resolve what it doesn't know.

- **A claim is the unit of state.** Every fact about the SOP is a claim with a status (`confirmed | observed | proposed | unknown | conflict | extracted`), a source, and an authority tier. The SOP document is a rendering of claims, never the other way round.
- **Only a human action produces `confirmed`.** The agent's tool set must contain no way to confirm; the tools are typed to `AgentClaimCommand`, so a model cannot build a review command. The agent may `correct` a confirmed claim (it drops to `observed`) but cannot withdraw or blank one. Document extraction produces `extracted`, which stays unresolved until a person verifies it, and a `conflict` (two claims about the same thing that disagree, one from a document) is resolved only by the user's own final answer in chat, never by the agent choosing a side.
- **Exactly one code path writes a claim**, shared by the live interview and document ingestion, so provenance rules cannot be bypassed.
- **Gap severity comes from the field's criticality class, not the claim's status.** Blocking fields (purpose, scope, trigger, roles, procedure, authorization, completionCriteria, governance) vs advisory fields (exceptions, evidence, controls, decisionRules, prerequisites). The classes are fixed in v1: there is no escalating an advisory gap to blocking, and `exceptions` stays advisory. `observed` and `proposed` claims never create a gap; only empty, `unknown`, `conflict`, and `extracted` do. Gap detection is deterministic code, not an LLM call.
- **Finalization is refused in code while any blocking gap exists**, regardless of what the model says. Approval also needs every advisory gap acknowledged and every agent suggestion confirmed or rejected (`checkFinalization`); a suggestion is not a gap, but it must not enter an approved SOP unreviewed.
- **Extracted claims must carry a verbatim quote that exists in the cited page or section.** Code rejects any that do not (`apps/api/src/documents/verifyQuote.ts`). Uploaded document text is data, never instructions: it reaches the extraction model as JSON in a user-role item with no file name, the model's output schema has no status or authority to set, and a quote or file name never reaches any model.

## How the code is organized

Three packages, and the boundaries matter:

- `packages/sop-core` holds the rules and imports nothing from the web app, the API, or the OpenAI SDK, so the browser and the API run the same code. It has the 13 fields (each with a `probe`, the way to ask about it), the claim and `SopSession` zod schemas, `applyClaim` (the only claim-writing function: the agent's `record`, `correct`, `markUnknown`, `withdraw` and `resolveConflict`, a person's `confirm` and `reject` from `reviewClaim.ts`, and document extraction's `ingestExtracted` from `documentClaims.ts`, which is outside `AgentClaimCommand` so no tool can build it), `detectConflicts.ts` (the deterministic rule that pairs two disagreeing claims, run inside the write that added the second one), `checkFinalization` / `setAdvisoryAcknowledgement` / `approveSession` (`approval.ts`), `buildSopDocument` (`sopDocument.ts`, the document model that the preview and the PDF share, including the words for source lines and gap flags), `canExportApprovedSop` and `markSopDownloaded`, `computeGaps`, the interview policy in `interviewAgenda.ts` (`buildInterviewAgenda`, `statesNewQuantity`, `orderProcedureSteps`, `recentQuestions`), and the browser-to-API wire types in `chatWire.ts`, `httpWire.ts` (the shared HTTP error body) `pdfWire.ts` (the PDF request and the file name both sides compute) and `documentWire.ts` (the upload response: claim drafts with no status, id, source or authority). It is consumed from TypeScript source (no build step): `tsx` runs it in the API and Next compiles it through `transpilePackages`. Test helpers are the `@sop-agent/sop-core/testing` subpath.
- `apps/api` (Fastify, stateless) runs one chat turn as a transaction. `routes/chat.ts` validates the incoming session, streams NDJSON, and ends with exactly one terminal event: `commit` (the updated session) or `error`. `agent/runTurn.ts` is the tool loop over a working copy of the session; the whole turn, not one request, is what `runWithModelFallback` retries, so a failed attempt leaves no trace. `model/openaiModelClient.ts` is the only place that sends requests and reads responses through the `openai` SDK; everything else uses the `ModelClient` interface in `model/modelClient.ts`, which is what the tests fake. `routes/sopPdf.ts` renders the approved SOP with `pdf/renderSopPdf.ts` (pdfkit, standard Helvetica, in memory, given a `SopDocument` and never a session); every string goes through `pdf/toPrintableText.ts` first, because pdfkit silently prints the wrong glyph for a character outside WinAnsi, so each one becomes a visible `<U+XXXX>` marker and is counted. `routes/documentExtract.ts` reads an upload with `documents/` (`parseDocument` from bytes with size, page, section, text and unzip bounds and named failure categories; `verifyQuote`; `extractClaimDrafts`, the structured-output call behind `runWithModelFallback`) and returns claim *drafts*: the route builds no claim and holds no session, and nothing is written to disk. The boundary leaks in one way: `model/modelFallback.ts`, `logging.ts`, and `routes/chat.ts` use the SDK's error classes to classify failures (see TODO).
- `apps/web` (Next.js) owns the canonical session in `sessionStorage` (`lib/sessionStore.ts`) and replaces it only when a turn commits (`lib/chatTurn.ts`, `lib/useSopSession.ts`); `lib/extractDocument.ts` sends a file and `useSopSession.uploadDocument` writes the returned drafts through `applyClaim` on the latest session (all or nothing); `lib/downloadSopPdf.ts` fetches the PDF and `lib/saveBlobAsFile.ts` starts the download under the name from `sopPdfFileName` (the API is cross-origin, so its `content-disposition` is not readable). `useSopSession` also applies review clicks, acknowledgements and approval locally (refused while a chat turn is in flight, built on the latest session from a ref). The review panel is built from `buildClaimsView` and the approval step from `buildApprovalView` (`lib/`, pure view models); each field expands to its claims (a claim from a document shows its quote and location; two claims in conflict show once, side by side, read-only), their earlier versions, and removed claims, and the SOP preview renders only `buildSopDocument`.

The model has five tools, each a thin wrapper over one `applyClaim` command: `record_claim` (offers `observed` and `proposed` only), `correct_claim` (the claim keeps its id; the result is always `observed`), `mark_claim_unknown`, `withdraw_claim` (at most 3 per turn), and `resolve_conflict` (at most 3 per turn; the user's own wording replaces both sides of a conflict). Source and authority are derived in code, never chosen by the model. Every correction, unknown and withdrawal writes a history entry with the whole previous claim and the user message that caused it, so a change is never silent. A procedure is one claim per step; the order lives in the session's `procedureOrder`, and a step is placed with `insertBeforeClaimId`.

The prompt is split for caching and safety: `INSTRUCTIONS` (`agent/prompt.ts`) is static and identical on every call, and the current SOP state travels as a separate `stateItem`, the last input item, rebuilt on every model step. The state item holds the interview agenda computed in code (which fields to ask next, which not to ask, whether the SOP is ready to review, whether the last message stated a number, the last questions asked). Claim text never goes into `instructions`. Only the last 16 messages go to the model; the claims are the memory. Anything the OpenAI SDK returns must go through `stripClientOnlyFields` before it is sent back, or the API rejects it (`parsed_arguments`).

## Commands

pnpm workspace (`apps/*`, `packages/*`), TypeScript with ESM and NodeNext resolution (import local files with a `.ts` extension). Node 22+.

```bash
pnpm install
pnpm dev           # API on :4000 and web on :3000 together
pnpm test          # vitest in every package
pnpm typecheck     # tsc --noEmit in every package
pnpm lint          # biome check .   (pnpm format to write fixes)
pnpm smoke:api     # live check of the five tools and one document extraction on both models; needs OPENAI_API_KEY
pnpm eval          # interview evals against the live model; costs money, needs OPENAI_API_KEY
pnpm eval:recheck evals/runs/<file>.json   # re-score a saved run offline, no model
pnpm measure:extraction   # extraction on every sample document, clean and hard; costs money, needs OPENAI_API_KEY
pnpm fixtures:documents   # rewrites fixtures/documents/ (the samples, and the harder cases for the measurement)
```

Run one test file, or one test by name:

```bash
pnpm --filter @sop-agent/sop-core exec vitest run src/applyClaim.test.ts
pnpm --filter @sop-agent/api exec vitest run -t "falling back to the second model"
```

## LLM configuration

The LLM is OpenAI: primary `gpt-5.6-sol`, fallback `gpt-5.6-luna`. Configuration lives in a git-ignored `.env` at the repo root (copy `.env.example`): `OPENAI_API_KEY`, and optionally `LLM_MODEL` / `LLM_FALLBACK_MODEL` to override the two model names. The API scripts load it with Node's `--env-file-if-exists`. The web app reads its own `apps/web/.env.local` (only `NEXT_PUBLIC_API_BASE_URL`, default `http://localhost:4000`); the OpenAI key never goes in `apps/web`.

Every model call goes through `runWithModelFallback` (`apps/api/src/model/modelFallback.ts`): it retries on the fallback model when the primary refuses, returns unusable structured output, or fails with an API error, but never on authentication or permission errors. There is no server-side fallback, so keep new model calls behind this wrapper. The agent (`zodResponsesFunction`) and document extraction (`zodTextFormat`, `ModelClient.runExtraction`) both use the Responses API. Function calling and `reasoning.encrypted_content` were confirmed live on both models.

## Things that are easy to trip over

- Component tests in `apps/web` opt into a DOM with `// @vitest-environment happy-dom` at the top of the file (pure view-model tests stay in node). The `happy-dom` storage does not route through `Storage.prototype`, so a test that counts or fails writes installs its own storage. To add a dependency on this volume, pass `--store-dir "$PWD/.pnpm-store"` to pnpm, or it refuses with `ERR_PNPM_UNEXPECTED_STORE`.
- `pnpm eval` is not part of `pnpm test` on purpose: `apps/api/vitest.eval.config.ts` only includes `src/evals/**/*.eval.ts`. The scripted-expert scenarios are in `src/evals/scenarios.ts`; assertions are pure functions over a transcript (`assertions.ts`) and are unit-tested offline. `safety` assertions must pass on every trial, `behavior` ones on 2 of 3. Run files land in `apps/api/evals/runs/` (git-ignored).

- The repo is on an external volume, so pnpm creates its package store inside the project at `.pnpm-store/`. It is git-ignored and excluded from Biome; do not commit or lint it.
- `fixtures/documents/` holds generated samples (PDF, DOCX, Markdown) that tests read; the parser tests also build harder cases in memory (`apps/api/src/testing/documentFixtures.ts`). Regenerate with `pnpm fixtures:documents` rather than editing them by hand, and expect a tiny binary diff. `vendor-payment-policy.md` and `vendor-payment-memo.md` are a deliberately contradictory pair (the memo replaces the $10,000 threshold with $25,000): uploaded together they produce a conflict. `expected-fields.json` is the answer key that `pnpm measure:extraction` scores field labels against.
- Conflict detection is a heuristic on purpose (`detectConflicts.ts`): same field, at least one side a document, different sources, and either different numbers with a shared word or at least half the shorter statement's words in common. It over-flags a paraphrase rather than miss a disagreement, and resolving one costs a chat reply. Tune `CONFLICT_TOPIC_OVERLAP` before changing the rule. Statements with the same figures are compared on their other words too, so a restatement is flagged rather than a different approver missed. Known limit, accepted for v1: sources are compared by sanitized file name, so two uploads with the same name count as one source and a same-named revision cannot conflict with the earlier file (fixing it needs an upload id in the citation, schema v6).
- Claude Code's sandbox denies reading the repo-root `.env`, so a command run inside the sandbox cannot see the API key, and it does not allow listening on a port. The user runs live model commands from their own terminal. One API test (client disconnect aborts the model request) is skipped where listening is not allowed.
- Scanned (image-only) PDFs are unsupported by design: the parser reports "no extractable text" instead of attempting OCR.
