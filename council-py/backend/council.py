"""The council orchestrator: three stages, streamed as events.

Stage 1  every member answers the query independently, in parallel
Stage 2  every member reviews and ranks the others' answers, identities hidden
Stage 3  the chairman reads everything and writes the final answer

The public entry point is `run_council`, an async generator of JSON-safe event
dicts. The HTTP layer turns those into server-sent events; the test suite
consumes them directly.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional, Sequence, Tuple

from . import anonymize, config, rankings
from .mesh_client import Completion, MeshClient

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

STAGE1_SYSTEM = (
    "You are a member of an expert council answering a user's question. "
    "Give your own best, self-contained answer. Be substantive and concrete; "
    "state your reasoning and flag genuine uncertainty rather than hedging "
    "everything. Do not mention which model or company you are."
)

STAGE2_SYSTEM = (
    "You are reviewing anonymous answers written by other council members to "
    "the same question. Judge only on accuracy, insight, and usefulness. You "
    "cannot tell who wrote what, and you must not speculate about authorship.\n\n"
    "Rank EVERY response from best (rank 1) to worst. Reply with JSON only, in "
    "exactly this shape:\n"
    '{"rankings": [{"label": "Response A", "rank": 1, "reason": "one sentence"}]}'
)

STAGE3_SYSTEM = (
    "You are the Chairman of an expert council. You receive the original "
    "question, every member's answer, and the council's peer rankings. Produce "
    "the single best final answer for the user.\n\n"
    "Synthesise — do not summarise the process. Take the strongest reasoning "
    "wherever it appeared, correct anything the council got wrong, and resolve "
    "disagreements explicitly rather than averaging them away. Never mention "
    "response labels, rankings, or that a council was involved. Write the answer "
    "the user should have received in the first place."
)

CODE_SYSTEM = (
    "You are a member of an expert engineering council proposing a concrete code "
    "change. Produce a minimal, correct, reviewable change.\n\n"
    "For every file you touch, emit a fenced block whose info string is the "
    "word `file` followed by the repository-relative path, e.g.\n"
    "```file src/utils/date.py\n<complete new file contents>\n```\n"
    "Emit the COMPLETE intended contents of each file, not a diff or a fragment. "
    "Before the blocks, briefly explain the change in prose. Do not mention "
    "which model you are."
)

CODE_CHAIRMAN_SYSTEM = (
    "You are the Chairman of an engineering council. You receive a change "
    "request, each member's proposed implementation, and the peer rankings. "
    "Produce the FINAL implementation.\n\n"
    "Requirements:\n"
    "1. Open with a short PR description: what changed and why.\n"
    "2. Then emit one fenced block per file, info string `file <path>`, "
    "containing that file's COMPLETE final contents.\n"
    "3. Merge the best ideas; do not ship two competing approaches.\n"
    "Never mention the council, labels, or rankings."
)


def _stage1_messages(query: str, history: Sequence[Dict[str, str]]) -> List[Dict[str, str]]:
    messages: List[Dict[str, str]] = [{"role": "system", "content": STAGE1_SYSTEM}]
    for turn in history or []:
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": query})
    return messages


def _stage2_messages(query: str, review_block: str) -> List[Dict[str, str]]:
    user = (
        "Original question:\n{query}\n\n"
        "Anonymous responses to rank:\n\n{block}\n\n"
        "Rank every response. JSON only."
    ).format(query=query, block=review_block)
    return [
        {"role": "system", "content": STAGE2_SYSTEM},
        {"role": "user", "content": user},
    ]


def _stage3_messages(
    query: str,
    review_block: str,
    leaderboard: Sequence[Dict[str, Any]],
    system: str = STAGE3_SYSTEM,
) -> List[Dict[str, str]]:
    board = "\n".join(
        "{pos}. {label} — {points} points{avg}".format(
            pos=row["position"],
            label=row["label"],
            points=row["points"],
            avg=(
                ", avg rank {}".format(row["average_rank"])
                if row.get("average_rank") is not None
                else ""
            ),
        )
        for row in leaderboard
    )
    user = (
        "Original question:\n{query}\n\n"
        "Council answers:\n\n{block}\n\n"
        "Peer ranking (aggregated):\n{board}\n\n"
        "Write the final answer."
    ).format(query=query, block=review_block, board=board or "(no valid rankings)")
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


# ---------------------------------------------------------------------------
# Cost accounting
# ---------------------------------------------------------------------------


class RunTotals:
    """Running tally shown in the cost panel."""

    def __init__(self) -> None:
        self.calls = 0
        self.failed_calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.cost_usd = 0.0
        self.cached_hits = 0
        self.fallbacks = 0

    def add(self, completion: Completion) -> None:
        self.calls += 1
        self.prompt_tokens += completion.prompt_tokens
        self.completion_tokens += completion.completion_tokens
        self.cost_usd += completion.cost_usd
        if completion.cached:
            self.cached_hits += 1
        if completion.used_fallback:
            self.fallbacks += 1
        if not completion.ok:
            self.failed_calls += 1

    def to_dict(self) -> Dict[str, Any]:
        return {
            "calls": self.calls,
            "failed_calls": self.failed_calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
            "cost_usd": round(self.cost_usd, 6),
            "cached_hits": self.cached_hits,
            "fallbacks": self.fallbacks,
        }


# ---------------------------------------------------------------------------
# Stage runners
# ---------------------------------------------------------------------------


async def _gather_completions(
    client: MeshClient,
    models: Sequence[str],
    messages_for: Any,
    max_tokens: int,
) -> List[Completion]:
    """Fan out one completion per model, in parallel, never raising per-model."""

    async def one(model: str) -> Completion:
        try:
            return await client.complete(
                model=model, messages=messages_for(model), max_tokens=max_tokens
            )
        except Exception as exc:  # noqa: BLE001 - surfaced per-seat, run continues
            return Completion(model=model, content="", error=str(exc))

    return list(await asyncio.gather(*[one(model) for model in models]))


async def run_council(
    query: str,
    models: Optional[Sequence[str]] = None,
    chairman: Optional[str] = None,
    history: Optional[Sequence[Dict[str, str]]] = None,
    client: Optional[MeshClient] = None,
    conversation_id: Optional[str] = None,
    code_mode: bool = False,
) -> AsyncIterator[Dict[str, Any]]:
    """Run the three council stages, yielding an event per milestone."""
    # `None` means "use the configured line-up"; an explicitly empty list is a
    # caller error and is reported as one rather than silently defaulted.
    council_models = (
        list(config.COUNCIL_MODELS) if models is None else list(models)
    )
    chairman_model = chairman or config.CHAIRMAN_MODEL
    run_id = str(uuid.uuid4())
    totals = RunTotals()
    started = time.perf_counter()

    if not council_models:
        yield {"type": "error", "message": "No council models configured."}
        return

    owns_client = client is None
    client = client or MeshClient()
    if owns_client:
        await client.__aenter__()

    try:
        yield {
            "type": "run_start",
            "run_id": run_id,
            "conversation_id": conversation_id,
            "query": query,
            "models": council_models,
            "chairman": chairman_model,
            "code_mode": code_mode,
        }

        # ---------------- Stage 1: first opinions ----------------
        yield {"type": "stage_start", "stage": 1, "label": "First opinions"}

        stage1_system = CODE_SYSTEM if code_mode else STAGE1_SYSTEM
        stage1_tokens = config.MAX_TOKENS_CODE if code_mode else config.MAX_TOKENS_STAGE1

        def stage1_for(_model: str) -> List[Dict[str, str]]:
            messages = _stage1_messages(query, history or [])
            messages[0] = {"role": "system", "content": stage1_system}
            return messages

        first_opinions = await _gather_completions(
            client, council_models, stage1_for, stage1_tokens
        )
        for completion in first_opinions:
            totals.add(completion)
            yield {
                "type": "stage1_response",
                "stage": 1,
                "response": completion.to_dict(),
            }

        answered: List[Tuple[str, str]] = [
            (c.model, c.content) for c in first_opinions if c.ok and c.content
        ]
        if not answered:
            yield {
                "type": "error",
                "message": "Every council member failed. Check MESH_API_KEY, "
                "your Mesh balance, and the configured model ids.",
                "totals": totals.to_dict(),
            }
            return

        entries, mapping = anonymize.anonymize(answered)
        review_block = anonymize.format_for_review(entries)
        labels = [entry["label"] for entry in entries]

        yield {
            "type": "stage_complete",
            "stage": 1,
            "answered": len(answered),
            "totals": totals.to_dict(),
        }

        # ---------------- Stage 2: peer review ----------------
        reviews: List[Dict[str, Any]] = []
        leaderboard: List[Dict[str, Any]] = []

        if len(answered) < 2:
            yield {
                "type": "stage_skipped",
                "stage": 2,
                "reason": "Only one member answered, so there is nothing to rank.",
            }
        else:
            yield {"type": "stage_start", "stage": 2, "label": "Peer review"}
            reviewer_models = [model for model, _ in answered]

            def stage2_for(_model: str) -> List[Dict[str, str]]:
                return _stage2_messages(query, review_block)

            review_completions = await _gather_completions(
                client, reviewer_models, stage2_for, config.MAX_TOKENS_STAGE2
            )

            for completion in review_completions:
                totals.add(completion)
                parsed = rankings.parse_review(completion.content, labels)
                parsed["reviewer"] = completion.model
                reviews.append(parsed)
                yield {
                    "type": "stage2_review",
                    "stage": 2,
                    "reviewer": completion.model,
                    "parsed": parsed["parsed"],
                    "ranks": parsed["ranks"],
                    "notes": parsed["notes"],
                    "meta": completion.to_dict(),
                }

            leaderboard = rankings.attach_models(
                rankings.aggregate(reviews, labels), mapping
            )
            yield {
                "type": "stage_complete",
                "stage": 2,
                "leaderboard": leaderboard,
                "reviews_parsed": sum(1 for r in reviews if r["parsed"]),
                "reviews_total": len(reviews),
                "totals": totals.to_dict(),
            }

        # ---------------- Stage 3: chairman ----------------
        yield {"type": "stage_start", "stage": 3, "label": "Final answer"}

        chairman_system = CODE_CHAIRMAN_SYSTEM if code_mode else STAGE3_SYSTEM
        chairman_tokens = (
            config.MAX_TOKENS_CODE if code_mode else config.MAX_TOKENS_STAGE3
        )
        final = await client.complete(
            model=chairman_model,
            messages=_stage3_messages(
                query, review_block, leaderboard, system=chairman_system
            ),
            max_tokens=chairman_tokens,
        )
        totals.add(final)

        if not final.ok or not final.content:
            # Chairman down: fall back to the peer-ranked winner rather than
            # handing the user nothing.
            best_label = leaderboard[0]["label"] if leaderboard else labels[0]
            best_model = mapping.get(best_label, answered[0][0])
            fallback_text = next(
                (content for model, content in answered if model == best_model),
                answered[0][1],
            )
            yield {
                "type": "stage_complete",
                "stage": 3,
                "final": fallback_text,
                "chairman": chairman_model,
                "degraded": True,
                "degraded_reason": final.error
                or "Chairman returned an empty response.",
                "source_model": best_model,
                "meta": final.to_dict(),
                "totals": totals.to_dict(),
            }
        else:
            yield {
                "type": "stage_complete",
                "stage": 3,
                "final": final.content,
                "chairman": chairman_model,
                "degraded": False,
                "meta": final.to_dict(),
                "totals": totals.to_dict(),
            }

        yield {
            "type": "run_complete",
            "run_id": run_id,
            "conversation_id": conversation_id,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
            "reveal": mapping,
            "leaderboard": leaderboard,
            "totals": totals.to_dict(),
        }
    finally:
        if owns_client:
            await client.__aexit__(None, None, None)


async def collect(events: AsyncIterator[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drain an event stream into a list (used by tests and Code+PR mode)."""
    return [event async for event in events]


def final_answer(events: Sequence[Dict[str, Any]]) -> str:
    """Pull the Stage 3 answer out of a collected event list."""
    for event in events:
        if event.get("type") == "stage_complete" and event.get("stage") == 3:
            return event.get("final", "")
    return ""
