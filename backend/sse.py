"""One SSE layer for every mode.

Previously each endpoint framed its own events and mapped its own errors. Now
there is one envelope helper and one exception→event mapper, so Chat, Quick,
Council, Code+PR and Humanizer all stream identically — and a new mode gets
correct error handling for free.
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Callable, Dict, Optional

from .github_pr import PRError
from .mesh_client import MeshAuthError, MeshCreditError, MeshError

logger = logging.getLogger("council.sse")

DONE = "data: [DONE]\n\n"


def frame(event: Dict[str, Any]) -> str:
    """Serialise one event as an SSE frame."""
    return "data: {}\n\n".format(json.dumps(event, ensure_ascii=False))


def error_event(exc: BaseException) -> Dict[str, Any]:
    """Map an exception to a user-facing event.

    Known, actionable failures keep their message and gain a `kind` the UI can
    react to. Anything unexpected is logged with its traceback and reported
    without one — a stack trace is not a user-facing error message.
    """
    if isinstance(exc, MeshCreditError):
        return {"type": "error", "kind": "credit", "message": str(exc)}
    if isinstance(exc, MeshAuthError):
        return {"type": "error", "kind": "auth", "message": str(exc)}
    if isinstance(exc, MeshError):
        return {"type": "error", "kind": "mesh", "message": str(exc)}
    if isinstance(exc, PRError):
        return {"type": "error", "kind": "pr", "message": str(exc)}

    logger.exception("Unhandled error during stream")
    return {
        "type": "error",
        "kind": "unexpected",
        "message": "Unexpected error: {}".format(exc),
    }


async def stream(
    events: AsyncIterator[Dict[str, Any]],
    on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    on_success: Optional[Callable[[], None]] = None,
) -> AsyncIterator[str]:
    """Wrap an event generator as SSE frames.

    `on_event` observes each event (used for persistence side-effects) and
    `on_success` fires only if the stream completed without an error event, so a
    failed run is never saved as if it had succeeded.
    """
    failed = False
    try:
        async for event in events:
            if event.get("type") == "error":
                failed = True
            if on_event is not None:
                try:
                    on_event(event)
                except Exception:  # noqa: BLE001 - persistence must not kill the stream
                    logger.exception("on_event handler failed")
            yield frame(event)
    except BaseException as exc:  # noqa: BLE001 - convert to an event, never a 500
        failed = True
        yield frame(error_event(exc))
    else:
        if not failed and on_success is not None:
            try:
                on_success()
            except Exception:  # noqa: BLE001
                logger.exception("on_success handler failed")
    finally:
        yield DONE
