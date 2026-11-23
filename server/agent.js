import { AppError, publicError } from "./errors.js";
import { systemPrompt } from "./prompt.js";
import { toolSpecs, validateAnalysis, validateTool } from "./schemas.js";
import { runReadTool } from "./tools.js";

const READ_BUDGET = 4;
const note = (list, value) => { if (!list.includes(value)) list.push(value); };

export async function analyze({ repo, model, issue, previous, context, trace }) {
  const evidence = previous ? [...previous.evidence] : [{
    id: "I1", kind: "issue", label: issue.title, excerpt: issue.body.slice(0, 600), url: issue.url
  }];
  let contextId = null;
  if (context) {
    contextId = `C${1 + evidence.filter(row => row.kind === "user_context").length}`;
    evidence.push({ id: contextId, kind: "user_context", label: `补充背景 ${contextId.slice(1)}`, excerpt: context });
  }
  const previousAdvice = previous ? Object.fromEntries(
    ["summary", "hypotheses", "steps", "clarifications", "changes", "limitations"].map(k => [k, previous[k]])) : null;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify({ issue, evidence, previousAdvice, newContextId: contextId }) }
  ];
  const limits = [];
  if (!issue.body.trim()) note(limits, "Issue 正文为空，本轮仅有标题及后续取得的证据。");
  if (issue.truncated) note(limits, "Issue 正文超过上限，仅读取前 16000 个字符。");
  let reads = 0;
  let repairs = 0;
  for (let round = 0; round < 7; round++) {
    if (repo.apiLimited) note(limits, "GitHub API 已限流，暂缓仓库检索。建议依据 Issue、用户补充及已取得的证据。");
    const finalOnly = Boolean(repo.apiLimited) || reads >= READ_BUDGET || round >= 5;
    const available = finalOnly ? toolSpecs.filter(s => s.function.name === "submit_analysis") : toolSpecs;
    const assistant = await model(messages, available, finalOnly);
    const calls = assistant.tool_calls;
    if (!Array.isArray(calls) || !calls.length) {
      if (++repairs > 1) break;
      messages.push({ role: "user", content: "请按协议调用可用工具，最终用 submit_analysis 提交。" });
      continue;
    }
    if (calls.length > 8 || calls.some(c => typeof c.id !== "string" || !c.id || c.type !== "function") ||
        new Set(calls.map(c => c.id)).size !== calls.length) break;
    // Keep provider-specific fields needed for multi-turn tool calling only inside this request.
    messages.push(assistant);
    for (const call of calls) {
      const name = call.function?.name;
      let output;
      let args;
      try {
        if (name !== "submit_analysis") {
          if (finalOnly || reads >= READ_BUDGET) throw new AppError("budget", "本轮仓库工具预算已用完，请提交当前结果。");
          reads++;
        }
        try { args = JSON.parse(call.function.arguments); }
        catch { throw new AppError("tool_args", "工具参数不是有效 JSON。"); }
        const invalid = validateTool(name, args);
        if (invalid) throw new AppError("tool_args", invalid);
        if (name === "submit_analysis") {
          if (calls.length !== 1) throw new AppError("tool_args", "请先收齐工具结果，再单独提交建议。");
          const problem = validateAnalysis(args, new Set(evidence.map(row => row.id)), contextId);
          if (problem) throw new AppError("invalid_analysis", problem);
          trace.push({ tool: name, outcome: "已校验并提交" });
          return { ...args, limitations: [...new Set([...limits, ...args.limitations])],
            issue: { title: issue.title, url: issue.url }, evidence };
        }
        output = await runReadTool(repo, name, args, evidence);
        if (output.treeTruncated) note(limits, "GitHub 返回的文件树不完整，检索只覆盖已取得的路径。");
        const outcome = name === "search_repo" ? `返回 ${output.files.length} 个路径` :
          output.found ? `${output.id} · ${output.label}` : "文件内未命中";
        trace.push({ tool: name, purpose: args.purpose, outcome });
      } catch (error) {
        output = { error: publicError(error) };
        trace.push({ tool: toolSpecs.some(t => t.function.name === name) ? name : "unknown", outcome: output.error.message });
        if (name === "submit_analysis" && ++repairs > 1) throw new AppError("invalid_analysis", "模型重复提交了无效结构或证据，请重试。", 502);
        if (error.code?.startsWith("github_") || error.code === "payload_limit") note(limits, output.error.message);
      }
      messages.push({ role: "tool", tool_call_id: call.id,
        content: JSON.stringify({ ...output, remainingRepoCalls: Math.max(0, READ_BUDGET - reads) }) });
    }
  }
  throw new AppError("invalid_analysis", "模型未在限定轮数内提交有效的结构化建议。", 502);
}
