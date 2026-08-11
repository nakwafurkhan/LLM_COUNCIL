# LLM Council

Four answer modes behind one chat interface, on the Mesh API gateway. MERN: MongoDB,
Express, React, Node.

| Mode | What happens | Cost |
|---|---|---|
| **Quick** | One small fast model, streamed. | 1 call |
| **Council** | Karpathy's three-stage pipeline — parallel answers → anonymous peer review → chairman synthesis. | ~3–6× |
| **Study** | Paste a topic, get a pack: orientation, concept map, layered explanation, misconceptions, worked example, flip-cards, self-check quiz. | 1 long call |
| **Humanize** | Paste AI-sounding text; it drafts, audits its own draft, then rewrites. | 1 call |

`⌘1` `⌘2` `⌘3` `⌘4` switch modes. `⌘K` settings, `⌘H` history, `⌘I` images.

## Quick start

```bash
git clone <repo> && cd LLM_COUNCIL
npm install                 # installs both workspaces
cp .env.example .env        # add MESH_API_KEY and MONGODB_URI
npm run dev                 # API on :8787
npm run dev:client          # UI on :5173  (second terminal)
```

Open **http://localhost:5173**. Vite proxies `/api` to the server, so the browser only
ever sees one origin.

Production:

```bash
npm run build     # client → server/public
npm start         # Express serves API + UI on :8787
```

Both `MESH_API_KEY` and `MONGODB_URI` are required; the server refuses to start without
them rather than failing later in a confusing place.

## Why it is shaped this way

**The server owns the pipeline.** In the previous version the browser fanned out N
streaming fetches, ran peer review, called the chair, then posted a record. Now the client
opens **one** SSE stream and receives typed events. That buys four things: the key never
needs to reach the browser, one connection instead of N+N+1, the run is persisted
server-side so closing the tab mid-run does not lose it, and the client holds no
orchestration logic at all.

**Parsing happens once, on the server.** Study packs and humanizer output are split into
structured fields before they are stored, so restoring from history is a pure render —
the client has no second copy of the parsing rules to drift out of sync.

### SSE event vocabulary

| Event | Payload | Meaning |
|---|---|---|
| `stage` | `{ stage, label, total? }` | a phase started |
| `seat` | `{ index, model }` | a council card should appear |
| `delta` | `{ target, text }` | tokens for `main`, `chair`, or `seat:N` |
| `seatDone` | `{ index, ms, firstTokenMs, words, error? }` | one seat finished |
| `review` | `{ ranking }` | peer scores aggregated |
| `done` | `{ run }` | persisted document |
| `error` | `{ message }` | run failed or was stopped |

Deltas are coalesced on a 50ms timer. A fast model emits hundreds of one-character chunks
per second and one frame each is pure overhead; 50ms is under the threshold where
streaming stops feeling live.

## Layout

```
server/
  src/
    config/      env (.env loader, no dependency), db
    models/      Run, Setting — Mongoose schemas with their indexes
    services/    meshClient (the only code that talks to the gateway)
                 prompts, sse, pipelines/{quick,council,study,humanize}
    routes/      chat, runs, settings, health, images
    middleware/  errors
    app.js       wiring only
    index.js     config check → connect → listen
  scripts/       migrate-json.js
  tests/         vitest, pure-function coverage
client/
  src/
    components/  Header, Composer, Turn, LiveTurn, cards, Leaderboard,
                 StudyPack, HumanizeResult, sheets
    hooks/       useRunStream (SSE reducer), useSettings, useRuns, useTheme
    lib/         api, markdown, modes
    styles/      tokens + app + parts
```

## How Council works

1. **Deliberation** — every seat answers in parallel. A seat that fails records its error
   and drops out; it never aborts the run.
2. **Peer review** — each seat sees all answers relabelled *Response A, B, C…*, reshuffled
   per reviewer, authorship stripped, its own answer unmarked. It returns JSON scores via
   `response_format: json_object`, with a loose-parse fallback for models that ignore it.
   **Self-votes are discarded** — a model rating its own answer is not evidence.
3. **Chairman** — reads the answers *and* the rankings, told to find the real disagreement
   rather than recap each seat.

Turn Stage 2 off in Settings to halve the seat calls.

## How Humanize works

Based on Wikipedia's *Signs of AI writing*. One call returns four sections and the server
splits them: **Draft**, **Tells** (the model auditing its own draft for what still reads
machine-written), **Final**, **Changes**. The audit is the point — a single rewrite tends
to launder slop into cleaner slop.

Two guardrails in the prompt: never invent specificity (no fabricated statistics or sources
to replace vague ones), and preserve register. Set a **voice sample** in Settings and it
matches your rhythm and vocabulary instead of defaulting to generic-natural.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MESH_API_KEY` | — | **Required.** Server-side only |
| `MONGODB_URI` | — | **Required.** Atlas or local mongod |
| `PORT` | `8787` | API port |
| `MONGODB_DB` | `llm_council` | Database name |
| `MESH_BASE_URL` | `https://api.meshapi.ai` | Upstream gateway |
| `MESH_TIMEOUT_MS` | `120000` | Per-request upstream timeout |
| `CORS_ORIGINS` | `http://localhost:5173` | Dev only; production is same-origin |

The server reads `.env` itself — no dotenv dependency, and no `--env-file` flag, so Node 18
works. Real environment variables win over the file.

**Your key is never stored in Mongo.** Settings sync so a second device inherits your
models and preferences, but `scrubSecrets()` drops any key-named field and any value shaped
like `rsk_…` or `sk-…`, recursively, on the way in.

## Migrating from v1

```bash
node server/scripts/migrate-json.js path/to/council-data.json
```

Converts the old loose payload blobs into typed documents, re-parsing study and humanizer
raw text through the same functions the live pipeline uses. Re-runnable: it matches on
original `createdAt` + prompt and preserves the original timestamps.

## Tests

```bash
npm test
```

Vitest over the pure functions — the JSON extractor, section splitter, flashcard and quiz
parsers, and the review aggregator, including that self-votes are dropped and that a
reviewer returning garbage does not poison the ranking.

## Known gaps

- No integration test against a live Mongo; `mongodb-memory-server` would be the next add.
- Default model slugs are a guess at the current catalog. **Settings → Check connection**
  reports how many models your key can actually see; edit any seat inline.
- Uploaded images become `data:` URLs. Fine for screenshots, slow for 12-megapixel photos.
