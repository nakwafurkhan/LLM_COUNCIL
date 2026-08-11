# LLM Council

Four answer modes behind one macOS-flavoured chat interface, running on the Mesh API
gateway (`https://api.meshapi.ai/v1`, OpenAI-compatible).

| Mode | What happens | Cost |
|---|---|---|
| **Quick** | One small fast model, streamed. | 1 call |
| **Council** | Karpathy's three-stage pipeline — parallel answers → anonymous peer review → chairman synthesis. | ~3–6× |
| **Deep Study** | Paste a topic, get a study pack: orientation, concept map, layered explanation, misconceptions, worked example, flip-cards, self-check quiz. | 1 long call |
| **Humanize** | Paste AI-sounding text, get it stripped of the tells — with the model's own audit of what still reads machine-written. | 1 call |

Switch with the header control or `⌘1` / `⌘2` / `⌘3` / `⌘4`. The choice persists, and each turn
is stamped with the mode it ran in.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app, single file. No build step, no runtime dependencies. |
| `server.mjs` | Local dev server, CORS proxy to Mesh, and the history/settings API. Node 18+. |
| `store.mjs` | Storage layer. MongoDB driver when `MONGODB_URI` is set, JSON file otherwise. |
| `package.json` | Only `mongodb`, and only as an optional dependency. |
| `parts/` | The source fragments `index.html` is concatenated from. Edit these, then rebuild. |
| `harness.html` | Test rig — drives the app in a real iframe and prints measured geometry and persistence assertions. |

Rebuild after editing `parts/`:

```bash
npm run build
```

## Run it

```bash
MESH_API_KEY=rsk_your_key node server.mjs
# → http://localhost:8787
```

With `MESH_API_KEY` set the key stays server-side and the browser never sees it. Otherwise
paste it into Settings — it lives in `localStorage` only. Either way, pick **Local proxy**.

## History

Every completed run is saved: the prompt, each seat's answer, the peer-review scores and
critiques, the chair's verdict, study packs, humanizer output. Open it with the clock icon
or `⌘H`, search it, restore any run, delete individually or wipe the lot.

Restored runs are **rebuilt through the same renderers as live ones**, not dumped as frozen
HTML — flashcards still flip, quiz answers still hide, the copy button still copies.

Three tiers, chosen automatically at boot:

| Tier | When | Scope |
|---|---|---|
| **MongoDB** | `MONGODB_URI` set and `mongodb` installed | Shared across devices |
| **Server file** | Running `server.mjs` without a URI | That machine, `council-data.json` |
| **localStorage** | No server (e.g. the published page) | That browser, last 30 runs |

### Atlas

```bash
npm install mongodb
MONGODB_URI="mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority" \
MESH_API_KEY=rsk_your_key \
node server.mjs
```

Optional: `MONGODB_DB` (default `llm_council`), `MONGODB_RUNS`, `MONGODB_SETTINGS`.
Indexes on `createdAt`, `id` (unique), `mode+createdAt` and a text index over title/prompt are
created on connect. Add your IP to the Atlas network access list or the driver will hang on
server selection for 8 seconds and then fall back.

**A bad connection string does not take down the app.** The failure is logged and the file
driver takes over, so you never lose a session to a typo in a URI.

Endpoints, if you want them directly: `GET /api/health`, `GET|POST /api/runs`,
`GET|DELETE /api/runs/:id`, `DELETE /api/runs`, `GET|PUT /api/settings`.

### Your key is never stored server-side

Settings sync to the server so a second device inherits your models, seats, theme and voice
sample — but the Mesh key is stripped twice on the way out: the client omits it, and
`scrubSettings()` in `store.mjs` drops any `apiKey`-ish field plus any value that looks like
`rsk_…` or `sk-…`. Verified: after PUTting a settings blob containing a key, `grep SECRET`
against the data file returns nothing.

Server settings are only *adopted* by a browser that has none of its own, so setting up a new
device pulls your config down without a stale device overwriting a configured one.

### Why the proxy is not optional

`api.meshapi.ai` rejects cross-origin browser requests — preflight from any web origin returns
`400 Disallowed CORS origin`. Mesh's docs are explicit: *"Never expose `rsk_` keys in
client-side code… always proxy through your backend."* `server.mjs` serves the page, forwards
`/v1/*`, streams SSE back unbuffered, and adds the CORS headers. Without it the app runs in
**Demo mode** — canned streams for every mode, no key, no spend.

## How Council works

1. **Deliberation** — every enabled seat gets the prompt in parallel via `stream: true`. Seats
   render independently; a dead slug fails in its own card without taking down the run.
2. **Peer review** — each seat receives all answers relabelled *Response A, B, C…*, shuffled
   per reviewer, with authorship stripped and its own answer unmarked. It returns JSON scores
   (accuracy / reasoning / usefulness) plus a one-line critique, requested via
   `response_format: json_object` with a plain-text fallback for models that ignore it.
   **Self-votes are discarded** when averaging — a model rating its own answer is not evidence.
   Results render as a leaderboard with expandable critiques, and each seat card gets a rank badge.
3. **Chairman** — reads the answers *and* the rankings, and is told to find the real
   disagreement rather than recap each seat in turn.

Turn Stage 2 off in Settings to halve the seat calls. With one seat enabled, Council quietly
degrades to Quick rather than reviewing itself.

## How Deep Study works

The study model is asked for one document with fixed section headers. The app parses it into
tabs: Overview, Explanation, Traps & example, Flashcards, Quiz, Go deeper. Flashcards are
`question :: answer` lines rendered as 3D flip cards; quiz answers stay hidden behind a reveal
button so you actually test yourself. If a model ignores the format, the raw markdown renders
instead — nothing is lost.

## How Humanize works

One call, three passes, based on Wikipedia's *Signs of AI writing* (WikiProject AI Cleanup).
The model returns four labelled sections and the app parses them apart:

1. **Draft** — first rewrite, cutting significance inflation ("stands as a testament", "pivotal
   moment"), promotional gloss ("nestled", "boasts", "seamless"), participle padding
   ("highlighting its role"), copula avoidance ("serves as" → "is"), negative parallelism
   ("not just X, it's Y"), forced rule-of-three, false ranges, vague attribution, em dash spray,
   filler, hedging, signposting, and generic uplift endings.
2. **Tells** — the model audits *its own draft* and names three to five things that still read as
   machine-written. This is the pass that matters; a single rewrite usually just launders the slop
   into cleaner slop.
3. **Final** — rewritten again against its own critique. This is what shows at the top, with a
   copy button and an in/out word count.

The draft, the tells, the change log and your original text all stay available in collapsed
sections beneath.

Two guardrails in the prompt: **never invent specificity** (no fabricated statistics, sources or
quotes to replace vague ones — if the original is vague it stays vague or gets cut), and
**preserve register** (a cover letter stays a cover letter).

Set a **voice sample** in Settings — a few sentences of your own writing — and it matches your
sentence length, vocabulary level and punctuation habits instead of defaulting to
generic-natural.

## Images

Openverse by default: keyless, CC-licensed, CORS-open. Switch to Mesh `POST /v1/web/search`
in Settings ($0.005 flat per query, needs the proxy). Device upload works too, becoming a
`data:` URL. Attached images ride along as `image_url` content parts, so point seats at
multimodal models before using them.

## Design notes

macOS idiom throughout: vibrancy instead of flat fills, hairline borders, SF system type,
a sliding segmented control, spring easing (`cubic-bezier(.32,.72,0,1)`) on every transition.
Under 860px the header wraps so the mode switch takes its own full-width row, drawers become
bottom sheets with a grabber, the council grid collapses to one column, and inputs sit at 16px
so iOS does not zoom on focus. Every animation collapses under `prefers-reduced-motion`.

`harness.html` also drives an end-to-end persistence check: run all three heavy modes, reload
the frame, restore each from history, and assert the rebuilt DOM. Last run — council replayed
4 cards, 4 score chips, 4 leaderboard rows, verdict and 3 stage labels; study replayed 6 tabs
and 10 flashcards with flipping intact; humanize replayed the copy button, 4 sections and 11
parsed bullets; no key in storage, no raw section markers leaking, no overflow.

Measured at 390px and 980px via `harness.html`: no horizontal overflow at either width, knob
alignment exact across all four segments, sheet/drawer switch correct, 1 vs 2 column grid as
intended. Below 620px the segment icons drop so four labels still fit on one row.

The UX rationale — Jakob, Doherty, Hick, Von Restorff, Fitts, Postel — is in the app under
**Settings → About**.
