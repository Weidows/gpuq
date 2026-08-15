"""Configuration loading: JSON file + environment variable overrides.

Resolution order (first match wins):
  1. --config flag (CLI) / GPUQ_CONFIG env var
  2. ./config.json (user-local, gitignored)
  3. ./config.example.json (shipped defaults)
  4. built-in DEFAULTS
"""
from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULTS = {
    "host": "127.0.0.1",            # bind address (0.0.0.0 to expose)
    "port": 8765,                   # REST API + WebUI port
    "poll_interval": 2.0,           # scheduler dispatch cycle (s)
    "metrics_interval": 5.0,        # GPU/host sampling interval (s)
    "vram_headroom_mb": 512,        # free-VRAM safety margin for scheduling
    "api_keys": [],                 # if non-empty, X-Api-Key must match one of these
    "default_power_limit_w": None,  # optional nvidia-smi -pl applied to every task
    "data_dir": "data",             # sqlite db + logs/ live here
    "gpu_bin": "nvidia-smi",
    "log_level": "INFO",
}

# env var -> config key. Nested types are coerced based on DEFAULTS' type.
ENV_MAP = {
    "GPUQ_HOST": "host",
    "GPUQ_PORT": "port",
    "GPUQ_DATA": "data_dir",
    "GPUQ_API_KEYS": "api_keys",
    "GPUQ_DEFAULT_POWER_LIMIT": "default_power_limit_w",
    "GPUQ_POLL_INTERVAL": "poll_interval",
    "GPUQ_METRICS_INTERVAL": "metrics_interval",
    "GPUQ_VRAM_HEADROOM": "vram_headroom_mb",
    "GPUQ_GPU_BIN": "gpu_bin",
}


def _coerce(key: str, raw: str):
    default = DEFAULTS[key]
    if isinstance(default, bool):
        return raw.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(default, int):
        return int(raw)
    if isinstance(default, float):
        return float(raw)
    if key == "api_keys":
        return [k.strip() for k in raw.split(",") if k.strip()]
    return raw


def find_config(explicit: str | None = None) -> str | None:
    if explicit:
        return explicit
    if os.environ.get("GPUQ_CONFIG"):
        return os.environ["GPUQ_CONFIG"]
    for name in ("config.json", "config.example.json"):
        p = Path(name)
        if p.is_file():
            return str(p)
    return None


def load_config(explicit: str | None = None) -> dict:
    cfg = dict(DEFAULTS)
    path = find_config(explicit)
    if path:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for k, v in data.items():
            if k in DEFAULTS:
                cfg[k] = v
            else:
                print(f"[gpuq] warning: ignoring unknown config key '{k}'")
    for env, key in ENV_MAP.items():
        if env in os.environ:
            cfg[key] = _coerce(key, os.environ[env])
    # resolve relative data_dir against the cwd the server started in
    cfg["data_dir"] = str(Path(cfg["data_dir"]).resolve())
    return cfg
