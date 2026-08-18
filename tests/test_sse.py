"""The shared SSE layer: framing, error mapping, and persistence side-effects."""
from __future__ import annotations

import json

import pytest

from backend import sse
from backend.github_pr import PRError
from backend.mesh_client import MeshAuthError, MeshCreditError, MeshError


async def _gen(*events):
    for event in events:
        yield event


async def _boom(*events, exc):
    for event in events:
        yield event
    raise exc


async def _collect(stream):
    return [chunk async for chunk in stream]


def _parse(chunks):
    out = []
    for chunk in chunks:
        payload = chunk[len("data: ") : -2]
        if payload == "[DONE]":
            continue
        out.append(json.loads(payload))
    return out


def test_frame_is_valid_sse():
    chunk = sse.frame({"type": "delta", "text": "hi"})
    assert chunk.startswith("data: ")
    assert chunk.endswith("\n\n")
    assert json.loads(chunk[6:-2])["text"] == "hi"


def test_frame_preserves_non_ascii():
    chunk = sse.frame({"text": "café ☕"})
    assert "café ☕" in chunk


@pytest.mark.parametrize(
    "exc,kind",
    [
        (MeshCreditError("empty"), "credit"),
        (MeshAuthError("bad key"), "auth"),
        (MeshError("gateway"), "mesh"),
        (PRError("no token"), "pr"),
        (RuntimeError("who knows"), "unexpected"),
    ],
)
def test_error_event_classifies_known_failures(exc, kind):
    event = sse.error_event(exc)
    assert event["type"] == "error"
    assert event["kind"] == kind


def test_unexpected_error_message_carries_no_traceback():
    event = sse.error_event(RuntimeError("kaboom"))
    assert "Traceback" not in event["message"]
    assert "kaboom" in event["message"]


@pytest.mark.asyncio
async def test_stream_always_terminates_with_done():
    chunks = await _collect(sse.stream(_gen({"type": "run_start"})))
    assert chunks[-1] == sse.DONE


@pytest.mark.asyncio
async def test_stream_terminates_with_done_even_after_a_raise():
    chunks = await _collect(
        sse.stream(_boom({"type": "run_start"}, exc=MeshCreditError("empty")))
    )
    events = _parse(chunks)

    assert chunks[-1] == sse.DONE
    assert events[-1]["kind"] == "credit"


@pytest.mark.asyncio
async def test_on_success_fires_only_on_a_clean_run():
    fired = []
    await _collect(
        sse.stream(
            _gen({"type": "run_complete"}), on_success=lambda: fired.append(True)
        )
    )
    assert fired == [True]


@pytest.mark.asyncio
async def test_on_success_is_skipped_when_an_error_event_appears():
    """A failed run must never be persisted as if it had succeeded."""
    fired = []
    await _collect(
        sse.stream(
            _gen({"type": "run_start"}, {"type": "error", "message": "nope"}),
            on_success=lambda: fired.append(True),
        )
    )
    assert fired == []


@pytest.mark.asyncio
async def test_on_success_is_skipped_when_the_generator_raises():
    fired = []
    await _collect(
        sse.stream(
            _boom({"type": "run_start"}, exc=RuntimeError("x")),
            on_success=lambda: fired.append(True),
        )
    )
    assert fired == []


@pytest.mark.asyncio
async def test_on_event_sees_every_event():
    seen = []
    await _collect(
        sse.stream(
            _gen({"type": "a"}, {"type": "b"}, {"type": "c"}),
            on_event=lambda e: seen.append(e["type"]),
        )
    )
    assert seen == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_a_broken_handler_does_not_kill_the_stream():
    """Persistence is a side-effect; it must not cost the user their answer."""

    def explode(_event):
        raise ValueError("disk on fire")

    chunks = await _collect(
        sse.stream(_gen({"type": "delta", "text": "hi"}), on_event=explode)
    )
    events = _parse(chunks)

    assert events == [{"type": "delta", "text": "hi"}]
    assert chunks[-1] == sse.DONE
