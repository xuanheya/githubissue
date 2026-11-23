import { parseDocument, DomUtils } from "htmlparser2";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { AppError, readJson, readText } from "./errors.js";
import { parseIssueUrl } from "../extension/issue-url.js";

const SHA = /^[a-f0-9]{40}$/i;
const FILE_BYTES = 384 * 1024;
const ISSUE_CHARS = 16000;
// Track cooldowns per transport and credential, without retaining raw token keys.
const resetTimes = new WeakMap();
const textPath = /(?:\.(?:[cm]?[jt]sx?|pyi?|go|rs|java|kt|c|cpp|cc|h|hpp|cs|rb|php|swift|scala|sh|lua|vue|svelte|css|html|mdx?|rst|txt|toml|ya?ml|json|xml|sql|exs?|dart)|(?:^|\/)(?:readme|makefile|dockerfile|license))$/i;
const skipPath = /(?:^|\/)(?:node_modules|vendor|dist|build|\.git)(?:\/|$)|(?:\.min\.[cm]?js|lock\.json)$/i;

export function configuredGitHubToken() {
  // Re-read the optional entry for new sessions so a local demo can be configured while running.
  try {
    const values = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
    if ("GITHUB_TOKEN" in values) return values.GITHUB_TOKEN.trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw new AppError("github_config", "无法读取项目的 .env 配置。", 503);
  }
  return process.env.GITHUB_TOKEN?.trim() || "";
}

export class GitHubRepo {
  #token;
  #quotaKey;
  constructor(issueUrl, fetcher = fetch, token = "") {
    this.target = parseIssueUrl(issueUrl);
    if (!this.target) throw new AppError("invalid_issue", "请打开一个 github.com 公开仓库的 Issue 详情页。");
    this.fetcher = fetcher;
    this.#token = token;
    this.#quotaKey = token ? createHash("sha256").update(token).digest("hex") : "anonymous";
    if (!resetTimes.has(fetcher)) resetTimes.set(fetcher, new Map());
    this.index = null;
    this.byId = new Map();
  }

  get apiLimited() {
    return (resetTimes.get(this.fetcher).get(this.#quotaKey) ?? 0) > Date.now();
  }

  async get(suffix, maxBytes = 1_000_000) {
    // A token may have wider permissions than this product. Check visibility before every authenticated content read.
    if (this.#token) {
      const info = await this.#api("", 100_000);
      const name = this.target.owner + "/" + this.target.repo;
      if (info.private !== false || info.visibility !== "public" || info.full_name?.toLowerCase() !== name.toLowerCase()) {
        throw new AppError("public_only", "此插件仅支持公开仓库。", 403);
      }
    }
    return this.#api("/" + suffix, maxBytes);
  }

  async #api(path, maxBytes) {
    const limited = () => new AppError("github_limited", "GitHub API 配额暂不可用，已暂停仓库检索。", 503);
    if (this.apiLimited) throw limited();
    const { owner, repo } = this.target;
    const url = `https://api.github.com/repos/${owner}/${repo}${path}`;
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "local-issue-advisor", "X-GitHub-Api-Version": "2022-11-28" };
    if (this.#token) headers.Authorization = "Bearer " + this.#token;
    try {
      const res = await this.fetcher(url, { method: "GET", redirect: "error", headers,
        signal: AbortSignal.timeout(12000) });
      const exhausted = res.headers.get("x-ratelimit-remaining") === "0";
      const retry = res.headers.get("retry-after");
      let rateLimited = res.status === 429;
      if (res.status === 403) {
        rateLimited = exhausted || retry !== null;
        if (!rateLimited) {
          const message = await readJson(res.body, 16000).catch(() => ({}));
          rateLimited = /rate limit/i.test(message?.message ?? "");
        }
        if (!rateLimited) throw new AppError("github_forbidden", "GitHub 拒绝读取此资源。", 403);
      }
      if (rateLimited || (res.ok && exhausted)) {
        const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
        const retryAt = retry && Number.isFinite(Number(retry)) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
        const until = Math.max(reset || 0, retryAt || 0);
        resetTimes.get(this.fetcher).set(this.#quotaKey, until > Date.now() ? until : Date.now() + 60000);
      }
      if (rateLimited) {
        if (!res.bodyUsed) await res.body?.cancel();
        throw limited();
      }
      if (res.status === 401 && this.#token) throw new AppError("github_auth", "GitHub 令牌无效或已过期，请更新本地 GITHUB_TOKEN 后重新分析。", 401);
      if (res.status === 404) throw new AppError("github_missing", "GitHub 资源不存在或无法公开访问。", 404);
      if (!res.ok) throw new AppError("github_error", `GitHub 读取失败（HTTP ${res.status}）。`, 502);
      return await readJson(res.body, maxBytes);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("github_network", "无法连接 GitHub API 或请求超时。", 502);
    }
  }

  async readIssue() {
    let row;
    try { row = await this.get(`issues/${this.target.number}`); }
    catch (error) {
      if (error.code !== "github_limited") throw error;
      return this.readPublicIssue();
    }
    if (row.pull_request) throw new AppError("is_pr", "这个编号属于 Pull Request，请选择 Issue。");
    const actual = parseIssueUrl(row.html_url);
    if (actual?.url.toLowerCase() !== this.target.url.toLowerCase() || typeof row.title !== "string") {
      throw new AppError("issue_mismatch", "GitHub 返回的 Issue 与当前页面不一致。", 502);
    }
    return this.snapshot(row.title, actual.url, row.body ?? "", "github_api");
  }

  snapshot(title, url, body, source) {
    return { title, url, body: body.slice(0, ISSUE_CHARS), truncated: body.length > ISSUE_CHARS, source };
  }

  async readPublicIssue() {
    // Use the canonical Issue page without browser cookies, credentials or redirects.
    const unavailable = () => new AppError("public_page_unavailable", "GitHub API 已限流，公开页面也未能提供这条 Issue 的标题和正文。", 503);
    try {
      const res = await this.fetcher(this.target.url, { method: "GET", redirect: "error", credentials: "omit",
        headers: { Accept: "text/html", "User-Agent": "local-issue-advisor" }, signal: AbortSignal.timeout(12000) });
      if (!res.ok || !res.headers.get("content-type")?.startsWith("text/html")) throw unavailable();
      const page = parseDocument(await readText(res.body, 5_000_000));
      const script = DomUtils.findOne(node => node.name === "script" && node.attribs.type === "application/json" &&
        node.attribs["data-target"] === "react-app.embeddedData", page.children);
      const data = script && JSON.parse(DomUtils.textContent(script));
      const issue = data?.payload?.issueViewerRoute?.data?.repository?.issue;
      const { owner, repo, number, url } = this.target;
      if (issue?.__isIssueOrPullRequest !== "Issue" || issue.repository?.isPrivate !== false ||
          issue.repository?.nameWithOwner?.toLowerCase() !== (owner + "/" + repo).toLowerCase() ||
          String(issue.number) !== number || parseIssueUrl(issue.url)?.url.toLowerCase() !== url.toLowerCase() ||
          typeof issue.title !== "string" || !issue.title.trim() || typeof issue.body !== "string") throw unavailable();
      return this.snapshot(issue.title, url, issue.body, "public_page");
    } catch { throw unavailable(); }
  }

  async loadIndex() {
    if (this.index) return this.index;
    const head = await this.get("commits/HEAD", 6_000_000);
    const tree = head.commit?.tree?.sha;
    if (!SHA.test(head.sha) || !SHA.test(tree)) throw new AppError("invalid_tree", "无法确认仓库快照。", 502);
    const listing = await this.get(`git/trees/${tree}?recursive=1`, 16_000_000);
    const files = listing.tree.filter(item =>
      item.type === "blob" && ["100644", "100755"].includes(item.mode) && SHA.test(item.sha) &&
      item.size <= FILE_BYTES && textPath.test(item.path) && !skipPath.test(item.path));
    this.index = { commit: head.sha, files, truncated: Boolean(listing.truncated) };
    return this.index;
  }

  async search(terms) {
    const index = await this.loadIndex();
    const words = [...new Set(terms.map(term => term.trim().toLowerCase()))];
    const hits = index.files.map((file, i) => {
      const path = file.path.toLowerCase();
      const name = path.split("/").at(-1);
      const score = words.reduce((n, word) => n + (path.includes(word) ? 1 : 0) + (name.includes(word) ? 2 : 0), 0);
      return { file, id: `F${i + 1}`, score };
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
    const files = hits.slice(0, 8).map(({ file, id }) => {
      this.byId.set(id, file);
      return { fileId: id, path: file.path };
    });
    return { scope: "path", commit: index.commit, treeTruncated: index.truncated, totalMatches: hits.length, files };
  }

  async excerpt(id, anchor) {
    const file = this.byId.get(id);
    if (!file) throw new AppError("unknown_file", "仅可读取本次会话中搜索工具返回的 fileId。");
    const blob = await this.get(`git/blobs/${file.sha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string" || blob.size > FILE_BYTES) {
      throw new AppError("unreadable", "文件不是可读取的小型文本。");
    }
    const bytes = Buffer.from(blob.content, "base64");
    if (bytes.length > FILE_BYTES || bytes.includes(0)) throw new AppError("unreadable", "文件超出文本限制。");
    const lines = bytes.toString("utf8").split(/\r?\n/);
    const needle = anchor.toLowerCase();
    const at = needle ? lines.findIndex(line => line.toLowerCase().includes(needle)) : 0;
    if (at < 0) return { found: false, path: file.path };
    const first = Math.max(0, at - 8);
    const snippet = [];
    let size = 0;
    for (let i = first; i < Math.min(lines.length, first + 80); i++) {
      const raw = lines[i];
      const offset = i === at && needle ? Math.max(0, raw.toLowerCase().indexOf(needle) - 45) : 0;
      const start = raw.length > 280 ? Math.min(offset, raw.length - 278) : 0;
      const line = raw.length <= 280 ? raw :
        (start ? "…" : "") + raw.slice(start, start + 278) + (start + 278 < raw.length ? "…" : "");
      if (size + line.length + 1 > 4000) break;
      snippet.push(line);
      size += line.length + 1;
    }
    const last = first + snippet.length;
    const path = file.path.split("/").map(encodeURIComponent).join("/");
    const { owner, repo } = this.target;
    return { found: true, path: file.path, firstLine: first + 1, lastLine: last,
      excerpt: snippet.join("\n"), url: `https://github.com/${owner}/${repo}/blob/${this.index.commit}/${path}#L${first + 1}-L${last}` };
  }
}
