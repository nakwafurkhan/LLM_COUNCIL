"""Code + PR mode: turn the Chairman's final implementation into a real PR.

Two halves, deliberately separated so the risky half is testable without ever
touching the network:

* `parse_file_blocks` / `validate_paths` — pure functions that turn model output
  into a set of file writes, and refuse anything that looks like an escape or a
  secret.
* `GitHubClient` — the thin REST wrapper that branches, commits and opens the PR.
"""
from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

import httpx

from . import config

# ```file path/to/thing.py
# <contents>
# ```
_FILE_BLOCK_RE = re.compile(
    r"```(?:file|FILE)[ \t]+(?P<path>[^\n`]+?)[ \t]*\n(?P<body>.*?)```",
    re.DOTALL,
)

# Paths we refuse to write no matter what the model says.
_FORBIDDEN_PATTERNS = [
    re.compile(r"(^|/)\.\.(/|$)"),          # traversal
    re.compile(r"^/"),                       # absolute
    re.compile(r"^~"),                       # home-relative
    re.compile(r"(^|/)\.git(/|$)"),          # git internals
    re.compile(r"(^|/)\.env(\.|$)"),         # secrets
    re.compile(r"(^|/)id_rsa"),
    re.compile(r"\.pem$"),
    re.compile(r"(^|/)\.ssh(/|$)"),
    re.compile(r"(^|/)node_modules(/|$)"),
]

MAX_FILES_PER_PR = 25
MAX_FILE_BYTES = 200_000


class PRError(RuntimeError):
    """Raised when a pull request cannot be prepared or created."""


@dataclass
class FileChange:
    path: str
    content: str

    def to_dict(self) -> Dict[str, str]:
        return {"path": self.path, "content": self.content}


def parse_file_blocks(text: str) -> List[FileChange]:
    """Extract ```file <path>``` blocks from model output.

    Later blocks win, so a model that revises a file mid-answer ends up with its
    final version rather than a duplicate entry.
    """
    changes: Dict[str, str] = {}
    for match in _FILE_BLOCK_RE.finditer(text or ""):
        path = match.group("path").strip().strip("`").strip()
        body = match.group("body")
        if not path:
            continue
        # Drop one trailing newline the fence adds, keep intentional blank lines.
        if body.endswith("\n"):
            body = body[:-1]
        changes[path] = body
    return [FileChange(path=p, content=c) for p, c in changes.items()]


def validate_paths(changes: Sequence[FileChange]) -> None:
    """Reject traversal, absolute paths, secrets and oversized payloads."""
    if not changes:
        raise PRError(
            "The council did not produce any file blocks. Expected fenced blocks "
            "like ```file path/to/file.py"
        )
    if len(changes) > MAX_FILES_PER_PR:
        raise PRError(
            "Refusing to open a PR touching {} files (limit {}).".format(
                len(changes), MAX_FILES_PER_PR
            )
        )
    for change in changes:
        path = change.path
        if path != path.strip() or not path:
            raise PRError("Invalid file path: {!r}".format(path))
        for pattern in _FORBIDDEN_PATTERNS:
            if pattern.search(path):
                raise PRError("Refusing to write to protected path: {}".format(path))
        if len(change.content.encode("utf-8")) > MAX_FILE_BYTES:
            raise PRError(
                "File {} is larger than the {} byte limit.".format(
                    path, MAX_FILE_BYTES
                )
            )


def slugify_branch(text: str, prefix: str = "council") -> str:
    """Build a safe, readable branch name from a change request."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "").lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)[:40].strip("-") or "change"
    return "{}/{}".format(prefix, slug)


def build_pr_body(
    request: str,
    summary: str,
    changes: Sequence[FileChange],
    models: Sequence[str],
    chairman: str,
    leaderboard: Optional[Sequence[Dict[str, Any]]] = None,
) -> str:
    """Compose a PR description that says how the change was produced."""
    lines: List[str] = []
    lines.append("## Change request")
    lines.append("")
    lines.append(request.strip() or "_(none given)_")
    lines.append("")
    lines.append("## Implementation")
    lines.append("")
    lines.append(summary.strip() or "_(no prose summary returned)_")
    lines.append("")
    lines.append("## Files changed")
    lines.append("")
    for change in changes:
        lines.append("- `{}`".format(change.path))
    lines.append("")
    lines.append("## How this was produced")
    lines.append("")
    lines.append(
        "Drafted by an LLM Council running on [Mesh API](https://meshapi.ai): "
        "each member proposed an implementation independently, the members "
        "peer-reviewed each other's proposals with authorship hidden, and the "
        "chairman merged the result."
    )
    lines.append("")
    lines.append("- **Council:** {}".format(", ".join(models) or "n/a"))
    lines.append("- **Chairman:** {}".format(chairman))
    if leaderboard:
        lines.append("- **Peer ranking:**")
        for row in leaderboard:
            lines.append(
                "  {}. `{}` — {} points".format(
                    row.get("position"), row.get("model"), row.get("points")
                )
            )
    lines.append("")
    lines.append("> Machine-drafted. Review before merging.")
    return "\n".join(lines)


def strip_file_blocks(text: str) -> str:
    """The prose part of the chairman's answer, without the file bodies."""
    return _FILE_BLOCK_RE.sub("", text or "").strip()


class GitHubClient:
    """Minimal GitHub REST client for the branch → commit → PR flow."""

    def __init__(
        self,
        token: Optional[str] = None,
        api_url: Optional[str] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.token = token or config.GITHUB_TOKEN
        self.api_url = (api_url or config.GITHUB_API_URL).rstrip("/")
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> "GitHubClient":
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=60.0)
            self._owns_client = True
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=60.0)
            self._owns_client = True
        return self._client

    def _headers(self) -> Dict[str, str]:
        if not self.token:
            raise PRError(
                "GITHUB_TOKEN is not set. Add a token with `repo` scope to "
                "council-py/.env to enable Code + PR mode."
            )
        return {
            "Authorization": "Bearer {}".format(self.token),
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def _request(
        self, method: str, path: str, **kwargs: Any
    ) -> httpx.Response:
        url = "{}{}".format(self.api_url, path)
        response = await self.client.request(
            method, url, headers=self._headers(), **kwargs
        )
        if response.status_code == 401:
            raise PRError("GitHub rejected the token (401). Check GITHUB_TOKEN.")
        if response.status_code == 403:
            raise PRError(
                "GitHub returned 403. The token likely lacks `repo` scope, or you "
                "hit a rate limit."
            )
        if response.status_code == 404:
            raise PRError(
                "GitHub returned 404 for {}. Check the owner/repo and that the "
                "token can see it.".format(path)
            )
        return response

    async def get_default_branch(self, owner: str, repo: str) -> str:
        response = await self._request("GET", "/repos/{}/{}".format(owner, repo))
        if response.status_code >= 400:
            raise PRError("Could not read repo: HTTP {}".format(response.status_code))
        return response.json().get("default_branch", "main")

    async def get_branch_sha(self, owner: str, repo: str, branch: str) -> str:
        response = await self._request(
            "GET", "/repos/{}/{}/git/ref/heads/{}".format(owner, repo, branch)
        )
        if response.status_code >= 400:
            raise PRError(
                "Could not resolve branch {!r}: HTTP {}".format(
                    branch, response.status_code
                )
            )
        return response.json()["object"]["sha"]

    async def create_branch(
        self, owner: str, repo: str, branch: str, from_sha: str
    ) -> None:
        response = await self._request(
            "POST",
            "/repos/{}/{}/git/refs".format(owner, repo),
            json={"ref": "refs/heads/{}".format(branch), "sha": from_sha},
        )
        if response.status_code == 422:
            # Already exists — fine, we'll commit onto it.
            return
        if response.status_code >= 400:
            raise PRError(
                "Could not create branch {}: HTTP {} {}".format(
                    branch, response.status_code, response.text[:200]
                )
            )

    async def get_file_sha(
        self, owner: str, repo: str, path: str, branch: str
    ) -> Optional[str]:
        url = "/repos/{}/{}/contents/{}".format(owner, repo, path.lstrip("/"))
        response = await self.client.request(
            "GET", "{}{}".format(self.api_url, url), headers=self._headers(),
            params={"ref": branch},
        )
        if response.status_code == 200:
            payload = response.json()
            if isinstance(payload, dict):
                return payload.get("sha")
        return None

    async def put_file(
        self,
        owner: str,
        repo: str,
        branch: str,
        change: FileChange,
        message: str,
    ) -> None:
        existing_sha = await self.get_file_sha(owner, repo, change.path, branch)
        body: Dict[str, Any] = {
            "message": message,
            "content": base64.b64encode(change.content.encode("utf-8")).decode("ascii"),
            "branch": branch,
        }
        if existing_sha:
            body["sha"] = existing_sha
        response = await self._request(
            "PUT",
            "/repos/{}/{}/contents/{}".format(owner, repo, change.path.lstrip("/")),
            json=body,
        )
        if response.status_code >= 400:
            raise PRError(
                "Could not commit {}: HTTP {} {}".format(
                    change.path, response.status_code, response.text[:200]
                )
            )

    async def create_pull_request(
        self,
        owner: str,
        repo: str,
        title: str,
        head: str,
        base: str,
        body: str,
        draft: bool = False,
    ) -> Dict[str, Any]:
        response = await self._request(
            "POST",
            "/repos/{}/{}/pulls".format(owner, repo),
            json={
                "title": title,
                "head": head,
                "base": base,
                "body": body,
                "draft": draft,
            },
        )
        if response.status_code >= 400:
            raise PRError(
                "Could not open PR: HTTP {} {}".format(
                    response.status_code, response.text[:300]
                )
            )
        return response.json()

    async def open_pr_with_changes(
        self,
        owner: str,
        repo: str,
        branch: str,
        title: str,
        body: str,
        changes: Sequence[FileChange],
        base: Optional[str] = None,
        draft: bool = False,
    ) -> Dict[str, Any]:
        """Branch, commit each file, then open the PR."""
        validate_paths(changes)
        base_branch = base or await self.get_default_branch(owner, repo)
        base_sha = await self.get_branch_sha(owner, repo, base_branch)
        await self.create_branch(owner, repo, branch, base_sha)
        for change in changes:
            await self.put_file(
                owner,
                repo,
                branch,
                change,
                message="council: update {}".format(change.path),
            )
        pr = await self.create_pull_request(
            owner, repo, title, branch, base_branch, body, draft=draft
        )
        return {
            "number": pr.get("number"),
            "url": pr.get("html_url"),
            "branch": branch,
            "base": base_branch,
            "files": [c.path for c in changes],
        }
