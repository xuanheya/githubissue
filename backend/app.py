import asyncio
import base64
import hashlib
import json
import re
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from .common import ROOT, Problem, read_json
from .sessions import Sessions

manifest = json.loads((ROOT / "extension/manifest.json").read_text())
digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
EXTENSION_ID = "".join(chr(97 + int(c, 16)) for c in digest)
ORIGIN = "chrome-extension://" + EXTENSION_ID
UUID = re.compile(r"[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}", re.I)


async def body(req):
    if req.headers.get("content-type", "").split(";")[0] != "application/json":
        raise Problem("content_type", "请求必须为 JSON。", 415)
    buf = bytearray()
    async for chunk in req.stream():
        if len(buf) + len(chunk) > 12000:
            raise Problem("payload_limit", "请求过大。", 413)
        buf.extend(chunk)
    data = read_json(buf)
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("requestId"), str)
        or not UUID.fullmatch(data["requestId"])
    ):
        raise Problem("bad_input", "请求编号无效。")
    return data


def create_app(sessions=None):
    store = sessions or Sessions()

    @asynccontextmanager
    async def lifespan(app):
        async def cleanup():
            while True:
                await asyncio.sleep(60)
                store.prune()

        task = asyncio.create_task(cleanup())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            await asyncio.gather(*(r.job for r in store.rows.values() if r.job), return_exceptions=True)
            store.client.close()

    api = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    api.state.sessions = store

    @api.exception_handler(Problem)
    async def error(req, exc):
        return JSONResponse({"error": exc.public()}, status_code=exc.status)

    @api.middleware("http")
    async def restrict(req, call_next):
        origin = req.headers.get("origin")
        if req.headers.get("host") != f"127.0.0.1:{req.scope['server'][1]}" or origin not in (None, ORIGIN):
            return await error(req, Problem("origin", "请求来源未获授权。", 403))
        if req.method == "OPTIONS" and origin == ORIGIN:
            res = Response(
                status_code=204,
                headers={
                    "Access-Control-Allow-Methods": "GET, POST",
                    "Access-Control-Allow-Headers": "Content-Type, X-Issue-Advisor",
                },
            )
        elif req.headers.get("x-issue-advisor") != EXTENSION_ID:
            res = await error(req, Problem("origin", "缺少扩展客户端标识。", 403))
        else:
            res = await call_next(req)
        if origin:
            res.headers.update({"Access-Control-Allow-Origin": ORIGIN, "Vary": "Origin"})
        res.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
        return res

    @api.get("/health")
    async def health():
        return {"service": "github-issue-advisor", "version": manifest["version"], "engine": "mini-swe-agent"}

    @api.post("/sessions", status_code=202)
    async def start(req: Request):
        data = await body(req)
        return store.start(data.get("issueUrl"), data["requestId"])

    @api.get("/sessions/{sid}")
    async def get(sid: str):
        return store.get(sid).view()

    @api.post("/sessions/{sid}/context", status_code=202)
    async def update(sid: str, req: Request):
        data = await body(req)
        text, base = data.get("text"), data.get("baseRevision")
        if (
            not isinstance(text, str)
            or not 1 <= len(text.strip()) <= 2000
            or type(base) is not int
            or base < 1
        ):
            raise Problem("bad_context", "请输入 1–2000 字的背景及有效版本。")
        return store.update(sid, text.strip(), base, data["requestId"])

    return api
