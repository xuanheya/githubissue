import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";

const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
export const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")
  .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
export const PORT = Number(process.env.ADVISOR_TEST_PORT || 43117);

export async function withExtension(task, port = PORT) {
  let extension = fileURLToPath(new URL("../extension", import.meta.url));
  const profile = await mkdtemp(join(tmpdir(), "issue-advisor-chrome-"));
  let browser;
  try {
    if (port !== 43117) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid backend port");
      const copy = join(profile, "test-extension");
      await cp(extension, copy, { recursive: true });
      const worker = join(copy, "service-worker.js");
      await writeFile(worker, (await readFile(worker, "utf8")).replace("127.0.0.1:43117", "127.0.0.1:" + port));
      extension = copy;
    }
    browser = await chromium.launchPersistentContext(profile, {
      executablePath: chromium.executablePath(), headless: true,
      viewport: { width: 1360, height: 980 },
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension]
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker", { timeout: 12000 });
    await task(browser, worker);
  } finally {
    if (browser) await browser.close();
    await rm(profile, { recursive: true, force: true });
  }
}

export async function waitRevision(panel, n) {
  const outcome = panel.locator(".status").filter({ hasText: `第 ${n} 版` }).or(panel.locator(".status.error"));
  await outcome.first().waitFor({ timeout: 420000 });
  const error = panel.locator(".status.error");
  if (await error.count()) throw new Error(await error.innerText());
}
