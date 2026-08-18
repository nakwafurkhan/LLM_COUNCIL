"""Parsing and aggregation of Stage 2 peer rankings.

Reviewers are asked for JSON. Models being models, they sometimes wrap it in
prose or a fenced block, so the parser is deliberately forgiving — but it never
invents data: an unparseable review is reported as such rather than silently
scored as zero.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Sequence

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def _candidate_json_blobs(text: str) -> List[str]:
    """Yield plausible JSON substrings, best candidate first."""
    candidates: List[str] = []
    stripped = (text or "").strip()
    if not stripped:
        return candidates

    for match in _FENCE_RE.finditer(stripped):
        candidates.append(match.group(1).strip())

    # Whole string, in case the model was obedient.
    candidates.append(stripped)

    # Widest brace span as a last resort.
    first, last = stripped.find("{"), stripped.rfind("}")
    if first != -1 and last > first:
        candidates.append(stripped[first : last + 1])

    return candidates


def parse_review(text: str, valid_labels: Sequence[str]) -> Dict[str, Any]:
    """Extract {label: rank} plus per-label notes from one reviewer's output.

    Returns a dict with keys: `ranks` (label -> int), `notes` (label -> str),
    and `parsed` (bool).
    """
    valid = set(valid_labels)

    for blob in _candidate_json_blobs(text):
        try:
            payload = json.loads(blob)
        except (ValueError, TypeError):
            continue

        rows: Optional[List[Any]] = None
        if isinstance(payload, dict):
            for key in ("rankings", "ranking", "results", "reviews"):
                if isinstance(payload.get(key), list):
                    rows = payload[key]
                    break
        elif isinstance(payload, list):
            rows = payload

        if not rows:
            continue

        ranks: Dict[str, int] = {}
        notes: Dict[str, str] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            label = row.get("label") or row.get("response") or row.get("id")
            if not isinstance(label, str):
                continue
            label = label.strip()
            # Tolerate "A" for "Response A".
            if label not in valid:
                for candidate in valid:
                    if candidate.lower().endswith(label.lower()):
                        label = candidate
                        break
            if label not in valid:
                continue
            rank = row.get("rank", row.get("position"))
            try:
                rank_int = int(rank)
            except (TypeError, ValueError):
                continue
            ranks[label] = rank_int
            reason = row.get("reason") or row.get("rationale") or row.get("note")
            if isinstance(reason, str) and reason.strip():
                notes[label] = reason.strip()

        if ranks:
            return {"ranks": ranks, "notes": notes, "parsed": True}

    return {"ranks": {}, "notes": {}, "parsed": False}


def aggregate(
    reviews: Sequence[Dict[str, Any]], valid_labels: Sequence[str]
) -> List[Dict[str, Any]]:
    """Borda-style aggregation across reviewers.

    Each reviewer's rank-1 gets N points, rank-2 gets N-1, and so on. Ties are
    broken by average rank, then label order, so output is deterministic.
    """
    labels = list(valid_labels)
    n = len(labels)
    points: Dict[str, int] = {label: 0 for label in labels}
    rank_sum: Dict[str, int] = {label: 0 for label in labels}
    vote_count: Dict[str, int] = {label: 0 for label in labels}

    for review in reviews:
        ranks = review.get("ranks") or {}
        for label, rank in ranks.items():
            if label not in points:
                continue
            if rank < 1 or rank > n:
                continue
            points[label] += n - rank + 1
            rank_sum[label] += rank
            vote_count[label] += 1

    table: List[Dict[str, Any]] = []
    for label in labels:
        votes = vote_count[label]
        table.append(
            {
                "label": label,
                "points": points[label],
                "votes": votes,
                "average_rank": round(rank_sum[label] / votes, 2) if votes else None,
            }
        )

    table.sort(
        key=lambda row: (
            -row["points"],
            row["average_rank"] if row["average_rank"] is not None else 99,
            row["label"],
        )
    )
    for position, row in enumerate(table, start=1):
        row["position"] = position
    return table


def attach_models(
    table: Sequence[Dict[str, Any]], mapping: Dict[str, str]
) -> List[Dict[str, Any]]:
    """De-anonymise the leaderboard once judging is finished."""
    revealed = []
    for row in table:
        item = dict(row)
        item["model"] = mapping.get(row["label"], "unknown")
        revealed.append(item)
    return revealed
