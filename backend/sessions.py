import asyncio
import logging
import time
from dataclasses import dataclass, field
from uuid import uuid4

import httpx

from .agent import DeepSeekModel, analyze
from .common import Problem, settings
from .github import Repository, issue_url


@dataclass
class Session:
    url: str
    start_id: str
    repo: Repository
    model_factory: object
    id: str = field(default_factory=lambda: str(uuid4()))
    history: list = field(default_factory=list)
    requests: dict = field(default_factory=dict)
    touched: float = field(default_factory=time.monotonic)
    status: str = "running"
    issue: dict | None = None
    error: dict | None = None
    pending: str | None = None
    trace: list = field(default_factory=list)
    job: asyncio.Task | None = None

    def view(self):
        return dict(
            sessionId=self.id,
            status=self.status,
            revision=len(self.history),
            result=self.history[-1] if self.history else None,
            error=self.error,
            pendingContext=self.pending,
            trace=list(self.trace),
        )


class Sessions:
    """Row admission and revision commits run on one asyncio event loop."""

    def __init__(self, client=None, repo_factory=None, make_model=None):
        self.client = client or httpx.Client(
            timeout=12,
            follow_redirects=False,
            event_hooks={"request": [lambda req: req.headers.pop("cookie", None)]},
        )
        self.repo_factory = repo_factory or (lambda url: Repository(url, self.client))
        self.make_model = make_model or self.configured_model
        self.rows, self.starts = {}, {}

    def configured_model(self):
        config = settings()
        return lambda env: DeepSeekModel(self.client, config, env)

    def prune(self):
        for sid, row in list(self.rows.items()):
            if row.status != "running" and time.monotonic() - row.touched >= 3600:
                del self.rows[sid], self.starts[row.start_id]

    def get(self, sid):
        self.prune()
        if sid not in self.rows:
            raise Problem("session_expired", "会话已过期或后端已重启，请重新生成建议。", 404)
        row = self.rows[sid]
        row.touched = time.monotonic()
        return row

    def start(self, url, request_id):
        url = issue_url(url)
        self.prune()
        if request_id in self.starts:
            row = self.get(self.starts[request_id])
            if row.url != url:
                raise Problem("request_conflict", "请求号已绑定其他 Issue。", 409)
            return row.view()
        if len(self.rows) >= 100:
            raise Problem("capacity", "本地会话已满。", 429)
        row = Session(url, request_id, self.repo_factory(url), self.make_model())
        self.starts[request_id] = row.id
        self.rows[row.id] = row
        return self.schedule(row, None)

    def update(self, sid, text, base, rid):
        row = self.get(sid)
        if rid in row.requests:
            if row.requests[rid] != (text, base):
                raise Problem("request_conflict", "请求号已用于其他更新。", 409)
            return row.view()
        if row.status == "running" or base != len(row.history):
            raise Problem("stale_revision", "版本已更新或正在运行，请刷新后重试。", 409)
        if len(row.history) >= 9 or len(row.requests) >= 32:
            raise Problem("context_limit", "已达到单会话补充上限。")
        row.requests[rid] = (text, base)
        return self.schedule(row, text)

    def schedule(self, row, context):
        row.trace, row.error, row.pending, row.status = [], None, context, "running"
        row.job = asyncio.create_task(self.run(row))
        return row.view()

    async def run(self, row):
        try:
            if row.issue is None:
                row.issue = await asyncio.to_thread(row.repo.read_issue)
                row.trace.append(dict(tool="read_issue", outcome="I1 · " + row.issue["source"]))
            previous = row.history[-1] if row.history else None
            used = {h["id"] for report in row.history for h in report["hypotheses"]}
            report = await asyncio.to_thread(
                analyze, row.repo, row.issue, previous, row.pending, row.trace, row.model_factory, used
            )
            row.history.append(dict(**report, sessionId=row.id, revision=len(row.history) + 1))
            row.pending, row.status = None, "ready"
        except Exception as e:
            if isinstance(e, Problem):
                row.error = e.public()
            elif isinstance(e, httpx.HTTPError):
                row.error = Problem("github_network", "连接 GitHub 失败或超时。", 502).public()
            else:
                logging.getLogger(__name__).error("Analysis failed: %s", type(e).__name__)
                row.error = Problem("internal_error", "分析失败，请重试。", 500).public()
            row.status = "failed"
        finally:
            row.touched = time.monotonic()
