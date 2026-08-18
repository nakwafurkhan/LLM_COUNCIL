"""Shared fixtures.

Every test runs against a stub Mesh client or a mocked transport — the suite
never calls the real API, so `pytest` is safe to run without credentials.
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional, Sequence

import pytest

from backend import config
from backend.mesh_client import Completion


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """Point conversation storage at a temp dir for every test."""
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "conversations")
    return tmp_path


@pytest.fixture(autouse=True)
def fake_keys(monkeypatch):
    monkeypatch.setattr(config, "MESH_API_KEY", "rsk_test_key")
    monkeypatch.setattr(config, "MAX_RETRIES", 0)
    return None


class StubMeshClient:
    """Stands in for MeshClient. Scripted replies, and it records every prompt."""

    def __init__(
        self,
        replies: Optional[Dict[str, str]] = None,
        default: str = "stub answer",
        errors: Optional[Dict[str, str]] = None,
        review_reply: Optional[str] = None,
        chairman_reply: Optional[str] = None,
    ) -> None:
        self.replies = replies or {}
        self.default = default
        self.errors = errors or {}
        self.review_reply = review_reply
        self.chairman_reply = chairman_reply
        self.calls: List[Dict[str, Any]] = []

    async def __aenter__(self) -> "StubMeshClient":
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        return None

    def _classify(self, messages: Sequence[Dict[str, str]]) -> str:
        system = (messages[0].get("content") or "") if messages else ""
        if "Rank EVERY response" in system:
            return "review"
        if "Chairman" in system:
            return "chairman"
        return "answer"

    async def complete(
        self,
        model: str,
        messages: Sequence[Dict[str, str]],
        max_tokens: int = 1024,
        temperature: Optional[float] = None,
        fallback_model: Optional[str] = None,
    ) -> Completion:
        kind = self._classify(messages)
        self.calls.append(
            {
                "model": model,
                "kind": kind,
                "messages": [dict(m) for m in messages],
                "max_tokens": max_tokens,
            }
        )

        if model in self.errors:
            return Completion(model=model, content="", error=self.errors[model])

        if kind == "review":
            content = (
                self.review_reply
                if self.review_reply is not None
                else '{"rankings": [{"label": "Response A", "rank": 1, '
                '"reason": "clearest"}, {"label": "Response B", "rank": 2, '
                '"reason": "vaguer"}]}'
            )
        elif kind == "chairman":
            content = (
                self.chairman_reply
                if self.chairman_reply is not None
                else "final synthesised answer"
            )
        else:
            content = self.replies.get(model, self.default)

        return Completion(
            model=model,
            content=content,
            prompt_tokens=10,
            completion_tokens=20,
            cost_usd=0.001,
            latency_ms=42,
        )

    async def stream_complete(
        self,
        model: str,
        messages: Sequence[Dict[str, str]],
        max_tokens: int = 1024,
        temperature: Optional[float] = None,
    ):
        """Same scripted replies, delivered as a token stream.

        Chunks the reply so tests exercise real multi-delta accumulation rather
        than a single all-at-once emission.
        """
        completion = await self.complete(
            model, messages, max_tokens=max_tokens, temperature=temperature
        )
        self.calls[-1]["streamed"] = True

        if not completion.ok:
            yield {"type": "error", "message": completion.error, "partial": ""}
            return

        text = completion.content
        size = max(1, len(text) // 3)
        for start in range(0, len(text), size):
            yield {"type": "delta", "text": text[start : start + size]}
        yield {"type": "done", "completion": completion}

    # Convenience accessors for assertions
    def prompts_of_kind(self, kind: str) -> List[str]:
        out = []
        for call in self.calls:
            if call["kind"] == kind:
                out.append(
                    "\n".join(m.get("content") or "" for m in call["messages"])
                )
        return out


@pytest.fixture
def stub_client():
    return StubMeshClient


@pytest.fixture
def run_async():
    def _run(coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    return _run
