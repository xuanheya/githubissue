import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError } from "../server/errors.js";
import { makeSessions, call, fixtureRepo, start, settled, turns, issue } from "./helpers.js";

test("replanning uses one Issue read, one session, previous plan and new C evidence", async () => {
  let reads = 0, second = false;
  const sessions = makeSessions({ repoFactory: url => {
    const repo = fixtureRepo(url), read = repo.readIssue;
    repo.readIssue = () => { reads++; return read(); };
    return repo;
  }, modelFactory: () => messages => {
    const data = JSON.parse(messages[1].content);
    if (!data.newContextId) return call("submit_analysis", turns.first);
    second = true;
    assert.deepEqual(data.previousAdvice.steps, turns.first.steps);
    assert.equal(data.evidence.at(-1).excerpt, issue.context);
    return call("submit_analysis", turns.second);
  } });
  const id = start(sessions).sessionId;
  await settled(sessions, id);
  const input = { requestId: randomUUID(), baseRevision: 1, text: issue.context };
  sessions.update(id, input);
  const result = (await settled(sessions, id)).result;
  assert.equal(reads, 1);
  assert.ok(second);
  assert.equal(result.sessionId, id);
  assert.equal(result.revision, 2);
  assert.deepEqual(result.clarifications, []);
  assert.notDeepEqual(result.steps, turns.first.steps);
  assert.equal(sessions.update(id, input).revision, 2);
  assert.throws(() => sessions.update(id, { ...input, requestId: randomUUID() }), { status: 409 });
});
test("duplicate start or update is idempotent and concurrent input cannot overwrite a run", async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const sessions = makeSessions({ modelFactory: () => async messages => {
    if (JSON.parse(messages[1].content).newContextId) { await gate; return call("submit_analysis", turns.second); }
    return call("submit_analysis", turns.first);
  } });
  const requestId = randomUUID(), id = start(sessions, requestId).sessionId;
  assert.equal(start(sessions, requestId).sessionId, id);
  await settled(sessions, id);
  const input = { text: issue.context, requestId: randomUUID(), baseRevision: 1 };
  assert.equal(sessions.update(id, input).status, "running");
  assert.equal(sessions.update(id, input).status, "running");
  assert.throws(() => sessions.update(id, { ...input, text: "不同输入" }), { status: 409 });
  assert.throws(() => sessions.update(id, { ...input, requestId: randomUUID() }), { status: 409 });
  resume();
  assert.equal((await settled(sessions, id)).revision, 2);
});
test("failed revision preserves the previous result and draft; a new attempt can recover", async () => {
  let attempts = 0;
  const sessions = makeSessions({ modelFactory: () => messages => {
    if (!JSON.parse(messages[1].content).newContextId) return call("submit_analysis", turns.first);
    if (++attempts === 1) throw new AppError("model_network", "模拟超时");
    return call("submit_analysis", turns.second);
  } });
  const id = start(sessions).sessionId;
  const first = await settled(sessions, id);
  const input = { text: issue.context, baseRevision: 1, requestId: randomUUID() };
  sessions.update(id, input);
  const failure = await settled(sessions, id);
  assert.equal(failure.status, "failed");
  assert.deepEqual(failure.result, first.result);
  assert.equal(failure.pendingContext, issue.context);
  sessions.update(id, { ...input, requestId: randomUUID() });
  assert.equal((await settled(sessions, id)).revision, 2);
});
test("sessions expire independently, including their duplicate-request index", async () => {
  let clock = 100;
  const sessions = makeSessions({ now: () => clock });
  const requestId = randomUUID(), id = start(sessions, requestId).sessionId;
  await settled(sessions, id);
  clock += 3600001;
  assert.throws(() => sessions.get(id), { code: "session_expired" });
  assert.notEqual(start(sessions, requestId).sessionId, id);
});
