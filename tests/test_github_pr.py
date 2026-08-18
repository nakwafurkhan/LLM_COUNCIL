"""Code + PR mode. The parser and the guard rails matter most: model output is
untrusted input, and this code has write access to a repository."""
from __future__ import annotations

import base64

import httpx
import pytest

from backend import github_pr
from backend.github_pr import FileChange, PRError

SAMPLE = """Here is the change: we memoise the fetch.

```file src/api/fetch.py
import functools


@functools.lru_cache(maxsize=64)
def fetch(url):
    return _get(url)
```

And a test:

```file tests/test_fetch.py
def test_fetch_is_cached():
    assert fetch("u") is fetch("u")
```
"""


def test_parses_multiple_file_blocks():
    changes = github_pr.parse_file_blocks(SAMPLE)
    assert [c.path for c in changes] == ["src/api/fetch.py", "tests/test_fetch.py"]
    assert changes[0].content.startswith("import functools")
    assert changes[0].content.endswith("return _get(url)")


def test_prose_summary_excludes_file_bodies():
    summary = github_pr.strip_file_blocks(SAMPLE)
    assert "memoise the fetch" in summary
    assert "lru_cache" not in summary


def test_later_block_wins_for_same_path():
    text = "```file a.py\nfirst\n```\n```file a.py\nsecond\n```"
    changes = github_pr.parse_file_blocks(text)
    assert len(changes) == 1
    assert changes[0].content == "second"


def test_no_blocks_returns_empty():
    assert github_pr.parse_file_blocks("just prose, no code") == []


def test_validate_rejects_empty_change_set():
    with pytest.raises(PRError) as excinfo:
        github_pr.validate_paths([])
    assert "```file" in str(excinfo.value)


@pytest.mark.parametrize(
    "path",
    [
        "../outside.py",
        "a/../../etc/passwd",
        "/etc/passwd",
        "~/.bashrc",
        ".git/config",
        "src/.git/hooks/pre-commit",
        ".env",
        ".env.production",
        "deploy/id_rsa",
        "certs/server.pem",
        ".ssh/authorized_keys",
        "node_modules/left-pad/index.js",
    ],
)
def test_validate_rejects_dangerous_paths(path):
    with pytest.raises(PRError):
        github_pr.validate_paths([FileChange(path=path, content="x")])


def test_validate_accepts_ordinary_paths():
    github_pr.validate_paths(
        [
            FileChange(path="src/app.py", content="x"),
            FileChange(path="docs/README.md", content="y"),
            FileChange(path="council-py/backend/main.py", content="z"),
        ]
    )


def test_validate_rejects_too_many_files():
    changes = [
        FileChange(path="f{}.py".format(i), content="x")
        for i in range(github_pr.MAX_FILES_PER_PR + 1)
    ]
    with pytest.raises(PRError) as excinfo:
        github_pr.validate_paths(changes)
    assert "limit" in str(excinfo.value)


def test_validate_rejects_oversized_file():
    big = "x" * (github_pr.MAX_FILE_BYTES + 1)
    with pytest.raises(PRError):
        github_pr.validate_paths([FileChange(path="big.txt", content=big)])


def test_slugify_branch_is_safe_and_readable():
    branch = github_pr.slugify_branch("Add rate limiting to the /api/v1 upload route!")
    assert branch.startswith("council/")
    assert " " not in branch
    assert "//" not in branch[len("council/") :]
    assert len(branch) <= len("council/") + 40


def test_slugify_branch_handles_junk_input():
    assert github_pr.slugify_branch("!!!") == "council/change"
    assert github_pr.slugify_branch("") == "council/change"


def test_pr_body_documents_provenance():
    body = github_pr.build_pr_body(
        request="Add caching",
        summary="Memoised the fetch helper.",
        changes=[FileChange(path="src/api/fetch.py", content="x")],
        models=["openai/gpt-4o", "anthropic/claude-sonnet-4.5"],
        chairman="anthropic/claude-sonnet-4.5",
        leaderboard=[{"position": 1, "model": "openai/gpt-4o", "points": 6}],
    )
    assert "Add caching" in body
    assert "`src/api/fetch.py`" in body
    assert "Mesh API" in body
    assert "openai/gpt-4o" in body
    assert "Review before merging" in body


# ---------------------------------------------------------------------------
# REST flow
# ---------------------------------------------------------------------------


def _gh(handler, token="ghp_test"):
    return github_pr.GitHubClient(
        token=token, client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )


@pytest.mark.asyncio
async def test_missing_token_raises_before_any_request():
    async def handler(request):  # pragma: no cover
        raise AssertionError("should not be called")

    client = _gh(handler, token="")
    with pytest.raises(PRError) as excinfo:
        await client.get_default_branch("o", "r")
    assert "GITHUB_TOKEN" in str(excinfo.value)


@pytest.mark.asyncio
async def test_full_pr_flow_branches_commits_and_opens():
    seen = {"puts": [], "created_branch": None, "pr": None}

    async def handler(request):
        path = request.url.path
        if request.method == "GET" and path == "/repos/o/r":
            return httpx.Response(200, json={"default_branch": "main"})
        if request.method == "GET" and path == "/repos/o/r/git/ref/heads/main":
            return httpx.Response(200, json={"object": {"sha": "basesha"}})
        if request.method == "POST" and path == "/repos/o/r/git/refs":
            import json as _json

            seen["created_branch"] = _json.loads(request.content)
            return httpx.Response(201, json={})
        if request.method == "GET" and path.startswith("/repos/o/r/contents/"):
            return httpx.Response(404, json={})
        if request.method == "PUT" and path.startswith("/repos/o/r/contents/"):
            import json as _json

            body = _json.loads(request.content)
            seen["puts"].append((path, body))
            return httpx.Response(201, json={"content": {"sha": "newsha"}})
        if request.method == "POST" and path == "/repos/o/r/pulls":
            import json as _json

            seen["pr"] = _json.loads(request.content)
            return httpx.Response(
                201, json={"number": 7, "html_url": "https://github.com/o/r/pull/7"}
            )
        raise AssertionError("unexpected {} {}".format(request.method, path))

    changes = [
        FileChange(path="src/a.py", content="print('a')"),
        FileChange(path="src/b.py", content="print('b')"),
    ]
    async with _gh(handler) as client:
        result = await client.open_pr_with_changes(
            owner="o",
            repo="r",
            branch="council/add-thing",
            title="council: add thing",
            body="body text",
            changes=changes,
        )

    assert result["number"] == 7
    assert result["url"] == "https://github.com/o/r/pull/7"
    assert result["base"] == "main"
    assert result["files"] == ["src/a.py", "src/b.py"]

    assert seen["created_branch"]["ref"] == "refs/heads/council/add-thing"
    assert seen["created_branch"]["sha"] == "basesha"

    assert len(seen["puts"]) == 2
    first_put = seen["puts"][0][1]
    assert base64.b64decode(first_put["content"]).decode() == "print('a')"
    assert first_put["branch"] == "council/add-thing"
    assert "sha" not in first_put  # new file, no blob sha

    assert seen["pr"]["head"] == "council/add-thing"
    assert seen["pr"]["base"] == "main"


@pytest.mark.asyncio
async def test_existing_file_is_updated_with_its_sha():
    puts = []

    async def handler(request):
        path = request.url.path
        if request.method == "GET" and path == "/repos/o/r":
            return httpx.Response(200, json={"default_branch": "main"})
        if request.method == "GET" and path == "/repos/o/r/git/ref/heads/main":
            return httpx.Response(200, json={"object": {"sha": "basesha"}})
        if request.method == "POST" and path == "/repos/o/r/git/refs":
            return httpx.Response(201, json={})
        if request.method == "GET" and path.startswith("/repos/o/r/contents/"):
            return httpx.Response(200, json={"sha": "existing123"})
        if request.method == "PUT":
            import json as _json

            puts.append(_json.loads(request.content))
            return httpx.Response(200, json={})
        if request.method == "POST" and path == "/repos/o/r/pulls":
            return httpx.Response(201, json={"number": 1, "html_url": "u"})
        raise AssertionError(path)

    async with _gh(handler) as client:
        await client.open_pr_with_changes(
            owner="o",
            repo="r",
            branch="b",
            title="t",
            body="b",
            changes=[FileChange(path="existing.py", content="new")],
        )

    assert puts[0]["sha"] == "existing123"


@pytest.mark.asyncio
async def test_existing_branch_is_reused_not_fatal():
    async def handler(request):
        path = request.url.path
        if request.method == "GET" and path == "/repos/o/r":
            return httpx.Response(200, json={"default_branch": "main"})
        if request.method == "GET" and path == "/repos/o/r/git/ref/heads/main":
            return httpx.Response(200, json={"object": {"sha": "s"}})
        if request.method == "POST" and path == "/repos/o/r/git/refs":
            return httpx.Response(422, json={"message": "Reference already exists"})
        if request.method == "GET" and path.startswith("/repos/o/r/contents/"):
            return httpx.Response(404, json={})
        if request.method == "PUT":
            return httpx.Response(201, json={})
        if request.method == "POST" and path == "/repos/o/r/pulls":
            return httpx.Response(201, json={"number": 2, "html_url": "u2"})
        raise AssertionError(path)

    async with _gh(handler) as client:
        result = await client.open_pr_with_changes(
            owner="o",
            repo="r",
            branch="existing",
            title="t",
            body="b",
            changes=[FileChange(path="a.py", content="x")],
        )
    assert result["number"] == 2


@pytest.mark.asyncio
async def test_dangerous_path_is_rejected_before_any_network_call():
    async def handler(request):  # pragma: no cover
        raise AssertionError("must not touch GitHub")

    async with _gh(handler) as client:
        with pytest.raises(PRError):
            await client.open_pr_with_changes(
                owner="o",
                repo="r",
                branch="b",
                title="t",
                body="b",
                changes=[FileChange(path="../../etc/passwd", content="x")],
            )


@pytest.mark.asyncio
async def test_404_gives_actionable_message():
    async def handler(request):
        return httpx.Response(404, json={"message": "Not Found"})

    async with _gh(handler) as client:
        with pytest.raises(PRError) as excinfo:
            await client.get_default_branch("o", "missing")
    assert "owner/repo" in str(excinfo.value)


@pytest.mark.asyncio
async def test_bad_token_gives_actionable_message():
    async def handler(request):
        return httpx.Response(401, json={"message": "Bad credentials"})

    async with _gh(handler) as client:
        with pytest.raises(PRError) as excinfo:
            await client.get_default_branch("o", "r")
    assert "GITHUB_TOKEN" in str(excinfo.value)
