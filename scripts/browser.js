import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export async function withExtension(task) {
  const extension = fileURLToPath(new URL("../extension", import.meta.url));
  const profile = await mkdtemp(join(tmpdir(), "issue-advisor-chrome-"));
  let browser;
  try {
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
