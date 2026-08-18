# LLM Council

Five ways to ask a model something, all through one [Mesh API](https://meshapi.ai) key.
No database, no Docker, two commands to run.

| Mode | What it does | Cost |
|---|---|---|
| **Chat** | A straight conversation with one model, streamed token by token. | one call |
| **Quick** | Same code path as Chat, but a cheap model and a hard length cap. For when you want an answer, not an essay. | one cheap call |
| **Council** | Several models answer independently, rank each other's answers **blind**, then a chairman synthesises the final answer. | ~(2 × members) + 1 |
| **Code + PR** | The council drafts a code change, peer-reviews the implementations, and opens a real pull request. | ~(2 × members) + 1 |
| **Humanize** | Rewrites stiff, AI-sounding text so it reads like a person wrote it. Tone and length controls, before/after view. | one call |

Every mode has its own model picker, fed by the live Mesh catalogue.

---

## Quickstart

```bash
git clone https://github.com/nakwafurkhan/LLM_COUNCIL.git
cd LLM_COUNCIL

cp .env.example .env          # then open .env and paste your MESH_API_KEY

python -m venv .venv          # recommended — see the note below
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cd frontend && npm install && cd ..

./start.sh
```

Open **http://localhost:5173**.

> **Use a venv, or make sure `pip` and `python` are the same interpreter.**
> The most common startup failure is `pip` installing into one Python (say
> Anaconda) while `python3` resolves to another (say Xcode's), which surfaces as
> `No module named uvicorn` right after a successful install. Check with
> `which python pip` — both paths should share a prefix. `start.sh` verifies this
> for you and tells you the exact command to fix it.

### Running the two halves separately

```bash
python -m uvicorn backend.main:app --port 8000    # terminal 1
cd frontend && npm run dev                         # terminal 2
```

Health check: `curl localhost:8000/api/health` → `mesh_key_configured` should be `true`.

---

## Try it without spending anything

`fake_mesh.py` is a local stand-in that serves the OpenAI-compatible routes the
app uses — including real SSE streaming — so you can exercise all five modes at
zero cost:

```bash
python fake_mesh.py &                                        # :8899

MESH_API_KEY=rsk_fake MESH_BASE_URL=http://127.0.0.1:8899/v1 \
  python -m uvicorn backend.main:app --port 8000

curl -N -X POST localhost:8000/api/council \
  -H 'Content-Type: application/json' \
  -d '{"query":"Why is the sky blue?"}'
```

---

## How the council works

1. **First opinions** — every member answers in parallel, independently.
2. **Peer review** — each member ranks the others' answers. Rankings are
   aggregated with Borda counting into a leaderboard.
3. **Final answer** — the chairman gets the question, every answer and the
   rankings, and writes the answer you should have got the first time. It streams
   as it is written.

### Anonymisation is more than relabelling

Models sign their work — *"As Claude, I'd argue…"*, *"I'm ChatGPT, so…"* — and a
reviewer who can tell whose answer it is stops judging on merit. Stage 2
therefore assigns neutral labels (`Response A/B/C`) **and scrubs identity out of
the bodies**: vendor names, model families, namespaced ids like
`anthropic/claude-sonnet-4.5`, and phrases like *"as a large language model
trained by…"*.

It is conservative in the other direction too — tokens that appear in model ids
but are ordinary English (`mini`, `pro`, `code`, `vision`) are left alone, so
real prose survives. Two tests pin this: one on the function, one asserting the
*actual Stage 2 prompts* contain no brand names while the substance survives.

### When things break

The council degrades instead of failing:

- a member errors → that seat is marked failed, the run continues
- a member is unreachable → the configured `FALLBACK_MODEL` stands in, labelled
- **the chairman dies** → you get the peer-ranked winner's answer, clearly
  flagged as unsynthesised
- a reviewer returns unparseable JSON → its votes are *excluded*, never guessed

Streaming deliberately has **no** fallback: once tokens have reached your screen,
swapping models mid-answer would splice two voices into one message, so a
mid-stream failure is reported as a failure with the partial text kept.

---

## Code + PR mode

Describe a change; each member proposes a complete implementation; they rank each
other blind; the chairman merges the best into one patch. Then it can open a PR.

- **Dry run is the default.** Nothing is pushed until you tick *"Open a real
  pull request"* — you read the patch first.
- Needs `GITHUB_TOKEN` (scope `repo`) in `.env`.
- Model output is untrusted input with write access, so paths are validated
  **before any network call**: `../` traversal, absolute paths, `.git/`,
  `.env*`, `*.pem`, `id_rsa`, `.ssh/`, `node_modules/`, more than 25 files, or
  any file over 200 KB are all refused.
- PR bodies record provenance: the line-up, the chairman, the peer ranking, and
  a "machine-drafted, review before merging" note.

---

## API

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/health` | liveness; whether keys are configured |
| `GET` | `/api/config` | non-secret config for the UI |
| `GET` | `/api/models` | live Mesh catalogue (falls back to config) |
| `POST` | `/api/chat` | Chat / Quick / Humanize — **SSE** |
| `POST` | `/api/council` | the three stages — **SSE** |
| `POST` | `/api/code-pr` | draft a change, optionally open a PR |
| `GET` | `/api/conversations` | saved runs |
| `GET` | `/api/conversations/{id}` | full transcript |
| `DELETE` | `/api/conversations/{id}` | delete a run |

Both streaming routes are POSTs, so `EventSource` (GET-only) can't be used — the
frontend reads the response body as a stream and parses frames itself.

Event types: `run_start`, `delta`, `stage_start`, `stage1_response`,
`stage2_review`, `stage_skipped`, `stage3_delta`, `stage_complete`,
`run_complete`, `error`, then `[DONE]`.

---

## Tests

```bash
python -m pytest
```

**177 tests, fully offline.** Every Mesh and GitHub call is mocked at the
transport layer, so no API key is needed and no request leaves your machine.
Coverage is concentrated where mistakes are expensive:

| File | What it protects |
|---|---|
| `test_anonymize.py` | identity leakage, and that ordinary prose survives scrubbing |
| `test_rankings.py` | messy reviewer JSON; unparseable reviews reported, not scored |
| `test_mesh_client.py` | retries, fallback, and actionable 401 / 402 errors |
| `test_streaming.py` | SSE chunk parsing, mid-stream drops, no silent model swap |
| `test_council.py` | stage order, Stage 2 anonymity in flight, every degraded path |
| `test_single.py` | Chat / Quick / Humanize prompts, budgets, word counts |
| `test_sse.py` | framing, error taxonomy, and that failed runs are never saved |
| `test_github_pr.py` | patch parsing and every rejected dangerous path |
| `test_api.py` | HTTP surface, persistence, Code+PR dry-run safety |
| `test_storage.py` | persistence and traversal-safe conversation ids |

---

## Layout

```
backend/
  config.py        env-driven settings; no code edits to change models
  mesh_client.py   Mesh client: retries, fallback, cost, token streaming
  prompts.py       every prompt in the app, in one place
  single.py        Chat / Quick / Humanize (one shared code path)
  council.py       the three-stage orchestrator
  anonymize.py     Stage 2 identity scrubbing
  rankings.py      review parsing + Borda aggregation
  github_pr.py     patch parsing, path guard rails, branch → commit → PR
  storage.py       JSON conversation persistence
  sse.py           one SSE envelope and error taxonomy for all modes
  main.py          FastAPI app
frontend/          React + Vite, monochrome UI, no web fonts
tests/             177 offline tests
fake_mesh.py       dev-only local Mesh stand-in
```

### Design notes

**No colour, no web fonts.** The interface is a neutral greyscale ramp with
hierarchy from type weight and hairline borders; states that would normally be
coloured (cached, fallback, failed) are labelled instead. Typography is the
system stack, which means zero font requests, no flash of invisible text, and SF
Pro / SF Mono on Apple hardware. Light and dark follow the OS.

**Perceived speed over benchmarks.** A council run takes 30–60s — that is model
time, not our code. So Stage 1 answers appear as they land, the chairman's answer
streams token by token, markdown rendering is lazy-loaded, Code+PR is
code-split, and token deltas are batched to one React update per animation frame
rather than one per token.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No module named uvicorn` after a successful `pip install` | `pip` and `python` are different interpreters — use a venv, or `python -m pip install -r requirements.txt` |
| `No module named 'backend'` | run from the repo root, not from a subdirectory |
| `mesh_key_configured: false` | `.env` missing, or you edited `.env.example` instead |
| HTTP 402 | Mesh balance empty — top up at meshapi.ai |
| HTTP 401 | wrong key, or an `rsk_` / `mesh_sk_` mix-up |
| A model errors with HTTP 400 | that model id isn't on your account — check `/api/models` or the picker |
| Port already in use | change `PORT` in `.env` (and `VITE_API_TARGET` for the frontend) |
| Council feels slow | expected: Stage 2 can't start until every member finishes Stage 1 |
