# LLM Council — Mesh API edition

Instead of asking one model your hardest question, convene a **council**: several
models answer independently, then review and rank each other's answers with
authorship hidden, and a **Chairman** model synthesises the final response.

Inspired by [karpathy/llm-council](https://github.com/karpathy/llm-council), with
three differences:

| | Original | This app |
|---|---|---|
| Gateway | OpenRouter | **[Mesh API](https://meshapi.ai)** — 900+ models, one key, pay in INR/UPI |
| Resilience | a dead provider kills the run | per-seat **fallback model**, degraded-chairman recovery, failed seats reported not fatal |
| Extra mode | — | **Code + PR** — the council drafts a change and opens a real pull request |

Everything else is faithful: three stages, tab view over first opinions, JSON
storage, FastAPI + React.

---

## The three stages

1. **First opinions** — the query goes to every council member in parallel; each
   answers independently. Shown in a tab view so you can read them side by side.
2. **Peer review** — every member receives the others' answers and ranks them on
   accuracy and insight. Identities are hidden (see below), and the results are
   aggregated with Borda counting into a leaderboard.
3. **Final answer** — the Chairman receives the question, every answer, and the
   peer ranking, and writes the answer you should have got in the first place.

### Anonymisation is not just relabelling

Models sign their work — *"As Claude, I'd argue..."*, *"I'm ChatGPT, so..."* — and
a reviewer who can tell whose answer it is stops judging on merit. So Stage 2
does two things: assigns neutral labels (`Response A/B/C`), **and scrubs
self-identifying text out of the bodies** — vendor names, model families,
namespaced ids like `anthropic/claude-sonnet-4.5`, and phrases like *"as a large
language model trained by ..."*. `tests/test_anonymize.py` and
`tests/test_council.py::test_stage_two_prompts_never_contain_model_identities`
are the guarantee.

---

## Setup

### 1. Get a Mesh key

Sign up at [meshapi.ai](https://meshapi.ai) and create a key (`rsk_...`). Mesh is
OpenAI-compatible, so this app only needs a base URL and a key — no vendor SDKs.

### 2. Configure

```bash
cd council-py
cp .env.example .env
# then edit .env and set MESH_API_KEY
```

### 3. Install

**Backend** (Python 3.9+):

```bash
pip install -r requirements.txt
```

**Frontend** (Node 18+):

```bash
cd frontend && npm install && cd ..
```

### 4. Run

```bash
./start.sh
```

…or manually, in two terminals:

```bash
python3 -m uvicorn backend.main:app --port 8001    # terminal 1
cd frontend && npm run dev                          # terminal 2
```

Open **http://localhost:5174**.

> Ports are 8001/5174 rather than 8000/5173 so this app can run alongside the
> MERN app at the repo root without a clash.

---

## Configuring the council

All via `.env` — no code edits needed:

```bash
COUNCIL_MODELS=openai/gpt-4o,anthropic/claude-sonnet-4.5,google/gemini-2.5-pro
CHAIRMAN_MODEL=anthropic/claude-sonnet-4.5
FALLBACK_MODEL=openai/gpt-4o-mini
```

The UI's model picker reads the **live Mesh catalogue** (`GET /v1/models`), so it
never goes stale as models are added or retired. If Mesh is unreachable, the
picker falls back to your configured line-up.

### Cost control

A full run costs roughly **(2 × members) + 1** completions — every member answers,
every member reviews, the chairman synthesises. With three members that's 7
calls. Defaults are chosen accordingly:

- three members, not six
- per-stage token caps (`MAX_TOKENS_STAGE1/2/3`)
- a live cost/latency/token readout under the composer, fed by Mesh's response
  metadata, so a curiosity click can't quietly burn credits

Mesh's free 24-hour response cache means repeat questions are cheap; cache hits
are labelled in the UI.

---

## Code + PR mode

Switch to **Code + PR** in the sidebar, describe a change, and the council
debates the *implementation*: each member proposes a complete patch, they rank
each other's proposals blind, and the chairman merges the best into one final
patch. Then it can open a real pull request.

- **Dry run is the default.** Nothing is pushed until you tick *"Open a real PR"* —
  you read the diff first.
- Requires `GITHUB_TOKEN` (scope: `repo`) in `.env`.
- Models emit fenced ```` ```file <path> ```` blocks containing complete file
  contents; the server parses those into commits.
- **Guard rails**, because model output is untrusted input with write access:
  path traversal (`../`), absolute paths, `.git/`, `.env*`, `*.pem`, `id_rsa`,
  `.ssh/` and `node_modules/` are all refused, along with >25 files or any file
  over 200 KB — *before* any network call. See `tests/test_github_pr.py`.
- The PR body records provenance: the council line-up, the chairman, the peer
  ranking, and a "machine-drafted, review before merging" note.

---

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | liveness; whether keys are configured |
| `GET` | `/api/config` | non-secret config for the UI |
| `GET` | `/api/models` | live Mesh catalogue (falls back to config) |
| `POST` | `/api/council` | run the council; **streams SSE** |
| `POST` | `/api/code-pr` | draft a change; optionally open a PR |
| `GET` | `/api/conversations` | saved runs |
| `GET` | `/api/conversations/{id}` | full transcript |
| `DELETE` | `/api/conversations/{id}` | delete a run |

`/api/council` is a POST that streams, so `EventSource` (GET-only) can't be used —
the frontend reads the response body as a stream and parses frames itself.

Event types: `run_start`, `stage_start`, `stage1_response`, `stage2_review`,
`stage_skipped`, `stage_complete`, `run_complete`, `error`, then `[DONE]`.

---

## Tests

```bash
python3 -m pytest
```

121 tests, no network and no API key required — every Mesh and GitHub call is
mocked at the transport layer. Coverage is concentrated where mistakes are
expensive:

- **`test_anonymize.py`** — identity leakage, including model ids and "as an AI
  trained by…" phrasing, and that ordinary prose survives scrubbing
- **`test_rankings.py`** — messy reviewer JSON (fenced, prose-wrapped, bare `"A"`
  labels), and that an unparseable review is *reported*, never scored as zero
- **`test_mesh_client.py`** — retry/fallback behaviour, and that 401 and 402
  (empty balance) produce actionable errors rather than silent retries
- **`test_council.py`** — stage sequencing, Stage 2 anonymity in flight, and every
  degraded path: one dead member, all members dead, dead chairman, single answer
- **`test_github_pr.py`** — patch parsing plus every rejected dangerous path
- **`test_api.py`** — SSE framing, persistence, and that Code+PR dry runs never
  touch GitHub
- **`test_storage.py`** — persistence and traversal-safe conversation ids

### Trying it without spending credits

`fake_mesh.py` is a dev-only stand-in that serves the two OpenAI-compatible
routes the app uses:

```bash
python3 fake_mesh.py &                                      # :8899
MESH_API_KEY=rsk_fake MESH_BASE_URL=http://127.0.0.1:8899/v1 \
  python3 -m uvicorn backend.main:app --port 8001
```

Then run a real streamed council with zero spend:

```bash
curl -N -X POST localhost:8001/api/council \
  -H 'Content-Type: application/json' \
  -d '{"query":"Why is the sky blue?"}'
```

---

## Layout

```
council-py/
├── backend/
│   ├── config.py        env-driven config, no code edits to change the council
│   ├── mesh_client.py   OpenAI-compatible Mesh client: retries, fallback, cost
│   ├── anonymize.py     Stage 2 identity scrubbing
│   ├── rankings.py      forgiving review parsing + Borda aggregation
│   ├── council.py       the three-stage orchestrator (async event generator)
│   ├── github_pr.py     patch parsing, path guard rails, branch→commit→PR
│   ├── storage.py       JSON conversation persistence
│   └── main.py          FastAPI app + SSE
├── frontend/            React + Vite UI
├── tests/               121 tests, fully offline
├── fake_mesh.py         dev-only local Mesh stand-in
└── start.sh
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `MESH_API_KEY is not set` | no `.env`, or you edited `.env.example` instead |
| HTTP 402 from Mesh | balance empty — top up at meshapi.ai |
| HTTP 401 from Mesh | wrong key, or a `mesh_sk_`/`rsk_` mix-up |
| A seat shows ⚠ | that provider failed and the fallback also failed; the run continues |
| A seat shows ↩ | primary model was down; the fallback answered in its place |
| "Chairman unavailable" banner | chairman call failed; you're seeing the peer-ranked winner unsynthesised |
| Reviews show "no parseable ranking" | that reviewer ignored the JSON format; its votes were excluded, not guessed |
| Frontend can't reach the API | backend not on `:8001`, or change `VITE_API_TARGET` |
