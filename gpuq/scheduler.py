"""Scheduler: dispatch loop + process management.

Rules:
  * Global queue may be paused (auto-paused when a task exits within its
    fallback_wait window — anything that fast is almost certainly a startup
    crash / smoke test, so we stop the line and surface it instead of
    burning the next task).
  * Tasks are picked by (priority DESC, created_at ASC).
  * A task runs only when a GPU is free (no gpuq task on it) and its free
    VRAM covers vram_mb + headroom. gpu_id=None = auto-allocate.
  * Optional power limit via nvidia-smi -pl (needs privileges; degraded to a
    warning otherwise). Restored when the task finishes.
  * Each task runs as a child process with stdout/stderr streamed to
    data/logs/<task_id>.log; process trees are killed on cancel.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import gpu as gpu_mod

IS_WINDOWS = os.name == "nt"

# shared state dict used by scheduler + sampler + API:
#   paused, pause_reason, pause_task_id,
#   running_task_id, running_gpu
STATE = {}


def make_state() -> dict:
    return {
        "paused": False,
        "pause_reason": None,
        "pause_task_id": None,
        "running_task_id": None,
        "running_gpu": None,
    }


def _kill_tree(pid: int) -> None:
    """Kill a process tree. Windows: taskkill /T /F; POSIX: kill process group."""
    try:
        if IS_WINDOWS:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, text=True, timeout=10)
        else:
            os.killpg(pid, signal.SIGTERM)
            time.sleep(0.5)
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    except Exception:
        pass


class Scheduler(threading.Thread):
    def __init__(self, db, cfg, state: dict, stop_event: threading.Event):
        super().__init__(name="gpuq-scheduler", daemon=True)
        self.db = db
        self.cfg = cfg
        self.state = state
        self.stop_event = stop_event
        self._procs: dict[str, subprocess.Popen] = {}
        self._lock = threading.Lock()

    # ---------------- main loop ----------------

    def run(self):
        while not self.stop_event.wait(self.cfg["poll_interval"]):
            try:
                self._tick()
            except Exception as e:
                print(f"[gpuq] scheduler error: {e}")
        self._shutdown()

    def _tick(self):
        self._reap()
        if self.state.get("paused"):
            return
        self._dispatch()

    # ---------------- reaping finished tasks ----------------

    def _reap(self):
        for task in self.db.running_tasks():
            proc = self._procs.get(task["id"])
            if proc is None:
                # server restarted while a task was running; mark it failed
                self._finalize(task, exit_code=None, reason="lost after restart")
                continue
            rc = proc.poll()
            if rc is not None:
                self._finalize(task, exit_code=rc)

    def _finalize(self, task, exit_code, reason=None):
        duration = 0.0
        if task.get("started_at"):
            try:
                from datetime import datetime
                started = datetime.fromisoformat(task["started_at"].replace("Z", "+00:00"))
                duration = time.time() - started.timestamp()
            except (ValueError, TypeError):
                pass
        if exit_code is None:
            status, note = "failed", reason or "unknown"
        else:
            status = "succeeded" if exit_code == 0 else "failed"
            note = f"exit_code={exit_code}, duration={duration:.1f}s"
        self.db.update_task(task["id"], {
            "status": status, "exit_code": exit_code, "finished_at": _now_iso(),
        })
        self._clear_gpu_state(task)
        self._restore_power(task)
        print(f"[gpuq] task {task['id']} -> {status} ({note})")

        # fallback_wait: startup window — anything exiting this fast parks the queue
        fw = task.get("fallback_wait_seconds") or 0
        if fw > 0 and duration < fw:
            self._pause_queue(task["id"], task["log_file"])

    def _pause_queue(self, task_id: str, log_file: str | None):
        self.state["paused"] = True
        self.state["pause_task_id"] = task_id
        self.state["pause_reason"] = (
            f"task {task_id} exited within its fallback_wait window. "
            f"Log: {log_file}. Fix the job, then resume the queue."
        )
        print(f"[gpuq] QUEUE PAUSED by task {task_id} (startup-window exit)")

    # ---------------- dispatch ----------------

    def _dispatch(self):
        gpus = gpu_mod.query_gpus(self.cfg["gpu_bin"])
        if not gpus:
            return  # no nvidia-smi / no GPU
        running = self.db.running_tasks()
        busy_gpus = {str(t.get("gpu_id")) for t in running if t.get("gpu_id") is not None}
        for task in self.db.queued_tasks():
            gpu = self._pick_gpu(task, gpus, busy_gpus)
            if gpu is None:
                continue  # blocked; a lower-priority task may fit elsewhere
            self._start(task, gpu)
            busy_gpus.add(str(gpu["index"]))
            return  # one new task per tick keeps the loop simple

    def _pick_gpu(self, task, gpus, busy_gpus):
        free_mb = task.get("vram_mb") or 0
        need = free_mb + (self.cfg.get("vram_headroom_mb") or 0)
        candidates = gpus
        if task.get("gpu_id") is not None:
            candidates = [g for g in gpus if str(g["index"]) == str(task["gpu_id"])]
        for g in candidates:
            if str(g["index"]) in busy_gpus:
                continue
            if (g.get("mem_total") or 0) and need > (g.get("free_mb") or 0):
                continue  # existing VRAM pressure (incl. processes outside gpuq)
            return g
        return None

    # ---------------- starting / cancelling ----------------

    def _start(self, task, gpu):
        task_id = task["id"]
        gpu_index = int(gpu["index"])
        logs_dir = Path(self.cfg["data_dir"]) / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        log_file = str(logs_dir / f"{task_id}.log")
        env = os.environ.copy()
        env.update(task.get("env") or {})
        # point CUDA at the allocated GPU unless the task chose its own
        env.setdefault("CUDA_VISIBLE_DEVICES", str(gpu_index))

        self._apply_power(task, gpu_index)
        kwargs = {}
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True

        f = open(log_file, "wb", buffering=0)
        try:
            proc = subprocess.Popen(
                task["command"], cwd=task.get("cwd"), env=env,
                stdout=f, stderr=subprocess.STDOUT, **kwargs,
            )
        except Exception as e:
            f.close()
            self.db.update_task(task_id, {
                "status": "failed", "finished_at": _now_iso(),
                "exit_code": None, "log_file": log_file,
            })
            self._restore_power(task)
            print(f"[gpuq] task {task_id} failed to launch: {e}")
            return

        with self._lock:
            self._procs[task_id] = proc
        self.db.update_task(task_id, {
            "status": "running", "started_at": _now_iso(),
            "pid": proc.pid, "gpu_id": str(gpu_index), "log_file": log_file,
        })
        self.state["running_task_id"] = task_id
        self.state["running_gpu"] = str(gpu_index)
        print(f"[gpuq] task {task_id} started on GPU {gpu_index} (pid {proc.pid})")

    def cancel(self, task_id: str) -> bool:
        task = self.db.get_task(task_id)
        if task is None:
            return False
        if task["status"] == "queued":
            self.db.update_task(task_id, {
                "status": "cancelled", "finished_at": _now_iso(), "exit_code": None,
            })
            return True
        if task["status"] == "running":
            proc = self._procs.get(task_id)
            if proc and proc.poll() is None:
                _kill_tree(proc.pid)
            self._clear_gpu_state(task)
            self._restore_power(task)
            self.db.update_task(task_id, {
                "status": "cancelled", "finished_at": _now_iso(), "exit_code": None,
            })
            return True
        return False

    # ---------------- helpers ----------------

    def _apply_power(self, task, gpu_index: int):
        watts = task.get("power_limit_w")
        if watts is None:
            watts = self.cfg.get("default_power_limit_w")
        if not watts:
            return
        gpus = {g["index"]: g for g in gpu_mod.query_gpus(self.cfg["gpu_bin"])}
        prev = gpus.get(gpu_index, {}).get("power_limit")
        if prev is not None:
            self.db.kv_set(f"pl_prev_{gpu_index}", prev)
        ok, msg = gpu_mod.set_power_limit(self.cfg["gpu_bin"], gpu_index, int(watts))
        if not ok:
            print(f"[gpuq] warning: {msg} (continuing without power limit)")

    def _restore_power(self, task):
        gpu_index = None
        if task.get("gpu_id") is not None:
            gpu_index = int(task["gpu_id"])
        if gpu_index is None:
            return
        prev = self.db.kv_get(f"pl_prev_{gpu_index}")
        gpu_mod.restore_power_limit(self.cfg["gpu_bin"], gpu_index, prev)

    def _clear_gpu_state(self, task):
        with self._lock:
            self._procs.pop(task["id"], None)
        if self.state.get("running_task_id") == task["id"]:
            self.state["running_task_id"] = None
            self.state["running_gpu"] = None

    def _shutdown(self):
        for task in self.db.running_tasks():
            self._restore_power(task)
            proc = self._procs.get(task["id"])
            if proc and proc.poll() is None:
                _kill_tree(proc.pid)
            self.db.update_task(task["id"], {
                "status": "cancelled", "finished_at": _now_iso(), "exit_code": None,
            })


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
