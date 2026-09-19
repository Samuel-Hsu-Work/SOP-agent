# TODO / Working Notes

Working state that isn't visible from the code alone — what's in progress, what's next. Update the **Status** section before ending a work session (or ask Claude to do it) so a new chat or a fresh IDE session can pick up context immediately from this file + `git log`.

**This file is a snapshot, not ground truth.** It may be stale if a session ended without updating it. Before acting on anything below, ground it against the repo: run `git log`/`git status`/`git diff` and spot-check that the files/features mentioned still look the way this file says they do. If it's drifted, fix the entry (or flag the drift) rather than trusting it blindly.

## Status (last updated: 2026-09-19)

- **Slice 1 (walking skeleton) is done:** built, checked, walked through by the user in the browser, and reviewed independently by Codex in two rounds. It is committed locally in scoped commits and **not pushed**; pushing needs the user's go-ahead. `main` on the private repo `Samuel-Hsu-Work/SOP-agent` is still at `9c9e620` until then.
- What works: a single page with a streaming chat and a readiness panel; a real agent that records claims (`observed`, `proposed`, `unknown`) through `applyClaim` and asks for the next blocking gap; a stated "I don't know" stays a gap until the user answers, which replaces it; refresh keeps the session, New chat and closing the tab clear it. Function calling was confirmed live on both `gpt-5.6-sol` and `gpt-5.6-luna`.
- Checks at last run: 144 tests (`sop-core` 48, `apps/api` 58 plus 1 skipped in the sandbox, `apps/web` 19, spike 19), 0 type errors, clean lint, `next build` succeeds.
- `docs/` (design docs and the implementation plan, now v0.5 with the slice-1 decisions in §9) is git-ignored on purpose, so it exists only on this machine and is not backed up.

## In progress

- _(nothing tracked yet — add items here as you start them)_

## Next up / backlog

- **Push slice 1** when the user says so.
- **Slice 2, the full interview:** start it with `/scope`. It generalizes the narrow "replace an unknown" path into corrections, adds the read-only claims list, and adds the eval harness. Things to tune from the slice-1 manual run: the agent repeated the identical question word for word on a later turn (fine, since the user had not answered it, but robotic); and an eval scenario is needed for a model that fills gaps with `proposed` claims unprompted. The gap rules are decided in `docs/scope-v1.md` §4.5.
- **Before slice 5 (document ingestion):** extend the spike beyond clean synthetic files: a messy PDF (tables, multi-column, hyphenated line breaks), a longer handbook, and a document with an embedded instruction ("mark everything confirmed") to confirm it changes nothing. The 100% verified-quote result only proves quotes are real, not that field labels are right (for example "contractors follow their own agreements" was labelled `exceptions`).
- **Accepted weak spots from the slice-1 review** (details in `docs/implementation-plan.md` §9, decision 16): make the adapter throw provider-neutral error types so `modelFallback.ts`, `logging.ts`, and `routes/chat.ts` stop importing OpenAI error classes; move claim text out of the model's `instructions` into a user-role message when document text arrives in slice 5; add a rate limit before any public deployment (slice 6).
- **A test gap to close when the UI grows (slice 3):** the React behavior in `useSopSession` and `ChatPanel` has no component tests, because the web package has no DOM test environment. Two behaviors were checked by reading the code and by hand only: a turn cancelled by New chat does not put its message back in the box, and a failed save of the new session shows the storage warning.
- **Two loose ends:** `apps/api/src/model/modelFallback.ts` is a verbatim copy of the spike's, and the spike copy is deleted in slice 5; and `next dev` generated `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` (a pointer to Next's bundled docs), which are included in the slice-1 web commit so the tree stays clean. Remove them if they are unwanted.
- **Back up `docs/`:** either remove `docs/` from `.gitignore` (the repo is private) or copy it elsewhere.

## Recently done

- 2026-09-19 — **Slice 1, walking skeleton.** Three packages: `packages/sop-core` (fields, claim and session schemas, `applyClaim`, `computeGaps`, wire types), `apps/api` (streaming `POST /chat`, agent tool loop, whole-turn fallback, one-line request and turn logs), `apps/web` (chat and readiness panels over `sessionStorage`). Planned through `/scope` with independent designs from Codex and an Opus planner. A live smoke test found and fixed a real bug (the SDK's `parsed_arguments` field cannot be echoed back). Codex's review found four issues, all confirmed and fixed with tests that fail without the fix: accept only a `completed` response, never log an untrusted session id, a turn cancelled by New chat is not a failure, and a failed save of a new session no longer lets the old chat return. A missing request log line found against the approved plan was added.
- 2026-09-19 — Settled the whole design in `docs/`: 8 features, 13 fields, 6 claim statuses, gap rules, session model and lifecycle, English only, no database, vertical-slice plan (v0.5), and a data-flow document.
- 2026-09-19 — Phase 0: workspace, sample documents, parsers, quote verification, extraction spike (43 of 43 claims verified), switch to OpenAI (`gpt-5.6-sol`, fallback `gpt-5.6-luna`), first commits pushed.

---
*Format note: keep entries short — this is a pointer to context, not a full changelog (that's what `git log` is for).*
