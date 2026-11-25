import asyncio
import json
import threading
import time
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.agent import DeepSeekModel
from backend.app import EXTENSION_ID, ORIGIN, create_app
from backend.common import Problem, settings
from backend.sessions import Sessions
from .fixtures import URL, call, report, setup_run

HEADERS = {"X-Issue-Advisor": EXTENSION_ID, "Origin": ORIGIN}


def rid():
    return str(uuid4())


def start_body():
    return dict(issueUrl=URL, requestId=rid())


def store_for(turns):
    s = setup_run(turns)
    return Sessions(repo_factory=lambda url: s.repo, make_model=lambda: s.factory)


def test_contract():
    store = store_for([call("submit_analysis", report()), call("submit_analysis", report(ctx=True))])
    with TestClient(create_app(store), base_url="http://127.0.0.1:43117", headers=HEADERS) as client:
        resp = client.post("/sessions", json=start_body())
        assert resp.status_code == 202
        route = "/sessions/" + resp.json()["sessionId"]

        def wait(n):
            for _ in range(100):
                data = client.get(route).json()
                if data["status"] == "ready" and data["revision"] == n:
                    return data
                time.sleep(0.01)
            pytest.fail(str(data))

        r = wait(1)
        assert r["result"]["issue"]["url"] == URL
        payload = dict(baseRevision=1, text="同一 CSV 在 LibreOffice 正常。", requestId=rid())
        assert client.post(route + "/context", json=payload).status_code == 202
        assert wait(2)["result"]["evidence"][-1]["id"] == "C1"
        assert client.post(route + "/context", json=payload).json()["revision"] == 2
        assert client.post(route + "/context", json={**payload, "requestId": rid()}).status_code == 409


def test_admission_and_validation():
    with TestClient(create_app(store_for([])), base_url="http://127.0.0.1:43117") as c:
        for h in [{}, {**HEADERS, "Origin": "https://hostile.invalid"}, {**HEADERS, "Host": "example.com"}]:
            assert c.post("/sessions", json=start_body(), headers=h).status_code == 403
        assert c.post("/sessions", content="form", headers=HEADERS).status_code == 415
        assert c.post("/sessions", json=[], headers=HEADERS).status_code == 400
        assert c.post("/sessions", json={"x": "A" * 13000}, headers=HEADERS).status_code == 413
        assert c.options("/sessions", headers=HEADERS).headers["access-control-allow-origin"] == ORIGIN


def test_missing_model(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "")
    with pytest.raises(Problem) as e:
        settings()
    assert e.value.code == "model_config"


@pytest.mark.parametrize("failure", ["denied", "network", "bad_response"])
def test_model_protocol_and_errors(failure):
    def handler(req):
        payload = json.loads(req.content)
        assert req.headers["Authorization"] == "Bearer dummy" and payload["tool_choice"] == "auto"
        if failure == "denied":
            return httpx.Response(401, text="secret upstream body")
        if failure == "network":
            raise httpx.ReadTimeout("secret upstream body")
        return httpx.Response(200, json={})

    m = DeepSeekModel(
        httpx.Client(transport=httpx.MockTransport(handler)),
        ("https://model.test", "model", "dummy"),
        type("Env", (), {"names": lambda self: ["submit_analysis"]})(),
    )
    with pytest.raises(Problem) as e:
        m.query([{"role": "system", "content": "prompt"}])
    assert "secret" not in str(e.value) and e.value.status == 502


def test_idempotence_recovery_expiration():
    async def scenario():
        gate = threading.Event()

        def hold(_):
            assert gate.wait(3)
            return call("submit_analysis", report())

        store = store_for(
            [
                hold,
                call("submit_analysis", report(code="R88")),
                call("submit_analysis", report(code="R88")),
                call("submit_analysis", report(ctx=True)),
            ]
        )
        first = rid()
        v = store.start(URL, first)
        row = store.get(v["sessionId"])
        assert store.start(URL, first)["sessionId"] == row.id
        with pytest.raises(Problem, match="绑定"):
            store.start(URL + "1", first)
        with pytest.raises(Problem, match="版本"):
            store.update(row.id, "context", 1, rid())
        gate.set()
        await row.job
        store.update(row.id, "extra", 1, rid())
        await row.job
        assert row.status == "failed" and row.pending == "extra" and len(row.history) == 1
        store.update(row.id, "extra", 1, rid())
        await row.job
        assert len(row.history) == 2 and row.status == "ready"
        row.touched -= 3601
        with pytest.raises(Problem, match="过期"):
            store.get(row.id)
        assert not store.starts
        store.client.close()

    asyncio.run(scenario())
