#!/usr/bin/env bash
# Start the backend and frontend together. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and add your Mesh key:"
  echo "    cp .env.example .env"
  exit 1
fi

PORT="${PORT:-8001}"

cleanup() { jobs -p | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "→ backend  http://127.0.0.1:${PORT}"
python3 -m uvicorn backend.main:app --host 127.0.0.1 --port "${PORT}" &

if [ ! -d frontend/node_modules ]; then
  echo "→ installing frontend deps (first run)"
  (cd frontend && npm install)
fi

echo "→ frontend http://localhost:5174"
(cd frontend && npm run dev) &

wait
