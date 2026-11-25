"""Local test entry point with an ephemeral port and deterministic upstream data."""

import json
import socket
import time

import uvicorn

from backend.app import create_app
from backend.common import Problem
from backend.sessions import Sessions
from tests.fixtures import ISSUE, call, report, setup_run

MARKUP = "<img src=x onerror='window.injectionRan=true'>"


def fixture_repo(url):
    fixture = setup_run().repo
    fixture.read_issue = lambda: dict(
        title=MARKUP if url.endswith("/8") else ISSUE["title"], url=url, body=ISSUE["body"], source="fixture"
    )
    return fixture


def make_model():
    fail_once = True

    def decide(payload):
        nonlocal fail_once
        data = json.loads(payload["messages"][1]["content"])
        if data["issue"]["title"] == MARKUP:
            time.sleep(1)
        if data["newContextId"] and fail_once:
            fail_once = False
            raise Problem("model_network", "测试中的模型超时", 502)
        return call("submit_analysis", report(ctx=bool(data["newContextId"])))

    return setup_run([decide] * 8).factory


if __name__ == "__main__":
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    print(json.dumps({"port": sock.getsockname()[1]}), flush=True)
    app = create_app(Sessions(repo_factory=fixture_repo, make_model=make_model))
    uvicorn.Server(uvicorn.Config(app, log_level="error", proxy_headers=False)).run(sockets=[sock])
