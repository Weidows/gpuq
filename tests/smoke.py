"""gpuq smoke test — end-to-end against a live server on a free port.

Starts a server on 127.0.0.1:0 (ephemeral), submits fake GPU tasks, and
verifies: scheduling, logs, metrics rows, fallback_wait auto-pause, CRUD,
rerun, queue pause/resume. Run:

    python tests/smoke.py

Needs nvidia-smi on PATH to observe GPU rows; everything else (task
scheduling, logs, CRUD) works without a GPU.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import gpuq.cli as cli  # noqa: E402
from gpuq.api import make_server  # noqa: E402
from gpuq.config import load_config  # noqa: E402
from gpuq.db import DB  # noqa: E402
from gpuq.metrics import Sampler  # noqa: E402
from gpuq.scheduler import Scheduler, make_state  # noqa: E402

PASS = 0
FAIL = 0


def check(name: str, cond: bool, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}  {extra}")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def http(port: int, method: str, path: str, body=None, key="") -> tuple[int, dict]:
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    if key:
        req.add_header("X-Api-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def main():
    fake = os.environ.get("GPUQ_SMOKE_FAKE_GPU")
    if fake:
        os.environ["GPUQ_FAKE_GPU"] = "1"
        print("== using FAKE GPU (CI mode) ==")
    port = free_port()
    cfg = load_config(None)
    cfg.update({
        "host": "127.0.0.1", "port": port,
        "data_dir": str(ROOT / "data" / "smoke-test"),
        "poll_interval": 0.5, "metrics_interval": 1.0,
        "gpu_bin": os.environ.get("GPUQ_SMOKE_GPU_BIN", "nvidia-smi"),
    })
    import threading
    Path(cfg["data_dir"]).mkdir(parents=True, exist_ok=True)
    Path(cfg["data_dir"], "logs").mkdir(parents=True, exist_ok=True)
    db = DB(str(Path(cfg["data_dir"]) / "gpuq.db"))
    state = make_state()
    stop = threading.Event()
    sched = Scheduler(db, cfg, state, stop)
    samp = Sampler(db, cfg, state, stop)
    server = make_server(db, cfg, state, sched)
    sched.start(); samp.start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.5)

    print("== server ==")
    code, body = http(port, "GET", "/api/system")
    check("GET /api/system 200", code == 200)
    check("system has counts", "counts" in body["data"])
    if body["data"]["gpus"]:
        print(f"  detected {len(body['data']['gpus'])} GPU(s)")
    else:
        print("  no GPU (nvidia-smi missing) — GPU-row checks skipped")

    print("== submit / CRUD ==")
    code, body = http(port, "POST", "/api/tasks", {
        "project": "smoke", "username": "tester",
        "command": ["python", "-c", "import time; time.sleep(6)"],
        "vram_mb": 500, "est_seconds": 10, "priority": 5,
        "fallback_wait_seconds": 3,
    })
    check("submit 201", code == 201, str(code))
    tid = body["data"]["id"]
    check("task id present", bool(tid))

    code, body = http(port, "GET", f"/api/tasks/{tid}")
    check("get task", code == 200 and body["data"]["status"] == "queued")

    code, body = http(port, "PATCH", f"/api/tasks/{tid}", {"priority": 9})
    check("patch queued task", code == 200 and body["data"]["priority"] == 9)

    code, body = http(port, "POST", "/api/tasks", {
        "project": "smoke2", "command": ["echo", "hi"]})
    tid2 = body["data"]["id"]
    code, _ = http(port, "DELETE", f"/api/tasks/{tid2}")
    check("delete queued task", code == 200)

    print("== scheduling ==")
    time.sleep(3)
    code, body = http(port, "GET", f"/api/tasks/{tid}")
    st = body["data"]["status"]
    check("task transitions to running", st == "running", f"status={st}")
    if st == "running":
        check("pid + gpu set", body["data"]["pid"] and body["data"]["gpu_id"] is not None)

    code, body = http(port, "GET", f"/api/tasks/{tid}/logs?limit=200")
    check("logs endpoint 200", code == 200)

    print("== metrics ==")
    time.sleep(2.5)
    code, body = http(port, "GET", "/api/metrics?step=1")
    check("metrics endpoint 200", code == 200)
    gpu_rows = 0
    for gid, series in body["data"]["gpus"].items():
        if gid != "-1" and series:
            gpu_rows += len(series)
    if body["data"]["gpus"]:
        check("gpu metric rows recorded", gpu_rows > 0, f"rows={gpu_rows}")
    else:
        print("  (skipping gpu-row check — no nvidia-smi)")

    print("== fallback_wait auto-pause ==")
    # the 6s task is still running; submit a fast-crash task AFTER it finishes
    time.sleep(5)  # let the first task finish (~6s total)
    time.sleep(2)
    code, body = http(port, "GET", f"/api/tasks/{tid}")
    check("first task succeeded", body["data"]["status"] == "succeeded",
          f"status={body['data']['status']}")
    code, body = http(port, "POST", "/api/tasks", {
        "project": "smoke-crash", "username": "tester",
        "command": ["python", "-c", "import sys; print('boom'); sys.exit(1)"],
        "fallback_wait_seconds": 30,
    })
    tid3 = body["data"]["id"]
    time.sleep(4)
    code, body = http(port, "GET", "/api/system")
    q = body["data"]["queue"]
    check("queue auto-paused by fallback_wait", q["paused"] is True,
          f"paused={q['paused']}")
    check("pause reason names the task", q["pause_task_id"] == tid3,
          f"trigger={q['pause_task_id']}")
    code, body = http(port, "GET", f"/api/tasks/{tid3}")
    check("fast task marked failed", body["data"]["status"] == "failed")

    print("== queue resume / rerun ==")
    code, body = http(port, "POST", "/api/queue/resume")
    check("resume 200", code == 200)
    code, body = http(port, "POST", f"/api/tasks/{tid3}/rerun")
    check("rerun 201", code == 201, str(code))
    tid4 = body["data"]["id"]
    # the rerun would also crash; cancel it so the queue stays clean
    http(port, "DELETE", f"/api/tasks/{tid4}")

    print("== auth ==")
    # server has no keys configured -> open
    code, body = http(port, "POST", "/api/tasks", {"command": ["echo", "x"]})
    check("open API without keys", code == 201)

    print("== cleanup ==")
    stop.set()
    server.shutdown()
    db.close()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
