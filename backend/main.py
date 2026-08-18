"""FastAPI app — LLM Council on Mesh API.

Five modes, one streaming contract:

    GET    /api/health              liveness + whether keys are present
    GET    /api/config              non-secret config for the UI
    GET    /api/models              live Mesh catalogue for the model picker
    POST   /api/chat                Chat / Quick / Humanizer (SSE, token stream)
    POST   /api/council             the three-stage council (SSE)
    POST   /api/code-pr             council-drafted change, optionally a real PR
    GET    /api/conversations       saved runs
    GET    /api/conversations/{id}  full transcript
    DELETE /api/conversations/{id}
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import config, council, github_pr, single, sse, storage
from .mesh_client import MeshClient, MeshError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("council")

app = FastAPI(title="LLM Council — Mesh API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    # Without this a reverse proxy buffers the stream and the UI looks frozen.
    "X-Accel-Buffering": "no",
}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    query: str = Field(..., min_length=1)
    mode: str = Field(default=single.CHAT, pattern="^(chat|quick|humanize)$")
    model: Optional[str] = None
    conversation_id: Optional[str] = None
    tone: str = Field(default="neutral", pattern="^(neutral|plain|warm|direct)$")
    length: str = Field(default="keep", pattern="^(tighten|keep|expand)$")


class CouncilRequest(BaseModel):
    query: str = Field(..., min_length=1)
    models: Optional[List[str]] = None
    chairman: Optional[str] = None
    conversation_id: Optional[str] = None


class CodePRRequest(BaseModel):
    request: str = Field(..., min_length=1)
    owner: Optional[str] = None
    repo: Optional[str] = None
    base: Optional[str] = None
    branch: Optional[str] = None
    title: Optional[str] = None
    models: Optional[List[str]] = None
    chairman: Optional[str] = None
    draft: bool = False
    open_pr: bool = Field(
        default=False,
        description="If false, return the drafted files without touching GitHub.",
    )


# ---------------------------------------------------------------------------
# Basics
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "mesh_key_configured": bool(config.MESH_API_KEY),
        "github_configured": bool(config.GITHUB_TOKEN),
    }


@app.get("/api/config")
async def get_config() -> Dict[str, Any]:
    return config.summary()


@app.get("/api/models")
async def get_models() -> Dict[str, Any]:
    """Live Mesh catalogue; falls back to configured models if unreachable."""
    try:
        async with MeshClient() as client:
            models = await client.list_models()
        return {"models": models, "source": "mesh"}
    except MeshError as exc:
        logger.warning("Mesh catalogue unavailable: %s", exc)
        configured = sorted(
            set(
                list(config.COUNCIL_MODELS)
                + [
                    config.CHAIRMAN_MODEL,
                    config.CHAT_MODEL,
                    config.QUICK_MODEL,
                    config.HUMANIZER_MODEL,
                ]
            )
        )
        return {
            "models": [
                {"id": m, "name": m, "context_length": 0, "owned_by": m.split("/")[0]}
                for m in configured
            ],
            "source": "config",
            "warning": str(exc),
        }


# ---------------------------------------------------------------------------
# Conversation helper
# ---------------------------------------------------------------------------


def _ensure_conversation(conversation_id: Optional[str], title: str, mode: str) -> str:
    """Resolve an existing conversation or start one. Unknown ids start fresh."""
    if conversation_id:
        try:
            if storage.load(conversation_id) is not None:
                return conversation_id
        except ValueError:
            pass
    return storage.new_conversation(title=title, mode=mode)["id"]


# ---------------------------------------------------------------------------
# Chat / Quick / Humanizer
# ---------------------------------------------------------------------------


@app.post("/api/chat")
async def chat(body: ChatRequest) -> StreamingResponse:
    conversation_id = _ensure_conversation(
        body.conversation_id, title=body.query, mode=body.mode
    )
    # The Humanizer is a one-shot transform: earlier turns must not leak in.
    history = (
        []
        if body.mode == single.HUMANIZE
        else storage.history_messages(conversation_id)
    )
    captured: Dict[str, Any] = {}

    def observe(event: Dict[str, Any]) -> None:
        if event.get("type") == "run_complete":
            captured.update(event)

    def persist() -> None:
        if not captured.get("final"):
            return
        storage.append_turn(
            conversation_id,
            query=body.query,
            final=captured["final"],
            mode=body.mode,
            model=captured.get("model", ""),
            totals=captured.get("totals") or {},
        )

    events = single.run_single(
        query=body.query,
        mode=body.mode,
        model=body.model,
        history=history,
        tone=body.tone,
        length=body.length,
        conversation_id=conversation_id,
    )
    return StreamingResponse(
        sse.stream(events, on_event=observe, on_success=persist),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


# ---------------------------------------------------------------------------
# Council
# ---------------------------------------------------------------------------


@app.post("/api/council")
async def run_council_endpoint(body: CouncilRequest) -> StreamingResponse:
    conversation_id = _ensure_conversation(
        body.conversation_id, title=body.query, mode="council"
    )
    history = storage.history_messages(conversation_id)
    state: Dict[str, Any] = {
        "stage1": [],
        "final": "",
        "leaderboard": [],
        "totals": {},
        "reveal": {},
    }

    def observe(event: Dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "stage1_response":
            state["stage1"].append(event["response"])
        elif kind == "stage_complete" and event.get("stage") == 3:
            state["final"] = event.get("final", "")
        elif kind == "run_complete":
            state["leaderboard"] = event.get("leaderboard") or []
            state["totals"] = event.get("totals") or {}
            state["reveal"] = event.get("reveal") or {}

    def persist() -> None:
        if not state["final"]:
            return
        storage.append_turn(
            conversation_id,
            query=body.query,
            final=state["final"],
            mode="council",
            stage1=state["stage1"],
            leaderboard=state["leaderboard"],
            totals=state["totals"],
            reveal=state["reveal"],
        )

    events = council.run_council(
        query=body.query,
        models=body.models,
        chairman=body.chairman,
        history=history,
        conversation_id=conversation_id,
    )
    return StreamingResponse(
        sse.stream(events, on_event=observe, on_success=persist),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


# ---------------------------------------------------------------------------
# Code + PR
# ---------------------------------------------------------------------------


@app.post("/api/code-pr")
async def code_pr(body: CodePRRequest) -> Dict[str, Any]:
    """Council-drafted change. Nothing is pushed unless `open_pr` is true."""
    events = await council.collect(
        council.run_council(
            query=body.request,
            models=body.models,
            chairman=body.chairman,
            code_mode=True,
            # Buffer the patch — there is nothing useful to render token by token.
            stream_chairman=False,
        )
    )

    error = next((e for e in events if e.get("type") == "error"), None)
    if error:
        raise HTTPException(status_code=502, detail=error.get("message"))

    final = council.final_answer(events)
    run_complete = next((e for e in events if e.get("type") == "run_complete"), {})

    changes = github_pr.parse_file_blocks(final)
    summary = github_pr.strip_file_blocks(final)

    result: Dict[str, Any] = {
        "request": body.request,
        "summary": summary,
        "files": [c.to_dict() for c in changes],
        "leaderboard": run_complete.get("leaderboard") or [],
        "totals": run_complete.get("totals") or {},
        "pr": None,
    }

    if not body.open_pr:
        try:
            github_pr.validate_paths(changes)
            result["valid"] = True
        except github_pr.PRError as exc:
            result["valid"] = False
            result["validation_error"] = str(exc)
        return result

    owner = body.owner or config.GITHUB_DEFAULT_OWNER
    repo = body.repo or config.GITHUB_DEFAULT_REPO
    if not owner or not repo:
        raise HTTPException(
            status_code=400,
            detail="owner and repo are required (or set GITHUB_DEFAULT_OWNER/REPO).",
        )

    board = run_complete.get("leaderboard") or []
    model_names = [row.get("model", "") for row in board] or list(
        body.models or config.COUNCIL_MODELS
    )
    pr_body = github_pr.build_pr_body(
        request=body.request,
        summary=summary,
        changes=changes,
        models=model_names,
        chairman=body.chairman or config.CHAIRMAN_MODEL,
        leaderboard=board,
    )

    try:
        async with github_pr.GitHubClient() as gh:
            pr = await gh.open_pr_with_changes(
                owner=owner,
                repo=repo,
                branch=body.branch or github_pr.slugify_branch(body.request),
                title=body.title or "council: {}".format(body.request.strip()[:60]),
                body=pr_body,
                changes=changes,
                base=body.base,
                draft=body.draft,
            )
    except github_pr.PRError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    result["pr"] = pr
    result["valid"] = True
    return result


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------


@app.get("/api/conversations")
async def list_conversations() -> Dict[str, Any]:
    return {"conversations": storage.list_conversations()}


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str) -> Dict[str, Any]:
    try:
        conversation = storage.load(conversation_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid conversation id")
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str) -> Dict[str, Any]:
    try:
        removed = storage.delete(conversation_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid conversation id")
    if not removed:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"deleted": True}


def run() -> None:
    import uvicorn

    uvicorn.run("backend.main:app", host=config.HOST, port=config.PORT, reload=False)


if __name__ == "__main__":
    run()
