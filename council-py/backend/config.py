"""Configuration for the LLM Council (Mesh API edition).

Everything here can be overridden with environment variables so you never have
to edit code to change the council line-up.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List

from dotenv import load_dotenv

# Load .env from the project root (council-py/.env), regardless of CWD.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def _csv_env(name: str, default: List[str]) -> List[str]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# Mesh API
# ---------------------------------------------------------------------------
# Mesh is OpenAI-compatible: same request/response shapes, different base URL.
MESH_BASE_URL = os.getenv("MESH_BASE_URL", "https://api.meshapi.ai/v1").rstrip("/")
MESH_API_KEY = os.getenv("MESH_API_KEY", "")

# ---------------------------------------------------------------------------
# The council
# ---------------------------------------------------------------------------
# Keep this small by default. A full run costs roughly (2 * N) + 1 completions:
# every member answers, every member reviews, then the chairman synthesises.
COUNCIL_MODELS: List[str] = _csv_env(
    "COUNCIL_MODELS",
    [
        "openai/gpt-4o",
        "anthropic/claude-sonnet-4.5",
        "google/gemini-2.5-pro",
    ],
)

CHAIRMAN_MODEL = os.getenv("CHAIRMAN_MODEL", "anthropic/claude-sonnet-4.5")

# If a council member errors out or times out, Mesh-side retries are attempted
# first; this model is the last-resort stand-in so one dead provider does not
# sink the whole run.
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "openai/gpt-4o-mini")

# ---------------------------------------------------------------------------
# Limits — these exist to stop a curiosity click burning credits.
# ---------------------------------------------------------------------------
MAX_TOKENS_STAGE1 = _int_env("MAX_TOKENS_STAGE1", 1200)
MAX_TOKENS_STAGE2 = _int_env("MAX_TOKENS_STAGE2", 800)
MAX_TOKENS_STAGE3 = _int_env("MAX_TOKENS_STAGE3", 2000)
MAX_TOKENS_CODE = _int_env("MAX_TOKENS_CODE", 4000)

TEMPERATURE = _float_env("TEMPERATURE", 0.7)
REQUEST_TIMEOUT_S = _float_env("REQUEST_TIMEOUT_S", 120.0)
MAX_RETRIES = _int_env("MAX_RETRIES", 2)

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
DATA_DIR = Path(os.getenv("DATA_DIR", str(PROJECT_ROOT / "data" / "conversations")))

# ---------------------------------------------------------------------------
# GitHub (for Code + PR mode)
# ---------------------------------------------------------------------------
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GITHUB_API_URL = os.getenv("GITHUB_API_URL", "https://api.github.com").rstrip("/")
GITHUB_DEFAULT_OWNER = os.getenv("GITHUB_DEFAULT_OWNER", "")
GITHUB_DEFAULT_REPO = os.getenv("GITHUB_DEFAULT_REPO", "")

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
HOST = os.getenv("HOST", "127.0.0.1")
PORT = _int_env("PORT", 8001)
CORS_ORIGINS: List[str] = _csv_env(
    "CORS_ORIGINS", ["http://localhost:5174", "http://127.0.0.1:5174"]
)


def summary() -> dict:
    """Non-secret config snapshot for the frontend."""
    return {
        "mesh_base_url": MESH_BASE_URL,
        "mesh_key_configured": bool(MESH_API_KEY),
        "council_models": COUNCIL_MODELS,
        "chairman_model": CHAIRMAN_MODEL,
        "fallback_model": FALLBACK_MODEL,
        "github_configured": bool(GITHUB_TOKEN),
        "github_default_repo": (
            f"{GITHUB_DEFAULT_OWNER}/{GITHUB_DEFAULT_REPO}"
            if GITHUB_DEFAULT_OWNER and GITHUB_DEFAULT_REPO
            else ""
        ),
    }
