"""Thin async client for Mesh API (https://meshapi.ai).

Mesh is an OpenAI-compatible gateway, so this is a plain HTTP client against
`/chat/completions` — no vendor SDK required. On top of the raw call we add:

* bounded retries with exponential backoff on transient failures
* an explicit fallback model so one dead provider cannot sink a council run
* per-call latency, token usage and cost capture (Mesh returns cost when it can)
* friendly errors for the two failures users actually hit: bad key (401) and
  empty balance (402)
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from . import config


# Sentinel so callers can distinguish "use the configured fallback" (omit the
# argument) from "do not fall back at all" (pass None explicitly).
_USE_CONFIG_FALLBACK = object()


class MeshError(RuntimeError):
    """Raised when Mesh cannot service a request."""

    def __init__(self, message: str, status_code: Optional[int] = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class MeshAuthError(MeshError):
    """Invalid or missing API key (401/403)."""


class MeshCreditError(MeshError):
    """Account balance exhausted — Mesh returns HTTP 402."""


@dataclass
class Completion:
    """One model's reply, plus the metadata we show in the cost panel."""

    model: str
    content: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    cached: bool = False
    used_fallback: bool = False
    error: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def ok(self) -> bool:
        return self.error is None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "model": self.model,
            "content": self.content,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "cost_usd": round(self.cost_usd, 6),
            "latency_ms": self.latency_ms,
            "cached": self.cached,
            "used_fallback": self.used_fallback,
            "error": self.error,
        }


def _extract_cost(payload: Dict[str, Any]) -> float:
    """Mesh reports spend in a few shapes depending on the route. Be liberal."""
    usage = payload.get("usage") or {}
    for key in ("cost", "cost_usd", "total_cost"):
        value = usage.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    value = payload.get("cost")
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _extract_content(payload: Dict[str, Any]) -> str:
    choices = payload.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    # Some providers return content as a list of parts.
    if isinstance(content, list):
        parts = [p.get("text", "") for p in content if isinstance(p, dict)]
        return "".join(parts).strip()
    return ""


class MeshClient:
    """Async Mesh API client. Use as an async context manager."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.api_key = api_key if api_key is not None else config.MESH_API_KEY
        self.base_url = (base_url or config.MESH_BASE_URL).rstrip("/")
        self.timeout = timeout if timeout is not None else config.REQUEST_TIMEOUT_S
        self.max_retries = (
            max_retries if max_retries is not None else config.MAX_RETRIES
        )
        self._client = client
        self._owns_client = client is None

    # -- lifecycle ---------------------------------------------------------
    async def __aenter__(self) -> "MeshClient":
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
            self._owns_client = True
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)
            self._owns_client = True
        return self._client

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": "Bearer {}".format(self.api_key),
            "Content-Type": "application/json",
            # Courtesy identification; Mesh mirrors OpenAI's optional headers.
            "X-Title": "LLM Council",
        }

    # -- core call ---------------------------------------------------------
    async def complete(
        self,
        model: str,
        messages: List[Dict[str, str]],
        max_tokens: int = 1024,
        temperature: Optional[float] = None,
        fallback_model: Any = _USE_CONFIG_FALLBACK,
    ) -> Completion:
        """Run one chat completion. Never raises for model-level failures.

        Transport/HTTP errors are retried, then the fallback model is tried, and
        only if that also fails do we return a Completion carrying `.error`.
        Auth and credit errors are raised immediately — retrying them is futile
        and the user needs to see them.

        Pass `fallback_model=None` to disable substitution entirely; omit it to
        use the configured FALLBACK_MODEL.
        """
        if not self.api_key:
            raise MeshAuthError(
                "MESH_API_KEY is not set. Add it to council-py/.env — "
                "get a key at https://meshapi.ai"
            )

        attempted_fallback = (
            config.FALLBACK_MODEL
            if fallback_model is _USE_CONFIG_FALLBACK
            else fallback_model
        )

        primary = await self._attempt(model, messages, max_tokens, temperature)
        if primary.ok or not attempted_fallback or attempted_fallback == model:
            return primary

        backup = await self._attempt(
            attempted_fallback, messages, max_tokens, temperature
        )
        if backup.ok:
            backup.used_fallback = True
            # Report under the requested seat so the UI keeps its line-up, but
            # make the substitution visible.
            backup.model = "{} (fallback: {})".format(model, attempted_fallback)
            return backup
        return primary

    async def _attempt(
        self,
        model: str,
        messages: List[Dict[str, str]],
        max_tokens: int,
        temperature: Optional[float],
    ) -> Completion:
        url = "{}/chat/completions".format(self.base_url)
        body: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": (
                temperature if temperature is not None else config.TEMPERATURE
            ),
        }

        last_error = "unknown error"
        for attempt in range(self.max_retries + 1):
            started = time.perf_counter()
            try:
                response = await self.client.post(
                    url, json=body, headers=self._headers()
                )
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = "network error: {}".format(exc)
                await self._backoff(attempt)
                continue

            latency_ms = int((time.perf_counter() - started) * 1000)

            if response.status_code in (401, 403):
                raise MeshAuthError(
                    "Mesh rejected the API key (HTTP {}). Check MESH_API_KEY.".format(
                        response.status_code
                    ),
                    response.status_code,
                )
            if response.status_code == 402:
                raise MeshCreditError(
                    "Mesh account balance is empty (HTTP 402). "
                    "Top up at https://meshapi.ai to continue.",
                    402,
                )

            if response.status_code == 429 or response.status_code >= 500:
                last_error = "HTTP {}: {}".format(
                    response.status_code, response.text[:200]
                )
                await self._backoff(attempt)
                continue

            if response.status_code >= 400:
                # 4xx other than the above (bad model id, malformed request) is
                # not worth retrying.
                return Completion(
                    model=model,
                    content="",
                    latency_ms=latency_ms,
                    error="HTTP {}: {}".format(
                        response.status_code, response.text[:300]
                    ),
                )

            try:
                payload = response.json()
            except ValueError:
                last_error = "malformed JSON from Mesh"
                await self._backoff(attempt)
                continue

            usage = payload.get("usage") or {}
            return Completion(
                model=model,
                content=_extract_content(payload),
                prompt_tokens=int(usage.get("prompt_tokens") or 0),
                completion_tokens=int(usage.get("completion_tokens") or 0),
                cost_usd=_extract_cost(payload),
                latency_ms=latency_ms,
                cached=bool(payload.get("cached") or usage.get("cached") or False),
                raw=payload,
            )

        return Completion(model=model, content="", error=last_error)

    async def _backoff(self, attempt: int) -> None:
        await asyncio.sleep(min(2 ** attempt * 0.5, 4.0))

    # -- catalogue ---------------------------------------------------------
    async def list_models(self) -> List[Dict[str, Any]]:
        """Fetch the live Mesh catalogue so the picker never goes stale."""
        if not self.api_key:
            raise MeshAuthError("MESH_API_KEY is not set.")

        url = "{}/models".format(self.base_url)
        try:
            response = await self.client.get(url, headers=self._headers())
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise MeshError("Could not reach Mesh: {}".format(exc)) from exc

        if response.status_code in (401, 403):
            raise MeshAuthError("Mesh rejected the API key.", response.status_code)
        if response.status_code >= 400:
            raise MeshError(
                "Mesh /models failed: HTTP {}".format(response.status_code),
                response.status_code,
            )

        payload = response.json()
        raw_models = payload.get("data") if isinstance(payload, dict) else payload
        models: List[Dict[str, Any]] = []
        for item in raw_models or []:
            if not isinstance(item, dict):
                continue
            model_id = item.get("id") or item.get("name")
            if not model_id:
                continue
            models.append(
                {
                    "id": model_id,
                    "name": item.get("name") or model_id,
                    "context_length": item.get("context_length")
                    or item.get("context_window")
                    or 0,
                    "owned_by": item.get("owned_by") or model_id.split("/")[0],
                }
            )
        models.sort(key=lambda m: m["id"])
        return models
