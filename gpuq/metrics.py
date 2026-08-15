"""Background metric sampler.

Every `metrics_interval` seconds it pulls live GPU state from nvidia-smi plus
host net/disk/CPU counters (via psutil when available) and stores one row per
GPU plus a host-only row (gpu_id="-1"). Each row is tagged with the task_id
that the scheduler reports as currently running, so a task's own window can be
charted later.
"""
from __future__ import annotations

import threading
import time

from . import gpu as gpu_mod

# optional host metrics
try:
    import psutil

    _HOST = True
except ImportError:
    _HOST = False

_NET_KEY = "net"
_DISK_KEY = "disk"
_CPU_KEY = "cpu"


class Sampler(threading.Thread):
    def __init__(self, db, cfg, state: dict, stop_event: threading.Event):
        super().__init__(name="gpuq-sampler", daemon=True)
        self.db = db
        self.cfg = cfg
        self.state = state          # shared dict, scheduler writes running_task_id
        self.stop_event = stop_event
        self._prev = {"net": None, "disk": None, "cpu_last": 0.0}
        self._last_cpu = 0.0

    def run(self):
        while not self.stop_event.wait(self.cfg["metrics_interval"]):
            try:
                self._sample()
            except Exception as e:  # never kill the sampler
                print(f"[gpuq] sampler error: {e}")

    # ----- host counters (psutil) -----

    def _host_rates(self):
        if not _HOST:
            return {"net_rx": None, "net_tx": None, "disk_io": None, "cpu": None}
        now = time.time()
        net = psutil.net_io_counters()
        disk = psutil.disk_io_counters()
        cpu = psutil.cpu_percent(interval=None)
        host = {"net_rx": None, "net_tx": None, "disk_io": None, "cpu": cpu}
        if self._prev["net"] is not None:
            dt = max(now - self._prev["t"], 0.001)
            host["net_rx"] = (net.bytes_recv - self._prev["net"].bytes_recv) / dt
            host["net_tx"] = (net.bytes_sent - self._prev["net"].bytes_sent) / dt
        if self._prev["disk"] is not None:
            dt = max(now - self._prev["t"], 0.001)
            host["disk_io"] = (disk.read_bytes + disk.write_bytes
                               - self._prev["disk"].read_bytes
                               - self._prev["disk"].write_bytes) / dt
        self._prev.update({"net": net, "disk": disk, "t": now})
        return host

    # ----- main sample -----

    def _sample(self):
        gpus = gpu_mod.query_gpus(self.cfg["gpu_bin"])
        host = self._host_rates()
        task_id = self.state.get("running_task_id")
        ts = time.time()
        rows = []
        for g in gpus:
            rows.append({
                "ts": ts, "gpu_id": str(g["index"]),
                "gpu_util": g.get("gpu_util"), "mem_used": g.get("mem_used"),
                "mem_total": g.get("mem_total"), "temp": g.get("temp"),
                "power_w": g.get("power_w"), "sm_clock": g.get("sm_clock"),
                "pcie_util": g.get("pcie_util"),
                "net_rx": host["net_rx"], "net_tx": host["net_tx"],
                "disk_io": host["disk_io"], "cpu": host["cpu"],
                "task_id": task_id,
            })
        if gpus:
            rows.append({
                "ts": ts, "gpu_id": "-1",
                "gpu_util": None, "mem_used": None, "mem_total": None,
                "temp": None, "power_w": None, "sm_clock": None, "pcie_util": None,
                "net_rx": host["net_rx"], "net_tx": host["net_tx"],
                "disk_io": host["disk_io"], "cpu": host["cpu"],
                "task_id": task_id,
            })
        self.db.insert_metrics(rows)


def host_available() -> bool:
    return _HOST
