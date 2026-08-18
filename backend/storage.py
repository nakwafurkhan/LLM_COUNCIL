"""Conversation persistence — JSON files on disk, same spirit as the original.

One file per conversation under DATA_DIR. Deliberately boring: no database to
run, and the files are readable if you want to inspect a run by hand.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config

_SAFE_ID = set("abcdefghijklmnopqrstuvwxyz0123456789-")


def _data_dir() -> Path:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    return config.DATA_DIR


def _safe_id(conversation_id: str) -> str:
    """Validate a conversation id.

    Deliberately strict rather than sanitising: silently stripping bad
    characters would map "../../etc/passwd" onto a real file named
    "etcpasswd", which is safe but confusing. Reject instead.
    """
    candidate = (conversation_id or "").strip().lower()
    if not candidate or len(candidate) > 64:
        raise ValueError("Invalid conversation id")
    if any(ch not in _SAFE_ID for ch in candidate):
        raise ValueError("Invalid conversation id")
    return candidate


def _path_for(conversation_id: str) -> Path:
    return _data_dir() / "{}.json".format(_safe_id(conversation_id))


def new_conversation(title: str = "", mode: str = "chat") -> Dict[str, Any]:
    conversation = {
        "id": str(uuid.uuid4()),
        "title": (title or "Untitled").strip()[:120],
        "mode": mode,
        "created_at": time.time(),
        "updated_at": time.time(),
        "turns": [],
    }
    save(conversation)
    return conversation


def save(conversation: Dict[str, Any]) -> Dict[str, Any]:
    conversation["updated_at"] = time.time()
    path = _path_for(conversation["id"])
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(conversation, indent=2), encoding="utf-8")
    tmp.replace(path)  # atomic-ish: never leave a half-written file behind
    return conversation


def load(conversation_id: str) -> Optional[Dict[str, Any]]:
    path = _path_for(conversation_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def append_turn(
    conversation_id: str,
    query: str,
    final: str,
    mode: str = "chat",
    model: str = "",
    stage1: Optional[List[Dict[str, Any]]] = None,
    leaderboard: Optional[List[Dict[str, Any]]] = None,
    totals: Optional[Dict[str, Any]] = None,
    reveal: Optional[Dict[str, str]] = None,
) -> Optional[Dict[str, Any]]:
    """Append one turn. Council-only fields are simply absent for other modes."""
    conversation = load(conversation_id)
    if conversation is None:
        return None

    turn: Dict[str, Any] = {
        "query": query,
        "final": final,
        "mode": mode,
        "totals": totals or {},
        "at": time.time(),
    }
    if model:
        turn["model"] = model
    if stage1:
        turn["stage1"] = stage1
    if leaderboard:
        turn["leaderboard"] = leaderboard
    if reveal:
        turn["reveal"] = reveal

    conversation["turns"].append(turn)
    if conversation.get("title") in ("", "Untitled") and query:
        conversation["title"] = query.strip()[:120]
    return save(conversation)


def list_conversations(limit: int = 50) -> List[Dict[str, Any]]:
    """Newest first, metadata only — the sidebar does not need full transcripts."""
    items: List[Dict[str, Any]] = []
    for path in _data_dir().glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        items.append(
            {
                "id": payload.get("id"),
                "title": payload.get("title") or "Untitled",
                "mode": payload.get("mode") or "chat",
                "created_at": payload.get("created_at", 0),
                "updated_at": payload.get("updated_at", 0),
                "turns": len(payload.get("turns") or []),
            }
        )
    items.sort(key=lambda item: item.get("updated_at", 0), reverse=True)
    return items[:limit]


def history_messages(conversation_id: str, max_turns: int = 6) -> List[Dict[str, str]]:
    """Recent turns as chat messages, for multi-turn council runs."""
    conversation = load(conversation_id)
    if not conversation:
        return []
    messages: List[Dict[str, str]] = []
    for turn in (conversation.get("turns") or [])[-max_turns:]:
        if turn.get("query"):
            messages.append({"role": "user", "content": turn["query"]})
        if turn.get("final"):
            messages.append({"role": "assistant", "content": turn["final"]})
    return messages


def delete(conversation_id: str) -> bool:
    path = _path_for(conversation_id)
    if path.exists():
        path.unlink()
        return True
    return False
