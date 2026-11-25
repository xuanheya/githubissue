import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { withExtension, waitRevision, extensionId, PORT } from "./browser.js";

const sparse = process.argv.includes("--sparse");
const url = "https://github.com/AsyncFuncAI/deepwiki-open/issues/" + (sparse ? "613" : "585");
const contextText = "我这次失败的请求已持续输出了非空文本，最后一条模型事件注明达到输出长度上限，传给解析器的文本缺少 </wiki_structure>。";
const directory = resolve("demo-output");
const base = `http://127.0.0.1:${PORT}`;
const headers = { "X-Issue-Advisor": extensionId };
async function readSession(id) {
  const res = await fetch(base + "/sessions/" + id, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error("无法读取验收会话，HTTP " + res.status);
  return res.json();
}

try {
  // Check reachability before launching Chrome. The random session should be missing.
  const probe = await fetch(base + "/sessions/" + crypto.randomUUID(), { headers, signal: AbortSignal.timeout(3000) });
  if ((await probe.json()).error?.code !== "session_expired") throw new Error("端口与本项目服务不匹配。");
  await withExtension(async (browser, worker) => {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const panel = page.locator("#github-issue-advisor");
    await panel.getByRole("button", { name: "生成处理建议" }).click();
    await waitRevision(panel, 1);
    const sessionId = await worker.evaluate(async () => {
      const slots = Object.values(await chrome.storage.session.get(null));
      return slots.find(slot => slot.sessionId)?.sessionId;
    });
    const before = await readSession(sessionId);
    if (before.revision !== 1 || before.result?.issue.url !== url) throw new Error("首版结果与演示 Issue 不匹配。");
    await mkdir(directory, { recursive: true });
    await panel.locator("aside").screenshot({ path: join(directory, sparse ? "sparse.png" : "revision-1.png") });
    if (sparse) {
      if (!before.result.clarifications.length) throw new Error("缺少澄清问题。");
      await writeFile(join(directory, "sparse.json"), JSON.stringify({ executedAt: new Date().toISOString(), url, before }, null, 2));
      console.log("通过 #613 信息不足场景");
      return;
    }
    const source = before.result.evidence.find(e => e.kind === "repo_excerpt");
    if (!source) throw new Error("首版未获取源码证据。");
    const target = await page.context().newPage();
    const response = await target.goto(source.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await target.close();
    if (!response?.ok() || !/#L\d+-L\d+$/.test(source.url)) throw new Error("源码证据链接无法打开 " + response?.status() + " " + source.url);
    await panel.getByLabel("补充背景").fill(contextText);
    await panel.getByRole("button", { name: "更新建议" }).click();
    await waitRevision(panel, 2);
    const after = await readSession(sessionId);
    if (after.result?.sessionId !== before.sessionId || after.revision !== 2 || !after.result.changes.some(c => c.evidenceIds.includes("C1"))) {
      throw new Error("新版本未关联原会话与补充证据。");
    }
    const previous = before.result.evidence;
    if (!previous.every(row => after.result.evidence.some(next => next.id === row.id && next.excerpt === row.excerpt))) {
      throw new Error("第二版未保留已有证据。");
    }
    await panel.locator("aside").screenshot({ path: join(directory, "revision-2.png") });
    await writeFile(join(directory, "run.json"), JSON.stringify({ executedAt: new Date().toISOString(), url,
      contextText, before, after }, null, 2));
    console.log("真实两轮调用完成，截图和结果已写入 " + directory + "。请按 docs/demo.md 核对建议的语义变化。");
  });
} catch (error) {
  console.error("真实验收未完成：" + (error.cause?.code === "ECONNREFUSED" ? "请先启动 Python 后端。" : error.message));
  process.exitCode = 1;
}
