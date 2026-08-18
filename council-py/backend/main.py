"""FastAPI app for the LLM Council (Mesh API edition).

Endpoints
    GET  /api/health              liveness + whether the Mesh key is present
    GET  /api/config              non-secret config for the UI
    GET  /api/models              live Mesh catalogue for the model picker
    POST /api/council             run the council, streamed as SSE
    POST /api/code-pr             council-drafted change, optionally opened as a PR
    GET  /api/conversations       list saved conversations
    GET  /api/conversations/{id}  full transcript
    DELETE /api/conversations/{id}
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import config, council, github_pr, storage
from .mesh_client import MeshClient, MeshError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("council")

app = FastAPI(title="LLM Council — Mesh API edition", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class CouncilRequest(BaseModel):
    query: str = Field(..., min_length=1)
    models: Optional[List[str]] = None
    chairman: Optional[str] = None
    conversation_id: Optional[str] = None


class CodePRRequest(BaseModel):
    request: str = Field(..., min_length=1, description="What should change")
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
# Basic routes
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
    """Live Mesh catalogue. Falls back to the configured line-up if unreachable."""
    try:
        async with MeshClient() as client:
            models = await client.list_models()
        return {"models": models, "source": "mesh"}
    except MeshError as exc:
        logger.warning("Mesh catalogue unavailable: %s", exc)
        configured = sorted(set(config.COUNCIL_MODELS + [config.CHAIRMAN_MODEL]))
        return {
            "models": [
                {"id": m, "name": m, "context_length": 0, "owned_by": m.split("/")[0]}
                for m in configured
            ],
            "source": "config",
            "warning": str(exc),
        }


# ---------------------------------------------------------------------------
# Council (SSE)
# ---------------------------------------------------------------------------


def _sse(event: Dict[str, Any]) -> str:
    return "data: {}\n\n".format(json.dumps(event, ensure_ascii=False))


async def _council_stream(body: CouncilRequest) -> AsyncIterator[str]:
    conversation_id = body.conversation_id
    if conversation_id and storage.load(conversation_id) is None:
        conversation_id = None
    if not conversation_id:
        conversation_id = storage.new_conversation(title=body.query)["id"]

    history = storage.history_messages(conversation_id)
    stage1: List[Dict[str, Any]] = []
    final = ""
    leaderboard: List[Dict[str, Any]] = []
    totals: Dict[str, Any] = {}
    reveal: Dict[str, str] = {}

    try:
        async for event in council.run_council(
            query=body.query,
            models=body.models,
            chairman=body.chairman,
            history=history,
            conversation_id=conversation_id,
        ):
            if event.get("type") == "stage1_response":
                stage1.append(event["response"])
            elif event.get("type") == "stage_complete" and event.get("stage") == 3:
                final = event.get("final", "")
            elif event.get("type") == "run_complete":
                leaderboard = event.get("leaderboard") or []
                totals = event.get("totals") or {}
                reveal = event.get("reveal") or {}
            yield _sse(event)
    except MeshError as exc:
        yield _sse({"type": "error", "message": str(exc)})
    except Exception as exc:  # noqa: BLE001 - never leak a traceback to the UI
        logger.exception("Council run failed")
        yield _sse({"type": "error", "message": "Unexpected error: {}".format(exc)})
    else:
        if final:
            storage.append_turn(
                conversation_id,
                query=body.query,
                final=final,
                stage1=stage1,
                leaderboard=leaderboard,
                totals=totals,
                reveal=reveal,
            )
    finally:
        yield "data: [DONE]\n\n"


@app.post("/api/council")
async def run_council_endpoint(body: CouncilRequest) -> StreamingResponse:
    return StreamingResponse(
        _council_stream(body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Code + PR mode
# ---------------------------------------------------------------------------


@app.post("/api/code-pr")
async def code_pr(body: CodePRRequest) -> Dict[str, Any]:
    """Run the council on a code change, then optionally open a real PR."""
    events = await council.collect(
        council.run_council(
            query=body.request,
            models=body.models,
            chairman=body.chairman,
            code_mode=True,
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
        # Dry run: let the user read the patch before anything is pushed.
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

    models = run_complete.get("leaderboard") or []
    model_names = [row.get("model", "") for row in models] or list(
        body.models or config.COUNCIL_MODELS
    )
    title = body.title or "council: {}".format(body.request.strip()[:60])
    branch = body.branch or github_pr.slugify_branch(body.request)
    pr_body = github_pr.build_pr_body(
        request=body.request,
        summary=summary,
        changes=changes,
        models=model_names,
        chairman=body.chairman or config.CHAIRMAN_MODEL,
        leaderboard=models,
    )

    try:
        async with github_pr.GitHubClient() as gh:
            pr = await gh.open_pr_with_changes(
                owner=owner,
                repo=repo,
                branch=branch,
                title=title,
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

    uvicorn.run(
        "backend.main:app", host=config.HOST, port=config.PORT, reload=False
    )


if __name__ == "__main__":
    run()
