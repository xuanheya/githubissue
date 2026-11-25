"""Manage this project's detached, loopback-only Python service on macOS/Linux."""

import argparse
import json
import os
import signal
import subprocess
import sys
import time

import httpx

from backend.app import EXTENSION_ID
from backend.common import ROOT, settings

STATE = ROOT / ".runtime"
PID = STATE / "backend.pid"
LOG = STATE / "backend.log"


def healthy():
    try:
        r = httpx.get("http://127.0.0.1:43117/health", headers={"X-Issue-Advisor": EXTENSION_ID}, timeout=1)
        return r.status_code == 200 and r.json().get("engine") == "mini-swe-agent"
    except (httpx.HTTPError, ValueError):
        return False


def owned_pid():
    try:
        pid = int(PID.read_text())
        cmd = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True
        ).stdout.strip()
        if cmd == str(ROOT / ".venv/bin/python") + " -m backend":
            return pid
    except (FileNotFoundError, ValueError):
        pass
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["start", "status", "stop"])
    action = parser.parse_args().action
    STATE.mkdir(mode=0o700, exist_ok=True)
    import fcntl

    with (STATE / "service.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        pid = owned_pid()
        if action == "status":
            print(json.dumps({"port": 43117, "healthy": healthy(), "managedPid": pid}))
            return
        if action == "stop":
            if pid:
                os.kill(pid, signal.SIGTERM)
                for _ in range(350):
                    if not owned_pid():
                        PID.unlink(missing_ok=True)
                        break
                    time.sleep(0.2)
                else:
                    sys.exit("服务仍在完成进行中的分析。")
            return
        if healthy():
            print("服务已在 127.0.0.1:43117 运行。")
            return
        settings()
        with LOG.open("ab") as log:
            process = subprocess.Popen(
                [str(ROOT / ".venv/bin/python"), "-m", "backend"],
                cwd=ROOT,
                stdout=log,
                stderr=log,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        for _ in range(60):
            if process.poll() is not None:
                break
            if healthy() and process.poll() is None:
                PID.write_text(str(process.pid))
                print(f"服务已启动，PID {process.pid}，地址 127.0.0.1:43117")
                return
            time.sleep(0.15)
        if process.poll() is None:
            process.terminate()
        sys.exit(f"服务启动失败，请检查 {LOG}")


if __name__ == "__main__":
    main()
