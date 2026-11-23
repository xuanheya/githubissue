export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function publicError(error) {
  return error instanceof AppError
    ? { code: error.code, message: error.message }
    : { code: "internal_error", message: "服务处理失败，请重试并检查本地后端。" };
}

// Apply limits before buffering incoming JSON, including responses without Content-Length.
export async function readText(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new AppError("payload_limit", "数据超过读取上限。", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(stream, maxBytes) {
  const text = await readText(stream, maxBytes);
  try { return JSON.parse(text); }
  catch { throw new AppError("invalid_json", "收到无效 JSON。"); }
}
