import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Sessions } from "./sessions.js";
import { AppError, publicError, readJson } from "./errors.js";

const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url)));
export const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")
  .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
export const PORT = 43117;
const origin = "chrome-extension://" + extensionId;

export function createServer(sessions = new Sessions()) {
  return http.createServer({ requestTimeout: 10000 }, async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` ||
          (req.headers.origin !== undefined && req.headers.origin !== origin)) throw new AppError("origin", "请求来源未获授权。", 403);
      if (req.headers.origin === origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS" && req.headers.origin === origin) {
        res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type, X-Issue-Advisor" });
        return res.end();
      }
      if (req.headers["x-issue-advisor"] !== extensionId) throw new AppError("origin", "缺少扩展客户端标识。", 403);
      const match = /^\/sessions\/([\da-f-]{36})(\/context)?$/.exec(req.url);
      if (req.method === "GET" && match && !match[2]) return send(200, sessions.view(sessions.get(match[1])));
      if (req.method === "POST" && (req.url === "/sessions" || match?.[2])) {
        if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new AppError("content_type", "请求必须使用 JSON。", 415);
        const body = await readJson(req, 12000);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("bad_input", "请求体无效。");
        const view = match ? sessions.update(match[1], body) : sessions.start(body);
        return send(202, view);
      }
      throw new AppError("not_found", "接口不存在。", 404);
    } catch (error) {
      send(error instanceof AppError ? error.status : 500, { error: publicError(error) });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sessions = new Sessions();
  const server = createServer(sessions);
  const cleanup = setInterval(() => sessions.prune(), 60000);
  cleanup.unref();
  server.on("error", error => {
    console.error(error.code === "EADDRINUSE" ? "端口 43117 已被占用。" : "本地后端启动失败。");
    process.exitCode = 1;
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`Issue Advisor 已启动 http://127.0.0.1:${PORT} （扩展 ${extensionId}）`));
}
