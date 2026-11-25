import hashlib
import os
import re
import time
from datetime import timezone
from email.utils import parsedate_to_datetime
from fnmatch import fnmatchcase
from functools import lru_cache
from pathlib import PurePosixPath
from urllib.parse import quote, urlsplit

import httpx
from bs4 import BeautifulSoup
from dotenv import dotenv_values

from .common import ROOT, Problem, bounded, read_json

SHA = re.compile(r"[a-f0-9]{40}")
ISSUE = re.compile(r"/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)/issues/([1-9][0-9]{0,14})/?")
TEXT = set(
    "js jsx ts tsx mjs cjs mts cts py pyi java kt go rs rb c cpp cc h hpp cs swift php scala sh lua vue svelte css html md mdx rst txt toml yaml yml json xml sql ex exs dart".split()
)
SKIP = {".git", "node_modules", "vendor", "dist", "build", ".venv", "__pycache__"}
FILE_BYTES = 384 * 1024
COOLDOWNS = {}


def issue_url(raw):
    try:
        u = urlsplit(raw)
        match = ISSUE.fullmatch(u.path)
        if (
            len(raw) <= 2048
            and u.scheme == "https"
            and u.netloc.lower() in ("github.com", "github.com:443")
            and match
        ):
            owner, repo, number = match.groups()
            if repo not in (".", ".."):
                return f"https://github.com/{owner}/{repo}/issues/{number}"
    except (ValueError, TypeError, AttributeError):
        pass
    raise Problem("bad_input", "请输入公开 GitHub 仓库的 Issue 详情页地址。")


def matches(path, pattern):
    parts = pattern.split("/")
    if any(p in ("", ".", "..") for p in parts) or "\\" in pattern or ":" in pattern:
        raise Problem("bad_glob", "请使用仓库内相对路径模式，如 **/*stream*.py。")
    path_parts = path.split("/")

    @lru_cache(None)
    def match(i, j):
        if j == len(parts):
            return i == len(path_parts)
        if parts[j] == "**":
            return match(i, j + 1) or (i < len(path_parts) and match(i + 1, j))
        return i < len(path_parts) and fnmatchcase(path_parts[i], parts[j]) and match(i + 1, j + 1)

    return match(0, 0)


def readable(row):
    p = PurePosixPath(row["path"])
    return (
        row.get("type") == "blob"
        and row.get("mode") in {"100644", "100755"}
        and SHA.fullmatch(row.get("sha", ""))
        and 0 <= row.get("size", FILE_BYTES + 1) <= FILE_BYTES
        and not p.is_absolute()
        and ".." not in p.parts
        and not SKIP.intersection(p.parts)
        and not p.name.endswith((".min.js", "lock.json"))
        and (
            p.suffix.lower()[1:] in TEXT or p.name.lower() in {"readme", "license", "makefile", "dockerfile"}
        )
    )


class Repository:
    def __init__(self, url, client, token=None):
        self.url = issue_url(url)
        self.owner, self.repo, _, self.number = urlsplit(self.url).path.strip("/").split("/")
        self.slug = self.owner + "/" + self.repo
        self.client = client
        self.token = (
            (dotenv_values(ROOT / ".env").get("GITHUB_TOKEN") or os.getenv("GITHUB_TOKEN", ""))
            if token is None
            else token
        )
        self.quota_key = hashlib.sha256(self.token.encode()).digest()
        self.commit, self.files, self.truncated = None, {}, False
        self.seen, self.cache = set(), {}
        self.cache_size = 0

    @property
    def limited(self):
        return COOLDOWNS.get(self.quota_key, 0) > time.time()

    def api(self, suffix, limit):
        if self.limited:
            raise Problem("github_limited", "GitHub API 配额暂不可用。", 503)
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "local-issue-advisor"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        with self.client.stream(
            "GET", "https://api.github.com/repos/" + self.slug + suffix, headers=headers
        ) as r:
            exhausted = r.headers.get("x-ratelimit-remaining") == "0"
            retry = r.headers.get("retry-after", "")
            denied = r.status_code == 403
            limited = r.status_code == 429 or (
                denied and (exhausted or retry or b"rate limit" in bounded(r, 16000).lower())
            )
            if limited or (r.is_success and exhausted):
                now = time.time()
                try:
                    after = now + int(retry)
                except ValueError:
                    try:
                        after = parsedate_to_datetime(retry).astimezone(timezone.utc).timestamp()
                    except (ValueError, TypeError, OverflowError):
                        after = 0
                reset = r.headers.get("x-ratelimit-reset", "")
                until = max(int(reset) if reset.isdigit() else 0, after)
                COOLDOWNS[self.quota_key] = until if until > now else now + 60
            if limited:
                raise Problem("github_limited", "GitHub API 已限流。", 503)
            if r.status_code in (401, 403, 404):
                code, msg = {
                    401: ("github_auth", "GitHub 凭证无效或已过期。"),
                    403: ("github_forbidden", "GitHub 拒绝读取此资源。"),
                    404: ("github_missing", "GitHub 资源不存在或无法公开访问。"),
                }[r.status_code]
                raise Problem(code, msg, r.status_code)
            if not r.is_success:
                raise Problem("github_error", f"GitHub 读取失败（HTTP {r.status_code}）。", 502)
            return read_json(bounded(r, limit))

    def get(self, path, limit):
        if self.token:
            info = self.api("", 100000)
            if (
                info.get("private") is not False
                or info.get("visibility") != "public"
                or info.get("full_name", "").lower() != self.slug.lower()
            ):
                raise Problem("public_only", "仅支持当前公开仓库。", 403)
        return self.api("/" + path, limit)

    def read_issue(self):
        try:
            row = self.get("issues/" + self.number, 1000000)
            if "pull_request" in row:
                raise Problem("is_pr", "请选择 Issue，当前编号属于 Pull Request。")
            if issue_url(row.get("html_url", "")).lower() != self.url.lower() or not isinstance(
                row.get("title"), str
            ):
                raise Problem("issue_mismatch", "返回的 Issue 与当前页面不一致。", 502)
            source = "github_api"
        except Problem as e:
            if e.code != "github_limited":
                raise
            row, source = self.public_page(), "public_page"
        body = row.get("body") or ""
        return dict(
            title=row["title"], url=self.url, body=body[:16000], truncated=len(body) > 16000, source=source
        )

    def public_page(self):
        try:
            with self.client.stream("GET", self.url, headers={"Accept": "text/html"}) as r:
                if r.status_code != 200 or not r.headers.get("content-type", "").startswith("text/html"):
                    raise ValueError
                page = BeautifulSoup(bounded(r, 5000000), "html.parser")
            tag = page.select_one('script[type="application/json"][data-target="react-app.embeddedData"]')
            row = read_json(tag.string)["payload"]["issueViewerRoute"]["data"]["repository"]["issue"]
            if (
                row["__isIssueOrPullRequest"] != "Issue"
                or row["repository"]["isPrivate"] is not False
                or row["repository"]["nameWithOwner"].lower() != self.slug.lower()
                or str(row["number"]) != self.number
                or issue_url(row["url"]).lower() != self.url.lower()
                or not row["title"].strip()
                or not isinstance(row["body"], str)
            ):
                raise ValueError
            return row
        except (ValueError, TypeError, AttributeError, KeyError, httpx.HTTPError, Problem):
            raise Problem("public_page_unavailable", "限流后无法从公开页面确认 Issue。", 503) from None

    def index(self):
        if self.commit:
            return
        head = self.get("commits/HEAD", 6000000)
        commit, tree = head["sha"], head["commit"]["tree"]["sha"]
        if not SHA.fullmatch(commit) or not SHA.fullmatch(tree):
            raise Problem("invalid_tree", "无法确认仓库快照。", 502)
        listing = self.get(f"git/trees/{tree}?recursive=1", 16000000)
        files = [r for r in listing["tree"] if readable(r)]
        self.files = {f"F{i}": row["path"] for i, row in enumerate(files, 1)}
        self.commit, self.truncated = commit, bool(listing.get("truncated"))

    def candidates(self, pattern):
        self.index()
        return [(fid, path) for fid, path in self.files.items() if matches(path, pattern)]

    def glob(self, pattern):
        rows = self.candidates(pattern)
        selected = rows[:32]
        self.seen.update(fid for fid, _ in selected)
        return dict(
            files=[dict(fileId=f, path=p) for f, p in selected],
            total=len(rows),
            truncated=self.truncated or len(rows) > len(selected),
            commit=self.commit,
        )

    def lines(self, fid):
        if fid in self.cache:
            return self.cache[fid]
        path = quote(self.files[fid], safe="/")
        url = f"https://raw.githubusercontent.com/{self.slug}/{self.commit}/{path}"
        # Fetch immutable public text without the GitHub token. Never follow a redirect.
        with self.client.stream("GET", url) as r:
            if r.status_code != 200:
                raise Problem("unreadable", f"读取公开快照失败（HTTP {r.status_code}）。", 502)
            data = bounded(r, FILE_BYTES)
        try:
            if b"\0" in data:
                raise ValueError
            lines = data.decode("utf-8-sig").splitlines()
        except ValueError:
            raise Problem("unreadable", "文件不是 UTF-8 文本。") from None
        if self.cache_size + len(data) <= 4_000_000:
            self.cache[fid] = lines
            self.cache_size += len(data)
        return lines

    def grep(self, text, path_glob):
        rows = self.candidates(path_glob)
        hits, scanned, failed = [], 0, 0
        for fid, path in rows[:16]:
            scanned += 1
            try:
                lines = self.lines(fid)
            except Problem as exc:
                if exc.code not in {"unreadable", "payload_limit"}:
                    raise
                failed += 1
                continue
            for number, line in enumerate(lines, 1):
                at = line.find(text)
                if at >= 0:
                    self.seen.add(fid)
                    hits.append(
                        dict(
                            fileId=fid,
                            path=path,
                            line=number,
                            match=line[max(0, at - 60) : at + len(text) + 60],
                        )
                    )
                    if len(hits) == 12:
                        break
            if len(hits) == 12:
                break
        return dict(
            hits=hits,
            scanned=scanned,
            candidates=len(rows),
            unreadable=failed,
            truncated=self.truncated or scanned < len(rows) or bool(failed) or len(hits) == 12,
        )

    def read_file(self, file_id, start_line, end_line):
        if file_id not in self.seen:
            raise Problem("unknown_file", "请使用 glob 或 grep 已返回的文件 ID。")
        if end_line < start_line or end_line - start_line >= 80:
            raise Problem("line_range", "单次读取 1–80 行，请检查起止行。")
        lines = self.lines(file_id)
        if start_line > len(lines):
            raise Problem("line_range", f"文件共 {len(lines)} 行，起始行超出范围。")
        path = self.files[file_id]
        end = min(end_line, len(lines))
        excerpt = "\n".join(lines[start_line - 1 : end])
        if len(excerpt) > 12000:
            raise Problem("line_range", "片段过长，请缩小行号范围。")
        return dict(
            path=path,
            firstLine=start_line,
            lastLine=end,
            excerpt=excerpt,
            url=f"https://github.com/{self.slug}/blob/{self.commit}/{quote(path, safe='/')}#L{start_line}-L{end}",
        )
