"""Orchestrator behaviour: stage sequencing, anonymity in flight, and the
degraded paths (dead member, dead chairman, everyone dead)."""
from __future__ import annotations

import pytest

from backend import council

MODELS = ["openai/gpt-4o", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"]


async def _run(client, **kwargs):
    kwargs.setdefault("query", "Why is the sky blue?")
    kwargs.setdefault("models", MODELS)
    kwargs.setdefault("chairman", "anthropic/claude-sonnet-4.5")
    return await council.collect(council.run_council(client=client, **kwargs))


def _types(events):
    return [e["type"] for e in events]


@pytest.mark.asyncio
async def test_happy_path_runs_three_stages_in_order(stub_client):
    events = await _run(stub_client())
    types = _types(events)

    assert types[0] == "run_start"
    assert types[-1] == "run_complete"

    stage_starts = [e["stage"] for e in events if e["type"] == "stage_start"]
    assert stage_starts == [1, 2, 3]

    stage_completes = [e["stage"] for e in events if e["type"] == "stage_complete"]
    assert stage_completes == [1, 2, 3]


@pytest.mark.asyncio
async def test_every_member_answers_stage_one(stub_client):
    client = stub_client()
    events = await _run(client)
    responses = [e for e in events if e["type"] == "stage1_response"]
    assert len(responses) == len(MODELS)
    assert {r["response"]["model"] for r in responses} == set(MODELS)


@pytest.mark.asyncio
async def test_stage_two_prompts_never_contain_model_identities(stub_client):
    client = stub_client(
        replies={
            "openai/gpt-4o": "As ChatGPT, I say Rayleigh scattering.",
            "anthropic/claude-sonnet-4.5": "Claude here: shorter wavelengths scatter.",
            "google/gemini-2.5-pro": "I am Gemini, developed by Google. Blue scatters.",
        }
    )
    await _run(client)

    review_prompts = client.prompts_of_kind("review")
    assert review_prompts, "expected stage 2 to run"
    for prompt in review_prompts:
        lowered = prompt.lower()
        for brand in ("chatgpt", "claude", "gemini", "openai", "anthropic", "google"):
            assert brand not in lowered, "stage 2 leaked {}".format(brand)
        # The substance must survive the scrubbing.
        assert "scatter" in lowered


@pytest.mark.asyncio
async def test_stage_two_uses_neutral_labels(stub_client):
    client = stub_client()
    await _run(client)
    prompt = client.prompts_of_kind("review")[0]
    assert "Response A" in prompt
    assert "Response B" in prompt


@pytest.mark.asyncio
async def test_leaderboard_is_revealed_only_after_judging(stub_client):
    events = await _run(stub_client())
    stage2 = [e for e in events if e["type"] == "stage_complete" and e["stage"] == 2][0]
    assert stage2["leaderboard"][0]["model"] in MODELS

    run_complete = events[-1]
    assert set(run_complete["reveal"].values()) <= set(MODELS)


@pytest.mark.asyncio
async def test_chairman_receives_the_query_and_rankings(stub_client):
    client = stub_client()
    await _run(client)
    chairman_prompts = client.prompts_of_kind("chairman")
    assert len(chairman_prompts) == 1
    assert "Why is the sky blue?" in chairman_prompts[0]
    assert "Peer ranking" in chairman_prompts[0]


@pytest.mark.asyncio
async def test_final_answer_is_surfaced(stub_client):
    events = await _run(stub_client(chairman_reply="THE ANSWER"))
    assert council.final_answer(events) == "THE ANSWER"


@pytest.mark.asyncio
async def test_one_dead_member_does_not_sink_the_run(stub_client):
    client = stub_client(errors={"google/gemini-2.5-pro": "HTTP 500"})
    events = await _run(client)

    failed = [
        e for e in events
        if e["type"] == "stage1_response" and e["response"]["error"]
    ]
    assert len(failed) == 1

    stage1 = [e for e in events if e["type"] == "stage_complete" and e["stage"] == 1][0]
    assert stage1["answered"] == 2
    assert council.final_answer(events) == "final synthesised answer"


@pytest.mark.asyncio
async def test_all_members_failing_ends_with_actionable_error(stub_client):
    client = stub_client(errors={model: "HTTP 500" for model in MODELS})
    events = await _run(client)

    error = [e for e in events if e["type"] == "error"]
    assert len(error) == 1
    assert "MESH_API_KEY" in error[0]["message"]
    assert "stage_start" not in [e["type"] for e in events if e.get("stage") == 3]


@pytest.mark.asyncio
async def test_single_answer_skips_peer_review(stub_client):
    client = stub_client(errors={MODELS[1]: "boom", MODELS[2]: "boom"})
    # Chairman must be a model that is still alive, otherwise we'd be testing
    # the degraded-chairman path instead.
    events = await _run(client, chairman=MODELS[0])

    skipped = [e for e in events if e["type"] == "stage_skipped"]
    assert len(skipped) == 1
    assert skipped[0]["stage"] == 2
    # Chairman still runs.
    assert council.final_answer(events) == "final synthesised answer"


@pytest.mark.asyncio
async def test_dead_chairman_degrades_to_peer_ranked_winner(stub_client):
    client = stub_client(
        replies={m: "answer from {}".format(m) for m in MODELS},
        chairman_reply="",
    )
    events = await _run(client)
    stage3 = [e for e in events if e["type"] == "stage_complete" and e["stage"] == 3][0]

    assert stage3["degraded"] is True
    assert stage3["final"].startswith("answer from ")
    assert stage3["source_model"] in MODELS


@pytest.mark.asyncio
async def test_unparseable_reviews_are_counted_not_hidden(stub_client):
    client = stub_client(review_reply="I decline to rank.")
    events = await _run(client)
    stage2 = [e for e in events if e["type"] == "stage_complete" and e["stage"] == 2][0]

    assert stage2["reviews_parsed"] == 0
    assert stage2["reviews_total"] == 3
    # Run still completes.
    assert events[-1]["type"] == "run_complete"


@pytest.mark.asyncio
async def test_totals_accumulate_across_stages(stub_client):
    events = await _run(stub_client())
    totals = events[-1]["totals"]

    # 3 answers + 3 reviews + 1 chairman
    assert totals["calls"] == 7
    assert totals["total_tokens"] == 7 * 30
    assert totals["cost_usd"] == pytest.approx(0.007)
    assert totals["failed_calls"] == 0


@pytest.mark.asyncio
async def test_empty_council_reports_error(stub_client):
    events = await _run(stub_client(), models=[])
    assert events[0]["type"] == "error"


@pytest.mark.asyncio
async def test_history_is_passed_to_stage_one(stub_client):
    client = stub_client()
    await _run(
        client,
        history=[
            {"role": "user", "content": "earlier question"},
            {"role": "assistant", "content": "earlier answer"},
        ],
    )
    answer_prompt = client.prompts_of_kind("answer")[0]
    assert "earlier question" in answer_prompt
    assert "earlier answer" in answer_prompt


@pytest.mark.asyncio
async def test_code_mode_switches_prompts_and_budget(stub_client):
    client = stub_client()
    await _run(client, code_mode=True)

    answer_calls = [c for c in client.calls if c["kind"] == "answer"]
    assert "```file" in answer_calls[0]["messages"][0]["content"]
    assert answer_calls[0]["max_tokens"] >= 4000

    chairman_call = [c for c in client.calls if c["kind"] == "chairman"][0]
    assert "FINAL implementation" in chairman_call["messages"][0]["content"]


# ---------------------------------------------------------------------------
# Streamed chairman
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chairman_answer_streams_by_default(stub_client):
    """The final third of a run is the longest wait, so it must not be a spinner."""
    events = await _run(stub_client(chairman_reply="Synthesised final answer."))

    deltas = [e for e in events if e["type"] == "stage3_delta"]
    assert len(deltas) > 1
    assert "".join(d["text"] for d in deltas) == "Synthesised final answer."

    stage3 = [e for e in events if e["type"] == "stage_complete" and e["stage"] == 3][0]
    assert stage3["final"] == "Synthesised final answer."
    assert stage3["degraded"] is False


@pytest.mark.asyncio
async def test_stage3_deltas_arrive_before_stage_completion(stub_client):
    events = await _run(stub_client())
    types = [e["type"] for e in events]
    first_delta = types.index("stage3_delta")
    completion = max(
        i for i, e in enumerate(events)
        if e["type"] == "stage_complete" and e.get("stage") == 3
    )
    assert first_delta < completion


@pytest.mark.asyncio
async def test_streaming_can_be_disabled_for_buffered_callers(stub_client):
    """Code+PR buffers the patch — there is nothing to render token by token."""
    client = stub_client()
    events = await _run(client, stream_chairman=False)

    assert not any(e["type"] == "stage3_delta" for e in events)
    assert council.final_answer(events) == "final synthesised answer"
    chairman_call = [c for c in client.calls if c["kind"] == "chairman"][0]
    assert chairman_call.get("streamed") is not True


@pytest.mark.asyncio
async def test_dead_chairman_still_degrades_when_streaming(stub_client):
    client = stub_client(
        replies={m: "answer from {}".format(m) for m in MODELS},
        chairman_reply="",
    )
    events = await _run(client)
    stage3 = [e for e in events if e["type"] == "stage_complete" and e["stage"] == 3][0]

    assert stage3["degraded"] is True
    assert stage3["final"].startswith("answer from ")
