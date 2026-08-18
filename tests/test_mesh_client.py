"""Mesh transport behaviour: parsing, retries, fallback, and the two errors
users actually hit (bad key, empty balance)."""
from __future__ import annotations

import httpx
import pytest

from backend import config
from backend.mesh_client import (
    MeshAuthError,
    MeshClient,
    MeshCreditError,
    MeshError,
)


def _completion_payload(content="hello", model="openai/gpt-4o", cost=0.0021):
    return {
        "id": "cmpl_1",
        "model": model,
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "usage": {
            "prompt_tokens": 11,
            "completion_tokens": 22,
            "cost": cost,
        },
    }


def _client_with(handler):
    transport = httpx.MockTransport(handler)
    return MeshClient(client=httpx.AsyncClient(transport=transport))


MESSAGES = [{"role": "user", "content": "hi"}]


@pytest.mark.asyncio
async def test_successful_completion_parses_content_and_usage():
    async def handler(request):
        assert request.url.path.endswith("/chat/completions")
        assert request.headers["authorization"] == "Bearer rsk_test_key"
        return httpx.Response(200, json=_completion_payload())

    async with _client_with(handler) as client:
        result = await client.complete("openai/gpt-4o", MESSAGES)

    assert result.ok
    assert result.content == "hello"
    assert result.prompt_tokens == 11
    assert result.completion_tokens == 22
    assert result.total_tokens == 33
    assert result.cost_usd == pytest.approx(0.0021)
    assert result.latency_ms >= 0


@pytest.mark.asyncio
async def test_handles_list_style_content_parts():
    payload = _completion_payload()
    payload["choices"][0]["message"]["content"] = [
        {"type": "text", "text": "part one "},
        {"type": "text", "text": "part two"},
    ]

    async def handler(request):
        return httpx.Response(200, json=payload)

    async with _client_with(handler) as client:
        result = await client.complete("openai/gpt-4o", MESSAGES)
    assert result.content == "part one part two"


@pytest.mark.asyncio
async def test_missing_key_raises_immediately(monkeypatch):
    monkeypatch.setattr(config, "MESH_API_KEY", "")

    async def handler(request):  # pragma: no cover - must never be called
        raise AssertionError("should not reach the network")

    client = MeshClient(api_key="", client=httpx.AsyncClient(
        transport=httpx.MockTransport(handler)))
    with pytest.raises(MeshAuthError):
        await client.complete("openai/gpt-4o", MESSAGES)


@pytest.mark.asyncio
async def test_401_raises_auth_error():
    async def handler(request):
        return httpx.Response(401, json={"error": "bad key"})

    async with _client_with(handler) as client:
        with pytest.raises(MeshAuthError):
            await client.complete("openai/gpt-4o", MESSAGES)


@pytest.mark.asyncio
async def test_402_raises_credit_error_with_actionable_message():
    async def handler(request):
        return httpx.Response(402, json={"error": "insufficient balance"})

    async with _client_with(handler) as client:
        with pytest.raises(MeshCreditError) as excinfo:
            await client.complete("openai/gpt-4o", MESSAGES)
    assert "Top up" in str(excinfo.value)


@pytest.mark.asyncio
async def test_bad_model_id_returns_error_without_retrying():
    calls = []

    async def handler(request):
        calls.append(1)
        return httpx.Response(400, json={"error": "unknown model"})

    async with _client_with(handler) as client:
        result = await client.complete(
            "nope/not-a-model", MESSAGES, fallback_model=None
        )

    assert result.ok is False
    assert "HTTP 400" in result.error
    assert len(calls) == 1  # 4xx is not retried


@pytest.mark.asyncio
async def test_server_error_retries_then_uses_fallback_model():
    seen = []

    async def handler(request):
        import json as _json

        model = _json.loads(request.content)["model"]
        seen.append(model)
        if model == "openai/gpt-4o":
            return httpx.Response(503, text="upstream down")
        return httpx.Response(200, json=_completion_payload(content="backup answer"))

    client = MeshClient(
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        max_retries=1,
    )
    async with client:
        result = await client.complete(
            "openai/gpt-4o", MESSAGES, fallback_model="openai/gpt-4o-mini"
        )

    assert result.ok
    assert result.used_fallback is True
    assert result.content == "backup answer"
    assert "fallback" in result.model
    # primary attempted twice (initial + 1 retry), then the fallback once
    assert seen.count("openai/gpt-4o") == 2
    assert seen.count("openai/gpt-4o-mini") == 1


@pytest.mark.asyncio
async def test_network_error_is_captured_not_raised():
    async def handler(request):
        raise httpx.ConnectError("no route to host")

    client = MeshClient(
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        max_retries=0,
    )
    async with client:
        result = await client.complete(
            "openai/gpt-4o", MESSAGES, fallback_model=None
        )
    assert result.ok is False
    assert "network error" in result.error


@pytest.mark.asyncio
async def test_list_models_normalises_catalogue():
    async def handler(request):
        assert request.url.path.endswith("/models")
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "openai/gpt-4o", "context_length": 128000},
                    {"id": "anthropic/claude-sonnet-4.5", "context_window": 200000},
                    {"nonsense": True},
                ]
            },
        )

    async with _client_with(handler) as client:
        models = await client.list_models()

    ids = [m["id"] for m in models]
    assert ids == ["anthropic/claude-sonnet-4.5", "openai/gpt-4o"]  # sorted
    assert models[1]["context_length"] == 128000
    assert models[0]["owned_by"] == "anthropic"


@pytest.mark.asyncio
async def test_list_models_wraps_transport_failure():
    async def handler(request):
        raise httpx.ConnectError("dns")

    async with _client_with(handler) as client:
        with pytest.raises(MeshError):
            await client.list_models()
