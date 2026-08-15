"""REST API + WebUI static serving (ThreadingHTTPServer, stdlib only).

Auth: if config.api_keys is non-empty, every /api/* request must carry a
matching X-Api-Key header. With no keys configured the API is open (bound to
127.0.0.1 by default) — local-first by design.

Endpoints (all JSON):
  POST /api/tasks | /api/submit      submit a task
  GET  /api/tasks                    list (filters: status/project/user/since)
  GET  /api/tasks/{id}               detail + aggregated metrics
  PATCH /api/tasks/{id}              edit a queued task
  DELETE /api/tasks/{id}             cancel / kill
  POST /api/tasks/{id}/rerun         clone + re-queue
  GET  /api/tasks/{id}/logs          tail / grep logs (?offset&limit&q)
  GET  /api/tasks/{id}/metrics       metrics inside the task's window
  GET  /api/metrics                  chart series (?gpu&from&to&step)
  GET  /api/system                   live GPU state + queue state
  POST /api/queue/pause | /resume
  GET  /api/openapi.json             machine-readable endpoint summary
"""
from __future__ import annotations

import json
import re
import time
import traceback
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from . import gpu as gpu_mod
from .metrics import host_available

MAX_LOG_BYTES = 2_000_000  # tail window read backwards from EOF
LOG_CHUNK = 64 * 1024


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class API:
    """Holds server-wide wiring; attached to the HTTPServer as .ctx."""

    def __init__(self, db, cfg, state, scheduler):
        self.db = db
        self.cfg = cfg
        self.state = state
        self.scheduler = scheduler

    # ---------- auth ----------

    def check_key(self, headers) -> bool:
        keys = self.cfg.get("api_keys") or []
        if not keys:
            return True  # no auth configured
        provided = headers.get("x-api-key", "")
        return provided in keys

    # ---------- task payload validation ----------

    def parse_task(self, body: dict) -> tuple[dict | None, str | None]:
        cmd = body.get("command")
        if not cmd:
            return None, "'command' is required (list of program + args, or a string)"
        if isinstance(cmd, str):
            cmd = cmd.split()
        if not isinstance(cmd, list) or not cmd or not all(isinstance(c, str) for c in cmd):
            return None, "'command' must be a non-empty list of strings"
        task = {
            "id": body.get("id") or uuid.uuid4().hex[:12],
            "project": str(body.get("project", "") or ""),
            "username": str(body.get("username", "") or ""),
            "gpu_id": body.get("gpu_id"),
            "vram_mb": int(body.get("vram_mb") or 0),
            "est_seconds": int(body.get("est_seconds") or 0),
            "priority": int(body.get("priority") or 5),
            "command": cmd,
            "cwd": body.get("cwd") or None,
            "env": body.get("env") or {},
            "fallback_wait_seconds": int(body.get("fallback_wait_seconds") or 0),
            "api_key": str(body.get("api_key", "") or ""),
            "version": str(body.get("version", "") or ""),
            "power_limit_w": body.get("power_limit_w"),
        }
        if task["power_limit_w"] is not None:
            task["power_limit_w"] = int(task["power_limit_w"])
        if not isinstance(task["env"], dict):
            return None, "'env' must be an object of string key/values"
        task["env"] = {str(k): str(v) for k, v in task["env"].items()}
        return task, None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "gpuq/0.1"

    @property
    def ctx(self) -> API:
        return self.server.ctx  # type: ignore[attr-defined]

    # ---------- plumbing ----------

    def log_message(self, fmt, *args):
        return  # keep the console clean; errors go to stderr via send_error

    # BaseHTTPRequestHandler dispatches by method name — route them all.
    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PATCH(self):
        self._route()

    def do_DELETE(self):
        self._route()

    def do_OPTIONS(self):
        self._route()

    def _send(self, code: int, payload: dict, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json_ok(self, data):
        self._send(200, {"ok": True, "data": data})

    def _json_err(self, code: int, error: str):
        self._send(code, {"ok": False, "error": error})

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    # ---------- routing ----------

    def _route(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        method = self.command
        headers = {k.lower(): v for k, v in self.headers.items()}
        cors = method == "OPTIONS"
        if cors:
            self._send(204, {})
            return

        if path.startswith("/api"):
            if not self.ctx.check_key(headers):
                self._json_err(401, "invalid or missing X-Api-Key")
                return
            if not self._api_route(method, path, query, headers):
                self._json_err(404, f"no such endpoint: {method} {path}")
            return

        if path in ("/", "/index.html") and method == "GET":
            self._serve_static("index.html")
            return
        if path.startswith("/app.js"):
            self._serve_static("app.js")
            return
        if path.startswith("/style.css"):
            self._serve_static("style.css")
            return
        if path.startswith("/vendor/"):
            self._serve_static(path.lstrip("/"))
            return
        self._json_err(404, f"not found: {method} {path}")

    # ---------- API endpoints ----------

    def _api_route(self, method, path, query, headers) -> bool:
        ctx = self.ctx

        # ---- tasks collection ----
        if method == "POST" and path in ("/api/tasks", "/api/submit"):
            task, err = ctx.parse_task(self._read_body())
            if err:
                self._json_err(400, err)
                return True
            if ctx.db.get_task(task["id"]):
                self._json_err(409, f"task id '{task['id']}' already exists")
                return True
            created = ctx.db.create_task(task)
            self._send(201, {"ok": True, "data": created})
            return True

        if method == "GET" and path == "/api/tasks":
            kw = {}
            if query.get("status"):
                kw["status"] = query["status"][0]
            if query.get("project"):
                kw["project"] = query["project"][0]
            if query.get("user"):
                kw["username"] = query["user"][0]
            if query.get("since"):
                kw["since"] = query["since"][0]
            limit = min(int(query.get("limit", ["100"])[0]), 1000)
            self._json_ok(ctx.db.list_tasks(**kw, limit=limit))
            return True

        # ---- single task ----
        m = re.match(r"^/api/tasks/([^/]+)$", path)
        m_log = re.match(r"^/api/tasks/([^/]+)/logs$", path)
        m_met = re.match(r"^/api/tasks/([^/]+)/metrics$", path)
        m_rerun = re.match(r"^/api/tasks/([^/]+)/rerun$", path)

        if m:
            task_id = m.group(1)
            if method == "GET":
                task = ctx.db.get_task(task_id)
                if not task:
                    self._json_err(404, f"task '{task_id}' not found")
                    return True
                out = dict(task)
                out["agg"] = ctx.db.task_agg(task_id)
                self._json_ok(out)
                return True
            if method == "PATCH":
                task = ctx.db.get_task(task_id)
                if not task:
                    self._json_err(404, f"task '{task_id}' not found")
                    return True
                if task["status"] != "queued":
                    self._json_err(409, "only queued tasks can be edited")
                    return True
                body = self._read_body()
                merged = {k: v for k, v in task.items() if k != "id"}
                for k in ("project", "username", "gpu_id", "vram_mb", "est_seconds",
                          "priority", "command", "cwd", "env", "fallback_wait_seconds",
                          "api_key", "version", "power_limit_w"):
                    if k in body:
                        merged[k] = body[k]
                patch, err = ctx.parse_task(merged)
                if err:
                    self._json_err(400, err)
                    return True
                self._json_ok(ctx.db.update_task(task_id, patch))
                return True
            if method == "DELETE":
                if not ctx.db.get_task(task_id):
                    self._json_err(404, f"task '{task_id}' not found")
                    return True
                ctx.scheduler.cancel(task_id)
                ctx.db.delete_task(task_id)
                self._json_ok({"deleted": task_id})
                return True

        if m_log and method == "GET":
            return self._logs(m_log.group(1), query)

        if m_met and method == "GET":
            task = ctx.db.get_task(m_met.group(1))
            if not task:
                self._json_err(404, "task not found")
                return True
            self._json_ok(ctx.db.task_metrics(m_met.group(1)))
            return True

        if m_rerun and method == "POST":
            task = ctx.db.get_task(m_rerun.group(1))
            if not task:
                self._json_err(404, f"task '{m_rerun.group(1)}' not found")
                return True
            clone = {k: v for k, v in task.items()
                     if k in ("project", "username", "gpu_id", "vram_mb", "est_seconds",
                              "priority", "command", "cwd", "env", "fallback_wait_seconds",
                              "api_key", "version", "power_limit_w")}
            created = ctx.db.create_task(clone)
            self._send(201, {"ok": True, "data": created})
            return True

        # ---- metrics / system / queue ----
        if method == "GET" and path == "/api/metrics":
            self._json_ok(self._metrics(query))
            return True

        if method == "GET" and path == "/api/system":
            self._json_ok(self._system())
            return True

        if method == "POST" and path == "/api/queue/pause":
            body = self._read_body()
            ctx.state["paused"] = True
            ctx.state["pause_reason"] = body.get("reason") or "paused by API"
            self._json_ok({"paused": True, "reason": ctx.state["pause_reason"]})
            return True

        if method == "POST" and path == "/api/queue/resume":
            ctx.state["paused"] = False
            ctx.state["pause_reason"] = None
            ctx.state["pause_task_id"] = None
            self._json_ok({"paused": False})
            return True

        if method == "GET" and path == "/api/openapi.json":
            self._send(200, {"ok": True, "data": OPENAPI})
            return True

        return False

    # ---------- endpoint implementations ----------

    def _logs(self, task_id: str, query) -> bool:
        task = self.ctx.db.get_task(task_id)
        if not task:
            self._json_err(404, f"task '{task_id}' not found")
            return True
        log_file = task.get("log_file")
        if not log_file or not Path(log_file).is_file():
            self._json_ok({"offset": 0, "next_offset": 0, "total": 0, "lines": [],
                           "task_id": task_id, "status": task["status"]})
            return True
        limit = min(int(query.get("limit", ["500"])[0]), 5000)
        want_q = query.get("q", [""])[0]
        offset = int(query.get("offset", ["-1"])[0])  # -1 = last `limit` lines
        offset, lines, next_offset, total = self._read_log(log_file, offset, limit, want_q)
        self._json_ok({"offset": offset, "next_offset": next_offset, "total": total,
                       "lines": lines, "task_id": task_id, "status": task["status"]})
        return True

    @staticmethod
    def _read_log(path: str, offset: int, limit: int, want_q: str):
        """Read lines from a byte offset; offset=-1 reads backwards from EOF."""
        with open(path, "rb") as f:
            f.seek(0, 2)
            total = f.tell()
            start_offset, next_offset = offset, offset
            if offset < 0 or offset > total:
                # walk backwards in chunks until we have more than `limit` lines
                pos, buf, seen = total, b"", 0
                while pos > 0 and seen <= limit:
                    start = max(pos - LOG_CHUNK, 0)
                    f.seek(start)
                    chunk = f.read(pos - start)
                    buf = chunk + buf
                    seen = chunk.count(b"\n")
                    pos = start
                line_starts = []
                p = 0
                for line in buf.splitlines(keepends=True):
                    line_starts.append(p)
                    p += len(line)
                lines = buf.splitlines()
                kept = lines[-limit:]
                if kept:
                    start_offset = pos + line_starts[len(line_starts) - len(kept)]
                else:
                    start_offset = total
                next_offset = total
            else:
                f.seek(offset)
                data = f.read(MAX_LOG_BYTES)
                kept = data.splitlines()[:limit]
                next_offset = offset + len(data)
        text_lines = [l.decode("utf-8", errors="replace") for l in kept]
        if want_q:
            text_lines = [l for l in text_lines if want_q in l]
        return start_offset, text_lines, next_offset, total

    def _metrics(self, query) -> dict:
        db = self.ctx.db
        step = int(query.get("step", ["0"])[0]) or None
        start = None
        end = None
        if query.get("from"):
            start = float(query["from"][0])
        if query.get("to"):
            end = float(query["to"][0])
        gpus = {}
        gpu_ids = [str(g["index"]) for g in gpu_mod.query_gpus(self.ctx.cfg["gpu_bin"])]
        if not gpu_ids:
            gpu_ids = ["0"]
        for gid in gpu_ids:
            gpus[gid] = db.query_metrics(gid, start, end, step)
        host = db.query_metrics("-1", start, end, step)
        return {"gpus": gpus, "host": host, "step": step, "host_available": host_available()}

    def _system(self) -> dict:
        gpus = gpu_mod.query_gpus(self.ctx.cfg["gpu_bin"])
        state = {k: self.ctx.state.get(k) for k in
                 ("paused", "pause_reason", "pause_task_id", "running_task_id", "running_gpu")}
        running = self.ctx.db.running_tasks()
        queued = self.ctx.db.queued_tasks()
        return {
            "gpus": gpus,
            "queue": state,
            "counts": {
                "queued": len(queued),
                "running": len(running),
                "total": len(self.ctx.db.list_tasks(limit=1000)),
            },
            "host_available": host_available(),
            "server": {"version": "0.1.0", "host": self.ctx.cfg["host"],
                       "port": self.ctx.cfg["port"], "uptime": int(time.time() - self.ctx._boot)},
        }

    def _serve_static(self, name: str):
        root = Path(self.ctx.cfg["webui_dir"])
        # only allow files inside webui/ (flattened top level, plus vendor/)
        rel = name.replace("\\", "/")
        if rel.startswith("vendor/"):
            rel = rel[len("vendor/"):]
            if "/" in rel or ".." in rel:
                self._send(404, {"ok": False, "error": "bad path"})
                return
            p = root / "vendor" / rel
        else:
            if "/" in rel or ".." in rel:
                self._send(404, {"ok": False, "error": "bad path"})
                return
            p = root / rel
        if not p.is_file():
            self._send(404, {"ok": False, "error": f"{name} not found"})
            return
        ctype = {"html": "text/html; charset=utf-8", "js": "application/javascript",
                 "css": "text/css; charset=utf-8", "min.js": "application/javascript"}[
            "min.js" if name.endswith(".min.js") else name.rsplit(".", 1)[-1]]
        body = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, ctx: API):
        self.ctx = ctx
        super().__init__(addr, Handler)

    def handle_error(self, request, client_address):
        # keep a broken client connection from killing the server loop
        traceback.print_exc()


def make_server(db, cfg, state, scheduler) -> Server:
    ctx = API(db, cfg, state, scheduler)
    ctx._boot = time.time()
    ctx.cfg["webui_dir"] = str(Path(__file__).resolve().parent / "webui")
    return Server((cfg["host"], cfg["port"]), ctx)


TASK_SCHEMA = {
    "type": "object",
    "required": ["command"],
    "properties": {
        "command": {"type": ["array", "string"],
                    "description": "argv list, e.g. [\"python\",\"main.py\",\"--epochs\",\"10\"]"},
        "project": {"type": "string", "description": "project name, used for grouping/filtering"},
        "username": {"type": "string"},
        "gpu_id": {"type": ["string", "null"], "description": "null = auto-allocate"},
        "vram_mb": {"type": "integer", "description": "estimated VRAM in MiB (scheduling hint)"},
        "est_seconds": {"type": "integer", "description": "estimated runtime in seconds"},
        "priority": {"type": "integer", "default": 5, "description": "higher = sooner"},
        "cwd": {"type": "string", "description": "working directory for the task"},
        "env": {"type": "object", "description": "extra environment variables"},
        "fallback_wait_seconds": {"type": "integer",
                                  "description": "startup window; exiting within it auto-pauses the queue"},
        "api_key": {"type": "string", "description": "platform auth key attached to the submission"},
        "version": {"type": "string", "description": "code/commit version for traceability"},
        "power_limit_w": {"type": "integer", "description": "nvidia-smi -pl cap while running (needs privileges)"},
    },
}

OPENAPI = {
    "openapi": "3.0.0",
    "info": {"title": "gpuq", "version": "0.1.0",
             "description": "GPU job queue. Auth via X-Api-Key header (only when api_keys configured)."},
    "paths": {
        "/api/tasks": {"post": {"summary": "submit a task", "requestBody": {
            "content": {"application/json": {"schema": TASK_SCHEMA}}}},
            "get": {"summary": "list tasks (filters: status, project, user, since, limit)"}},
        "/api/tasks/{id}": {"get": {"summary": "task detail + agg metrics"},
                             "patch": {"summary": "edit a queued task"},
                             "delete": {"summary": "cancel/kill + delete"}},
        "/api/tasks/{id}/logs": {"get": {"summary": "tail/grep logs (?offset&limit&q)"}},
        "/api/tasks/{id}/metrics": {"get": {"summary": "metrics inside the task's window"}},
        "/api/tasks/{id}/rerun": {"post": {"summary": "clone + re-queue"}},
        "/api/metrics": {"get": {"summary": "chart series (?gpu&from&to&step)"}},
        "/api/system": {"get": {"summary": "live GPU + queue state"}},
        "/api/queue/pause": {"post": {"summary": "pause the queue (body: reason)"}},
        "/api/queue/resume": {"post": {"summary": "resume the queue"}},
    },
}
