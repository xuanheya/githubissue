import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { once } from "node:events";
import { withExtension, waitRevision } from "../scripts/browser.js";

const issue = { url: "https://github.com/example/csv/issues/7", title: "CSV 导出后中文乱码", context: "只有 Excel 乱码。" };
const summary = "需要比较应用的导出编码与读取环境。";
const change = "结合用户环境调整检查顺序。";
const markup = "<img src=x onerror='window.injectionRan=true'>";
const server = spawn("uv", ["run", "--locked", "python", "-m", "tests.browser_fixture"], { stdio: ["ignore", "pipe", "inherit"] });
const exited = once(server, "exit");
const lines = createInterface({ input: server.stdout });
try {
  const first = await lines[Symbol.asyncIterator]().next();
  if (first.done) throw new Error("Python fixture did not start");
  const { port } = JSON.parse(first.value);
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
    await host.getByLabel("补充背景").fill(issue.context);
    await host.getByRole("button", { name: "更新建议" }).click();
    await host.getByText("测试中的模型超时").waitFor();
    assert.equal(await host.getByLabel("补充背景").inputValue(), issue.context);
    assert.equal(await host.getByText(summary).count(), 1);
    await host.getByRole("button", { name: "更新建议" }).click();
    await waitRevision(host, 2);
    assert.equal(await host.getByText(change).count(), 1);
    await page.reload();
    await waitRevision(host, 2);
    assert.equal(await host.getByLabel("补充背景").inputValue(), "");
    await host.getByText("调查范围与工具记录", { exact: true }).click();
    assert.equal(await host.getByText("submit_analysis", { exact: true }).count(), 1);
    await navigate(issue.url.replace("/7", "/8"));
    await host.getByRole("button", { name: "生成处理建议" }).waitFor();
    assert.equal(await host.getByText(change).count(), 0);
    await host.getByRole("button", { name: "生成处理建议" }).click();
    await host.getByText("正在分析 Issue…").waitFor();
    await navigate(issue.url);
    await waitRevision(host, 2);
    assert.equal(await host.getByText(change).count(), 1);
    await navigate(issue.url.replace("/7", "/8"));
    await waitRevision(host, 1);
    assert.equal(await host.getByRole("link", { name: markup, exact: true }).count(), 1);
    assert.equal(await host.locator("img").count(), 0);
    assert.equal(await page.evaluate(() => window.injectionRan), undefined);
    await navigate("/example/terminal-demo/pull/7");
    assert.equal(await host.count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS · MV3 extension loaded; SPA entry; first analysis; failed update/retry; same session v2; reload; Issue isolation; PR exclusion.");
  }, port);
} finally {
  lines.close();
  server.kill("SIGTERM");
  await exited;
}
