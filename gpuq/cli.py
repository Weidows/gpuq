"""gpuq CLI — the agent-facing entry point.

All subcommands talk to the server over HTTP (urllib, stdlib), so they work
identically against a direct run, a Docker container, or a systemd-deployed
server on another host (point --host/--port at it, or export GPUQ_PORT etc.).

Subcommands:
  serve                    run the server in the foreground (also: python -m gpuq)
  submit -- cmd args       submit a task; everything after `--` is the command
  status | list            queue overview / task list
  logs  ID                 tail logs of a task (--q grep, --follow, --offset)
  cancel ID                cancel (kill if running)
  rerun ID                 clone + re-queue
  metrics                  chart-ready time series (--gpu --from --to --step)
  gpu                      live GPU status
  queue pause|resume       pause / resume the whole queue
  version                  print version and server url
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import __version__
from .config import load_config

CT = "application/json; charset=utf-8"


# ---------------- http client ----------------

class Client:
    def __init__(self, base: str, key: str = ""):
        self.base = base.rstrip("/")
        self.key = key

    def request(self, method: str, path: str, body=None, params=None) -> dict:
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = CT
        if self.key:
            headers["X-Api-Key"] = self.key
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode("utf-8"))
                err = payload.get("error", e.reason)
            except Exception:
                err = str(e)
            raise SystemExit(f"error {e.code}: {err}")


def build_client(args) -> Client:
    key = args.key
    return Client(f"http://{args.host}:{args.port}", key)


# ---------------- formatters ----------------

def _fmt_ts(ts):
    return (ts or "")[:19].replace("T", " ")


def _fmt_duration(task) -> str:
    if task.get("started_at") and task.get("finished_at"):
        try:
            from datetime import datetime
            a = datetime.fromisoformat(task["started_at"].replace("Z", "+00:00"))
            b = datetime.fromisoformat(task["finished_at"].replace("Z", "+00:00"))
            return f"{(b - a).total_seconds():.0f}s"
        except ValueError:
            pass
    return "-"


def print_task_row(t: dict) -> str:
    gpu = t.get("gpu_id") or "auto"
    return (f"{t['id'][:8]:8} {t['status']:<9} gpu={gpu:<4} "
            f"prio={t.get('priority', 5):<2} vram={t.get('vram_mb', 0):>6}MB "
            f"{_fmt_duration(t):>6} {t.get('project', ''):<12} "
            f"{t.get('username', ''):<10} {' '.join(t.get('command', []))[:60]}")


# ---------------- subcommands ----------------

def cmd_serve(args):
    # line-buffer stdout/stderr so daemon logs survive when redirected to a file
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    from .scheduler import Scheduler, make_state
    from .metrics import Sampler
    from .api import make_server
    from .db import DB

    cfg = load_config(args.config)
    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = args.port
    if args.data:
        cfg["data_dir"] = str(Path(args.data).resolve())
    if args.gpu_bin:
        cfg["gpu_bin"] = args.gpu_bin

    Path(cfg["data_dir"]).mkdir(parents=True, exist_ok=True)
    Path(cfg["data_dir"], "logs").mkdir(parents=True, exist_ok=True)
    db = DB(str(Path(cfg["data_dir"]) / "gpuq.db"))
    state = make_state()
    stop = threading_event()
    scheduler = Scheduler(db, cfg, state, stop)
    sampler = Sampler(db, cfg, state, stop)
    server = make_server(db, cfg, state, scheduler)
    scheduler.start()
    sampler.start()
    url = f"http://{cfg['host']}:{cfg['port']}"
    print(f"[gpuq] listening on {url}  (data: {cfg['data_dir']})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[gpuq] shutting down...")
        stop.set()
        scheduler.join(timeout=3)
        server.shutdown()
        db.close()


def threading_event():
    import threading
    return threading.Event()


def cmd_submit(args):
    client = build_client(args)
    cmd = list(args.command or [])
    # argparse REMAINDER keeps the literal '--' separator; drop it
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        raise SystemExit("error: no command given after --")
    payload = {
        "command": cmd,
        "project": args.project,
        "username": args.user,
        "vram_mb": args.vram,
        "est_seconds": args.est,
        "priority": args.priority,
        "fallback_wait_seconds": args.fallback_wait,
        "cwd": args.cwd or None,
        "gpu_id": args.gpu,
        "api_key": args.task_key or args.key or "",
        "version": args.version or "",
        "power_limit_w": args.power_limit,
    }
    if args.env:
        payload["env"] = {k: v for k, v in (pair.split("=", 1) for pair in args.env)}
    resp = client.request("POST", "/api/tasks", payload)
    t = resp["data"]
    print(f"submitted task {t['id']}  ({t['status']})")
    sys_ = client.request("GET", "/api/system")["data"]
    print(f"  queue: {sys_['counts']['queued']} queued, {sys_['counts']['running']} running")
    print(f"  watch: {client.base}/#/tasks/{t['id']}")


def cmd_list(args):
    client = build_client(args)
    params = {"limit": args.limit}
    for k, v in (("status", args.status), ("project", args.project), ("user", args.user)):
        if v:
            params[k] = v
    data = client.request("GET", "/api/tasks", params=params)["data"]
    if not data:
        print("no tasks")
        return
    for t in data:
        print(print_task_row(t))
    print(f"\n{len(data)} task(s)")


def cmd_status(args):
    client = build_client(args)
    sys_ = client.request("GET", "/api/system")["data"]
    q = sys_["queue"]
    if q["paused"]:
        print(f"QUEUE: PAUSED — {q['pause_reason']}")
    else:
        print("QUEUE: running")
    print(f"counts: {sys_['counts']}")
    print()
    if sys_["gpus"]:
        for g in sys_["gpus"]:
            print(f"GPU {int(g['index'])}  {g.get('name', ''):<24} "
                  f"util={g.get('gpu_util', 0):>4.0f}%  "
                  f"mem={g.get('mem_used', 0):>6.0f}/{g.get('mem_total', 0):>6.0f} MiB  "
                  f"temp={g.get('temp', 0):>3.0f}C  "
                  f"pwr={g.get('power_w', 0):>5.0f}W/{g.get('power_limit', 0):>4.0f}W")
    else:
        print("no GPU detected (nvidia-smi not available)")
    print()
    if sys_["counts"]["running"] or sys_["counts"]["queued"]:
        print("tasks:")
        for t in client.request("GET", "/api/tasks", params={"limit": args.limit})["data"]:
            if t["status"] in ("queued", "running"):
                print(print_task_row(t))


def cmd_logs(args):
    client = build_client(args)
    params = {"limit": args.limit}
    if args.q:
        params["q"] = args.q
    if not args.follow:
        data = client.request("GET", f"/api/tasks/{args.id}/logs", params=params)["data"]
        if data["total"] == 0:
            print(f"(no log output yet — status {data['status']})")
        for line in data["lines"]:
            print(line)
        return
    # follow mode: print new lines as they appear
    offset = -1
    printed = 0
    while True:
        data = client.request("GET", f"/api/tasks/{args.id}/logs",
                              params={**params, "offset": offset})["data"]
        lines = data["lines"]
        if offset < 0:
            for line in lines:
                print(line)
            printed = len(lines)
        elif len(lines) > printed:
            for line in lines[printed:]:
                print(line)
            printed = len(lines)
        offset = data["next_offset"]
        if data["status"] not in ("queued", "running"):
            # keep polling briefly in case output lands right at exit
            if not lines and printed == 0:
                time.sleep(1)
                continue
            break
        time.sleep(1)


def cmd_cancel(args):
    client = build_client(args)
    resp = client.request("DELETE", f"/api/tasks/{args.id}")
    print(f"cancelled {resp['data']['deleted']}")


def cmd_rerun(args):
    client = build_client(args)
    resp = client.request("POST", f"/api/tasks/{args.id}/rerun")
    print(f"re-queued as {resp['data']['id']}")


def cmd_queue(args):
    client = build_client(args)
    if args.action == "pause":
        resp = client.request("POST", "/api/queue/pause", {"reason": args.reason or "manual"})
        print(f"queue paused: {resp['data']['reason']}")
    else:
        resp = client.request("POST", "/api/queue/resume")
        print("queue resumed")


def cmd_metrics(args):
    client = build_client(args)
    params = {}
    if args.gpu:
        params["gpu"] = args.gpu
    if args.from_:
        params["from"] = args.from_
    if args.to:
        params["to"] = args.to
    if args.step:
        params["step"] = args.step
    data = client.request("GET", "/api/metrics", params=params)["data"]
    if args.gpu:
        series = data["gpus"].get(args.gpu, [])
    else:
        series = data["gpus"].get("0", [])
    print(f"host_metrics_available={data['host_available']}  points={len(series)}")
    print("ts                 util%   mem_MB  tempC  pwr_W   sm_MHz")
    for r in series[-int(args.limit):]:
        ts = time.strftime("%m-%d %H:%M:%S", time.localtime(r["ts"]))
        print(f"{ts}  {r.get('gpu_util') or 0:>6.0f}  {r.get('mem_used') or 0:>7.0f} "
              f"{r.get('temp') or 0:>5.0f}  {r.get('power_w') or 0:>5.0f}  "
              f"{r.get('sm_clock') or 0:>6.0f}")


def cmd_gpu(args):
    client = build_client(args)
    sys_ = client.request("GET", "/api/system")["data"]
    if not sys_["gpus"]:
        print("no GPU detected (nvidia-smi not available)")
        return
    for g in sys_["gpus"]:
        print(f"GPU {int(g['index'])}: {g.get('name', '')}")
        print(f"  util   : {g.get('gpu_util', 0):.0f}%   mem_util: {g.get('mem_util', 0):.0f}%")
        print(f"  memory : {g.get('mem_used', 0):.0f} / {g.get('mem_total', 0):.0f} MiB free")
        print(f"  temp   : {g.get('temp', 0):.0f}C   power: {g.get('power_w', 0):.0f} W "
              f"(limit {g.get('power_limit', 0):.0f} W)")
        print(f"  clocks : sm {g.get('sm_clock', 0):.0f} MHz   mem {g.get('mem_clock', 0):.0f} MHz")
        print()


def cmd_version(args):
    print(f"gpuq {__version__}")
    print(f"server: http://{args.host}:{args.port}")


# ---------------- arg parsing ----------------

def _add_conn(parser: argparse.ArgumentParser):
    parser.add_argument("--host", default=None, help="gpuq server host (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="gpuq server port (default 8765)")
    parser.add_argument("--key", default="", help="X-Api-Key for the server, if configured")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="gpuq",
        description="GPU job queue with WebUI + metrics. See https://github.com/Weidows/gpuq",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_serve = sub.add_parser("serve", help="run the server in the foreground")
    p_serve.add_argument("--config", default=None, help="path to config.json")
    p_serve.add_argument("--host", default=None)
    p_serve.add_argument("--port", type=int, default=None)
    p_serve.add_argument("--data", default=None, help="data directory (overrides config)")
    p_serve.add_argument("--gpu-bin", default=None, help="path to nvidia-smi")
    p_serve.set_defaults(func=cmd_serve)

    p_sub = sub.add_parser("submit", help="submit a task (everything after -- is the command)")
    _add_conn(p_sub)
    p_sub.add_argument("--project", default="")
    p_sub.add_argument("--user", default="")
    p_sub.add_argument("--gpu", default=None, help="GPU index, omit for auto-allocate")
    p_sub.add_argument("--vram", type=int, default=0, help="estimated VRAM MiB")
    p_sub.add_argument("--est", type=int, default=0, help="estimated seconds")
    p_sub.add_argument("--priority", type=int, default=5)
    p_sub.add_argument("--fallback-wait", type=int, default=0,
                       help="startup window (s); exiting within it auto-pauses the queue")
    p_sub.add_argument("--cwd", default=None)
    p_sub.add_argument("--env", action="append", default=[], metavar="K=V",
                       help="extra env var (repeatable)")
    p_sub.add_argument("--task-key", default="", help="platform API key recorded on the task")
    p_sub.add_argument("--version", default="", help="code/commit version for traceability")
    p_sub.add_argument("--power-limit", type=int, default=None, help="nvidia-smi -pl watts")
    p_sub.add_argument("command", nargs=argparse.REMAINDER, help="command after --")
    p_sub.set_defaults(func=cmd_submit)

    p_list = sub.add_parser("list", help="list tasks")
    _add_conn(p_list)
    p_list.add_argument("--status", choices=["queued", "running", "succeeded", "failed", "cancelled"])
    p_list.add_argument("--project")
    p_list.add_argument("--user")
    p_list.add_argument("--limit", type=int, default=50)
    p_list.set_defaults(func=cmd_list)

    p_status = sub.add_parser("status", help="queue + GPU overview")
    _add_conn(p_status)
    p_status.add_argument("--limit", type=int, default=20)
    p_status.set_defaults(func=cmd_status)

    p_logs = sub.add_parser("logs", help="tail task logs")
    _add_conn(p_logs)
    p_logs.add_argument("id")
    p_logs.add_argument("--q", default="", help="only lines containing this substring")
    p_logs.add_argument("--limit", type=int, default=500)
    p_logs.add_argument("--follow", action="store_true", help="tail -f")
    p_logs.set_defaults(func=cmd_logs)

    p_cancel = sub.add_parser("cancel", help="cancel / kill a task")
    _add_conn(p_cancel)
    p_cancel.add_argument("id")
    p_cancel.set_defaults(func=cmd_cancel)

    p_rerun = sub.add_parser("rerun", help="clone + re-queue a finished task")
    _add_conn(p_rerun)
    p_rerun.add_argument("id")
    p_rerun.set_defaults(func=cmd_rerun)

    p_queue = sub.add_parser("queue", help="pause / resume the queue")
    _add_conn(p_queue)
    p_queue.add_argument("action", choices=["pause", "resume"])
    p_queue.add_argument("--reason", default="")
    p_queue.set_defaults(func=cmd_queue)

    p_met = sub.add_parser("metrics", help="chart-ready time series")
    _add_conn(p_met)
    p_met.add_argument("--gpu", default=None)
    p_met.add_argument("--from", dest="from_", default=None, help="unix epoch start")
    p_met.add_argument("--to", default=None, help="unix epoch end")
    p_met.add_argument("--step", type=int, default=None, help="bucket seconds")
    p_met.add_argument("--limit", type=int, default=50)
    p_met.set_defaults(func=cmd_metrics)

    p_gpu = sub.add_parser("gpu", help="live GPU status")
    _add_conn(p_gpu)
    p_gpu.set_defaults(func=cmd_gpu)

    p_ver = sub.add_parser("version", help="print version")
    _add_conn(p_ver)
    p_ver.set_defaults(func=cmd_version)

    args = parser.parse_args(argv)
    # resolve connection defaults after parse (host/port may be None)
    if args.cmd != "serve":
        cfg = load_config(None)
        if args.host is None:
            args.host = cfg["host"]
        if args.port is None:
            args.port = cfg["port"]
    args.func(args)


if __name__ == "__main__":
    main()
