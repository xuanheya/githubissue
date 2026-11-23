import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, PORT } from "../server/index.js";
import { withExtension, waitRevision } from "../scripts/browser.js";
import { AppError } from "../server/errors.js";
import { call, fixtureRepo, issue, makeSessions, turns } from "./helpers.js";

let failOnce = true, hold = false, release;
let signalHold;
const enteredHold = new Promise(resolve => { signalHold = resolve; });
const markup = "<img src=x onerror='window.injectionRan=true'>";
const sessions = makeSessions({ repoFactory: url => {
  const repo = fixtureRepo(url);
  if (url.endsWith("/8")) repo.readIssue = async () => ({ title: markup, url, body: issue.body });
  return repo;
}, modelFactory: () => async messages => {
  if (hold) await new Promise(resolve => { release = resolve; signalHold(); });
  if (!JSON.parse(messages[1].content).newContextId) return call("submit_analysis", turns.first);
  if (failOnce) { failOnce = false; throw new AppError("model_network", "测试中的模型超时"); }
  return call("submit_analysis", turns.second);
} });
const server = createServer(sessions);
server.listen(PORT, "127.0.0.1");
await once(server, "listening");
try {
  await withExtension(async browser => {
    await browser.route("https://github.com/**", route => route.fulfill({
      contentType: "text/html", body: "<!doctype html><title>Issue Advisor browser test</title><main>Extension integration fixture</main>"
    }));
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(issue.url.replace("/7", ""));
    const host = page.locator("#github-issue-advisor");
    assert.equal(await host.count(), 0);
    const navigate = path => page.evaluate(path => history.pushState({}, "", path), path);
    await navigate(issue.url);
    await host.getByRole("button", { name: "生成处理建议" }).click();
    await waitRevision(host, 1);
    assert.equal(await host.getByRole("link", { name: issue.title, exact: true }).getAttribute("href"), issue.url);
    assert.equal(await host.getByRole("heading", { name: "待澄清信息" }).count(), 1);
    const id = [...sessions.rows.keys()][0];
    await host.getByLabel("补充背景").fill(issue.context);
    await host.getByRole("button", { name: "更新建议" }).click();
    await host.getByText("测试中的模型超时").waitFor();
    assert.equal(await host.getByLabel("补充背景").inputValue(), issue.context);
    assert.equal(await host.getByText(turns.first.summary).count(), 1);
    await host.getByRole("button", { name: "更新建议" }).click();
    await waitRevision(host, 2);
    assert.equal(sessions.rows.size, 1);
    assert.equal(sessions.get(id).revision, 2);
    assert.equal(await host.getByText(turns.second.changes[0].description).count(), 1);
    await page.reload();
    await waitRevision(host, 2);
    assert.equal(await host.getByLabel("补充背景").inputValue(), "");
    await host.locator("summary").click();
    assert.equal(await host.getByText("submit_analysis", { exact: true }).count(), 1);
    await navigate(issue.url.replace("/7", "/8"));
    await host.getByRole("button", { name: "生成处理建议" }).waitFor();
    assert.equal(await host.getByText(turns.second.summary).count(), 0);
    hold = true;
    await host.getByRole("button", { name: "生成处理建议" }).click();
    await host.getByText("正在分析 Issue…").waitFor();
    await enteredHold;
    await navigate(issue.url);
    await waitRevision(host, 2);
    hold = false;
    release();
    const second = [...sessions.rows.values()].find(row => row.url.endsWith("/8"));
    await second.job;
    assert.equal(await host.getByText(turns.second.summary).count(), 1);
    await navigate(issue.url.replace("/7", "/8"));
    await waitRevision(host, 1);
    assert.equal(await host.getByRole("link", { name: markup, exact: true }).count(), 1);
    assert.equal(await host.locator("img").count(), 0);
    assert.equal(await page.evaluate(() => window.injectionRan), undefined);
    await navigate("/example/terminal-demo/pull/7");
    assert.equal(await host.count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS · MV3 extension loaded; SPA entry; first analysis; failed update/retry; same session v2; reload; Issue isolation; PR exclusion.");
  });
} finally {
  release?.();
  await new Promise(resolve => server.close(resolve));
}
