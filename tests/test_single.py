"""Chat, Quick and Humanizer — the three modes that share one code path."""
from __future__ import annotations

import pytest

from backend import config, single


async def _run(client, **kwargs):
    kwargs.setdefault("query", "why is the sky blue")
    events = []
    async for event in single.run_single(client=client, **kwargs):
        events.append(event)
    return events


def _system_of(client):
    return client.calls[-1]["messages"][0]["content"]


def _text(events):
    return "".join(e["text"] for e in events if e["type"] == "delta")


@pytest.mark.asyncio
async def test_chat_streams_deltas_then_completes(stub_client):
    events = await _run(stub_client(default="a clear answer"), mode=single.CHAT)

    assert events[0]["type"] == "run_start"
    assert events[-1]["type"] == "run_complete"
    assert _text(events) == "a clear answer"
    assert events[-1]["final"] == "a clear answer"
    assert events[-1]["totals"]["calls"] == 1


@pytest.mark.asyncio
async def test_each_mode_uses_its_own_prompt(stub_client):
    client = stub_client()

    await _run(client, mode=single.CHAT)
    assert "thoughtful, direct assistant" in _system_of(client)

    await _run(client, mode=single.QUICK)
    assert "terse" in _system_of(client)

    await _run(client, mode=single.HUMANIZE, query="Some stiff text.")
    assert "reads like a person wrote it" in _system_of(client)


@pytest.mark.asyncio
async def test_quick_has_a_much_tighter_token_budget(stub_client):
    client = stub_client()
    await _run(client, mode=single.QUICK)
    quick_tokens = client.calls[-1]["max_tokens"]
    await _run(client, mode=single.CHAT)
    chat_tokens = client.calls[-1]["max_tokens"]

    assert quick_tokens < chat_tokens
    assert quick_tokens == config.MAX_TOKENS_QUICK


@pytest.mark.asyncio
async def test_each_mode_has_its_own_default_model(stub_client):
    client = stub_client()
    await _run(client, mode=single.QUICK)
    assert client.calls[-1]["model"] == config.QUICK_MODEL
    await _run(client, mode=single.CHAT)
    assert client.calls[-1]["model"] == config.CHAT_MODEL


@pytest.mark.asyncio
async def test_explicit_model_overrides_the_default(stub_client):
    client = stub_client()
    await _run(client, mode=single.CHAT, model="meta/llama-3.1-70b")
    assert client.calls[-1]["model"] == "meta/llama-3.1-70b"


@pytest.mark.asyncio
async def test_chat_carries_history(stub_client):
    client = stub_client()
    await _run(
        client,
        mode=single.CHAT,
        history=[
            {"role": "user", "content": "earlier question"},
            {"role": "assistant", "content": "earlier answer"},
        ],
    )
    joined = " ".join(m["content"] for m in client.calls[-1]["messages"])
    assert "earlier question" in joined
    assert "earlier answer" in joined


@pytest.mark.asyncio
async def test_humanizer_ignores_history(stub_client):
    """A rewrite must depend only on the text given, never on earlier turns."""
    client = stub_client()
    await _run(
        client,
        mode=single.HUMANIZE,
        query="Rewrite this.",
        history=[{"role": "user", "content": "CONTAMINATION"}],
    )
    joined = " ".join(m["content"] for m in client.calls[-1]["messages"])
    assert "CONTAMINATION" not in joined
    assert "Rewrite this." in joined


@pytest.mark.asyncio
async def test_humanizer_reports_word_counts(stub_client):
    client = stub_client(default="Short rewrite here.")
    events = await _run(
        client, mode=single.HUMANIZE, query="one two three four five six"
    )

    assert events[0]["source_words"] == 6
    assert events[-1]["source_words"] == 6
    assert events[-1]["result_words"] == 3


@pytest.mark.asyncio
async def test_chat_does_not_report_word_counts(stub_client):
    events = await _run(stub_client(), mode=single.CHAT)
    assert events[0]["source_words"] is None
    assert "result_words" not in events[-1]


@pytest.mark.parametrize("tone", ["neutral", "plain", "warm", "direct"])
@pytest.mark.asyncio
async def test_humanizer_tones_change_the_prompt(stub_client, tone):
    client = stub_client()
    await _run(client, mode=single.HUMANIZE, query="text", tone=tone)
    assert "Tone:" in _system_of(client)


@pytest.mark.parametrize(
    "length,marker",
    [("tighten", "Cut it down"), ("keep", "same length"), ("expand", "specificity")],
)
@pytest.mark.asyncio
async def test_humanizer_length_bias_changes_the_prompt(stub_client, length, marker):
    client = stub_client()
    await _run(client, mode=single.HUMANIZE, query="text", length=length)
    assert marker in _system_of(client)


@pytest.mark.asyncio
async def test_unknown_mode_is_rejected(stub_client):
    events = await _run(stub_client(), mode="telepathy")
    assert events[0]["type"] == "error"
    assert "Unknown mode" in events[0]["message"]


@pytest.mark.asyncio
async def test_model_failure_surfaces_as_an_error_event(stub_client):
    client = stub_client(errors={config.CHAT_MODEL: "HTTP 500"})
    events = await _run(client, mode=single.CHAT)

    assert events[-1]["type"] == "error"
    assert "HTTP 500" in events[-1]["message"]
    assert not any(e["type"] == "run_complete" for e in events)
