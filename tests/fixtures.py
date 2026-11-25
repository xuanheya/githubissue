"""Deterministic transports; the production app never imports this module."""

import json
from types import SimpleNamespace

import httpx

from backend.agent import DeepSeekModel
from backend.github import Repository

URL = "https://github.com/example/csv/issues/7"
COMMIT, TREE, BLOB = "a" * 40, "b" * 40, "c" * 40
ISSUE = dict(title="CSV 导出后中文乱码", body="用户在打开 CSV 后看到中文乱码。", html_url=URL)
FILES = {
    "src/export/csv.ts": "export function csv(rows) {\n  return rows.join(',');\n}",
    "jobs/export.ts": "import {csv} from '../src/export/csv';\nexport const batch = csv;\n",
    "src/long.txt": "x" * 900 + "target\n",
}


def github_request(req):
    path = req.url.path
    if req.url.host == "raw.githubusercontent.com":
        name = path.split("/", 4)[-1]
        return httpx.Response(200, text=FILES[name])
    if path.endswith("/csv"):
        value = {"private": False, "visibility": "public", "full_name": "example/csv"}
    elif "/issues/" in path:
        value = {**ISSUE, "html_url": URL.rsplit("/", 1)[0] + "/" + path.split("/")[-1]}
    elif "/commits/" in path:
        value = {"sha": COMMIT, "commit": {"tree": {"sha": TREE}}}
    elif "/git/trees/" in path:
        rows = [
            dict(type="blob", mode="100644", sha=BLOB, size=len(v.encode()), path=k) for k, v in FILES.items()
        ]
        value = dict(tree=rows + [{**rows[0], "mode": "120000", "path": "outside.ts"}], truncated=False)
    else:
        raise AssertionError(path)
    return httpx.Response(200, json=value)


def report(ctx=False, code=None):
    ids = [code or "I1"]
    return dict(
        summary="需要比较应用的导出编码与读取环境。",
        hypotheses=[
            dict(
                id="H1",
                claim="读取工具的编码识别可能影响中文。",
                evidenceIds=ids,
                counterEvidenceIds=[],
                howToCheck="用另一种阅读工具打开同一个文件，比较相同单元格。",
            )
        ],
        steps=[
            dict(
                action="比较同一文件的读取结果。",
                expectedObservation="若仅 Excel 出错，优先检查其导入设置。",
                evidenceIds=ids,
            )
        ],
        clarifications=[] if ctx else [dict(question="使用哪种工具？", whyItMatters="决定验证环境。")],
        changes=[dict(description="结合用户环境调整检查顺序。", evidenceIds=["C1"])] if ctx else [],
        limitations=[],
    )


def call(name, args):
    return dict(id="call1", type="function", function=dict(name=name, arguments=json.dumps(args)))


def model_response(calls):
    return httpx.Response(
        200, json={"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": calls}}]}
    )


def setup_run(turns=(), handler=github_request):
    repo = Repository(URL, httpx.Client(transport=httpx.MockTransport(handler)), token="")
    requests = []
    turns = iter(turns)

    def chat(req):
        payload = json.loads(req.content)
        requests.append(payload)
        current = next(turns)
        calls = current(payload) if callable(current) else current
        return model_response(calls if isinstance(calls, list) else [calls])

    client = httpx.Client(transport=httpx.MockTransport(chat))
    factory = lambda env: DeepSeekModel(client, ("https://model.test", "test", "dummy"), env)
    return SimpleNamespace(repo=repo, factory=factory, requests=requests)
