---
name: gpuq
description: >-
  Submit, queue, monitor, and debug GPU training/eval jobs through the gpuq
  job queue instead of launching them directly. Use when an agent wants to run
  a GPU workload (training, evaluation, inference batch) in a queue with
  scheduling by priority/VRAM, per-task logs, GPU/IO/network metrics, a WebUI
  dashboard, and a fallback_wait auto-pause for startup crashes. Covers
  submission fields, status polling, log tailing/grep, metric-based
  diagnosis (OOM/throttling/IO/network), rerun, and queue pause/resume.
user-invocable: true
metadata: {"openclaw":{"emoji":"🎛️","os":["darwin","linux","win32"]}}
---

# gpuq — GPU 任务排队调度

gpuq 是一个**零依赖**（Python 标准库）的 GPU 任务队列服务：agent 不要直接
`python main.py` 占 GPU，而是把任务提交给 gpuq（REST API 或 CLI）。gpuq 负责
排队调度、逐任务日志、运行时 GPU/宿主机指标采样，并提供 WebUI 看板与图表。

## 0. 先确认服务

```bash
gpuq status            # 若已安装（/usr/bin/gpuq）或
python -m gpuq.cli status   # 源码直接运行时
```

- 如果输出队列状态 + GPU 列表 → 服务已就绪，跳到「提交任务」。
- 如果连接失败 → 用下面任一方式启动服务（任选其一）：

```bash
# 方式 A：直接运行（源码目录）
python -m gpuq.cli serve &

# 方式 B：Docker（需宿主机 NVIDIA Container Toolkit）
docker compose -f packaging/docker/docker-compose.yml up -d

# 方式 C：systemd（.deb 安装后）
systemctl status gpuq        # 未运行则 systemctl start gpuq
```

WebUI 默认 `http://<host>:8765`（任务看板 / 图表 / 日志查看 / 手动增删改查）。
服务地址可用 `--host <ip> --port <port>` 或环境变量 `GPUQ_HOST`/`GPUQ_PORT` 覆盖。

## 1. 提交任务（核心）

### CLI 方式（推荐，命令放在 `--` 之后）

```bash
gpuq submit \
  --project mnist --user alice \
  --gpu 0                  `# 留空 = 自动分配第一个满足条件的 GPU` \
  --vram 8000              `# 预估显存 MiB（调度依据，务必填准）` \
  --est 3600               `# 预估时长秒（仅展示）` \
  --priority 5             `# 越高越先跑` \
  --fallback-wait 300      `# 启动缓冲窗口（见下）` \
  --version $(git rev-parse --short HEAD) `# 代码版本，追溯用` \
  --task-key "$PLATFORM_API_KEY"          `# 平台认证 key，记录在任务上` \
  --power-limit 250        `# 可选：功耗上限 W（需 root/管理员）` \
  --cwd /path/to/project   `# 可选：工作目录` \
  --env DATASET=/data/xx   `# 可选：额外环境变量，可多次` \
  -- python main.py --epochs 10 --batch-size 32
```

成功输出 `submitted task <12位id> (queued)`。**保存这个 task id**，后续所有操作都靠它。

### REST 方式（等价）

```bash
curl -s http://127.0.0.1:8765/api/tasks -H 'Content-Type: application/json' -d '{
  "project": "mnist", "username": "alice",
  "command": ["python", "main.py", "--epochs", "10"],
  "vram_mb": 8000, "est_seconds": 3600, "priority": 5,
  "fallback_wait_seconds": 300, "api_key": "PLATFORM_KEY", "version": "abc1234"
}'
```

### 提交字段全表

| 字段 | 必需 | 说明 |
|---|---|---|
| `command` | ✅ | 命令 + 参数**列表**（`["python","main.py","--epochs","10"]`） |
| `project` | | 项目名，分组/筛选用（日志追溯第一维） |
| `username` | | 提交者 |
| `gpu_id` | | 指定 GPU 索引（如 `"0"`）；留空 = 自动分配 |
| `vram_mb` | | **预估显存 MiB**。调度要求：该 GPU 空闲显存 ≥ 预估 + 512MB 余量，否则继续排队 |
| `est_seconds` | | 预估时长（仅展示） |
| `priority` | | 优先级，默认 5，**越大越先** |
| `fallback_wait_seconds` | | **启动缓冲窗口**：任务启动后该秒数内退出（无论退出码）→ **自动暂停整个队列**，原因里带任务 id 和日志路径，不自动切下一个任务，方便你调试启动即崩 |
| `api_key` | | 平台认证 key（记录在任务上，用于追溯谁提交的） |
| `version` | | 代码版本 / commit，追溯用 |
| `power_limit_w` | | 运行时功耗上限（`nvidia-smi -pl`，需 root/管理员，失败仅警告） |
| `cwd` | | 任务工作目录 |
| `env` | | 额外环境变量 dict；默认注入 `CUDA_VISIBLE_DEVICES=分配到的GPU` |

> 提交后 gpuq 会给任务自动分配 GPU 并注入 `CUDA_VISIBLE_DEVICES`，命令里不要自己写死 GPU。

## 2. 标准工作流（提交 → 轮询 → 日志 → 指标 → 修复 → 重跑）

### Step 1 — 提交并确认入队

```bash
gpuq submit --project P --user U --vram 8000 --fallback-wait 300 -- python main.py
gpuq status                      # 看队列状态 + 是否 running
gpuq list --status queued        # 排队中的任务
```

### Step 2 — 轮询运行状态

```bash
gpuq list --status running       # 或
gpuq logs <task_id> --follow     # tail -f 实时日志，进程结束时自然退出
```

### Step 3 — 出错时查日志（按任务 id 精确定位）

```bash
gpuq logs <task_id> --q "Error|Traceback"     # grep 过滤
gpuq logs <task_id> --limit 200               # 最近 200 行
gpuq logs <task_id> --follow                  # 跟随
```

### Step 4 — 看运行窗口指标（找根因）

```bash
gpuq metrics --gpu 0 --step 30      # 或 WebUI 任务详情页
```

| 症状 | 看什么指标 | 应对 |
|---|---|---|
| OOM / 显存溢出 | `mem_used` 峰值接近显存上限，日志 `out of memory` | 减 batch size / 换低显存方案 |
| 降频 / 过热 | `temp` 高 + `sm_clock` 掉 | 降功耗上限 `--power-limit`、降负载 |
| IO 卡住 | `disk_io` 长时间为 0 且 GPU util 低 | 换 SSD / 预加载数据 |
| 网络拥塞 | `net_rx`/`net_tx` 打满 | 错峰、限速 |

### Step 5 — 修复后重跑

```bash
gpuq queue resume      # 若 fallback_wait 触发了队列暂停，先恢复
gpuq rerun <task_id>   # 用原字段克隆重排（省得重新填参）
```

## 3. 常用运维命令速查

```bash
gpuq status                         # 队列 + GPU 实时状态（util/显存/温度/功耗）
gpuq list [--status running] [--project P] [--user U]
gpuq logs <id> [--q grep] [--limit N] [--follow]
gpuq cancel <id>                    # 取消（运行中整树强杀）
gpuq rerun <id>                     # 克隆重排
gpuq metrics --gpu 0 --from <epoch> --to <epoch> --step 30
gpuq queue pause --reason "manual"  # 暂停队列（如要独占 GPU 调试）
gpuq queue resume
```

## 4. REST API（agent 脚本化时用）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tasks` | 提交（body 见字段表；`command` 为数组） |
| GET | `/api/tasks?status=&project=&user=&limit=` | 列表 |
| GET | `/api/tasks/{id}` | 详情 + 聚合指标（avg/max util、peak 显存、温度、功耗、IO） |
| PATCH | `/api/tasks/{id}` | 编辑排队中的任务 |
| DELETE | `/api/tasks/{id}` | 取消 / 删除 |
| POST | `/api/tasks/{id}/rerun` | 克隆重排 |
| GET | `/api/tasks/{id}/logs?offset=&limit=&q=` | 日志 tail / grep |
| GET | `/api/tasks/{id}/metrics` | 任务运行窗口指标 |
| GET | `/api/metrics?gpu=&from=&to=&step=` | 时间序列（`gpu=-1` 为宿主机 net/disk/cpu） |
| GET | `/api/system` | 实时状态 |
| POST | `/api/queue/pause` / `resume` | 暂停 / 恢复 |
| GET | `/api/openapi.json` | 端点摘要（自动发现用） |

鉴权：服务端配置了 `api_keys` 时所有请求需带 `X-Api-Key` 头；未配置则开放。

## 5. 常见错误处理

| 现象 | 原因 / 动作 |
|---|---|
| 提交返回 400 `'command' is required` | `command` 必须是数组，如 `["python","main.py"]` |
| 任务一直 queued 不运行 | 看 `gpuq status` 的 GPU 显存/占用：预估 `vram_mb` 大于空闲显存 → 调小或等前面的任务跑完；或队列被暂停（fallback_wait 触发） |
| 队列莫名其妙暂停 | `gpuq status` 会打印原因：某任务在 fallback_wait 秒内退出了（启动即崩）。`gpuq logs <触发任务id>` 查错 → 修复 → `gpuq queue resume` |
| 任务秒退但退出码 0 | 也是 fallback_wait 语义：任何快速退出都暂停队列，方便你确认是不是「正常退出但没干活」 |
| 任务 failed 但没日志 | 命令本身不存在（`command` 拼错）→ `gpuq logs <id>` 看启动错误 |
| 401 invalid X-Api-Key | 服务端开了鉴权，CLI 加 `--key <key>` |

## 6. 服务部署参考

- 直接运行：`python -m gpuq.cli serve`（默认 127.0.0.1:8765）
- Docker：`docker compose -f packaging/docker/docker-compose.yml up -d`（宿主机需 NVIDIA Container Toolkit）
- apt/.deb：`scripts/build-deb.sh && scripts/install.sh`（systemd 开机自启，`journalctl -u gpuq -f`）
- 配置文件 `config.json`：`host/port/poll_interval/metrics_interval/vram_headroom_mb/api_keys/default_power_limit_w/data_dir`
