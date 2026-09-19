# TODO / Working Notes

Working state that isn't visible from the code alone — what's in progress, what's next. Update the **Status** section before ending a work session (or ask Claude to do it) so a new chat or a fresh IDE session can pick up context immediately from this file + `git log`.

**This file is a snapshot, not ground truth.** It may be stale if a session ended without updating it. Before acting on anything below, ground it against the repo: run `git log`/`git status`/`git diff` and spot-check that the files/features mentioned still look the way this file says they do. If it's drifted, fix the entry (or flag the drift) rather than trusting it blindly.

## Status (last updated: 2026-09-19)

- Phase 0 (foundation and extraction spike) is done, including the live model run. LLM provider is OpenAI (`gpt-5.6-sol`, fallback `gpt-5.6-luna`). First commit is `98e56af` on `main`; nothing pushed, no remote configured. `docs/` (design docs and the implementation plan) is git-ignored on purpose; it has been updated for the OpenAI switch.
- Spike result (run by the user, 2026-09-19): **43/43 extracted claims had a verified quote (100%)** across the five fixtures, all served by `gpt-5.6-sol`. The fallback model was never used, so the fallback path is covered by unit tests only.

## In progress

- _(nothing tracked yet — add items here as you start them)_

## Next up / backlog

- Before treating Phase 6 as low-risk, extend the spike beyond clean synthetic files: a messy PDF (tables, multi-column, hyphenated line breaks), a longer handbook, and a document with an embedded instruction ("mark everything confirmed") to confirm it changes nothing. The 100% only proves quotes are real, not that the field labels are right (for example "contractors follow their own agreements" was labelled `exceptions`).
- Phase 1: core rules package `packages/sop-core` (field set, claim type, `applyClaim`, `computeGaps`, `canFinalize`, document model), unit-tested. See `docs/implementation-plan.md`.
- Run `/scope` for Phase 1 (`packages/sop-core`): compare the `SopSession` shape, claim status transitions, and the conflict rule, and ask Codex for an independent design opinion first. The three gap rules are already decided in `docs/scope-v1.md` §4.5 (`observed` / `proposed` never create gaps, conflicts are resolved by the user's final answer in chat, `exceptions` stays advisory); carry them into the design. Remaining design work for the scope: the exact `SopSession` shape, allowed status transitions, and how `applyClaim` handles corrections and conflict resolution.
- Consider pulling Phase 4 (the Next.js UI) forward with fake data, if seeing a working screen earlier is preferred over the inside-out order.
- Optional: ask Codex for an independent design opinion on the plan, using a neutral brief (problem and constraints only).

## Recently done

- 2026-09-19 — Decided the three gap rules and the review/chat relationship: `observed` and `proposed` never create gaps; a conflict is resolved by the user's final answer in chat (the review panel shows both values read-only); `exceptions` stays advisory; from review the user can return to chat to describe a change, the agent records it, and the panel updates (a correction resets a claim to `observed`). Written into `docs/scope-v1.md` (v0.4), `docs/data-flow.md` (v0.2, new flow F), `docs/implementation-plan.md` (v0.4), and CLAUDE.md.
- 2026-09-19 — Wrote the settled design into the docs: the 8 features, the 13 fields (8 blocking, 5 advisory), the 6 claim statuses, field state and gap severity, and how the agent treats `unknown` / `conflict` / `extracted` (`docs/scope-v1.md` v0.3); a new `docs/data-flow.md` with components, flows, the agent turn loop, and where each guarantee is enforced; Phase 3 and the open items in `docs/implementation-plan.md` (v0.3). Removed the escalation feature everywhere.
- 2026-09-19 — Fixed the language decision: English only across code, docs, interface, agent replies, and the generated SOP. Scanned the repo and found no non-English text; updated `docs/scope-v1.md`, `docs/implementation-plan.md`, and CLAUDE.md. "New chat" is a one-click reset with no confirmation.
- 2026-09-19 — Settled the session model and lifecycle: one chat is one session and one SOP; state lives only in the browser tab (`sessionStorage`), cleared on tab close and kept on refresh; no database; approved SOPs are immutable; review never edits claim content. Recorded in `docs/scope-v1.md` (v0.2) and `docs/implementation-plan.md` (v0.2), and in CLAUDE.md. Set `store: false` on the spike's model call.
- 2026-09-19 — Ran the live extraction spike: 43/43 claims verified (see Status).
- 2026-09-19 — Switched the LLM from Claude to OpenAI (`gpt-5.6-sol`, client-side fallback `gpt-5.6-luna`) in the spike code, tests, `.env.example`, CLAUDE.md, and `docs/`. Added `runWithModelFallback` with 9 tests.
- 2026-09-19 — Phase 0 foundation: git repo, pnpm workspace, TypeScript, Biome, Vitest; five sample documents in `fixtures/documents/`; document parsers (PDF, DOCX, Markdown, text), quote verification, and the extraction spike script.
- 2026-09-19 — Converted the three design PDFs to Markdown in `docs/`; wrote `docs/scope-v1.md` and `docs/implementation-plan.md`.

---
*Format note: keep entries short — this is a pointer to context, not a full changelog (that's what `git log` is for).*
