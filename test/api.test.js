import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { createServer, extensionId } from "../server/index.js";
import { createModel } from "../server/model.js";
import { issue, makeSessions, call, turns } from "./helpers.js";

async function serve(t, sessions) {
  const server = createServer(sessions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return "http://127.0.0.1:" + server.address().port;
}
const headers = { "X-Issue-Advisor": extensionId, Origin: "chrome-extension://" + extensionId, "content-type": "application/json" };
const post = (base, path, body, h = headers) => fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) });
test("API start, poll and context update use a consistent result envelope", async t => {
  const base = await serve(t, makeSessions());
  const started = await post(base, "/sessions", { requestId: randomUUID(), issueUrl: issue.url });
  assert.equal(started.status, 202);
  const { sessionId } = await started.json();
  const path = "/sessions/" + sessionId;
  const current = () => fetch(base + path, { headers }).then(r => r.json());
  assert.equal((await current()).result.issue.title, issue.title);
  assert.equal((await post(base, path + "/context", { requestId: randomUUID(), baseRevision: 1, text: issue.context })).status, 202);
  assert.equal((await current()).revision, 2);
});
test("untrusted origins, forged hosts, missing extension headers and non-JSON forms are denied", async t => {
  const base = await serve(t, makeSessions());
  for (const bad of [{}, { ...headers, Origin: "https://github.com" }]) {
    const res = await post(base, "/sessions", {}, bad);
    assert.equal(res.status, 403);
  }
  // fetch normalizes Host; use HTTP directly to exercise the server's Host check.
  const forgedHost = await new Promise((resolve, reject) => {
    const req = request(base + "/sessions", { headers: { ...headers, Host: "outside.invalid" } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(forgedHost, 403);
  assert.equal((await post(base, "/sessions", {}, { ...headers, "content-type": "text/plain" })).status, 415);
  const cors = await fetch(base + "/sessions", { method: "OPTIONS", headers });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get("access-control-allow-origin"), headers.Origin);
  assert.equal((await post(base, "/sessions", [], headers)).status, 400);
});
test("missing real-model configuration fails explicitly", async t => {
  const base = await serve(t, makeSessions({ modelFactory: () => createModel({}) }));
  const res = await post(base, "/sessions", { requestId: randomUUID(), issueUrl: issue.url });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "model_config");
});
test("model adapter sends a real protocol request and limits error disclosure", async () => {
  const env = { LLM_BASE_URL: "https://llm.example/v1/", LLM_API_KEY: "test-only", LLM_MODEL: "test-model" };
  const expected = call("submit_analysis", turns.first);
  const model = createModel(env, async (url, req) => {
    assert.equal(url, "https://llm.example/v1/chat/completions");
    assert.equal(req.headers.Authorization, "Bearer test-only");
    assert.equal(req.redirect, "error");
    assert.equal(JSON.parse(req.body).tool_choice, "auto");
    assert.match(JSON.parse(req.body).messages[0].content, /submit_analysis/);
    return Response.json({ choices: [{ message: expected }] });
  });
  assert.deepEqual(await model([{ role: "system", content: "test" }], [], true), expected);
  const errorModel = createModel(env, async () => new Response("private upstream response", { status: 401 }));
  await assert.rejects(errorModel([], [], false), e => e.code === "model_http" && !e.message.includes("private"));
  const timeout = createModel(env, () => { throw new Error("internal transport details"); });
  await assert.rejects(timeout([], [], false), { code: "model_network" });
  assert.throws(() => createModel({ ...env, LLM_BASE_URL: "http://invalid.example" }), { code: "model_config" });
});
