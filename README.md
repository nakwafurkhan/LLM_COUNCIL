# LLM Council

Five ways to put a model to work, with the cost and failure modes visible rather than hidden.

| Mode          | What it does                                                                                                                                      | Latency                                           | Cost per turn                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| **Chat**      | Full-depth conversation with streaming and persistent history                                                                                     | Seconds                                           | Highest — frontier model, large context                 |
| **Quick**     | The same code path with a cheap model, tight token cap and terse prompt                                                                           | Sub-second to seconds                             | ~15× cheaper than Chat                                  |
| **Council**   | Asks several models the same question, then a chairman synthesises and names the disagreements                                                    | Slowest — bounded by the slowest surviving member | Sum of all members plus the chairman                    |
| **Code+PR**   | Plans a multi-file change, writes it in an isolated worktree, runs your lint and tests, shows you the diff, and opens a PR only after you approve | Minutes                                           | One planning call plus one per file, plus repair rounds |
| **Humanizer** | Strips AI-writing tells from text in three passes: rewrite, self-audit, revise. All three are shown                                               | Slow on long text                                 | Three passes over your full text                        |

---

## Setup

```bash
git clone https://github.com/nakwafurkhan/LLM_COUNCIL.git
cd LLM_COUNCIL
npm install
cp .env.example .env      # fill in MESH_API_KEY and MONGODB_URI
npm run dev               # API on :8787, client on :5173
```

Or with Docker. The default compose file uses whatever `MONGODB_URI` is in your
`.env` — Atlas, a managed host, anything — rather than hijacking it:

```bash
cp .env.example .env      # fill in MESH_API_KEY and MONGODB_URI
docker compose up
```

If you would rather have a disposable Mongo in a container, add the override:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-db.yml up
```

Either way, open **http://localhost:5173**.

Requires Node 20 or 22.

---

## Architecture

```
                    ┌──────────────────────────────────────┐
  browser  ───────► │ client/  React 18 + Vite             │
                    │  /chat /quick /council /pr /humanize │
                    └───────────────┬──────────────────────┘
                                    │  JSON + SSE over /api
                    ┌───────────────▼──────────────────────┐
                    │ server/src/app.js  buildApp()        │
                    │  requestId → helmet → cors → rate    │
                    │  limit → validate(zod) → routes      │
                    │  → one terminal error handler        │
                    └──┬────────┬─────────┬─────────┬────────┘
                       │        │         │         │
       ┌───────────────▼┐ ┌─────▼─────┐ ┌─▼────────┐ ┌▼──────────┐
       │  conversation  │ │  council  │ │  codePR  │ │ humanizer │
       │    service     │ │  service  │ │ planner →│ │  draft →  │
       │   chat+quick   │ │  fan-out  │ │ context →│ │  audit →  │
       └───────────────┬┘ └─────┬─────┘ │ generate→│ │  revise   │
                       │        │       │ verify → │ │ +detector │
                       │        │       │ diff →   │ └┬──────────┘
                       │        │       │ approve  │  │
                       │        │       └─┬────────┘  │
                       └────────┴─────────┴───────────┘
                                    │
                 ┌──────────────────▼───┐        ┌──────────────┐
                 │ services/llm adapter │        │   MongoDB    │
                 │ the ONLY importer of │        │ Conversation │
                 │ the openai SDK       │        │ Message      │
                 └──────────┬───────────┘        │ CouncilRun   │
                            │                    │ PrJob        │
                     MeshAPI router              │ HumanizerRun │
                                                 └──────────────┘
```

Four rules hold the thing together:

1. **`app.js` exports a factory and never calls `listen()`.** `index.js` is the only file that opens a port. This is what lets the integration suite drive a real Express app through supertest with no sockets.
2. **One LLM adapter.** Nothing outside `services/llm/` imports the `openai` SDK, so every test swaps the entire provider for a scriptable fake.
3. **Nothing reads `process.env` outside `config/env.js`.** That rule is exactly what would have prevented the `MESHAPI_KEY` / `MESH_API_KEY` drift described below.
4. **One error taxonomy, one terminal handler.** No route calls `res.status(500)`. Stack traces never cross the wire in production.

---

## API reference

All routes are under `/api`. Every error response has the same shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "requestId": "3f9c…",
    "fields": [{ "path": "prompt", "message": "must not be empty" }]
  }
}
```

### Chat and Quick

The mode lives on the conversation; both use the same endpoints.

```http
POST /api/conversations
{ "mode": "chat" }                    → 201 { id, mode, title, model, … }

POST /api/conversations/:id/messages
{ "content": "Why is the sky blue?", "stream": true }
```

With `stream: true` (the default) the response is SSE:

```
event: delta
data: {"text":"Because "}

event: message
data: {"messageId":"…","content":"Because …","usage":{"promptTokens":11,"completionTokens":84,"costUsd":0.000868},"latencyMs":1420}

event: done
data: {"ok":true}
```

With `stream: false` you get `201 { message, conversation }` instead — useful for scripts that should not have to speak SSE.

Also: `GET /api/conversations`, `GET /api/conversations/:id/messages`, `POST /api/conversations/:id/regenerate`, `POST /api/conversations/:id/archive`, `DELETE /api/conversations/:id`.

### Council

```http
POST /api/council
{ "prompt": "Should we use Postgres or Mongo here?", "stream": true }
```

SSE events arrive in this order: `start`, one `member` per model **as it lands**, `chairman-start`, many `chairman-delta`, `complete`, `done`. The completed run:

```json
{
  "id": "…",
  "memberAnswers": [
    {
      "model": "openai/gpt-4o",
      "status": "fulfilled",
      "content": "…",
      "latencyMs": 3200,
      "costUsd": 0.0041
    },
    {
      "model": "anthropic/claude-3-5-sonnet",
      "status": "timeout",
      "error": "…",
      "latencyMs": 60000
    }
  ],
  "finalAnswer": "…",
  "disagreements": [
    {
      "claim": "whether write throughput matters here",
      "positions": [{ "model": "openai/gpt-4o", "stance": "it does" }]
    }
  ],
  "confidence": "medium",
  "partial": true,
  "partialReason": "1 of 3 members did not answer: anthropic/claude-3-5-sonnet (timeout)",
  "totals": { "costUsd": 0.0068, "latencyMs": 61200 },
  "cached": false
}
```

Also: `GET /api/council`, `GET /api/council/:id`.

### Code+PR

```http
POST /api/pr
Idempotency-Key: 8f14e45f
{ "task": "Add a /health endpoint and cover it with a test",
  "targetPaths": ["src/server.js"] }        → 202 { jobId, status: "queued" }
```

Then poll `GET /api/pr/:id` or stream `GET /api/pr/:id/stream`. The job walks:

```
queued → planning → generating → verifying → awaiting_approval
                                    ↓ (lint/tests fail)
                              repair ×N → failed
```

At `awaiting_approval` the job carries a per-file unified diff. `POST /api/pr/:id/approve` commits, pushes and opens the PR; `POST /api/pr/:id/reject` discards the branch and worktree. Nothing is pushed before approval.

### Humanizer

```http
POST /api/humanize
{ "text": "It's not just a tool—it's a testament to innovation…",
  "tone": "neutral",
  "voiceSample": "optional sample of your own writing",
  "stream": true }
```

Three passes, streamed in order: `start` (with the pattern scan of your input),
`draft-delta`/`draft`, `audit-delta`/`audit`, `final-delta`, `complete`, `done`.

The `audit` event is the interesting one. It carries the model's own answer to
"what makes this obviously AI generated?" about the draft it just wrote, and
those notes are fed into the third pass:

```json
{ "notes": ["The opening still reads like a summary", "Every sentence is the same length"] }
```

The completed run reports what changed:

```json
{ "before": { "total": 7, "per1000Words": 152, "findings": [ { "id": "em-dash", "count": 2, "severity": "medium", "examples": ["—"] } ] },
  "after":  { "total": 0, "per1000Words": 0, "findings": [] },
  "diff":   { "delta": 7, "removed": [...], "remaining": [], "introduced": [] } }
```

`introduced` is not decoration: a rewrite can trade one tell for another, and
the UI surfaces it when that happens.

**What the pattern count does and does not mean.** It covers the mechanically
detectable subset — em dashes, curly quotes, emoji, bolded list headers, AI
vocabulary density, rule of three, filler, copula avoidance, signposting and a
few more. It cannot see inflated significance, superficial analysis, or the
absence of a point of view. Text can score zero and still read like a press
release. The number is a floor, not a verdict, and the UI says so.

Also: `GET /api/humanize`, `GET /api/humanize/:id`.

### Health

`GET /api/health` reports process uptime, Mongo reachability, and which optional subsystems are configured — as booleans, never values.

---

## Testing

```bash
npm test              # unit + integration + client
npm run test:unit
npm run test:integration
npm run test:client
npm run test:e2e      # Playwright
npm run test:coverage # enforces the thresholds
```

**No test makes a real network call to MeshAPI, GitHub, or any model.** The suite needs no API key.

- **Unit** — pure logic. Config validation, the adapter's retry/timeout classification (over msw-intercepted HTTP), council fan-out helpers, chairman parsing, path containment, branch sanitisation, planner validation, cost math, redaction.
- **Integration** — a real Express app, real Mongo via `mongodb-memory-server`, and the fake adapter. Includes a full Code+PR run against a **throwaway git repo with a bare origin on disk**, so pushes are real pushes that simply go to a directory instead of github.com.
- **Component** — React Testing Library, including an explicit XSS test asserting a `<script>` payload in model output renders inert.
- **E2E** — Playwright against the built client with `USE_FAKE_LLM=true`.

The fake adapter (`server/tests/fixtures/fakeLlm.js`) is scriptable per model: canned content, injected latency, thrown errors, hangs that trigger real timeouts, fail-then-recover, and token-stream simulation. That is what makes the council's interesting cases — one member down, one hanging, all down — expressible as tests rather than as hopes.

---

## Migrating from the old `server.js`

The pre-2.0 app was seven files: a `node:http` server with one `POST /api/chat` route, a hardcoded `openai/gpt-4o`, static file serving, and conversation history living in a browser-side array.

| Then                                                                     | Now                                                                                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MESHAPI_KEY` in code, `MESH_API_KEY` in `.env.example`                  | **`MESH_API_KEY` only.** Validated at boot; the old spelling no longer satisfies the requirement, and a test pins that.                                  |
| `path.join(__dirname, "public", req.url)` served files outside `public/` | Static serving is gone. The client is a built React bundle; the server is JSON and SSE only.                                                             |
| Model hardcoded, no timeout, no retry                                    | Models and timeouts come from validated config. Every call has an enforced deadline and bounded, jittered retries that fire only for retryable failures. |
| Browser posted its whole `messages` array each turn                      | Server-side persistence. The client posts only the new turn.                                                                                             |
| `POST /api/chat`                                                         | `POST /api/conversations/:id/messages`                                                                                                                   |

**If you ran the old version:** `.env` was already gitignored, and no key was ever committed to this repository. If you pasted a key anywhere else while testing, rotate it.

To migrate: copy your `MESH_API_KEY` into the new `.env`, add a `MONGODB_URI`, and run `npm install && npm run dev`. There is no data to migrate — the old version never stored any.

---

## Configuration

Every variable is documented in [`.env.example`](.env.example), grouped by area with defaults. Only two are required: `MESH_API_KEY` and `MONGODB_URI`. Bad config fails at boot with the offending variable named, rather than surfacing as a 500 on first request.

---

## Design decisions worth knowing about

**In-process job queue, not BullMQ + Redis.** Code+PR jobs run in-process with the job record in Mongo as durable state. Redis would buy retries that survive a restart; the same safety comes here from reconciling interrupted jobs at boot, and from the fact that nothing pushes without human approval anyway. Revisit this when the server runs as more than one process — at that point two workers could pick up the same job.

**Costs are estimates, not billing data.** MeshAPI does not return a price with a completion, so `lib/tokenCost.js` derives cost from a static per-model table. Treat the numbers as an order-of-magnitude guide for the Chat/Quick tradeoff, not an invoice. Prices drift; the table is in one place for that reason.

**Rolling summary, not retrieval.** Long conversations are compacted by summarising aged-out turns with the cheap model rather than by embedding and retrieving them. Simpler, and adequate until threads get much longer.

**Branch names are rejected, not sanitised.** Rewriting `a;rm -rf /` into something safe would create a branch nobody asked for and hide the fact that something tried.

---

## Limitations

Still true after this work:

- **Single-process job execution.** Two server instances would both run jobs; there is no distributed lock. Fine for one process, not for a horizontally scaled deployment.
- **No auth.** There are no users and no sessions. Anyone who can reach the API can spend your model budget and open pull requests. Do not expose this to the internet without putting something in front of it.
- **Token counting is approximate.** ~4 characters per token, not a real tokenizer. Fine for budgeting a context pack; wrong at the margins, especially for non-English text and non-OpenAI models.
- **Context packing is lexical, not semantic.** Related files are found by grepping for symbols from the task, which reliably finds a named symbol's definition and reliably misses a conceptually related file that shares no vocabulary.
- **The chairman is one model's opinion.** It can smooth over a disagreement it should have surfaced. The structured `disagreements[]` makes that failure visible, not impossible.
- **Council cost scales linearly with members.** There is no early exit when the first two members already agree.
- **Repair rounds regenerate whole files.** A large file with a one-line lint error is rewritten entirely, which is wasteful and can introduce unrelated churn.
- **The humanizer's pattern detector covers about a third of the spec.** The countable patterns are counted; judgement calls are left to the model. A clean score means "no mechanical tells", not "this is good writing".
- **The humanizer costs three passes.** Every run sends your full text upstream three times. On a long document that adds up quickly.
- **No streaming for Code+PR generation.** Progress is reported per stage, not per token, so a long generation looks idle.
