"""nvidia-smi wrapper: live GPU metrics, power-limit get/set.

All output parsing tolerates missing values (e.g. WDDM on Windows reports
some clocks as N/A) by coercing to None instead of crashing.

When the GPUQ_FAKE_GPU env var is set (CI runners have no GPU), a synthetic
GPU is returned instead of shelling out to nvidia-smi, so the scheduler and
metric pipeline are still exercised end-to-end.
"""
from __future__ import annotations

import os
import subprocess
import time
from typing import Optional

QUERY_FIELDS = {
    "index": "gpu_index",
    "name": "name",
    "uuid": "uuid",
    "utilization.gpu": "gpu_util",
    "utilization.memory": "mem_util",
    "memory.used": "mem_used",
    "memory.total": "mem_total",
    "temperature.gpu": "temp",
    "power.draw": "power_w",
    "power.limit": "power_limit",
    "power.max_limit": "power_max",
    "power.min_limit": "power_min",
    "clocks.sm": "sm_clock",
    "clocks.mem": "mem_clock",
    "pcie.link.gen.current": "pcie_gen",
}

FIELD_ORDER = list(QUERY_FIELDS.keys())


def _fake_gpus() -> list[dict]:
    """Synthetic GPU for environments without nvidia-smi (CI)."""
    t = time.time()
    util = 5.0 + 10.0 * ((t % 7) / 7)  # gently varies so charts aren't flat
    return [{
        "gpu_index": 0.0, "name": "Fake GPU (CI)", "uuid": None,
        "gpu_util": util, "mem_util": 4.0,
        "mem_used": 1200.0, "mem_total": 8192.0,
        "temp": 45.0, "power_w": 60.0, "power_limit": 250.0,
        "power_max": 250.0, "power_min": 100.0,
        "sm_clock": 1500.0, "mem_clock": 5000.0, "pcie_gen": 4.0,
        "index": 0, "free_mb": 8192.0 - 1200.0,
    }]


def _num(value: str) -> Optional[float]:
    value = value.strip().replace(" MiB", "").replace(" MHz", "").replace(" W", "")
    if value in ("", "[N/A]", "N/A", "Not Supported"):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def query_gpus(gpu_bin: str = "nvidia-smi") -> list[dict]:
    """Return one dict per GPU with normalized keys (see QUERY_FIELDS)."""
    if os.environ.get("GPUQ_FAKE_GPU"):
        return _fake_gpus()
    cmd = [gpu_bin, "--query-gpu=" + ",".join(FIELD_ORDER), "--format=csv,noheader,nounits"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    gpus = []
    for line in out.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != len(FIELD_ORDER):
            continue
        gpu = {}
        for key, value in zip(FIELD_ORDER, parts):
            gpu[QUERY_FIELDS[key]] = _num(value) if QUERY_FIELDS[key] != "name" else value
        gpu["index"] = int(gpu.get("gpu_index") or 0)
        gpu["free_mb"] = (gpu.get("mem_total") or 0) - (gpu.get("mem_used") or 0)
        gpus.append(gpu)
    return gpus


def set_power_limit(gpu_bin: str, gpu_index: int, watts: int) -> tuple[bool, str]:
    """Set power limit. Returns (ok, message). Requires root/admin privileges."""
    if os.environ.get("GPUQ_FAKE_GPU"):
        return True, f"power limit of GPU {gpu_index} set to {watts} W (fake)"
    try:
        r = subprocess.run(
            [gpu_bin, "-i", str(gpu_index), "-pl", str(int(watts))],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return True, f"power limit of GPU {gpu_index} set to {watts} W"
        return False, (r.stderr or r.stdout or "nvidia-smi -pl failed").strip()
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, str(e)


def restore_power_limit(gpu_bin: str, gpu_index: int, watts: int) -> None:
    """Best-effort restore of a previous limit; failures are silent."""
    if watts is None:
        return
    set_power_limit(gpu_bin, gpu_index, watts)
