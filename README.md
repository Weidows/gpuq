<div align="center">

# 🎛️ gpuq

**A zero-dependency GPU job queue with a live WebUI dashboard and per-task metrics.**

Agents and scripts stop racing for the GPU. They submit a job to gpuq — it queues,
schedules, runs, logs, samples GPU/host metrics, and shows everything on a dashboard.

[**Live WebUI demo**](https://weidows.github.io/gpuq/) · [简体中文](./README.zh-CN.md)

![GitHub release](https://img.shields.io/github/v/release/Weidows/gpuq?color=4da3ff)
![CI](https://img.shields.io/github/actions/workflow/status/Weidows/gpuq/ci.yml?branch=main&label=CI)
![Python](https://img.shields.io/badge/python-%3E%3D3.10-4da3ff)
![platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-3fb950)
![license](https://img.shields.io/github/license/Weidows/gpuq)

</div>

---

## What is it?

`gpuq` is a lightweight, self-hosted **GPU task queue** for a single machine (or a
machine with many GPUs). Instead of every agent/script doing `python main.py` directly
and fighting over the GPU, they submit a job — **queue → schedule → run → log →
metrics → dashboard** — and let gpuq decide when and where it runs.

- **Zero pip dependencies** — pure Python standard library (scheduler, SQLite, HTTP server, CLI, WebUI).
- **Priority + VRAM-aware scheduling** across any number of GPUs, with automatic GPU allocation.
- **Per-task log files** — tail, grep, or view in the browser by task id.
- **Per-second GPU telemetry** — utilization, VRAM, temperature, power, SM/memory clocks — plus optional host network/disk/CPU curves (`psutil`).
- **WebUI dashboard** — live GPU cards, task table (submit/edit/cancel/rerun), time-series charts, and a task detail view with in-window metrics + log viewer.
- **`fallback_wait` crash guard** — a task that dies within N seconds of startup auto-pauses the whole queue so you notice immediately.
- **Optional `X-Api-Key` auth** (enforced as soon as `api_keys` is non-empty).
- **Cross-platform** — Windows / Linux / macOS. Deploys as a Python package, a Docker image, or a `.deb` with systemd.

## Demo

The WebUI is a static single-page app. The dashboard on [GitHub Pages](https://weidows.github.io/gpuq/)
is the **real dashboard running against an in-browser simulated backend** (4 virtual GPUs, a live task
queue, streaming metrics) — try every feature without installing anything, including submitting tasks,
tailing logs, and reading the charts. It degrades gracefully if GitHub Pages is not yet enabled for the
repo (the 404 there is harmless).

## Installation

### pip (PyPI: `gpu-q`)

> The plain `gpuq` name is taken on PyPI, so the distribution is published as
> **`gpu-q`** there. The installed console command and import package stay `gpuq`.

```bash
pip install gpu-q                          # core, zero deps
pip install "gpu-q[host]"                  # + psutil → host net/disk/cpu charts
```

This installs the `gpuq` console command:

```bash
gpuq serve                      # start the server (default http://127.0.0.1:8765)
```

Or install the latest from source (same package layout):

```bash
pip install "gpu-q @ git+https://github.com/Weidows/gpuq.git"
```

Or run from a checkout without installing: `python -m gpuq.cli serve` (Python ≥ 3.10).

### Docker

```bash
docker run -d --name gpuq \
  --gpus all \
  -p 8765:8765 \
  -v gpuq-data:/data \
  -v /path/to/work:/work \
  ghcr.io/weidows/gpuq:latest
# WebUI: http://localhost:8765
```

- Requires the NVIDIA Container Toolkit on the host (containerized tasks see the GPUs).
- Tasks run as child processes inside the container; mount training code/data at `/work`
  and submit with `"cwd": "/work"`.
- `docker compose -f packaging/docker/docker-compose.yml up -d` gives the full setup
  (`gpus: all`, restart policy, health check).

### Debian / Ubuntu (`.deb`)

```bash
# Download gpuq_<ver>_all.deb from the GitHub Release
sudo dpkg -i gpuq_*.deb        # creates a gpuq user + enables the systemd unit
# WebUI: http://<host>:8765     logs: journalctl -u gpuq -f
```

Install layout: `/usr/bin/gpuq` (CLI), `/etc/gpuq/config.json`, `/var/lib/gpuq/` (data),
`/etc/systemd/system/gpuq.service`.

### From source

```bash
git clone https://github.com/Weidows/gpuq && cd gpuq
pip install -e . && gpuq serve
```

## Quick start

```bash
gpuq serve &

# Submit a job (CLI and REST API are equivalent)
gpuq submit \
  --project myexp --user alice --gpu 0 \
  --vram 8000 --est 3600 --priority 5 \
  --fallback-wait 300 --key my-platform-key \
  --version $(git rev-parse --short HEAD) \
  -- python main.py --epochs 10 --batch-size 32

gpuq status                     # queue state + live GPU state
gpuq logs <task_id> --follow    # tail a task's log
gpuq list --status running      # filter tasks
gpuq metrics --gpu 0 --step 30  # metric series (feed charts / analysis)
gpuq queue pause / resume       # pause / resume the whole queue
```

## How it works

```
 agents / CI / cron / scripts
        │  POST /api/tasks  (CLI `gpuq submit`)
        ▼
┌─────────────────┐   poll every ~2s   ┌──────────────────────────────┐
│  REST API + WebUI │ ◄───────────────► │  Scheduler                   │
│  (ThreadingHTTP)  │                   │  priority ↓, created ↑,     │
│  X-Api-Key auth   │                   │  free VRAM ≥ est + headroom │
└────────┬────────┘                     └──────┬───────────────────────┘
         │ sqlite3                             │ Popen (per-task log file)
         ▼                                     ▼
   tasks + metrics db                 GPU tasks (CUDA_VISIBLE_DEVICES injected)
         │
         ▼
   metric sampler: nvidia-smi (GPU) · psutil (host net/disk/cpu, optional)
```

- Every ~2 s the scheduler picks the highest-priority **queued** task whose VRAM
  estimate fits a free GPU (or its pinned `gpu_id`) and starts it as a child process.
- A sampler thread records GPU telemetry per second; with `psutil` installed it adds
  host network / disk / CPU curves.
- When a task exits, its run window gets aggregated (avg/peak utilization, peak VRAM,
  max temperature, peak power, peak net/disk IO) — viewable in the WebUI detail page.

## Task fields

| Field | Required | Description |
|---|---|---|
| `command` | ✅ | Program + args as an **array** (`["python","main.py","--epochs","10"]`); with the CLI, put them after `--` |
| `project` | | Project name — grouping/filtering (first dimension of log tracing) |
| `username` | | Submitter |
| `gpu_id` | | Pin a GPU index; omit for automatic allocation of the first fitting GPU |
| `vram_mb` | | **Estimated VRAM in MiB** — the scheduling constraint (free VRAM must be ≥ estimate + 512 MB headroom) |
| `est_seconds` | | Estimated runtime (display only) |
| `priority` | | Default 5; **higher runs sooner** |
| `fallback_wait_seconds` | | **Startup crash guard**: if the task exits within this many seconds of starting (any exit code), the whole queue auto-pauses with a reason that includes the task id and log path |
| `api_key` | | Platform key recorded on the task (server-side validation via config `api_keys`) |
| `version` | | Code version / commit for traceability |
| `power_limit_w` | | Runtime power cap (`nvidia-smi -pl`; needs root/admin — failure only warns) |
| `cwd` | | Working directory |
| `env` | | Extra environment variables (dict); `CUDA_VISIBLE_DEVICES` is injected automatically |

## REST API

Base `http://<host>:8765`; auth header `X-Api-Key` (enforced only when `api_keys` is non-empty).

| Method | Path | Description |
|---|---|---|
| POST | `/api/tasks` (alias `/api/submit`) | Submit a task |
| GET | `/api/tasks?status=&project=&user=&since=&limit=` | List tasks |
| GET | `/api/tasks/{id}` | Detail + aggregated metrics (avg/peak util, VRAM, temp, power, IO) |
| PATCH | `/api/tasks/{id}` | Edit a queued task |
| DELETE | `/api/tasks/{id}` | Cancel (kills the whole process tree if running) / delete |
| POST | `/api/tasks/{id}/rerun` | Clone + re-queue |
| GET | `/api/tasks/{id}/logs?offset=&limit=&q=` | Tail / grep the task log |
| GET | `/api/tasks/{id}/metrics` | Metric series inside the task's run window |
| GET | `/api/metrics?gpu=&from=&to=&step=` | Chart time series (`gpu=-1` = host net/disk/cpu) |
| GET | `/api/system` | Live GPU + queue state |
| POST | `/api/queue/pause` / `/api/queue/resume` | Pause / resume the queue |
| GET | `/api/openapi.json` | Machine-readable endpoint summary (for agent auto-discovery) |

## Configuration

`config.json` (gitignored; template in `config.example.json`) — every key can be
overridden by a `GPUQ_*` env var (`GPUQ_PORT`, `GPUQ_HOST`, `GPUQ_DATA`,
`GPUQ_API_KEYS`, `GPUQ_DEFAULT_POWER_LIMIT`, …).

```json
{
  "host": "127.0.0.1",
  "port": 8765,
  "poll_interval": 2.0,
  "metrics_interval": 5.0,
  "vram_headroom_mb": 512,
  "api_keys": [],
  "default_power_limit_w": null,
  "data_dir": "data"
}
```

## WebUI

- **GPU cards** — live utilization, VRAM, temperature, power, SM clock per GPU.
- **Charts** — per-GPU utilization / VRAM / temp+power / SM clock over 1h · 6h · 24h · 7d, plus host net/disk/CPU when `psutil` is available.
- **Tasks** — filter tabs by status, submit via form, edit queued jobs, cancel (tree-kill), re-run.
- **Task detail** — full metadata, in-window metric chart, and a live-updating log viewer with grep.

## Debugging workflow (agent-friendly)

1. `gpuq status` — is the queue paused (fallback_wait), are GPUs free?
2. `gpuq logs <id> --follow` — find the error.
3. `gpuq metrics --gpu 0 --from <ts>` or the WebUI detail page — read the run window:
   - **OOM** → `peak_mem` near the VRAM ceiling; log says `out of memory`.
   - **Throttling / overheating** → high `temp` with dropping `sm_clock` → lower power cap / change strategy.
   - **IO stall** → `disk_io` stuck at 0 while utilization is low.
   - **Network congestion** → `net_rx` / `net_tx` pinned at the ceiling.
4. Fix, then `gpuq rerun <id>` to re-queue (resume first if paused).

## Agent skill

The repo ships a ready-made agent skill at `skills/gpuq/SKILL.md` — copy it into your
agent's skill directory:

```bash
cp skills/gpuq/SKILL.md ~/.agents/skills/gpuq/SKILL.md
```

It covers service detection/startup, the full submission-field table, the
status → logs → metrics → rerun workflow, CLI + curl examples, and an error-handling table.

## Development / CI / Release

```bash
pip install -e . && python tests/smoke.py      # local smoke test (set GPUQ_SMOKE_FAKE_GPU=1 with no GPU)
```

- **CI** (`.github/workflows/ci.yml`) — ubuntu/windows/macos × py3.10/3.11 matrix:
  install the wheel → fake-GPU smoke test → `python -m build` sanity.
- **Release** (`.github/workflows/release.yml`, on `v*` tags) — GitHub Release assets
  (wheel + sdist + `.deb`), a `ghcr.io/weidows/gpuq:<tag>` + `latest` image, and PyPI
  publishing of the `gpu-q` distribution (skipped unless the `PYPI_ENABLED` repo
  variable is set — it is).
- **GitHub Pages** (`.github/workflows/pages.yml`, on `docs/**` changes) — publishes the
  static WebUI demo to `https://weidows.github.io/gpuq/`.

### Layout

```
gpuq/
  gpuq/            # config / db / gpu / metrics / scheduler / api / cli / webui (bundled)
  docs/            # static WebUI + mock backend → GitHub Pages live demo
  packaging/       # docker/ + deb/ (systemd unit, maintainer scripts)
  skills/gpuq/     # agent skill
  tests/smoke.py
  .github/workflows/  # ci.yml + release.yml + pages.yml
```

## Known limitations & graceful degradation

- `nvidia-smi -pl` (power cap) needs root/admin; on failure it warns and keeps running.
- Host net/disk/CPU curves need `psutil` (`pip install "gpu-q[host]"`); without it the
  corresponding charts are greyed out and everything else keeps working.
- Chart.js loads the bundled local vendor file first, falls back to a CDN.
- Multiple GPUs on one host are first-class (per-`gpu_id` scheduling); cross-host
  federation is out of scope for now.
- No GPU? `GPUQ_FAKE_GPU=1` drives the whole scheduler/metrics path with a synthetic GPU
  (used by CI).

## License

[MIT](./LICENSE)
