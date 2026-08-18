"""A stand-in Mesh API for local smoke tests. NOT part of the shipped app.

Serves the two OpenAI-compatible routes the council uses, so you can exercise
the whole stack without spending credits:

    python3 fake_mesh.py &
    MESH_API_KEY=rsk_fake MESH_BASE_URL=http://127.0.0.1:8899/v1 \
        python3 -m uvicorn backend.main:app --port 8001
"""
from __future__ import annotations

import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

MODELS = [
    {"id": "openai/gpt-4o", "context_length": 128000},
    {"id": "anthropic/claude-sonnet-4.5", "context_length": 200000},
    {"id": "google/gemini-2.5-pro", "context_length": 1000000},
    {"id": "openai/gpt-4o-mini", "context_length": 128000},
]


CODE_REPLY = (
    "Adds a retry helper with exponential backoff.\n\n"
    "```file src/retry.py\n"
    "import time\n\n\n"
    "def retry(fn, attempts=3, base=0.5):\n"
    "    for i in range(attempts):\n"
    "        try:\n"
    "            return fn()\n"
    "        except Exception:\n"
    "            if i == attempts - 1:\n"
    "                raise\n"
    "            time.sleep(base * 2 ** i)\n"
    "```\n"
)


def _reply_for(system: str, model: str) -> str:
    if "reads like a person wrote it" in system:
        return (
            "We shipped the new dashboard today. It loads in under a second, and "
            "the filters finally stick between sessions."
        )
    if "terse assistant" in system:
        return "Rayleigh scattering — blue light scatters most."

    # Code mode is detected the same way the real models see it: the system
    # prompt asks for ```file blocks.
    if "```file" in system or "FINAL implementation" in system:
        return CODE_REPLY
    if "Rank EVERY response" in system:
        return json.dumps(
            {
                "rankings": [
                    {"label": "Response A", "rank": 1, "reason": "most concrete"},
                    {"label": "Response B", "rank": 2, "reason": "solid but thin"},
                    {"label": "Response C", "rank": 3, "reason": "hand-wavy"},
                ]
            }
        )
    if "Chairman" in system:
        return (
            "## Final answer\n\nSunlight scatters off air molecules, and short "
            "(blue) wavelengths scatter far more than long ones — Rayleigh "
            "scattering. Your eye therefore receives blue from every direction.\n"
        )
    return "As {}, I'd say: shorter wavelengths scatter more strongly.".format(model)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/").endswith("/models"):
            self._json(200, {"data": MODELS})
        else:
            self._json(404, {"error": "not found"})

    def _stream(self, text: str, model: str) -> None:
        """Emit an OpenAI-compatible SSE stream, a few words at a time."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        words = text.split(" ")
        for index in range(0, len(words), 3):
            chunk = " ".join(words[index : index + 3])
            if index + 3 < len(words):
                chunk += " "
            frame = {
                "model": model,
                "choices": [{"delta": {"content": chunk}}],
            }
            self.wfile.write("data: {}\n\n".format(json.dumps(frame)).encode())
            self.wfile.flush()
            time.sleep(0.02)

        usage = {
            "model": model,
            "choices": [{"delta": {}}],
            "usage": {
                "prompt_tokens": 120,
                "completion_tokens": 80,
                "cost": 0.0012,
            },
        }
        self.wfile.write("data: {}\n\n".format(json.dumps(usage)).encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        messages = payload.get("messages") or []
        system = messages[0].get("content", "") if messages else ""
        model = payload.get("model", "unknown")

        if not (self.headers.get("Authorization") or "").startswith("Bearer "):
            self._json(401, {"error": "missing key"})
            return

        if payload.get("stream"):
            self._stream(_reply_for(system, model), model)
            return

        self._json(
            200,
            {
                "id": "cmpl_fake",
                "model": model,
                "choices": [
                    {"message": {"role": "assistant", "content": _reply_for(system, model)}}
                ],
                "usage": {
                    "prompt_tokens": 120,
                    "completion_tokens": 80,
                    "cost": 0.0012,
                },
            },
        )

    def log_message(self, *args) -> None:  # keep test output clean
        return


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8899), Handler).serve_forever()
