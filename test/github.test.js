import test from "node:test";
import assert from "node:assert/strict";
import { GitHubRepo } from "../server/github.js";
import { parseIssueUrl } from "../extension/issue-url.js";
import { issue } from "./helpers.js";

const commit = "a".repeat(40), tree = "b".repeat(40), blob = "c".repeat(40);
const body = "line one\nline two\nif stream.isatty():\n    use_color()";
function transport(index = {}) {
  const calls = [];
  const map = {
    "issues/7": { title: issue.title, body: issue.body, html_url: issue.url },
    "commits/HEAD": { sha: commit, commit: { tree: { sha: tree } } },
    [`git/trees/${tree}?recursive=1`]: { tree: [
      { path: "src/term.py", mode: "100644", type: "blob", size: body.length, sha: blob },
      { path: "term-link.py", mode: "120000", type: "blob", size: 10, sha: blob },
      { path: "term.bin", mode: "100644", type: "blob", size: 10, sha: blob }
    ], truncated: true },
    [`git/blobs/${blob}`]: { size: body.length, encoding: "base64", content: Buffer.from(body).toString("base64") }, ...index
  };
  const fetcher = async (url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, undefined);
    const prefix = "https://api.github.com/repos/example/terminal-demo/";
    assert.ok(url.startsWith(prefix));
    const path = url.slice(prefix.length);
    calls.push(path);
    const row = map[path];
    if (row instanceof Response) return row;
    assert.ok(row, "unexpected route: " + path);
    return Response.json(row);
  };
  return { repo: new GitHubRepo(issue.url, fetcher), calls };
}
test("validates Issue-only page URLs on both sides", () => {
  for (const url of ["https://github.com/a/b/pull/1", "https://evil.invalid/a/b/issues/1",
    "https://github.com:999/a/b/issues/1", "https://user@github.com/a/b/issues/1", "https://github.com/a/b/issues/new"]) {
    assert.equal(parseIssueUrl(url), null);
  }
  assert.equal(parseIssueUrl(issue.url + "?query=1#ref").url, issue.url);
});
test("snapshot is pinned, tree is reused, symlinks are excluded, links resolve to actual lines", async () => {
  const { repo, calls } = transport();
  assert.equal((await repo.readIssue()).title, issue.title);
  const hits = await repo.search(["term"]);
  assert.equal(hits.files.length, 1);
  assert.equal(hits.treeTruncated, true);
  assert.equal((await repo.search(["no-match"])).files.length, 0);
  assert.equal(calls.filter(p => p === "commits/HEAD").length, 1);
  const record = await repo.excerpt(hits.files[0].fileId, "isatty");
  assert.equal(record.excerpt, body);
  assert.ok(record.url.endsWith(commit + "/src/term.py#L1-L4"));
  assert.equal((await repo.excerpt(hits.files[0].fileId, "absent")).found, false);
  const n = calls.length;
  await assert.rejects(repo.excerpt("https://evil.invalid/key", ""), { code: "unknown_file" });
  assert.equal(calls.length, n);
});
test("PR, inaccessible issues and mismatched pages fail without trying the public page", async () => {
  for (const [row, code] of [
    [{ pull_request: {} }, "is_pr"], [new Response("", { status: 404 }), "github_missing"],
    [Response.json({ message: "Forbidden" }, { status: 403 }), "github_forbidden"], [{ html_url: issue.url + "1" }, "issue_mismatch"]
  ]) await assert.rejects(transport({ "issues/7": row }).repo.readIssue(), { code });
});

function limitedTransport(status, overrides = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    if (url.startsWith("https://api.github.com/")) return Response.json({ message: "Rate limit exceeded" },
      { status, headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } });
    assert.equal(url, issue.url);
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, undefined);
    const githubIssue = { title: issue.title, body: issue.body, url, number: 7, __isIssueOrPullRequest: "Issue",
      repository: { isPrivate: false, nameWithOwner: "example/terminal-demo" }, timelineItems: [{ body: "comment" }], ...overrides };
    const data = { payload: { issueViewerRoute: { data: { repository: { issue: githubIssue } } } } };
    const html = '<script type="application/json" data-target="react-app.embeddedData">' + JSON.stringify(data) + '</script>';
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  return { fetcher, calls };
}

test("403 exhaustion and 429 use only anonymous public Issue data; later sessions respect cooldown", async () => {
  for (const status of [403, 429]) {
    const { fetcher, calls } = limitedTransport(status);
    const repo = new GitHubRepo(issue.url, fetcher);
    const result = await repo.readIssue();
    assert.deepEqual([result.title, result.body, result.source], [issue.title, issue.body, "public_page"]);
    assert.equal(repo.apiLimited, true);
    await assert.rejects(repo.search(["readme"]), { code: "github_limited" });
    await new GitHubRepo(issue.url, fetcher).readIssue();
    assert.deepEqual(calls, ["https://api.github.com/repos/example/terminal-demo/issues/7", issue.url, issue.url]);
  }
});

test("fallback fails closed for a different issue, private repository or PR", async () => {
  for (const change of [{ number: 8 }, { url: issue.url + "9" }, { repository: { isPrivate: true } },
    { __isIssueOrPullRequest: "PullRequest" }, { body: null }]) {
    const { fetcher } = limitedTransport(429, change);
    await assert.rejects(new GitHubRepo(issue.url, fetcher).readIssue(), { code: "public_page_unavailable" });
  }
});
test("body is bounded without executing links or markdown", async () => {
  const { repo, calls } = transport({ "issues/7": { html_url: issue.url, title: "Issue", body: "x".repeat(16200) } });
  assert.equal((await repo.readIssue()).body.length, 16000);
  assert.equal((await repo.readIssue()).truncated, true);
  assert.deepEqual(calls, ["issues/7", "issues/7"]);
});

const publicInfo = { full_name: "example/terminal-demo", private: false, visibility: "public" };
const apiBase = "https://api.github.com/repos/example/terminal-demo";
test("authenticated Issue and repository tools use GET and check public visibility before each read", async () => {
  const calls = [];
  const token = "fixture-only";
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer " + token);
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "GET");
    calls.push(url);
    if (url === apiBase) return Response.json(publicInfo);
    if (url === apiBase + "/issues/7") return Response.json({ html_url: issue.url, title: issue.title, body: issue.body });
    if (url === apiBase + "/commits/HEAD") return Response.json({ sha: commit, commit: { tree: { sha: tree } } });
    if (url === apiBase + "/git/trees/" + tree + "?recursive=1") return Response.json({ tree: [
      { path: "src/term.py", type: "blob", mode: "100644", size: 1, sha: blob }
    ] });
    assert.equal(url, apiBase + "/git/blobs/" + blob);
    return Response.json({ size: 1, encoding: "base64", content: "YQ==" });
  };
  const repo = new GitHubRepo(issue.url, fetcher, token);
  const snapshot = await repo.readIssue();
  const hits = await repo.search(["term"]);
  const evidence = await repo.excerpt(hits.files[0].fileId, "");
  assert.equal(evidence.excerpt, "a");
  assert.deepEqual(calls.filter((_v, i) => i % 2 === 0), Array(4).fill(apiBase));
  assert.ok(!JSON.stringify([snapshot, hits, evidence]).includes(token));
});

test("broad or invalid credentials cannot open private, internal or mismatched repositories", async () => {
  for (const [response, code] of [
    [Response.json({ ...publicInfo, private: true }), "public_only"],
    [Response.json({ ...publicInfo, visibility: "internal" }), "public_only"],
    [Response.json({ ...publicInfo, full_name: "elsewhere/demo" }), "public_only"],
    [new Response("server-side details", { status: 401 }), "github_auth"]
  ]) {
    let calls = 0;
    const repo = new GitHubRepo(issue.url, async url => { calls++; assert.equal(url, apiBase); return response; }, "fixture-only");
    await assert.rejects(repo.readIssue(), e => e.code === code && !e.message.includes("fixture-only"));
    assert.equal(calls, 1);
  }
});

test("token cooldown is separate from anonymous quota and public HTML never carries the token", async () => {
  const fallback = limitedTransport(429);
  const fetcher = async (url, opts) => {
    if (opts.headers.Authorization === "Bearer working-fixture") {
      return Response.json(url === apiBase ? publicInfo : { title: issue.title, body: issue.body, html_url: issue.url });
    }
    return fallback.fetcher(url, opts);
  };
  assert.equal((await new GitHubRepo(issue.url, fetcher).readIssue()).source, "public_page");
  assert.equal((await new GitHubRepo(issue.url, fetcher, "working-fixture").readIssue()).source, "github_api");
  assert.equal((await new GitHubRepo(issue.url, fetcher, "limited-fixture").readIssue()).source, "public_page");
});
test("a match far into a long line remains visible in the cited excerpt", async () => {
  const content = "x".repeat(900) + "target_symbol" + "y".repeat(900);
  const { repo } = transport({ [`git/blobs/${blob}`]: {
    encoding: "base64", size: content.length, content: Buffer.from(content).toString("base64")
  } });
  const hits = await repo.search(["term"]);
  const hit = await repo.excerpt(hits.files[0].fileId, "target_symbol");
  assert.match(hit.excerpt, /target_symbol/);
  assert.ok(hit.excerpt.length <= 280);
  assert.equal(hit.firstLine, 1);
  assert.equal(hit.lastLine, 1);
});
