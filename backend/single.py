"""Chat, Quick and Humanizer — three modes, one code path.

They differ only in system prompt, default model and token ceiling, so they
share this module. That is the whole reason "Quick" is not 200 lines of its own:
it is Chat with a cheap model and a tight budget.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, AsyncIterator, Dict, Optional, Sequence

from . import config, prompts
from .mesh_client import MeshClient

CHAT = "chat"
QUICK = "quick"
HUMANIZE = "humanize"

MODES = (CHAT, QUICK, HUMANIZE)


def default_model(mode: str) -> str:
    return {
        CHAT: config.CHAT_MODEL,
        QUICK: config.QUICK_MODEL,
        HUMANIZE: config.HUMANIZER_MODEL,
    }.get(mode, config.CHAT_MODEL)


def max_tokens(mode: str) -> int:
    return {
        CHAT: config.MAX_TOKENS_CHAT,
        QUICK: config.MAX_TOKENS_QUICK,
        HUMANIZE: config.MAX_TOKENS_HUMANIZE,
    }.get(mode, config.MAX_TOKENS_CHAT)


def system_prompt(mode: str, tone: str = "neutral", length: str = "keep") -> str:
    if mode == QUICK:
        return prompts.QUICK
    if mode == HUMANIZE:
        return prompts.humanizer_system(tone=tone, length=length)
    return prompts.CHAT


def _word_count(text: str) -> int:
    return len((text or "").split())


async def run_single(
    query: str,
    mode: str = CHAT,
    model: Optional[str] = None,
    history: Optional[Sequence[Dict[str, str]]] = None,
    tone: str = "neutral",
    length: str = "keep",
    client: Optional[MeshClient] = None,
    conversation_id: Optional[str] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """Stream a single-model answer, token by token.

    Event sequence: `run_start`, many `delta`, then `run_complete` — or `error`.
    The Humanizer additionally reports word counts so the UI can show the delta
    between the original and the rewrite.
    """
    if mode not in MODES:
        yield {"type": "error", "message": "Unknown mode: {}".format(mode)}
        return

    chosen = model or default_model(mode)
    run_id = str(uuid.uuid4())
    started = time.perf_counter()

    owns_client = client is None
    client = client or MeshClient()
    if owns_client:
        await client.__aenter__()

    try:
        yield {
            "type": "run_start",
            "run_id": run_id,
            "conversation_id": conversation_id,
            "mode": mode,
            "model": chosen,
            "source_words": _word_count(query) if mode == HUMANIZE else None,
        }

        messages = prompts.with_history(
            system_prompt(mode, tone=tone, length=length),
            query,
            # A rewrite must not be contaminated by earlier turns.
            () if mode == HUMANIZE else (history or ()),
        )

        text_parts = []
        async for event in client.stream_complete(
            model=chosen, messages=messages, max_tokens=max_tokens(mode)
        ):
            kind = event.get("type")
            if kind == "delta":
                text_parts.append(event["text"])
                yield {"type": "delta", "text": event["text"]}
            elif kind == "error":
                yield {
                    "type": "error",
                    "message": event["message"],
                    "partial": event.get("partial") or "".join(text_parts),
                }
                return
            elif kind == "done":
                completion = event["completion"]
                final = completion.content or "".join(text_parts).strip()
                payload: Dict[str, Any] = {
                    "type": "run_complete",
                    "run_id": run_id,
                    "conversation_id": conversation_id,
                    "mode": mode,
                    "final": final,
                    "model": chosen,
                    "elapsed_ms": int((time.perf_counter() - started) * 1000),
                    "totals": {
                        "calls": 1,
                        "failed_calls": 0,
                        "prompt_tokens": completion.prompt_tokens,
                        "completion_tokens": completion.completion_tokens,
                        "total_tokens": completion.total_tokens,
                        "cost_usd": round(completion.cost_usd, 6),
                        "cached_hits": 1 if completion.cached else 0,
                        "fallbacks": 0,
                    },
                }
                if mode == HUMANIZE:
                    payload["source_words"] = _word_count(query)
                    payload["result_words"] = _word_count(final)
                yield payload
    finally:
        if owns_client:
            await client.__aexit__(None, None, None)
