"""HTTP surface: SSE framing, persistence side-effects, and Code+PR guard rails."""
from __future__ import annotations

import json
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

from backend import config, council, github_pr, main, storage

client = TestClient(main.app)


def _sse_events(body: str) -> List[Dict[str, Any]]:
    events = []
    for line in body.splitlines():
        if not line.startswith("data: "):
            continue
        payload = line[len("data: ") :]
        if payload == "[DONE]":
            continue
        events.append(json.loads(payload))
    return events


def _fake_run(final="synthesised", totals=None, leaderboard=None, error=None):
    async def _gen(**kwargs):
        yield {"type": "run_start", "query": kwargs.get("query")}
        if error:
            yield {"type": "error", "message": error}
            return
        yield {
            "type": "stage1_response",
            "response": {"model": "openai/gpt-4o", "content": "a", "error": None},
        }
        yield {"type": "stage_complete", "stage": 1, "answered": 1}
        yield {"type": "stage_complete", "stage": 3, "final": final}
        yield {
            "type": "run_complete",
            "leaderboard": leaderboard or [{"position": 1, "model": "openai/gpt-4o", "points": 2}],
            "totals": totals or {"calls": 3, "cost_usd": 0.002},
            "reveal": {"Response A": "openai/gpt-4o"},
        }

    return _gen


# ---------------------------------------------------------------------------
# Basics
# ---------------------------------------------------------------------------


def test_health_reports_key_presence():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["mesh_key_configured"] is True


def test_config_never_leaks_the_key():
    payload = client.get("/api/config").json()
    assert payload["mesh_key_configured"] is True
    serialised = json.dumps(payload)
    assert "rsk_test_key" not in serialised


def test_models_falls_back_to_config_when_mesh_unreachable(monkeypatch):
    from backend.mesh_client import MeshError

    class Boom:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def list_models(self):
            raise MeshError("mesh down")

    monkeypatch.setattr(main, "MeshClient", lambda *a, **k: Boom())
    payload = client.get("/api/models").json()

    assert payload["source"] == "config"
    assert payload["warning"] == "mesh down"
    assert any(m["id"] == config.CHAIRMAN_MODEL for m in payload["models"])


def test_models_returns_live_catalogue(monkeypatch):
    class Good:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def list_models(self):
            return [{"id": "openai/gpt-4o", "name": "GPT-4o", "context_length": 128000,
                     "owned_by": "openai"}]

    monkeypatch.setattr(main, "MeshClient", lambda *a, **k: Good())
    payload = client.get("/api/models").json()
    assert payload["source"] == "mesh"
    assert payload["models"][0]["id"] == "openai/gpt-4o"


# ---------------------------------------------------------------------------
# Council SSE
# ---------------------------------------------------------------------------


def test_council_streams_events_and_terminates(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run())

    response = client.post("/api/council", json={"query": "why is the sky blue"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    body = response.text
    assert body.rstrip().endswith("data: [DONE]")

    events = _sse_events(body)
    assert events[0]["type"] == "run_start"
    assert events[-1]["type"] == "run_complete"


def test_council_persists_the_turn(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run(final="persisted answer"))

    client.post("/api/council", json={"query": "remember me"})

    conversations = client.get("/api/conversations").json()["conversations"]
    assert len(conversations) == 1
    assert conversations[0]["turns"] == 1

    full = client.get("/api/conversations/{}".format(conversations[0]["id"])).json()
    assert full["turns"][0]["final"] == "persisted answer"
    assert full["turns"][0]["query"] == "remember me"
    assert full["title"] == "remember me"


def test_council_rejects_empty_query():
    assert client.post("/api/council", json={"query": ""}).status_code == 422


def test_council_error_event_is_streamed_not_raised(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run(error="Mesh balance empty"))

    response = client.post("/api/council", json={"query": "x"})
    events = _sse_events(response.text)

    assert response.status_code == 200
    assert events[-1]["type"] == "error"
    assert "balance" in events[-1]["message"]
    # Nothing persisted for a failed run.
    assert client.get("/api/conversations").json()["conversations"][0]["turns"] == 0


def test_council_unexpected_exception_is_reported_without_traceback(monkeypatch):
    async def explode(**kwargs):
        yield {"type": "run_start"}
        raise RuntimeError("kaboom in the orchestrator")

    monkeypatch.setattr(council, "run_council", explode)
    response = client.post("/api/council", json={"query": "x"})
    events = _sse_events(response.text)

    assert events[-1]["type"] == "error"
    assert "Unexpected error" in events[-1]["message"]
    assert "Traceback" not in response.text


def test_council_continues_an_existing_conversation(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run(final="first"))
    client.post("/api/council", json={"query": "one"})
    conversation_id = client.get("/api/conversations").json()["conversations"][0]["id"]

    monkeypatch.setattr(council, "run_council", _fake_run(final="second"))
    client.post(
        "/api/council", json={"query": "two", "conversation_id": conversation_id}
    )

    conversations = client.get("/api/conversations").json()["conversations"]
    assert len(conversations) == 1
    assert conversations[0]["turns"] == 2


def test_unknown_conversation_id_starts_a_new_one(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run())
    response = client.post(
        "/api/council", json={"query": "x", "conversation_id": "does-not-exist"}
    )
    assert response.status_code == 200
    assert len(client.get("/api/conversations").json()["conversations"]) == 1


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------


def test_missing_conversation_is_404():
    assert client.get("/api/conversations/abc123").status_code == 404


def test_traversal_conversation_id_is_rejected():
    response = client.get("/api/conversations/..%2F..%2Fetc%2Fpasswd")
    assert response.status_code in (400, 404)


def test_delete_conversation(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run())
    client.post("/api/council", json={"query": "delete me"})
    conversation_id = client.get("/api/conversations").json()["conversations"][0]["id"]

    assert client.delete("/api/conversations/{}".format(conversation_id)).status_code == 200
    assert client.get("/api/conversations").json()["conversations"] == []
    assert client.delete("/api/conversations/{}".format(conversation_id)).status_code == 404


# ---------------------------------------------------------------------------
# Code + PR
# ---------------------------------------------------------------------------

CODE_FINAL = (
    "Adds a retry helper.\n\n"
    "```file src/retry.py\n"
    "def retry(fn):\n"
    "    return fn\n"
    "```\n"
)


def test_code_pr_dry_run_returns_files_without_touching_github(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run(final=CODE_FINAL))

    def explode(*a, **k):  # pragma: no cover
        raise AssertionError("GitHub must not be called on a dry run")

    monkeypatch.setattr(github_pr, "GitHubClient", explode)

    payload = client.post(
        "/api/code-pr", json={"request": "add a retry helper"}
    ).json()

    assert payload["pr"] is None
    assert payload["valid"] is True
    assert payload["files"][0]["path"] == "src/retry.py"
    assert "def retry" in payload["files"][0]["content"]
    assert "Adds a retry helper." in payload["summary"]
    assert "```" not in payload["summary"]


def test_code_pr_dry_run_flags_invalid_paths(monkeypatch):
    bad = "Oops.\n\n```file ../../etc/passwd\nroot\n```\n"
    monkeypatch.setattr(council, "run_council", _fake_run(final=bad))

    payload = client.post("/api/code-pr", json={"request": "escape"}).json()
    assert payload["valid"] is False
    assert "protected path" in payload["validation_error"]
    assert payload["pr"] is None


def test_code_pr_requires_owner_and_repo_when_opening(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run(final=CODE_FINAL))
    monkeypatch.setattr(config, "GITHUB_DEFAULT_OWNER", "")
    monkeypatch.setattr(config, "GITHUB_DEFAULT_REPO", "")

    response = client.post(
        "/api/code-pr", json={"request": "x", "open_pr": True}
    )
    assert response.status_code == 400
    assert "owner and repo" in response.json()["detail"]


def test_code_pr_opens_pull_request(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run(final=CODE_FINAL))
    captured = {}

    class FakeGH:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def open_pr_with_changes(self, **kwargs):
            captured.update(kwargs)
            return {
                "number": 12,
                "url": "https://github.com/o/r/pull/12",
                "branch": kwargs["branch"],
                "base": "main",
                "files": [c.path for c in kwargs["changes"]],
            }

    monkeypatch.setattr(github_pr, "GitHubClient", lambda *a, **k: FakeGH())

    payload = client.post(
        "/api/code-pr",
        json={
            "request": "add a retry helper",
            "owner": "nakwafurkhan",
            "repo": "LLM_COUNCIL",
            "open_pr": True,
        },
    ).json()

    assert payload["pr"]["number"] == 12
    assert payload["pr"]["url"].endswith("/pull/12")
    assert captured["owner"] == "nakwafurkhan"
    assert captured["branch"].startswith("council/")
    assert "Mesh API" in captured["body"]
    assert "add a retry helper" in captured["title"]


def test_code_pr_surfaces_pr_errors_as_400(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run(final=CODE_FINAL))

    class FailingGH:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def open_pr_with_changes(self, **kwargs):
            raise github_pr.PRError("GITHUB_TOKEN is not set.")

    monkeypatch.setattr(github_pr, "GitHubClient", lambda *a, **k: FailingGH())

    response = client.post(
        "/api/code-pr",
        json={"request": "x", "owner": "o", "repo": "r", "open_pr": True},
    )
    assert response.status_code == 400
    assert "GITHUB_TOKEN" in response.json()["detail"]


def test_code_pr_propagates_council_failure(monkeypatch):
    monkeypatch.setattr(council, "run_council", _fake_run(error="all members failed"))
    response = client.post("/api/code-pr", json={"request": "x"})
    assert response.status_code == 502
    assert "all members failed" in response.json()["detail"]
