import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


class Problem(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status

    def public(self):
        return {"code": self.code, "message": str(self)}


def settings():
    values = {**dotenv_values(ROOT / ".env"), **os.environ}
    base = (values.get("LLM_BASE_URL") or "").rstrip("/")
    url = urlsplit(base)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or not values.get("LLM_API_KEY")
        or not values.get("LLM_MODEL")
    ):
        raise Problem("model_config", "请配置 LLM_BASE_URL、LLM_MODEL 和 LLM_API_KEY。", 503)
    return base, values["LLM_MODEL"], values["LLM_API_KEY"]


def bounded(response, limit):
    buf = bytearray()
    for chunk in response.iter_bytes(16384):
        if len(buf) + len(chunk) > limit:
            raise Problem("payload_limit", "数据超过读取上限。", 413)
        buf.extend(chunk)
    return bytes(buf)


def read_json(data):
    try:
        return json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        raise Problem("invalid_json", "收到无效 JSON。") from None
