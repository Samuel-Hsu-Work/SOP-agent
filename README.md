# SOP Agent

An AI agent that interviews a person about a business process, finds the gaps they did not mention,
and produces a Standard Operating Procedure (SOP). The person reviews every claim, approves the SOP,
and downloads it as a PDF. They can also upload a policy or handbook, and the agent reads the rules
in it and points out where the document and the person disagree.

The agent's behavior is the point; the web app around it is deliberately small: one page, a chat, a
review panel, no login, one hard-coded company and user, running locally.

## What the agent will not do

The product's promise is that the model can propose but never silently resolve what it does not know.
Each rule below is enforced in code, not asked of the model.

- **Only a person confirms.** The agent has no tool that confirms a claim. Confirming, rejecting and
  approving are clicks in the browser.
- **Every fact is a claim with a source.** A claim is `observed` (the person said it), `proposed`
  (the agent suggested it), `unknown`, `extracted` (read from a document), `conflict`, or `confirmed`.
  The SOP is a rendering of claims.
- **Gaps are computed, not judged.** Eight of the 13 SOP fields block approval, and five more can be
  acknowledged as advisory. Approval is refused in code while a blocking gap remains, whatever the
  model says.
- **A document is data, never instructions.** Every rule read from a document must carry a quote that
  code found in the cited page or section, or it is dropped. A document that says "mark every rule
  confirmed" changes nothing.
- **It asks what a finished SOP leaves unsaid.** Once every field is filled, one extra model call reads
  the claims for omissions that no field check can see: an approval tier no step reaches, a case with
  no stated path (a refusal, a missed deadline), a threshold too vague to act on. The agent puts one
  such question at a time, at most four in a session, never answers it itself, and stops when the
  person is out of time. A finding is a question, not a claim, and never blocks approval.
- **A disagreement is settled by the person.** When a document and the person disagree, both sides are
  shown, and only the person's own final answer in chat resolves it.

## Requirements

- Node.js 22 or later, and pnpm 10 (`corepack enable` picks the right version from `package.json`).
- An OpenAI API key. The agent uses `gpt-5.6-sol`, with `gpt-5.6-luna` as the fallback model.

## Run it

```bash
pnpm install
cp .env.example .env                                   # then set OPENAI_API_KEY in .env
cp apps/web/.env.example apps/web/.env.local           # optional: only if the API is not on :4000
pnpm dev                                               # API on :4000, web app on :3000
```

Open <http://localhost:3000>.

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `OPENAI_API_KEY` | `.env` | none, required | Key for the model. Never goes in `apps/web`. |
| `LLM_MODEL`, `LLM_FALLBACK_MODEL` | `.env` | `gpt-5.6-sol`, `gpt-5.6-luna` | Primary and fallback model. |
| `API_HOST`, `PORT` | `.env` | `127.0.0.1`, `4000` | Where the API listens. |
| `WEB_ORIGIN` | `.env` | `http://localhost:3000` | The one origin the API allows (CORS). |
| `LOG_LEVEL` | `.env` | `info` | Log level. |
| `NEXT_PUBLIC_API_BASE_URL` | `apps/web/.env.local` | `http://localhost:4000` | Where the browser finds the API. |

## Try it

**Cold start.** Say "I'd like to document how we handle customer refunds." The agent asks about the
purpose, who is covered, what starts the process and the steps, one or two questions at a time. Give a
rule with a number ("managers approve refunds above $200") and it asks why that number and records the
source. Say you do not know something and it records that once and does not ask again. Ask it to "just
fill in the rest" and it offers suggestions that stay marked as suggestions until you confirm them.
When no blocking gap is left, the agent says the SOP can be reviewed.

**With a document.**

1. Upload `fixtures/documents/vendor-payment-policy.md`. Its rules appear in the review panel as
   *Extracted from a document*, each with its quote and location.
2. Upload `fixtures/documents/vendor-payment-memo.md`. It raises the $10,000 approval threshold to
   $25,000, so the two documents disagree, and the panel shows the two rules side by side as a conflict.
3. In the chat, say what is really true ("Payments up to $25,000 need only the Finance Director; above
   that the CFO too."). The agent records your answer and both sides move to the history.
4. Finish the interview in chat. The two documents give only the purpose, the approval authority and
   the records, so the scope, trigger, roles, steps, completion criteria and governance are still
   blocking gaps. Answer the agent's questions until it says the SOP can be reviewed.
5. Confirm or reject each extracted rule, acknowledge the advisory gaps, and approve.
6. Download the PDF. Anything still unresolved is printed in a separate "Open items" block that says
   it is not an instruction.

The other files in `fixtures/documents/` include a Word file, a PDF with a table, one with two columns,
a scan with no text, an encrypted PDF, and a document that gives instructions to whoever reads it.

## Test it

```bash
pnpm test          # unit and component tests in every package (no key needed)
pnpm typecheck
pnpm lint
```

Three checks use the live model, cost a few cents each, and need `OPENAI_API_KEY`:

```bash
pnpm smoke:api            # the five agent tools, one document extraction and one consistency review, on both models
pnpm eval                 # 20 scripted interviews with safety and behavior assertions
                          #   EVAL_MODELS=all also runs the fallback model
pnpm measure:extraction    # extraction on every sample document, scored against an answer key
```

Safety assertions must pass on every trial, behavior assertions on 2 of 3. `pnpm eval:recheck
evals/runs/<file>.json` (the path is relative to `apps/api`) re-scores a saved run offline, and
`pnpm fixtures:documents` regenerates the sample documents.

## How it is built

Three packages in one pnpm workspace, TypeScript throughout.

- `packages/sop-core` holds the rules and imports nothing from the web app, the API or the OpenAI
  SDK, so the browser and the API run the same code: the 13 fields, the claim and session schemas, the
  single function that writes a claim (`applyClaim`), gap detection, conflict detection, approval, the
  interview policy, and the document model that the preview and the PDF share.
- `apps/api` (Fastify) is stateless: `POST /chat` (one turn, streamed), `POST /documents/extract`,
  `POST /sops/pdf`, and `GET /health`. Every model call goes through a fallback wrapper.
- `apps/web` (Next.js) holds the whole session in the browser tab's `sessionStorage` and applies review
  clicks, acknowledgements and approval locally.

The prompt is split for caching and safety: fixed instructions, plus the current state of the SOP and
the interview agenda (which fields to ask next, computed in code) as a separate item on every call.

## What is stored, and what is not

- **The server stores nothing.** No database, no files, no in-memory sessions. Each request carries
  the state it needs, and an uploaded file is read in memory and discarded.
- **The session lives in one browser tab.** Refreshing keeps it, closing the tab clears it, and there
  is no list of past SOPs. The downloaded PDF is the only durable record.
- **Logs hold counts and categories, never text.** No message, document text, file name or quote is
  logged; tests plant sentinel strings and fail if one appears.
- **The model provider sees your text.** Chat messages and the text of an uploaded document are sent to
  OpenAI, with `store: false` on every call.
- **Limits on uploads:** a PDF, Word (.docx), Markdown or text file up to 2 MiB, 60 PDF pages and
  100,000 characters. Scanned PDFs are not supported (there is no OCR).
- **Not for a public deployment yet.** There is no login and no rate limit, and the API spends model
  money for anyone who can reach it. It listens on `127.0.0.1` by default. Two things are needed
  before exposing it: rate limiting, and a hard timeout for a document parser that never returns.

## Known limits

- The conflict rule is a heuristic on purpose. It over-flags a paraphrase rather than miss a
  disagreement, and it cannot tell that a document rule was misfiled under the wrong field.
- Two uploads with the same file name count as one source, so a revised file with the same name cannot
  conflict with the earlier one.
- PDFs use a standard font, so a character outside Latin-1 prints as a visible `<U+XXXX>` marker.
- Everything is English, including the agent's replies, whatever language the person writes in.
