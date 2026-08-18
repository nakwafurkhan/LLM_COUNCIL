#!/usr/bin/env bash
# Start backend + frontend together. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env found. Create one first:"
  echo "    cp .env.example .env     # then add your MESH_API_KEY"
  exit 1
fi

# Resolve ONE interpreter and use it for everything. Having pip install into one
# Python while `python3` points at another (conda vs system vs Xcode) is the most
# common way this fails to start, so it is settled here instead of per-command.
PY="${PYTHON:-$(command -v python || command -v python3)}"
PORT="${PORT:-8000}"

if ! "$PY" -c "import fastapi" >/dev/null 2>&1; then
  echo "Dependencies are missing for: $PY"
  echo "Install them with the SAME interpreter:"
  echo "    $PY -m pip install -r requirements.txt"
  exit 1
fi

cleanup() { jobs -p | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "→ backend   http://127.0.0.1:${PORT}"
"$PY" -m uvicorn backend.main:app --host 127.0.0.1 --port "${PORT}" &

if [ ! -d frontend/node_modules ]; then
  echo "→ installing frontend dependencies (first run only)"
  (cd frontend && npm install)
fi

echo "→ frontend  http://localhost:5173"
(cd frontend && npm run dev) &

wait
