#!/usr/bin/env python3
"""Generate mock gpuq data for the GitHub Pages demo.

Writes a single JS file (`docs/mock-data.js`) defining
`window.__GPUQ_MOCK_DATA` — an initial-state snapshot that `docs/mock-api.js`
loads to bootstrap the in-browser simulation: GPU live state + ~1h of
per-GPU/host metric history + a set of tasks (running / queued / succeeded /
failed / cancelled) with their log lines and in-window metric series.

The output is deterministic for a given seed (only wall-clock timestamps vary
with the current time). `docs/mock-api.js` time-aligns the snapshot to page
load, so the demo always looks fresh no matter when the file was generated.

Usage:
    uv run python scripts/gen_mock_data.py
    uv run python scripts/gen_mock_data.py --seed 7 --hours 2
    uv run python scripts/gen_mock_data.py --json-out /tmp/gpuq-mock   # also dump raw JSON
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import random
import time
from datetime import datetime, timezone

# ---------------------------------------------------------------- hardware --

GPU_SPECS = {
    0: {"name": "NVIDIA GeForce RTX 4090", "mem_total": 24564, "power_limit": 450,
        "power_max": 450, "power_min": 100, "sm_clock": 2520, "mem_clock": 10501, "pcie_gen": 4},
    1: {"name": "NVIDIA GeForce RTX 4090", "mem_total": 24564, "power_limit": 450,
        "power_max": 450, "power_min": 100, "sm_clock": 2520, "mem_clock": 10501, "pcie_gen": 4},
    2: {"name": "NVIDIA A100 80GB PCIe", "mem_total": 81920, "power_limit": 300,
        "power_max": 300, "power_min": 100, "sm_clock": 1410, "mem_clock": 1593, "pcie_gen": 4},
    3: {"name": "NVIDIA RTX A6000", "mem_total": 49140, "power_limit": 300,
        "power_max": 300, "power_min": 100, "sm_clock": 1860, "mem_clock": 8001, "pcie_gen": 4},
}

# ---------------------------------------------------------------- helpers --

def clamp(v: float, a: float, b: float) -> float:
    return max(a, min(b, v))


def fmt_ts(ts: float) -> str:
    """UTC 'YYYY-MM-DD HH:MM:SS' — matches the browser mock's log format."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def fmt_dur(s: float) -> str:
    s = max(0, int(s))
    sec, mn, hr = s % 60, (s // 60) % 60, s // 3600
    if hr:
        return f"{hr}:{mn:02d}:{sec:02d}"
    return f"{mn:02d}:{sec:02d}"


def progress_bar(pct: float, width: int = 18) -> str:
    filled = round(clamp(pct, 0, 100) / 100 * width)
    return "█" * filled + " " * (width - filled)


def js_literal(obj) -> str:
    """json.dumps with </ escaped so the file is safe inside <script>."""
    return json.dumps(obj, ensure_ascii=False, indent=1).replace("</", "<\\/")


# ------------------------------------------------------------- log bodies --

def gen_train_log(secs: float, start: float, r: random.Random,
                  epochs=3, total_steps=2341, it_s=17.4, max_lines=600) -> list[str]:
    step_dur = 1 / it_s
    total = total_steps * epochs
    n_steps = min(total, int(secs / step_dur))
    every = max(1, math.ceil(max(total, n_steps) / max_lines))
    lines: list[str] = []
    for step in range(1, n_steps + 1, every):
        epoch = min(step // total_steps + 1, epochs)
        in_epoch = step % total_steps or total_steps
        pct = in_epoch / total_steps * 100
        elapsed = step * step_dur
        eta = ((total_steps - in_epoch) + (epochs - epoch) * total_steps) * step_dur
        loss = clamp(2.6 - (step / 8000) * 1.9 - math.sin(step / 300) * 0.05, 0.4, 2.6)
        lr = 2e-5 * (1 - step / total)
        lines.append(
            f"[{fmt_ts(start + elapsed)}] Epoch {epoch}/{epochs}: "
            f"{int(pct):3d}%|{progress_bar(pct)}| {in_epoch}/{total_steps} "
            f"[{fmt_dur(elapsed)}<{fmt_dur(max(0, eta))}, {it_s:.2f}it/s, "
            f"loss={loss:.3f}, lr={lr:.1e}]"
        )
    return lines


def gen_eval_log(secs: float, start: float, r: random.Random,
                 benches=("mmlu", "gsm8k", "humaneval")) -> list[str]:
    per = max(6, secs / 8)
    lines: list[str] = []
    t, i = 0.0, 0
    while t < secs:
        bench = benches[i % len(benches)]
        pct = min(100, t / secs * 100)
        score = {"mmlu": r.uniform(0.68, 0.72), "gsm8k": r.uniform(0.71, 0.76),
                 "humaneval": r.uniform(0.55, 0.62)}[bench]
        lines.append(
            f"[{fmt_ts(start + int(t))}] Evaluating {bench}@5-shot: "
            f"{int(pct):3d}%|{progress_bar(pct)}| {int(t / per)}/8 "
            f"[{fmt_dur(t)}<{fmt_dur(max(0, secs - t))}, {score:.3f}]"
        )
        t += per
        i += 1
    return lines


OOM_LOG = [
    "[{ts}] Loading model shards: 100%|██████████| 4/4 [00:12<00:00]",
    "[{ts}]   /work/models/llama-3-8b/shard-2.safetensors",
    "[{ts}]   /work/models/llama-3-8b/shard-3.safetensors",
    "[{ts}] Traceback (most recent call last):",
    "[{ts}]   File \"/work/train.py\", line 42, in <module>",
    "[{ts}]     model = model.to(\"cuda\")",
    "[{ts}] torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 512.00 MiB",
    "[{ts}] (GPU 1; 24.39 GiB total capacity; 23.51 GiB already allocated; 512.00 MiB free;",
    "[{ts}]  ... 12.04 GiB reserved in total by PyTorch)",
]
CANCEL_LOG = [
    "[{ts}] Task received SIGTERM — cancelling (queue: manual cancel by weidows)",
    "[{ts}] Cleaning up worker processes...",
]


# ------------------------------------------------------------- metric series --

def metric_point(gpu: str, ts: float, util: float, mem: float, temp: float,
                 power: float, sm: float, r: random.Random) -> dict:
    return {
        "ts": ts, "gpu_id": gpu,
        "gpu_util": round(clamp(util, 0, 100) * 10) / 10,
        "mem_used": round(mem), "mem_total": GPU_SPECS[int(gpu)]["mem_total"],
        "temp": round(temp), "power_w": round(power), "sm_clock": round(sm),
        "net_rx": r.uniform(6, 50) * 1024 * 1024,
        "net_tx": r.uniform(3, 30) * 1024 * 1024,
        "disk_io": r.uniform(2, 25) * 1024 * 1024,
    }


def gen_series(gpu: str, from_ts: float, to_ts: float, step: float,
               base: dict, r: random.Random, spike=False) -> list[dict]:
    out = []
    ts = from_ts
    while ts <= to_ts:
        jitter = math.sin(ts / 90) * 8 + r.uniform(-5, 5)
        mem = base["mem"] + (24000 if (spike and ts > to_ts - 20) else 0) \
            + r.uniform(-base["mem"] * 0.05, base["mem"] * 0.05)
        out.append(metric_point(
            gpu, ts,
            clamp(base["util"] + jitter, 5, 99.9),
            mem,
            clamp(base["temp"] + jitter / 4 + r.uniform(-2, 2), 30, 90),
            clamp(base["power"] + jitter * 1.5 + r.uniform(-20, 20), 30, 460),
            round(base["sm"] + r.uniform(-150, 150)),
            r,
        ))
        ts += step
    return out


def gen_history(specs: dict, boot: float, hours: float, r: random.Random) -> dict:
    t0 = boot - hours * 3600
    step = 30.0
    history: dict[str, list[dict]] = {}
    for idx, sp in specs.items():
        busy = idx in ("0", "2")
        history[str(idx)] = [
            metric_point(
                str(idx), ts,
                clamp(85 + math.sin(ts / 200) * 8 + r.uniform(-6, 6), 60, 99) if busy else r.uniform(0, 5),
                (56000 + r.uniform(-800, 800) if idx == "2" else 21000 + r.uniform(-400, 400)) if busy else r.uniform(600, 2200),
                74 + r.uniform(-3, 3) if busy else 40 + r.uniform(-4, 4),
                340 + r.uniform(-30, 30) if busy else 45 + r.uniform(-10, 10),
                sp["sm_clock"] - r.uniform(0, 120) if busy else 210 + r.uniform(0, 120),
                r,
            )
            for ts in frange(t0, boot, step)
        ]
    history["host"] = [{
        "ts": ts,
        "net_rx": r.uniform(8, 60) * 1024 * 1024,
        "net_tx": r.uniform(3, 40) * 1024 * 1024,
        "disk_io": r.uniform(2, 30) * 1024 * 1024,
        "cpu": r.uniform(8, 42),
    } for ts in frange(t0, boot, step)]
    return history


def frange(start: float, end: float, step: float):
    t = start
    while t <= end:
        yield t
        t += step


# ---------------------------------------------------------------- tasks --

def task(**kw) -> dict:
    defaults = {
        "project": "unnamed", "username": "weidows", "gpu_id": None,
        "vram_mb": 0, "est_seconds": 0, "priority": 5,
        "command": ["echo", "hello"], "cwd": None, "env": {},
        "fallback_wait_seconds": 0, "api_key": "", "version": "",
        "power_limit_w": None, "status": "queued",
        "created_at": None, "started_at": None, "finished_at": None,
        "exit_code": None, "pid": None, "log_file": None,
        "log": [], "_series": [],
    }
    t = {**defaults, **kw}
    if t["gpu_id"] is not None:
        t["env"] = {**t.get("env", {}), "CUDA_VISIBLE_DEVICES": str(t["gpu_id"])}
    t["log_file"] = t["log_file"] or f"data/logs/{t['id']}.log"
    return t


def gen_tasks(boot: float, r: random.Random) -> list[dict]:
    t0 = boot - 3600
    tasks = [
        task(
            id="9f2c1a7d4e01", project="llm-finetune", username="alice", gpu_id="0",
            vram_mb=21000, est_seconds=5400, priority=9, version="9f2c1a7",
            command=["python", "train.py", "--model", "llama-3.1-8b", "--dataset", "sft-corpus-v3",
                     "--lr", "2e-5", "--epochs", "3", "--per-device-bs", "4", "--grad-accum", "8"],
            status="running", created_at=boot - 1560, started_at=boot - 1500, pid=18231,
            fallback_wait_seconds=300,
        ),
        task(
            id="b41d0ef2c890", project="eval-rag", username="bob", gpu_id="2",
            vram_mb=60000, est_seconds=900, priority=7, version="b41d0ef",
            command=["python", "eval.py", "--checkpoint", "runs/final",
                     "--bench", "mmlu,gsm8k,humaneval", "--shots", "5"],
            status="running", created_at=boot - 480, started_at=boot - 420, pid=19307,
            fallback_wait_seconds=60,
        ),
        task(
            id="7e3aa90c1b2d", project="diffusion-train", username="carol", gpu_id=None,
            vram_mb=16000, est_seconds=3600, priority=6, version="7e3aa90",
            command=["python", "train_unet.py", "--config", "configs/sd2-xl.yaml", "--steps", "120000"],
            status="queued", created_at=boot - 120,
        ),
        task(
            id="d99f201e5a6b", project="data-prep", username="dave", gpu_id=None,
            vram_mb=2048, est_seconds=1800, priority=3, version="d99f201",
            command=["python", "scripts/tokenize.py", "--input", "corpus", "--out", "shards", "--workers", "32"],
            status="queued", created_at=boot - 45,
        ),
        task(
            id="3c8e55bf7a9d", project="ablation-lora", username="alice", gpu_id="0",
            vram_mb=12000, est_seconds=2100, priority=5, version="3c8e55b",
            command=["python", "train_lora.py", "--base", "llama-3.1-8b", "--rank", "64", "--epochs", "2"],
            status="succeeded", created_at=boot - 6500, started_at=boot - 6400, finished_at=boot - 4300,
            exit_code=0, pid=14092,
        ),
        task(
            id="aa1c9d4e0f12", project="baseline-resnet", username="eve", gpu_id="1",
            vram_mb=8000, est_seconds=3800, priority=4, version="aa1c9d4",
            command=["python", "train_cv.py", "--arch", "resnet-152", "--data", "imagenet-1k", "--bs", "256"],
            status="succeeded", created_at=boot - 9000, started_at=boot - 8900, finished_at=boot - 5100,
            exit_code=0, pid=13877,
        ),
        task(
            id="f5e6d7c8b9a0", project="inference-bench", username="bob", gpu_id="1",
            vram_mb=14000, est_seconds=600, priority=6, version="b41d0ef",
            command=["python", "bench.py", "--model", "llama-3-8b", "--batch", "32", "--mode", "offline"],
            status="failed", created_at=boot - 5400, started_at=boot - 5320, finished_at=boot - 5308,
            exit_code=1, pid=15810,
        ),
        task(
            id="e7f2bb3c4d5e", project="backup-migrate", username="frank", gpu_id="3",
            vram_mb=4000, est_seconds=3600, priority=1, version="e7f2bb3",
            command=["python", "scripts/migrate.py", "--from", "nfs:/data/v1", "--to", "lustre:/data/v2"],
            status="cancelled", created_at=boot - 3000, started_at=boot - 2900, finished_at=boot - 2850,
            exit_code=-9, pid=14888,
        ),
    ]

    # running tasks: seed logs + in-window series
    for t in tasks:
        if t["status"] == "running":
            start = t["started_at"]
            if "train" in t["command"][1]:
                t["log"] = gen_train_log(boot - start, start, r)
            else:
                t["log"] = gen_eval_log(boot - start, start, r)
            t["_series"] = gen_series(str(t["gpu_id"]), start, boot, 30,
                                      {"util": 88 if "train" in t["command"][1] else 62,
                                       "mem": t["vram_mb"] * 0.9,
                                       "temp": 76 if "train" in t["command"][1] else 58,
                                       "power": 360 if "train" in t["command"][1] else 180,
                                       "sm": 2400},
                                      r)
        elif t["status"] == "succeeded":
            start, end = t["started_at"], t["finished_at"]
            secs = end - start
            if "lora" in t["command"][1]:
                t["log"] = gen_train_log(secs, start, r, epochs=2, total_steps=1417, it_s=11.2)
            else:
                t["log"] = gen_train_log(secs, start, r, epochs=90, total_steps=50045, it_s=220, max_lines=900)
            t["_series"] = gen_series(str(t["gpu_id"]), start, end, 30,
                                      {"util": 86, "mem": t["vram_mb"], "temp": 72, "power": 300, "sm": 2400}, r)
        elif t["status"] == "failed":
            t["log"] = [l.format(ts=fmt_ts(t["finished_at"] - 5)) for l in OOM_LOG]
            t["_series"] = gen_series(str(t["gpu_id"]), t["started_at"], t["finished_at"], 5,
                                      {"util": 30, "mem": 22000, "temp": 68, "power": 250, "sm": 1600}, r, spike=True)
        elif t["status"] == "cancelled":
            t["log"] = [l.format(ts=fmt_ts(t["finished_at"] - 2)) for l in CANCEL_LOG]
            t["_series"] = gen_series(str(t["gpu_id"]), t["started_at"], t["finished_at"], 5,
                                      {"util": 12, "mem": 4000, "temp": 44, "power": 80, "sm": 900}, r)
    return tasks


def gen_gpus(specs: dict, r: random.Random) -> dict:
    gpus = {}
    for idx, sp in specs.items():
        gpus[str(idx)] = {
            "index": int(idx), "name": sp["name"], "uuid": "GPU-" + "".join(r.choices("0123456789ABCDEF", k=8)),
            "mem_total": sp["mem_total"], "power_limit": sp["power_limit"],
            "power_max": sp["power_max"], "power_min": sp["power_min"],
            "sm_clock": sp["sm_clock"], "mem_clock": sp["mem_clock"], "pcie_gen": sp["pcie_gen"],
            "gpu_util": 0.0, "mem_util": 0.0, "mem_used": round(r.uniform(600, 2200)),
            "temp": round(r.uniform(36, 46)), "power_w": round(r.uniform(28, 70)),
            "free_mb": sp["mem_total"] - round(r.uniform(600, 2200)),
        }
    return gpus


# ---------------------------------------------------------------- main --

def build(seed: int, hours: float) -> dict:
    r = random.Random(seed)
    boot = int(time.time())
    return {
        "boot": boot,
        "gpus": gen_gpus(GPU_SPECS, r),
        "history": gen_history(GPU_SPECS, boot, hours, r),
        "tasks": gen_tasks(boot, r),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(pathlib.Path(__file__).resolve().parent.parent / "docs" / "mock-data.js"),
                    help="output JS file (default: docs/mock-data.js)")
    ap.add_argument("--seed", type=int, default=42, help="random seed (default: 42)")
    ap.add_argument("--hours", type=float, default=1.0, help="metric history length in hours (default: 1)")
    ap.add_argument("--json-out", default=None,
                    help="optional dir to also dump raw JSON (tasks.json / metrics.json / logs/)")
    args = ap.parse_args()

    data = build(args.seed, args.hours)
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    nl = chr(10)
    header = "/* Auto-generated by scripts/gen_mock_data.py (seed=%d, hours=%g) */" % (args.seed, args.hours) + nl
    js = header
    js += "(function (g) { g.__GPUQ_MOCK_DATA = %s; })(typeof window !== \"undefined\" ? window : globalThis);" % js_literal(data) + nl
    js += ";" + nl
    out.write_text(js, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")

    if args.json_out:
        jdir = pathlib.Path(args.json_out)
        jdir.mkdir(parents=True, exist_ok=True)
        (jdir / "gpus.json").write_text(json.dumps(data["gpus"], indent=1), encoding="utf-8")
        (jdir / "tasks.json").write_text(json.dumps(data["tasks"], indent=1), encoding="utf-8")
        (jdir / "metrics.json").write_text(json.dumps(data["history"], indent=1), encoding="utf-8")
        logs_dir = jdir / "logs"
        logs_dir.mkdir(exist_ok=True)
        for t in data["tasks"]:
            (logs_dir / f"{t['id']}.log").write_text("\n".join(t["log"]) + "\n", encoding="utf-8")
        print(f"wrote raw JSON to {jdir}/")


if __name__ == "__main__":
    main()
