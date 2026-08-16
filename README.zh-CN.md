<div align="center">

# 🎛️ gpuq

**零依赖的 GPU 任务排队调度框架，自带实时 WebUI 看板与逐任务指标。**

agent / 脚本不再直接 `python main.py` 抢 GPU，而是提交给 gpuq —— 排队、调度、执行、
日志、GPU/宿主机指标采样、WebUI 看板，一条链路全搞定。

[**在线 WebUI 演示**](https://weidows.github.io/gpuq/) · [English](./README.md)

![GitHub release](https://img.shields.io/github/v/release/Weidows/gpuq?color=4da3ff)
![CI](https://img.shields.io/github/actions/workflow/status/Weidows/gpuq/ci.yml?branch=main&label=CI)
![Python](https://img.shields.io/badge/python-%3E%3D3.10-4da3ff)
![platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-3fb950)
![license](https://img.shields.io/github/license/Weidows/gpuq)

</div>

---

## 这是什么？

`gpuq` 是一个轻量、自托管的 **GPU 任务队列**，面向单机（或多卡单机）。每个 agent /
CI / cron / 脚本不再直接 `python main.py` 抢占 GPU，而是提交一个任务 —— **排队 → 调度
→ 执行 → 日志 → 指标 → 看板** —— 由 gpuq 决定何时、在哪张卡上运行。

- **零 pip 依赖** —— 纯 Python 标准库（调度器、SQLite、HTTP 服务、CLI、WebUI 全部内置）。
- **优先级 + 显存感知调度**，天然支持多卡，可自动分配 GPU。
- **每个任务独立日志文件** —— 按任务 ID 定位，支持 tail / grep / WebUI 查看。
- **秒级 GPU 遥测** —— 利用率 / 显存 / 温度 / 功耗 / SM·显存时钟；可选宿主机 net / disk / CPU 曲线（`psutil`）。
- **WebUI 看板** —— GPU 实时卡片、任务增删改查、折线图（时间范围切换）、任务详情（运行窗口指标 + 日志查看器）。
- **`fallback_wait` 启动崩溃守卫** —— 任务启动后 N 秒内退出（无论退出码）→ 自动暂停整个队列并提示，方便调试启动即崩的任务。
- **可选 `X-Api-Key` 鉴权**（`api_keys` 非空即强制）。
- **跨平台** —— Windows / Linux / macOS；可打包为 Python 包、Docker 镜像或带 systemd 的 `.deb`。

## 在线演示

WebUI 是纯静态单页应用。GitHub Pages 上的 [在线演示](https://weidows.github.io/gpuq/)
跑的是**真实的前端，后端是在浏览器内模拟的**（4 张虚拟 GPU、一个活的队列、实时指标流）——
无需安装即可点遍所有功能（提交任务、跟日志、看图表都行）。若仓库尚未开启 GitHub Pages，
该地址 404 属正常现象，不影响仓库本身。

## 安装

### pip（PyPI 上叫 `gpuqu`）

> PyPI 上的 `gpuq` 名字已被占用，所以发行包名是 **`gpuqu`**；安装后命令和导入包仍是 `gpuq`。

```bash
pip install gpuqu                          # 核心，零依赖
pip install "gpuqu[host]"                  # + psutil → 宿主机 net/disk/cpu 曲线
```

安装后直接有 `gpuq` 命令：

```bash
gpuq serve                      # 启动服务（默认 http://127.0.0.1:8765）
```

或从源码安装最新版（包布局相同）：

```bash
pip install "gpuqu @ git+https://github.com/Weidows/gpuq.git"
```

或者拉源码免安装直接跑：`python -m gpuq.cli serve`（Python ≥ 3.10）。

### Docker（ghcr.io 镜像）

```bash
docker run -d --name gpuq \
  --gpus all \
  -p 8765:8765 \
  -v gpuq-data:/data \
  -v /path/to/work:/work \
  ghcr.io/weidows/gpuq:latest
# WebUI: http://localhost:8765
```

- 需宿主机 NVIDIA Container Toolkit（容器内任务可见 GPU）。
- 任务在容器内作为子进程执行；训练环境（代码/数据集）挂到 `/work` 后提交时带 `"cwd": "/work"`。
- `docker compose -f packaging/docker/docker-compose.yml up -d` 有完整编排（`gpus: all`、restart、健康检查）。

### Debian / Ubuntu（.deb）

```bash
# 从 GitHub Release 下载 gpuq_<ver>_all.deb
sudo dpkg -i gpuq_*.deb        # 自动创建 gpuq 用户 + 启用 systemd 开机自启
# WebUI: http://<host>:8765     日志: journalctl -u gpuq -f
```

安装后布局：`/usr/bin/gpuq`(CLI)、`/etc/gpuq/config.json`、`/var/lib/gpuq/`(数据)、`/etc/systemd/system/gpuq.service`。

### 源码运行

```bash
git clone https://github.com/Weidows/gpuq && cd gpuq
pip install -e . && gpuq serve
```

## 快速开始

```bash
gpuq serve &

# 提交一个任务（CLI 与 REST API 等价）
gpuq submit \
  --project myexp --user alice --gpu 0 \
  --vram 8000 --est 3600 --priority 5 \
  --fallback-wait 300 --key my-platform-key \
  --version $(git rev-parse --short HEAD) \
  -- python main.py --epochs 10 --batch-size 32

gpuq status                     # 队列状态 + GPU 实时状态
gpuq logs <task_id> --follow    # 跟日志（tail -f）
gpuq list --status running      # 筛选任务
gpuq metrics --gpu 0 --step 30  # 指标序列（喂给图表/分析）
gpuq queue pause / resume       # 暂停 / 恢复队列
```

## 工作原理

```
 agents / CI / cron / 脚本
        │  POST /api/tasks  (CLI `gpuq submit`)
        ▼
┌─────────────────┐   每 ~2s 轮询   ┌──────────────────────────────┐
│ REST API + WebUI │ ◄───────────────► │ 调度器                       │
│ (ThreadingHTTP)  │                   │ 优先级↓ + 创建时间↑，        │
│ X-Api-Key 鉴权   │                   │ 空闲显存 ≥ 预估 + 余量      │
└────────┬────────┘                     └──────┬───────────────────────┘
         │ sqlite3                             │ Popen（逐任务日志文件）
         ▼                                     ▼
   任务 + 指标数据库                   GPU 任务（自动注入 CUDA_VISIBLE_DEVICES）
         │
         ▼
   指标采样：nvidia-smi（GPU）· psutil（宿主机 net/disk/cpu，可选）
```

- 每 ~2s 调度器从 **queued** 中选出优先级最高、显存预估能装进空闲卡（或落在指定
  `gpu_id`）的任务，作为子进程启动。
- 采样线程秒级记录 GPU 遥测；装了 `psutil` 后额外记录宿主机网络 / 磁盘 / CPU 曲线。
- 任务退出后汇总其运行窗口指标（平均/峰值利用率、峰值显存、最高温度、峰值功耗、峰值
  net/disk IO）—— 可在 WebUI 详情页直接查看。

## 提交字段

| 字段 | 必需 | 说明 |
|---|---|---|
| `command` | ✅ | 命令 + 参数**列表**（`["python","main.py","--epochs","10"]`）；CLI 放在 `--` 之后 |
| `project` | | 项目名，分组/筛选用（日志追溯第一维） |
| `username` | | 提交者 |
| `gpu_id` | | 指定 GPU 索引；留空 = 自动分配第一个满足条件的 GPU |
| `vram_mb` | | **预估显存 MiB**（调度依据：空闲显存 ≥ 预估 + 512MB 余量） |
| `est_seconds` | | 预估时长（仅展示） |
| `priority` | | 优先级，默认 5，**越大越先** |
| `fallback_wait_seconds` | | **启动缓冲窗口**：任务启动后该秒数内退出（无论退出码）→ **自动暂停整个队列**，原因里带任务 id 和日志路径，方便调试启动即崩 |
| `api_key` | | 平台认证 key（记录在任务上；服务端校验见 config `api_keys`） |
| `version` | | 代码版本 / commit，追溯用 |
| `power_limit_w` | | 运行时功耗上限（`nvidia-smi -pl`，需 root/管理员；失败仅警告） |
| `cwd` | | 工作目录 |
| `env` | | 额外环境变量 dict（默认注入 `CUDA_VISIBLE_DEVICES=分配到的GPU`） |

## REST API

Base `http://<host>:8765`，鉴权头 `X-Api-Key`（仅当 `api_keys` 非空时强制）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tasks`（别名 `/api/submit`） | 提交任务 |
| GET | `/api/tasks?status=&project=&user=&since=&limit=` | 任务列表 |
| GET | `/api/tasks/{id}` | 详情 + 聚合指标（平均/峰值 util、显存、温度、功耗、IO） |
| PATCH | `/api/tasks/{id}` | 编辑排队中的任务 |
| DELETE | `/api/tasks/{id}` | 取消（运行中整树强杀）/ 删除 |
| POST | `/api/tasks/{id}/rerun` | 克隆重排 |
| GET | `/api/tasks/{id}/logs?offset=&limit=&q=` | 日志 tail / grep |
| GET | `/api/tasks/{id}/metrics` | 该任务运行窗口内的指标序列 |
| GET | `/api/metrics?gpu=&from=&to=&step=` | 图表时间序列（`gpu=-1` 为宿主机 net/disk/cpu） |
| GET | `/api/system` | 实时 GPU + 队列状态 |
| POST | `/api/queue/pause` / `/api/queue/resume` | 暂停 / 恢复队列 |
| GET | `/api/openapi.json` | 机器可读端点摘要（agent 自动发现用） |

## 配置

`config.json`（gitignored；模板见 `config.example.json`），环境变量 `GPUQ_*` 覆盖
（`GPUQ_PORT` / `GPUQ_HOST` / `GPUQ_DATA` / `GPUQ_API_KEYS` / `GPUQ_DEFAULT_POWER_LIMIT` / …）。

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

- **GPU 卡片** —— 每张卡的实时利用率 / 显存 / 温度 / 功耗 / SM 时钟。
- **图表** —— 每 GPU 的利用率 / 显存 / 温度+功耗 / SM 时钟，时间范围 1h · 6h · 24h · 7d；
  有 psutil 时追加宿主机 net/disk/CPU 曲线。
- **任务** —— 按状态筛选 tab、表单提交、编辑排队任务、取消（整树强杀）、重跑。
- **任务详情** —— 完整元数据、运行窗口指标曲线、自动刷新的日志查看器（支持 grep）。

## 任务排错工作流（agent 用）

1. `gpuq status` — 看队列是否因 fallback_wait 暂停、GPU 是否空闲
2. `gpuq logs <id> --follow` — 定位报错
3. `gpuq metrics --gpu 0 --from <ts>` 或 WebUI 详情页 — 看运行窗口指标：
   - **OOM** → `peak_mem` 接近显存上限；日志 `out of memory`
   - **降频/过热** → `temp` 高 + `sm_clock` 掉 → 降功耗 / 换策略
   - **IO 卡住** → `disk_io` 长时间为 0 且 util 低
   - **网络拥塞** → `net_rx/net_tx` 打满
4. 修复后 `gpuq rerun <id>` 重排队，必要时先 `gpuq queue resume`。

## Agent skill

仓库内置 skill（`skills/gpuq/SKILL.md`），安装到 agent 技能目录即可：

```bash
cp skills/gpuq/SKILL.md ~/.agents/skills/gpuq/SKILL.md
```

skill 里包含：服务确认/启动方法、提交字段全表、状态轮询→日志→指标分析→rerun 的完整工作流、curl 与 CLI 双示例、错误处理表。

## 开发 / CI / 发包

```bash
pip install -e . && python tests/smoke.py    # 本机冒烟（无 GPU 设 GPUQ_SMOKE_FAKE_GPU=1）
```

- **CI**（`.github/workflows/ci.yml`）：ubuntu/windows/macos × py3.10/3.11 矩阵，装 wheel → 假 GPU 冒烟 → `python -m build` 打包 sanity
- **发包**（`.github/workflows/release.yml`，打 `v*` tag 触发）：
  - GitHub Release 资产：wheel + sdist + .deb
  - ghcr.io 镜像：`ghcr.io/weidows/gpuq:<tag>` + `latest`
  - PyPI：以 `gpuqu` 发行名发布（已配置 `PYPI_ENABLED` 变量，会执行）
- **GitHub Pages**（`.github/workflows/pages.yml`，`docs/**` 变更触发）：把静态 WebUI 演示部署到 `https://weidows.github.io/gpuq/`

### 目录结构

```
gpuq/
  gpuq/            # config / db / gpu / metrics / scheduler / api / cli / webui(打包进包)
  docs/            # 静态 WebUI + 浏览器内模拟后端 → GitHub Pages 在线演示
  packaging/       # docker/ + deb/（systemd unit、maintainer 脚本）
  skills/gpuq/     # agent skill
  tests/smoke.py
  .github/workflows/  # ci.yml + release.yml + pages.yml
```

## 已知限制与降级

- `nvidia-smi -pl`（功耗上限）需要 root / 管理员权限，失败仅打警告、不中断任务
- 宿主机 net/disk/cpu 曲线需要 `psutil`（`pip install "gpuqu[host]"`），缺失时 WebUI 对应图表置灰，其余功能不受影响
- Chart.js 优先加载本地 vendor 文件（已打包进 wheel），缺失时回退 CDN
- 单机多 GPU 天然支持（按 gpu_id 独立调度）；跨机联邦不在本期范围
- 无 GPU 环境（如 CI）可用 `GPUQ_FAKE_GPU=1` 跑通调度/指标链路做冒烟

## License

[MIT](./LICENSE)
