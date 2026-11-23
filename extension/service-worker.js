import { parseIssueUrl } from "./issue-url.js";
const base = "http://127.0.0.1:43117";
const queues = new Map();

async function api(path, body) {
  const headers = { "X-Issue-Advisor": chrome.runtime.id };
  if (body) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(base + path, { method: body ? "POST" : "GET", headers, cache: "no-store",
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8000),
      ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw Object.assign(new Error("无法连接本地后端，请确认 npm start 已运行。"), { code: "offline" }); }
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || "后端请求失败。"), { code: data.error?.code });
  return data;
}

async function handle(key, url, message) {
  const storage = chrome.storage.session;
  const slot = (await storage.get(key))[key] || {};
  if (message.type === "start") {
    if (slot.sessionId && !message.restart) {
      try { return await api("/sessions/" + slot.sessionId); }
      catch (e) { if (e.code !== "session_expired") throw e; }
    }
    const requestId = slot.startId || crypto.randomUUID();
    await storage.set({ [key]: { ...slot, startId: requestId } });
    const view = await api("/sessions", { issueUrl: url, requestId });
    await storage.set({ [key]: { sessionId: view.sessionId } });
    return view;
  }
  if (!slot.sessionId) {
    if (message.type === "read") return null;
    throw Object.assign(new Error("会话已过期，请重新生成建议。"), { code: "session_expired" });
  }
  const path = "/sessions/" + slot.sessionId;
  try {
    if (message.type === "read") return await api(path);
    if (message.type !== "update") throw new Error("未知操作。");
    const { text, baseRevision } = message;
    const pending = slot.pending?.text === text && slot.pending.baseRevision === baseRevision
      ? slot.pending : { text, baseRevision, requestId: crypto.randomUUID() };
    await storage.set({ [key]: { ...slot, pending } });
    const view = await api(path + "/context", pending);
    await storage.set({ [key]: { sessionId: slot.sessionId } });
    return view;
  } catch (error) {
    if (error.code === "session_expired") await storage.remove(key);
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) ||
      sender.origin !== "https://github.com" || !["start", "read", "update"].includes(message?.type)) return false;
  const issue = parseIssueUrl(message.url);
  if (!issue) return false;
  const key = `issue:${sender.tab.id}:${issue.url.toLowerCase()}`;
  const job = (queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    // sender.url may still be the initial document URL after history.pushState.
    const tab = await chrome.tabs.get(sender.tab.id);
    if (parseIssueUrl(tab.url)?.url !== issue.url) throw new Error("当前页面已切换，请在新页面重试。");
    return handle(key, issue.url, message);
  });
  queues.set(key, job);
  job.then(view => reply({ view }), e => reply({ error: { code: e.code || "extension", message: e.message } }))
    .finally(() => { if (queues.get(key) === job) queues.delete(key); });
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const keys = Object.keys(await chrome.storage.session.get(null)).filter(key => key.startsWith(`issue:${tabId}:`));
  if (keys.length) await chrome.storage.session.remove(keys);
});
