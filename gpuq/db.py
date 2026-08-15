"""SQLite storage: tasks, metrics, queue state (kv).

One connection, guarded by a lock (WAL journaling so readers never block).
Timestamps: tasks use ISO-8601 strings, metrics use unix epoch floats.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL DEFAULT '',
    username    TEXT NOT NULL DEFAULT '',
    gpu_id      TEXT,
    vram_mb     INTEGER DEFAULT 0,
    est_seconds INTEGER DEFAULT 0,
    priority    INTEGER DEFAULT 5,
    command     TEXT NOT NULL,          -- JSON list of argv
    cwd         TEXT,
    env         TEXT,                   -- JSON dict of extra env vars
    fallback_wait_seconds INTEGER DEFAULT 0,
    api_key     TEXT DEFAULT '',
    version     TEXT DEFAULT '',
    power_limit_w INTEGER,
    status      TEXT NOT NULL DEFAULT 'queued',
    created_at  TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT,
    exit_code   INTEGER,
    pid         INTEGER,
    log_file    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);

CREATE TABLE IF NOT EXISTS metrics (
    ts       REAL NOT NULL,
    gpu_id   TEXT NOT NULL,             -- '-1' = host-only row (net/disk/cpu)
    gpu_util REAL, mem_used REAL, mem_total REAL,
    temp     REAL, power_w REAL, sm_clock REAL, pcie_util REAL,
    net_rx   REAL, net_tx REAL, disk_io REAL, cpu REAL,
    task_id  TEXT                       -- task that was running at sample time (nullable)
);
CREATE INDEX IF NOT EXISTS idx_metrics_ts   ON metrics(ts);
CREATE INDEX IF NOT EXISTS idx_metrics_gpu  ON metrics(gpu_id, ts);
CREATE INDEX IF NOT EXISTS idx_metrics_task ON metrics(task_id, ts);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY, value TEXT
);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_kv(value: str):
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


class DB:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self):
        with self._lock:
            self._conn.close()

    # ---------- tasks ----------

    def create_task(self, task: dict) -> dict:
        task = dict(task)
        task.setdefault("id", uuid.uuid4().hex[:12])
        task.setdefault("created_at", _now_iso())
        task.setdefault("status", "queued")
        with self._lock:
            cur = self._conn.execute(
                """INSERT INTO tasks (id, project, username, gpu_id, vram_mb, est_seconds,
                   priority, command, cwd, env, fallback_wait_seconds, api_key, version,
                   power_limit_w, status, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task["id"], task.get("project", ""), task.get("username", ""),
                    task.get("gpu_id"), task.get("vram_mb", 0), task.get("est_seconds", 0),
                    task.get("priority", 5), json.dumps(task.get("command", [])),
                    task.get("cwd"), json.dumps(task.get("env") or {}),
                    task.get("fallback_wait_seconds", 0), task.get("api_key", ""),
                    task.get("version", ""), task.get("power_limit_w"),
                    task["status"], task["created_at"],
                ),
            )
            self._conn.commit()
            return self.get_task(task["id"])

    def get_task(self, task_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            return self._row_task(row) if row else None

    def _row_task(self, row: sqlite3.Row) -> dict:
        t = dict(row)
        t["command"] = json.loads(t.get("command") or "[]")
        try:
            t["env"] = json.loads(t.get("env") or "{}")
        except json.JSONDecodeError:
            t["env"] = {}
        return t

    def list_tasks(self, status=None, project=None, username=None, since=None,
                   limit=100) -> list[dict]:
        sql, args, where = "SELECT * FROM tasks", [], []
        if status:
            where.append("status=?")
            args.append(status)
        if project:
            where.append("project=?")
            args.append(project)
        if username:
            where.append("username=?")
            args.append(username)
        if since:
            where.append("created_at>=?")
            args.append(since)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
            return [self._row_task(r) for r in rows]

    def update_task(self, task_id: str, fields: dict) -> dict | None:
        """Update arbitrary columns (only keys present in the tasks schema)."""
        allowed = {"project", "username", "gpu_id", "vram_mb", "est_seconds", "priority",
                   "command", "cwd", "env", "fallback_wait_seconds", "api_key", "version",
                   "power_limit_w", "status", "started_at", "finished_at", "exit_code",
                   "pid", "log_file"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if "command" in updates:
            updates["command"] = json.dumps(updates["command"])
        if "env" in updates:
            updates["env"] = json.dumps(updates["env"])
        if not updates:
            return self.get_task(task_id)
        sets = ", ".join(f"{k}=?" for k in updates)
        with self._lock:
            self._conn.execute(f"UPDATE tasks SET {sets} WHERE id=?",
                               (*updates.values(), task_id))
            self._conn.commit()
            return self.get_task(task_id)

    def delete_task(self, task_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def running_tasks(self) -> list[dict]:
        return self.list_tasks(status="running", limit=1000)

    def queued_tasks(self) -> list[dict]:
        return self.list_tasks(status="queued", limit=1000)

    # ---------- metrics ----------

    def insert_metrics(self, rows: list[dict]):
        """rows: list of {ts, gpu_id, gpu_util, ..., task_id}"""
        if not rows:
            return
        with self._lock:
            self._conn.executemany(
                """INSERT INTO metrics (ts, gpu_id, gpu_util, mem_used, mem_total, temp,
                   power_w, sm_clock, pcie_util, net_rx, net_tx, disk_io, cpu, task_id)
                   VALUES (:ts, :gpu_id, :gpu_util, :mem_used, :mem_total, :temp,
                   :power_w, :sm_clock, :pcie_util, :net_rx, :net_tx, :disk_io, :cpu, :task_id)""",
                rows,
            )
            self._conn.commit()

    def query_metrics(self, gpu_id: str, start: float | None = None, end: float | None = None,
                      step: int | None = None, limit: int | None = None) -> list[dict]:
        """Time-series with optional bucketing. step in seconds groups by floor(ts/step)."""
        where, args = ["gpu_id=?"], [gpu_id]
        if start is not None:
            where.append("ts>=?"); args.append(start)
        if end is not None:
            where.append("ts<=?"); args.append(end)
        sql = "SELECT "
        if step:
            sql += f"CAST(ts/{step} AS INTEGER)*{step} AS ts, "
            sql += ("AVG(gpu_util) AS gpu_util, AVG(mem_used) AS mem_used, "
                    "AVG(mem_total) AS mem_total, AVG(temp) AS temp, AVG(power_w) AS power_w, "
                    "AVG(sm_clock) AS sm_clock, AVG(pcie_util) AS pcie_util, "
                    "AVG(net_rx) AS net_rx, AVG(net_tx) AS net_tx, AVG(disk_io) AS disk_io, "
                    "AVG(cpu) AS cpu")
        else:
            sql += ("ts, gpu_util, mem_used, mem_total, temp, power_w, sm_clock, pcie_util, "
                    "net_rx, net_tx, disk_io, cpu")
        sql += " FROM metrics WHERE " + " AND ".join(where) + " GROUP BY ts ORDER BY ts"
        if step:
            pass  # bucketed: fine to return all buckets
        elif limit:
            sql += f" LIMIT {int(limit)}"
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
            return [dict(r) for r in rows]

    def task_metrics(self, task_id: str, limit: int = 100000) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """SELECT ts, gpu_util, mem_used, mem_total, temp, power_w, sm_clock,
                          pcie_util, net_rx, net_tx, disk_io, cpu
                   FROM metrics WHERE task_id=? ORDER BY ts LIMIT ?""",
                (task_id, limit)).fetchall()
            return [dict(r) for r in rows]

    def task_agg(self, task_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                """SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts,
                          ROUND(AVG(gpu_util),1) AS avg_util, MAX(gpu_util) AS max_util,
                          ROUND(MAX(mem_used),0) AS peak_mem, ROUND(AVG(temp),1) AS avg_temp,
                          MAX(temp) AS max_temp, ROUND(AVG(power_w),1) AS avg_power,
                          MAX(power_w) AS max_power,
                          ROUND(MAX(net_rx),0) AS peak_net_rx, ROUND(MAX(net_tx),0) AS peak_net_tx,
                          ROUND(MAX(disk_io),0) AS peak_disk_io
                   FROM metrics WHERE task_id=?""", (task_id,)).fetchone()
            return dict(row) if row and row["first_ts"] is not None else None

    # ---------- kv ----------

    def kv_get(self, key: str, default=None):
        with self._lock:
            row = self._conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
            return _parse_kv(row["value"]) if row else default

    def kv_set(self, key: str, value):
        with self._lock:
            self._conn.execute(
                "INSERT INTO kv (key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value)),
            )
            self._conn.commit()
