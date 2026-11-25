import json

import httpx
import pytest

from backend.common import Problem
from backend.github import COOLDOWNS, Repository, issue_url
from .fixtures import COMMIT, FILES, ISSUE, URL, github_request


@pytest.fixture(autouse=True)
def reset():
    COOLDOWNS.clear()
    yield
    COOLDOWNS.clear()


def repo(handler, token=""):
    return Repository(URL, httpx.Client(transport=httpx.MockTransport(handler)), token)


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/a/b/issues/7",
        "https://other.test/a/b/issues/7",
        "https://github.com:999/a/b/issues/7",
        "https://name@github.com/a/b/issues/7",
        "https://github.com/a/../issues/7",
        URL.replace("/issues/", "/pull/"),
        URL.replace("/7", "/new"),
    ],
)
def test_url(url):
    with pytest.raises(Problem):
        issue_url(url)
    assert issue_url(URL + "?a=b#x") == URL


def test_visibility_cache_pinning_and_limits():
    calls = []

    def handler(req):
        calls.append((str(req.url), req.headers.get("Authorization")))
        assert req.method == "GET"
        return github_request(req)

    r = repo(handler, "fake")
    assert r.read_issue()["title"] == ISSUE["title"]
    assert len(r.glob("**/*.ts")["files"]) == 2
    hit = r.grep("target", "**/*.txt")["hits"][0]
    f = r.read_file(hit["fileId"], 1, 1)
    assert f["url"].endswith(COMMIT + "/src/long.txt#L1-L1") and "target" in f["excerpt"]
    assert [u for u, _ in calls if "commits/HEAD" in u].__len__() == 1
    for i, (u, token) in enumerate(calls):
        if "api.github" in u:
            assert token == "Bearer fake"
            if not u.endswith("/repos/example/csv"):
                assert calls[i - 1][0].endswith("/repos/example/csv")
        else:
            assert token is None
    for args in [("not_seen", 1, 2), (hit["fileId"], 2, 2), (hit["fileId"], 1, 81)]:
        with pytest.raises(Problem):
            r.read_file(*args)
    with pytest.raises(Problem):
        r.glob("../*")


@pytest.mark.parametrize(
    "info",
    [
        {"private": True},
        {"private": False, "visibility": "internal"},
        {"private": False, "visibility": "public", "full_name": "elsewhere/repo"},
    ],
)
def test_deny_broad_token(info):
    def handler(req):
        assert req.url.path == "/repos/example/csv"
        return httpx.Response(200, json=info)

    with pytest.raises(Problem) as exc:
        repo(handler, "token").read_issue()
    assert exc.value.code == "public_only"


@pytest.mark.parametrize(
    "status,change,code",
    [
        (200, {"pull_request": {}}, "is_pr"),
        (404, {}, "github_missing"),
        (200, {"html_url": URL + "1"}, "issue_mismatch"),
        (401, {}, "github_auth"),
        (403, {}, "github_forbidden"),
    ],
)
def test_no_html_fallback(status, change, code):
    def handler(req):
        assert req.url.host == "api.github.com"
        return httpx.Response(status, json={**ISSUE, **change})

    with pytest.raises(Problem) as e:
        repo(handler).read_issue()
    assert e.value.code == code


def html(change):
    row = dict(
        title=ISSUE["title"],
        body="reported",
        url=URL,
        number=7,
        __isIssueOrPullRequest="Issue",
        repository=dict(isPrivate=False, nameWithOwner="example/csv"),
    )
    row.update(change)
    data = {"payload": {"issueViewerRoute": {"data": {"repository": {"issue": row}}}}}
    return (
        '<script type="application/json" data-target="react-app.embeddedData">'
        + json.dumps(data)
        + "</script>"
    )


@pytest.mark.parametrize("status", [403, 429])
def test_cooldown_and_public_fallback(status):
    calls = []

    def handler(req):
        calls.append(req)
        if req.url.host == "api.github.com":
            return httpx.Response(
                status, headers={"x-ratelimit-remaining": "0", "retry-after": "60"}, json={}
            )
        assert str(req.url) == URL and "authorization" not in req.headers
        return httpx.Response(200, text=html({}), headers={"content-type": "text/html"})

    assert repo(handler, "fake").read_issue()["source"] == "public_page"
    assert repo(handler, "fake").read_issue()["body"] == "reported"
    assert len(calls) == 3 and not repo(handler).limited


@pytest.mark.parametrize(
    "change",
    [
        {"number": 8},
        {"url": URL + "1"},
        {"body": None},
        {"repository": {"isPrivate": True}},
        {"__isIssueOrPullRequest": "PullRequest"},
    ],
)
def test_bad_public_fallback(change):
    def handler(req):
        if req.url.host == "api.github.com":
            return httpx.Response(429)
        return httpx.Response(200, text=html(change), headers={"content-type": "text/html"})

    with pytest.raises(Problem) as e:
        repo(handler).read_issue()
    assert e.value.code == "public_page_unavailable"


def test_truncation_and_scan_coverage(monkeypatch):
    def long_body(req):
        return httpx.Response(200, json={**ISSUE, "body": "x" * 18000})

    issue = repo(long_body).read_issue()
    assert issue["truncated"] and len(issue["body"]) == 16000
    for i in range(20):
        monkeypatch.setitem(FILES, f"sample{i}.ts", "data")
    out = repo(github_request).grep("absent", "**/*.ts")
    assert out["scanned"] == 16 and out["truncated"] and out["candidates"] > 16
