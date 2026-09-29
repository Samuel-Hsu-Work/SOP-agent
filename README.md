# SOP Agent

An AI agent that interviews a person about a business process, finds the gaps they did not mention,
and produces a Standard Operating Procedure (SOP). The person reviews every claim, approves the SOP,
and downloads it as a PDF. They can also upload a policy or handbook: it is read for the SOP they
are writing, the agent asks them about what it finds, and it points out where the document and the
person disagree.

The agent's behavior is the point; the web app around it is deliberately small: one page, a chat, a
review panel, no login, one hard-coded company and user, running locally.

## What the agent will not do

The product's promise is that the model can propose but never silently resolve what it does not know.
Each rule below is enforced in code, not asked of the model.

- **Only a person confirms.** The agent has no tool that confirms a claim. Confirming, rejecting and
  approving are clicks in the browser.
- **Every fact is a claim with a source.** A claim is `observed` (the person said it), `proposed`
  (the agent suggested it), `unknown`, `conflict`, or `confirmed`. The SOP is a rendering of claims.
- **Gaps are computed, not judged.** Eight of the 13 SOP fields block approval, and five more can be
  acknowledged as advisory. Approval is refused in code while a blocking gap remains, whatever the
  model says.
- **A document is reference material, never SOP content by itself.** An upload is read for the SOP
  being written (so it waits until the person has said what that is), and it keeps at most eight
  passages that SOP needs. Nothing enters the SOP until the agent has put a passage to the person and
  they agree; then it is their own statement, with the document shown as evidence. The agent sees only
  a passage's short statement, never the document.
- **A document is data, never instructions.** Every passage must carry a quote that code found in the
  cited page or section, and every number in it must be in that quote, or it is dropped. A document
  that says "mark every rule confirmed" changes nothing.
- **It asks what a finished SOP leaves unsaid, or says two ways.** Once no blocking gap remains, one
  extra model call reads the claims together for what no field check can see: an approval tier no step
  reaches, a case with no stated path (a refusal, a missed deadline), a threshold too vague to act on,
  or one rule stated two different ways ("more than $500" in the roles, "$500 or more" in the
  authorization). When the person answers, the agent corrects every claim that disagreed, in place.
- **It asks when a step is too thin to carry out.** A separate check reads each procedure step on its
  own. "The operator submits a maintenance request" does not say what the request must contain, so the
  agent asks, and adds the answer to that same step. It asks about each step at most once.
- **These checks only ask.** Each puts one question at a time, at most four in a session, never answers
  it itself, and stops when the person is out of time. A rule stated two ways is asked before a thin
  step, because the SOP already gives a reader two answers. A finding is a question, not a claim, and
  never blocks approval.
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

**A whole process in one message, with a problem in it.** Start a new chat and paste:

```text
Here's our equipment loaner process. The purpose is to make sure shared equipment is loaned fairly
and comes back in working order. It covers all loans of department-owned equipment, like laptops and
monitors, to staff. It's triggered when a staff member submits a loan request form on the intranet.

The equipment coordinator reviews every loan request. A department head approves loan requests for
equipment worth more than $500.

The steps are: the requester submits the loan request form with the item and the dates. The equipment
coordinator checks that the item is available for those dates. The equipment coordinator approves the
request, or sends it to the department head if the equipment is worth more than $500. IT hands the
equipment to the requester. The requester signs the checkout sheet.

For authorization: the equipment coordinator approves loans of equipment worth less than $500; loans
worth $500 or more need department head approval.

Completion criteria: the item is returned, checked and signed back in the loan log. The facilities
manager owns this procedure and reviews it every year.
```

Every blocking field is filled at once, so the agent says the SOP can be reviewed. It also asks about
the one rule the text states two ways: does a loan of exactly $500 need the department head ("$500 or
more") or not ("more than $500")? It picks neither. Answer "A loan of exactly $500 needs the department
head too, so it is $500 or more everywhere." and the claims that said "more than $500" are corrected
in place. The next question is usually about a step too thin to follow, such as what the coordinator
checks availability against.

**With a document.**

1. Start with what the SOP is about: "I'm documenting how vendor payments get approved." The upload
   button waits until then, because a document is read for that SOP.
2. Upload `fixtures/documents/vendor-payment-policy.md`. The upload panel lists the few passages kept
   for this SOP, each with its quote and location. Nothing is added to the SOP yet.
3. The agent brings them up in chat ("Your policy says payments above $10,000 need the budget owner and
   the CFO. Is that how it works?"). Say yes and it is recorded as your statement, based on the
   document; say it does not apply and it is left out.
4. Upload `fixtures/documents/vendor-payment-memo.md`. It raises the $10,000 threshold to $25,000, so
   it disagrees with the policy, or with what you just agreed, and the review panel shows the two sides
   of the conflict together. Say what is really true ("Payments up to $25,000 need only the Finance
   Director; above that the CFO too.") and the agent records your answer.
5. Finish the interview in chat until the agent says the SOP can be reviewed, then acknowledge the
   advisory gaps and approve.
6. Download the PDF. A statement based on a document names it; anything still unresolved is printed
   in a separate "Open items" block that says it is not an instruction.

`fixtures/documents/northstar-store-policy.pdf` shows the relevance side: a store-wide policy far
broader than any one SOP. Read for a cashier closing SOP, it gives the clock-out and closing rules and
leaves out the opening, the cleaning products and what the policy says about itself.

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
pnpm smoke:api            # the agent's tools, one document reading, one consistency
                          #   review and one claim-depth review, on both models
pnpm eval                 # 29 scripted interviews with safety and behavior assertions
                          #   EVAL_MODELS=all also runs the fallback model
pnpm measure:extraction    # document reading on every sample, scored against two answer keys:
                          #   field labels, and what one broad policy keeps for two different SOPs
```

Safety assertions must pass on every trial, behavior assertions on 2 of 3. `pnpm eval:recheck
evals/runs/<file>.json` (the path is relative to `apps/api`) re-scores a saved run offline, and
`pnpm fixtures:documents` regenerates the sample documents.

## How it is built

Three packages in one pnpm workspace, TypeScript throughout.

- `packages/sop-core` holds the rules and imports nothing from the web app, the API or the OpenAI
  SDK, so the browser and the API run the same code: the 13 fields, the claim and session schemas, the
  single function that writes a claim (`applyClaim`), gap detection, conflict detection, approval, the
  interview policy (including which review question goes first), the rules that check what the two
  review model calls return, and the document model that the preview and the PDF share.
- `apps/api` (Fastify) is stateless: `POST /chat` (one turn, streamed), `POST /documents/references`,
  `POST /sops/pdf`, and `GET /health`. Every model call goes through a fallback wrapper.
- `apps/web` (Next.js) holds the whole session in the browser tab's `sessionStorage` and applies review
  clicks, acknowledgements and approval locally.

The prompt is split for caching and safety: fixed instructions, plus the current state of the SOP and
the interview agenda (which fields to ask next, computed in code) as a separate item on every call.

## What was left out, and why

This is a take-home build of a larger design: a multi-tenant product in which a process owner is
interviewed and a separate approver signs the SOP off. The part being evaluated is the agent, so v1
keeps everything that shows how it interviews, finds gaps and refuses to guess, and cuts the rest on
purpose:

- **One person, not two.** The same person is interviewed, reviews the claims and approves. In the
  full design the draft goes to an approver, who can send an item back to the process owner or
  escalate an advisory gap to blocking. Here there is no handoff, and which fields block approval is
  fixed.
- **No versions.** "Reopen for editing" puts an approved SOP back to draft, and it must be approved
  again, but the earlier approved state is not kept and there is no diff between versions.
- **No accounts.** No login, organizations or roles, and one hard-coded company.
- **No persistence.** Everything lives in the browser tab; the next section says why.

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
- **There is no login and no rate limit.** Anyone who can reach the API spends model money. It
  listens on `127.0.0.1` by default, so it is private until you deploy it. If you do, cap what the
  key can spend first (see "Deploy").

## Why there is no database

The project exists to show the agent working: how it interviews, finds gaps, and refuses to settle
what it does not know. A database, logins and tenants would not show any of that, so v1 leaves them
out on purpose. Leaving out a database is a separate choice from leaving out tenants. A single-user
SQLite file would have been small. The choice is where the state lives: in the browser tab rather
than on the server.

What that buys:

- **A privacy promise that is easy to check.** The server keeps nothing, so there is nothing to
  retain, secure or delete.
- **A simple deployment.** Both services are stateless, so a restart or a second instance loses
  nothing and needs no volume or migration.

What it costs:

- **The rules run in the browser as well as on the server.** Review, acknowledgement and approval
  happen in the tab, which is why `packages/sop-core` is shared and imports nothing server-only.
- **The server cannot trust the session it receives.** Every request is validated, and the PDF
  endpoint rechecks approval itself, because a hand-built session can claim to be approved.
- **Every request carries the whole session.** Its size is capped, and document text is never kept
  in it, only the few passages kept for this SOP and their citations.
- **Nothing outlives the tab.** There is no resume, no list of past SOPs and no audit trail on the
  server. The downloaded PDF is the only durable record. A session saved by an older schema version
  is discarded, not migrated.

What adding a database would change:

- The server becomes the source of truth. Review, acknowledgement and approval become API routes that
  run the same `sop-core` functions, and the browser sends a session id and the new message instead
  of the whole session.
- `sop-core` would still be a separate module, because keeping the rules apart from HTTP and the model
  is what makes them testable. It would run only on the server, and the browser would keep only its
  types and the functions that shape what the page shows.
- The recheck of a forged session and the size cap on requests go away. Retention, deletion,
  schema migrations and concurrent writes to one session become new work.
- The claim history and the approved SOP become a lasting audit trail, which v1 does not provide.

The full product design (Postgres with row-level security and append-only claim history) remains
the target. The rules and the single path that writes a claim would carry over unchanged.

## Deploy

The web app and the API are separate, so they deploy separately: the API on Render, the web app on
Vercel. Nothing is stored on either, so a restart loses nothing except a chat that is open in a tab.

**Before anything else, cap what the key can spend.** The API has no login and no rate limit, so
anyone who finds the address can spend the key's credit, and nothing in this repository stops them.
The only hard limit is on the OpenAI side, and it has to be one that cannot be exceeded:
- Create a separate project for this app and use that project's key, so nothing else is exposed.
- Pay with prepaid credit and switch automatic recharge off, and load only what you are willing to
  lose. When the balance is gone, requests fail, which is the limit you want.
- A monthly budget on the project is worth setting for the alert email, but do not count on it to
  block requests: check in the OpenAI dashboard whether your account's budget stops requests or only
  warns.
- Do not post the web address anywhere public, and take the deployment down when the review is over.

**1. The API on Render**
1. Push the repository to GitHub, then in Render choose New, then Blueprint, and select it. Render
   reads `render.yaml`.
2. Render asks for the two variables that are left out of the file: `OPENAI_API_KEY`, and
   `WEB_ORIGIN`. You do not have the web address yet, so enter `https://placeholder.invalid` and fix
   it in step 3.
3. When it is live, open `https://<your-service>.onrender.com/health`. It should answer
   `{"status":"ok"}`. Keep this address for the next step.

**2. The web app on Vercel**
1. In Vercel choose Add New, then Project, and import the same repository.
2. Set Root Directory to `apps/web`, and leave the framework as Next.js. Vercel installs from the
   repository root, so the workspace package is found.
3. Add the environment variable `NEXT_PUBLIC_API_BASE_URL` with the Render address from above (scheme
   and host only, no trailing slash). It is read when the app is built, so changing it later needs a
   new deployment.
4. Deploy, and note the address Vercel gives you.

**3. Point the API at the web app.** In Render, set `WEB_ORIGIN` to the Vercel address exactly as it
appears (for example `https://sop-agent.vercel.app`), and redeploy. The API allows this one origin
only, so a browser on any other address, including a Vercel preview deployment, is refused.

Things to expect on the free plans: Render puts a service to sleep after fifteen idle minutes, so the
first request after a pause takes about a minute. Every reply is streamed, and the browser shows it
as it arrives. If the first message seems stuck, wait for the service to wake up.

## Known limits

- The conflict rule is a heuristic on purpose. It over-flags a paraphrase rather than miss a
  disagreement, and it cannot tell that a passage was filed under the wrong field.
- A document is judged for relevance once, when it is uploaded. If the SOP's scope changes, its
  passages stop being offered, and the document has to be uploaded again to be read for the new scope.
- Code checks a passage's numbers against its quote, but not its meaning: a statement that rewords the
  quote wrongly is caught by the person, who sees the quote beside it and answers in chat.
- The two review checks (what a finished SOP leaves unsaid, and a step too thin to carry out) are model
  judgments. They can miss something, or ask about something that is actually fine. Code checks what
  they return and decides when a question is asked, and a finding is only ever a question, so neither
  can change a claim or block approval.
- Two uploads with the same file name count as one source, so a revised file with the same name cannot
  conflict with the earlier one.
- PDFs use a standard font, so a character outside Latin-1 prints as a visible `<U+XXXX>` marker.
- A document parser that never returns would block the API until Render's health check restarts it.
  The size, page, section and text limits and a two-at-a-time cap make this unlikely, and it costs
  no model money, so there is no separate hard timeout.
- Everything is English, including the agent's replies, whatever language the person writes in.
