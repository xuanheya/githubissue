import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Sessions } from "../server/sessions.js";

const fixture = name => JSON.parse(readFileSync(new URL("./fixtures/" + name + ".json", import.meta.url)));
export const issue = fixture("issues");
export const turns = fixture("model-turns");
export function call(name, args) {
  return { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function",
    function: { name, arguments: JSON.stringify(args) } }] };
}
export function fixtureRepo(url = issue.url) {
  return {
    readIssue: async () => ({ title: issue.title, url, body: issue.body, truncated: false }),
    search: async () => ({ files: [{ fileId: "F1", path: "src/term.py" }], treeTruncated: false }),
    excerpt: async () => ({ found: true, path: "src/term.py", firstLine: 6, lastLine: 6,
      excerpt: "auto_color = stream.isatty()", url: url.split("/issues/")[0] + "/blob/" + "a".repeat(40) + "/src/term.py#L6-L6" })
  };
}
export function simpleModel(messages) {
  const { newContextId } = JSON.parse(messages[1].content);
  return call("submit_analysis", newContextId ? turns.second : turns.first);
}
export function makeSessions(overrides = {}) {
  return new Sessions({ modelFactory: () => simpleModel, repoFactory: fixtureRepo, ...overrides });
}
export function start(sessions, requestId = randomUUID()) {
  return sessions.start({ issueUrl: issue.url, requestId });
}
export async function settled(sessions, id) {
  const row = sessions.get(id);
  await row.job;
  return sessions.view(row);
}
