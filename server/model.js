import { AppError, readJson } from "./errors.js";

export function createModel(env = process.env, fetcher = fetch) {
  const { LLM_BASE_URL, LLM_MODEL, LLM_API_KEY } = env;
  if (![LLM_BASE_URL, LLM_MODEL, LLM_API_KEY].every(value => value?.trim())) {
    throw new AppError("model_config", "请在项目 .env 中配置 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY，然后重启后端。", 503);
  }
  let base;
  try { base = new URL(LLM_BASE_URL); } catch { /* invalid configuration below */ }
  if (base?.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new AppError("model_config", "LLM_BASE_URL 应是远程 HTTPS API 的基础地址。", 503);
  }
  const endpoint = base.href.replace(/\/$/, "") + "/chat/completions";
  return async (messages, tools, finalOnly) => {
    const input = finalOnly ? messages.map((message, i) => i === 0 ?
      { ...message, content: message.content + "\n本轮取证已结束。现在仅调用 submit_analysis，提交依据现有证据得到的结果。" } : message) : messages;
    try {
      const response = await fetcher(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(45000),
        headers: { Authorization: "Bearer " + LLM_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: LLM_MODEL, messages: input, tools, tool_choice: "auto" }) });
      if (!response.ok) throw new AppError("model_http", `模型服务返回 HTTP ${response.status}，请检查模型、额度、认证和工具支持。`, 502);
      const data = await readJson(response.body, 600_000);
      const message = data.choices?.[0]?.message;
      if (!message || message.role !== "assistant") throw new AppError("model_protocol", "模型响应缺少有效的 assistant 消息。", 502);
      return message;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("model_network", "远程模型连接失败或响应超时。", 502);
    }
  };
}
