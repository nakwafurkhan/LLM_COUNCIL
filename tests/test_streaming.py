"""Token streaming through Mesh: SSE chunk parsing and mid-stream failure."""
from __future__ import annotations

import httpx
import pytest

from backend.mesh_client import MeshAuthError, MeshClient, MeshCreditError


def _sse(*chunks: str) -> bytes:
    return "".join("data: {}\n\n".format(c) for c in chunks).encode()


def _delta(text: str) -> str:
    return '{"choices":[{"delta":{"content":"%s"}}]}' % text


def _client(handler):
    return MeshClient(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


MESSAGES = [{"role": "user", "content": "hi"}]


async def _drain(client, **kwargs):
    events = []
    async for event in client.stream_complete("openai/gpt-4o", MESSAGES, **kwargs):
        events.append(event)
    return events


@pytest.mark.asyncio
async def test_deltas_are_yielded_then_a_single_done():
    async def handler(request):
        import json as _json

        assert _json.loads(request.content)["stream"] is True
        body = _sse(
            _delta("Hello"),
            _delta(" world"),
            '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,'
            '"completion_tokens":2,"cost":0.0004}}',
            "[DONE]",
        )
        return httpx.Response(200, content=body)

    async with _client(handler) as client:
        events = await _drain(client)

    assert [e["type"] for e in events] == ["delta", "delta", "done"]
    assert [e["text"] for e in events if e["type"] == "delta"] == ["Hello", " world"]

    completion = events[-1]["completion"]
    assert completion.content == "Hello world"
    assert completion.prompt_tokens == 5
    assert completion.completion_tokens == 2
    assert completion.cost_usd == pytest.approx(0.0004)


@pytest.mark.asyncio
async def test_malformed_chunks_are_skipped_not_fatal():
    async def handler(request):
        return httpx.Response(
            200,
            content=_sse("{not json", _delta("ok"), "[DONE]"),
        )

    async with _client(handler) as client:
        events = await _drain(client)

    assert events[-1]["completion"].content == "ok"


@pytest.mark.asyncio
async def test_stream_stops_at_done_sentinel():
    async def handler(request):
        return httpx.Response(
            200, content=_sse(_delta("kept"), "[DONE]", _delta("ignored"))
        )

    async with _client(handler) as client:
        events = await _drain(client)

    assert events[-1]["completion"].content == "kept"
    assert not any(e.get("text") == "ignored" for e in events)


@pytest.mark.asyncio
async def test_mid_stream_drop_reports_partial_text():
    async def handler(request):
        raise httpx.ReadError("connection reset")

    async with _client(handler) as client:
        events = await _drain(client)

    assert events[-1]["type"] == "error"
    assert "before any output" in events[-1]["message"]


@pytest.mark.asyncio
async def test_402_during_stream_raises_credit_error():
    async def handler(request):
        return httpx.Response(402, json={"error": "no balance"})

    async with _client(handler) as client:
        with pytest.raises(MeshCreditError):
            await _drain(client)


@pytest.mark.asyncio
async def test_401_during_stream_raises_auth_error():
    async def handler(request):
        return httpx.Response(401, json={"error": "bad key"})

    async with _client(handler) as client:
        with pytest.raises(MeshAuthError):
            await _drain(client)


@pytest.mark.asyncio
async def test_other_http_error_becomes_an_error_event():
    async def handler(request):
        return httpx.Response(400, text="unknown model")

    async with _client(handler) as client:
        events = await _drain(client)

    assert events == [
        {"type": "error", "message": "HTTP 400: unknown model"}
    ]


@pytest.mark.asyncio
async def test_streaming_never_substitutes_a_fallback_model():
    """A model that dies mid-answer must not be silently swapped: splicing two
    models' output into one message would be worse than reporting the failure."""
    seen = []

    async def handler(request):
        import json as _json

        seen.append(_json.loads(request.content)["model"])
        return httpx.Response(500, text="upstream down")

    async with _client(handler) as client:
        events = await _drain(client)

    assert events[-1]["type"] == "error"
    assert seen == ["openai/gpt-4o"]  # no second model attempted


@pytest.mark.asyncio
async def test_missing_key_raises_before_any_request():
    async def handler(request):  # pragma: no cover
        raise AssertionError("should not reach the network")

    client = MeshClient(
        api_key="", client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    with pytest.raises(MeshAuthError):
        await _drain(client)
