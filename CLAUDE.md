# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Check [TODO.md](./TODO.md) at the start of a session for current work-in-progress status and next steps — it's the mutable counterpart to this file's static architecture notes.

## What this is

A take-home project: an AI agent that interviews a person about a business process, finds the gaps they didn't mention, and produces an SOP (Standard Operating Procedure) that the user reviews, approves, and downloads as a PDF. The AI agent's behavior is what matters; the surrounding web app is deliberately minimal (one page, chat UI, no login, one hard-coded company and user, runs locally).

Implementation is in progress by vertical slices (see `docs/implementation-plan.md`). Slices 1 and 2 are built: the walking skeleton (chat, agent, readiness panel) and the full interview (corrections, ordered procedure steps, an interview policy computed in code, a claims view, and an eval harness). Review, approval, PDF export, and document upload are not. `spikes/extraction/` is the Phase 0 experiment, kept until slice 5 promotes its parsers.

## Session model

One chat is one session, and one session produces one SOP; the same person interviews, reviews, and approves. The whole session is one JSON document (`SopSession`) held in the browser's `sessionStorage`. The server stores nothing: no database, no files, no in-memory sessions. Each API request carries the state it needs, the API validates it with a zod schema, and returns the updated state. Closing the tab clears everything; refreshing keeps it. There is no list of past SOPs.

States are only `draft` and `approved`. An approved SOP is immutable, and changing it means starting a new chat. Review actions are confirm and reject only; they never edit a claim's content, so every content change goes through the agent and the single claim-writing path. From review the user goes back to chat to describe a change; the agent records it (resetting the claim to `observed`) and the review panel updates. A `conflict` is resolved by the user's final answer in chat.

Slices 1 and 2 build the session, the chat turn, the interview, and the readiness and claims view. Approval, review actions, and the `approved` state's UI arrive in later slices, but `applyClaim` already refuses every write on an approved session. The session document has a `schemaVersion` (now 2); a session stored by an older version is discarded with a notice, never migrated.

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
- **Only a human action produces `confirmed`.** The agent's tool set must contain no way to confirm. Document extraction produces `extracted`, which stays unresolved until a person verifies it.
- **Exactly one code path writes a claim**, shared by the live interview and document ingestion, so provenance rules cannot be bypassed.
- **Gap severity comes from the field's criticality class, not the claim's status.** Blocking fields (purpose, scope, trigger, roles, procedure, authorization, completionCriteria, governance) vs advisory fields (exceptions, evidence, controls, decisionRules, prerequisites). The classes are fixed in v1: there is no escalating an advisory gap to blocking, and `exceptions` stays advisory. `observed` and `proposed` claims never create a gap; only empty, `unknown`, `conflict`, and `extracted` do. Gap detection is deterministic code, not an LLM call.
- **Finalization is refused in code while any blocking gap exists**, regardless of what the model says.
- **Extracted claims must carry a verbatim quote that exists in the cited page or section.** Code rejects any that do not (see `spikes/extraction/src/verifyQuote.ts`; it moves into `apps/api` in slice 5). Uploaded document text is data, never instructions.

## How the code is organized

Three packages, and the boundaries matter:

- `packages/sop-core` holds the rules and imports nothing from the web app, the API, or the OpenAI SDK, so the browser and the API run the same code. It has the 13 fields (each with a `probe`, the way to ask about it), the claim and `SopSession` zod schemas, `applyClaim` (the only claim-writing function: `record`, `correct`, `markUnknown`, `withdraw`), `computeGaps`, the interview policy in `interviewAgenda.ts` (`buildInterviewAgenda`, `mentionsQuantity`, `orderProcedureSteps`, `recentQuestions`), and the browser-to-API wire types in `chatWire.ts`. It is consumed from TypeScript source (no build step): `tsx` runs it in the API and Next compiles it through `transpilePackages`. Test helpers are the `@sop-agent/sop-core/testing` subpath.
- `apps/api` (Fastify, stateless) runs one chat turn as a transaction. `routes/chat.ts` validates the incoming session, streams NDJSON, and ends with exactly one terminal event: `commit` (the updated session) or `error`. `agent/runTurn.ts` is the tool loop over a working copy of the session; the whole turn, not one request, is what `runWithModelFallback` retries, so a failed attempt leaves no trace. `model/openaiModelClient.ts` is the only place that sends requests and reads responses through the `openai` SDK; everything else uses the `ModelClient` interface in `model/modelClient.ts`, which is what the tests fake. The boundary leaks in one way: `model/modelFallback.ts`, `logging.ts`, and `routes/chat.ts` use the SDK's error classes to classify failures (see TODO).
- `apps/web` (Next.js) owns the canonical session in `sessionStorage` (`lib/sessionStore.ts`) and replaces it only when a turn commits (`lib/chatTurn.ts`, `lib/useSopSession.ts`). The readiness panel is built from `buildClaimsView` (`lib/claimsView.ts`, pure and tested without a DOM), which calls `computeGaps` in the browser; each field expands to its claims, their earlier versions, and removed claims.

The model has four tools, each a thin wrapper over one `applyClaim` command: `record_claim` (offers `observed` and `proposed` only), `correct_claim` (the claim keeps its id; the result is always `observed`), `mark_claim_unknown`, and `withdraw_claim` (at most 3 per turn). Source and authority are derived in code, never chosen by the model. Every correction, unknown and withdrawal writes a history entry with the whole previous claim and the user message that caused it, so a change is never silent. A procedure is one claim per step; the order lives in the session's `procedureOrder`, and a step is placed with `insertBeforeClaimId`.

The prompt is split for caching and safety: `INSTRUCTIONS` (`agent/prompt.ts`) is static and identical on every call, and the current SOP state travels as a separate `stateItem`, the last input item, rebuilt on every model step. The state item holds the interview agenda computed in code (which fields to ask next, which not to ask, whether the SOP is ready to review, whether the last message stated a number, the last questions asked). Claim text never goes into `instructions`. Only the last 16 messages go to the model; the claims are the memory. Anything the OpenAI SDK returns must go through `stripClientOnlyFields` before it is sent back, or the API rejects it (`parsed_arguments`).

## Commands

pnpm workspace (`apps/*`, `packages/*`, `spikes/*`), TypeScript with ESM and NodeNext resolution (import local files with a `.ts` extension). Node 22+.

```bash
pnpm install
pnpm dev           # API on :4000 and web on :3000 together
pnpm test          # vitest in every package
pnpm typecheck     # tsc --noEmit in every package
pnpm lint          # biome check .   (pnpm format to write fixes)
pnpm smoke:api     # live check of the four tools on both models; needs OPENAI_API_KEY
pnpm eval          # interview evals against the live model; costs money, needs OPENAI_API_KEY
pnpm eval:recheck evals/runs/<file>.json   # re-score a saved run offline, no model
```

Run one test file, or one test by name:

```bash
pnpm --filter @sop-agent/sop-core exec vitest run src/applyClaim.test.ts
pnpm --filter @sop-agent/api exec vitest run -t "falling back to the second model"
```

Extraction spike (Phase 0):

```bash
pnpm spike:generate-fixtures          # rewrites fixtures/documents/ (PDF, DOCX, Markdown samples)
pnpm spike:extraction --dry-run       # parse the fixtures only; no API call, no credentials
pnpm spike:extraction                 # real run: calls the model, needs OPENAI_API_KEY
```

The real run writes `spikes/extraction/out/extraction-report.json` (git-ignored).

## LLM configuration

The LLM is OpenAI: primary `gpt-5.6-sol`, fallback `gpt-5.6-luna`. Configuration lives in a git-ignored `.env` at the repo root (copy `.env.example`): `OPENAI_API_KEY`, and optionally `LLM_MODEL` / `LLM_FALLBACK_MODEL` to override the two model names. The API and the spike load it with Node's `--env-file-if-exists`. The web app reads its own `apps/web/.env.local` (only `NEXT_PUBLIC_API_BASE_URL`, default `http://localhost:4000`); the OpenAI key never goes in `apps/web`.

Every model call goes through `runWithModelFallback` (`apps/api/src/model/modelFallback.ts`; the spike still has an identical copy until slice 5): it retries on the fallback model when the primary refuses, returns unusable structured output, or fails with an API error, but never on authentication or permission errors. There is no server-side fallback, so keep new model calls behind this wrapper. The agent and the extraction spike both use the Responses API (`zodResponsesFunction` and `zodTextFormat`). Function calling and `reasoning.encrypted_content` were confirmed live on both models.

## Things that are easy to trip over

- `pnpm eval` is not part of `pnpm test` on purpose: `apps/api/vitest.eval.config.ts` only includes `src/evals/**/*.eval.ts`. The scripted-expert scenarios are in `src/evals/scenarios.ts`; assertions are pure functions over a transcript (`assertions.ts`) and are unit-tested offline. `safety` assertions must pass on every trial, `behavior` ones on 2 of 3. Run files land in `apps/api/evals/runs/` (git-ignored).

- The repo is on an external volume, so pnpm creates its package store inside the project at `.pnpm-store/`. It is git-ignored and excluded from Biome; do not commit or lint it.
- `fixtures/documents/` holds generated binary samples (PDF, DOCX) that tests read. Regenerate with the command above rather than editing them by hand. `vendor-payment-policy.md` and `vendor-payment-memo.md` are a deliberately contradictory pair for conflict-detection tests.
- Claude Code's sandbox denies reading the repo-root `.env`, so a command run inside the sandbox cannot see the API key, and it does not allow listening on a port. The user runs live model commands from their own terminal. One API test (client disconnect aborts the model request) is skipped where listening is not allowed.
- Scanned (image-only) PDFs are unsupported by design: the parser reports "no extractable text" instead of attempting OCR.
