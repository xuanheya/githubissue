import { randomUUID } from "node:crypto";
import { parseIssueUrl } from "../extension/issue-url.js";
import { AppError, publicError } from "./errors.js";
import { GitHubRepo, configuredGitHubToken } from "./github.js";
import { createModel } from "./model.js";
import { analyze } from "./agent.js";

const TTL = 60 * 60 * 1000;
const validId = value => typeof value === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const fail = (code, message, status = 400) => { throw new AppError(code, message, status); };

export class Sessions {
  constructor({ modelFactory = createModel, repoFactory = url => new GitHubRepo(url, fetch, configuredGitHubToken()), now = Date.now } = {}) {
    this.modelFactory = modelFactory;
    this.repoFactory = repoFactory;
    this.now = now;
    this.rows = new Map();
    this.starts = new Map();
  }

  prune() {
    for (const [id, row] of this.rows) {
      if (row.status !== "running" && this.now() - row.touched >= TTL) {
        this.rows.delete(id);
        this.starts.delete(row.startId);
      }
    }
  }

  view(row) {
    return { sessionId: row.id, status: row.status, revision: row.revision, result: row.result,
      trace: [...row.trace], error: row.error, pendingContext: row.pendingContext };
  }

  get(id) {
    this.prune();
    const row = this.rows.get(id);
    if (!row) fail("session_expired", "会话已过期或后端已重启，请重新生成建议。", 404);
    row.touched = this.now();
    return row;
  }

  start({ issueUrl, requestId }) {
    const target = parseIssueUrl(issueUrl);
    if (!target || !validId(requestId)) fail("bad_input", "Issue 地址或请求编号无效。");
    this.prune();
    const prior = this.starts.get(requestId);
    if (prior) {
      const row = this.get(prior);
      if (row.url !== target.url) fail("request_conflict", "请求编号已绑定其他 Issue。", 409);
      return this.view(row);
    }
    if (this.rows.size >= 100) fail("capacity", "本地会话已达到上限，请稍后重试。", 429);
    const model = this.modelFactory();
    const row = { id: randomUUID(), startId: requestId, url: target.url, repo: this.repoFactory(target.url), model,
      issue: null, result: null, revision: 0, requests: new Map(), touched: this.now() };
    this.rows.set(row.id, row);
    this.starts.set(requestId, row.id);
    return this.run(row, null);
  }

  update(id, { text, requestId, baseRevision }) {
    const row = this.get(id);
    if (typeof text !== "string" || !text.trim() || text.length > 2000 || !validId(requestId) ||
        !Number.isSafeInteger(baseRevision) || baseRevision < 1) fail("bad_context", "请输入 1–2000 个字符的背景和有效版本。");
    const prior = row.requests.get(requestId);
    if (prior) {
      if (prior.text !== text.trim() || prior.baseRevision !== baseRevision) fail("request_conflict", "请求编号已用于其他更新。", 409);
      return this.view(row);
    }
    if (row.status === "running" || baseRevision !== row.revision || !row.result) fail("stale_revision", "会话正在运行或版本已更新，请刷新后重试。", 409);
    if (row.revision >= 9 || row.requests.size >= 32) fail("context_limit", "本次会话已达到补充上限，请开始新的分析。");
    row.requests.set(requestId, { text: text.trim(), baseRevision });
    return this.run(row, text.trim());
  }

  run(row, context) {
    row.status = "running";
    row.error = null;
    row.trace = [];
    row.pendingContext = context;
    // The status is visible before the first await; concurrent mutations see "running".
    row.job = (async () => {
      try {
        if (!row.issue) {
          row.issue = await row.repo.readIssue();
          row.trace.push({ tool: "read_issue", outcome: row.issue.source === "public_page" ?
            "I1 · 已从匿名可见的 GitHub Issue 网页读取标题和正文" : "I1 · 已读取标题和正文" });
        }
        const result = await analyze({ repo: row.repo, model: row.model, issue: row.issue,
          previous: row.result, context, trace: row.trace });
        const revision = row.revision + 1;
        row.result = { ...result, sessionId: row.id, revision };
        row.revision = revision;
        row.pendingContext = null;
        row.status = "ready";
      } catch (error) {
        row.error = publicError(error);
        row.status = "failed";
      } finally {
        row.touched = this.now();
      }
    })();
    return this.view(row);
  }
}
