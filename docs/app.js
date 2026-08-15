/* gpuq dashboard — task-centric UI, vanilla JS, no build step.
 *
 * Every task is a card: status icon + running time + embedded sparklines
 * (GPU util / VRAM / temp / power from the task's run window) + a log
 * preview line. Clicking a card collapses it into the left rail and slides
 * a detail panel out on the right: full metadata, aggregate metrics, the
 * in-window metric chart, and a timestamped log viewer. Hovering a log row
 * locks a vertical line to that timestamp on the chart and shows the metric
 * values at that moment.
 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmtNum = (n, d = 0) => (n === null || n === undefined ? "-" : Number(n).toFixed(d));
const fmtMB = (mb) => {
  if (mb === null || mb === undefined) return "-";
  if (mb >= 1024) return (mb / 1024).toFixed(1) + "G";
  return Math.round(mb) + "M";
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtClock = (secs) => {
  secs = Math.max(0, Math.floor(secs));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const fmtHMS = (secs) => {
  secs = Math.max(0, Math.floor(secs));
  if (secs >= 3600) return fmtClock(secs);
  const m = Math.floor(secs / 60), s = secs % 60;
  return m ? `${m}m${s}s` : `${s}s`;
};
const toEpoch = (iso) => (typeof iso === "number" ? iso : new Date(iso).getTime() / 1000);

const STATUS_META = {
  queued: { ico: "⏳", label: "排队中" },
  running: { ico: "▶️", label: "运行中" },
  succeeded: { ico: "✅", label: "已完成" },
  failed: { ico: "❌", label: "失败" },
  cancelled: { ico: "⏹️", label: "已取消" },
};
const SPARKS = [
  { key: "gpu_util", label: "util", unit: "%", color: "#4da3ff" },
  { key: "mem_used", label: "VRAM", unit: "", color: "#bc8cff", mb: true },
  { key: "temp", label: "temp", unit: "°C", color: "#f85149" },
  { key: "power_w", label: "power", unit: "W", color: "#d29922" },
];

const STATE = {
  system: null,
  tasks: [],
  filter: "",
  detailId: null,
  cache: { metrics: {}, logs: {} },
  chart: null,
  series: [],        // detail chart series (points)
  tsArr: [],         // parallel epoch ts
  vlineIdx: -1,
  vlinePinned: false,
  logTimer: null,
  _bootLogs: false,
};

/* ---------------- api ---------------- */

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `${resp.status} ${resp.statusText}`);
  return data.data;
}

function showError(msg) {
  const el = $("#error-banner");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 6000);
}

/* ---------------- system overview ---------------- */

async function refreshSystem() {
  try {
    STATE.system = await api("GET", "/api/system");
    $("#host-badge").textContent = "server ok";
    $("#host-metrics-badge").textContent =
      STATE.system.host_available ? "host metrics: on" : "host metrics: off (no psutil)";
    renderBanner();
    renderCounts();
  } catch (e) {
    $("#host-badge").textContent = "offline";
    showError(`无法连接 gpuq 服务：${e.message}`);
  }
}

function renderBanner() {
  const q = STATE.system?.queue || {};
  const banner = $("#paused-banner");
  if (q.paused) {
    $("#pause-reason").textContent = q.pause_reason || "";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function renderCounts() {
  const c = STATE.system?.counts;
  if (c) $("#counts").textContent = `共 ${c.total} · 排队 ${c.queued} · 运行中 ${c.running}`;
}

/* ---------------- cards ---------------- */

async function refreshTasks() {
  try {
    const params = new URLSearchParams();
    if (STATE.filter) params.set("status", STATE.filter);
    params.set("limit", "200");
    STATE.tasks = await api("GET", "/api/tasks?" + params);
    await preloadTaskData();
    renderCards();
  } catch (e) {
    showError(`加载任务失败：${e.message}`);
  }
}

/* Fetch per-task metrics + logs for card sparklines / log preview.
 * Running tasks refresh every poll; finished ones are cached. */
async function preloadTaskData() {
  const jobs = STATE.tasks
    .filter((t) => t.status !== "queued")
    .map(async (t) => {
      const isRunning = t.status === "running";
      if (isRunning || !STATE.cache.metrics[t.id]) {
        try { STATE.cache.metrics[t.id] = await api("GET", `/api/tasks/${t.id}/metrics`); } catch { /* noop */ }
      }
      if (isRunning || !STATE.cache.logs[t.id]) {
        try { STATE.cache.logs[t.id] = await api("GET", `/api/tasks/${t.id}/logs?limit=200`); } catch { /* noop */ }
      }
    });
  await Promise.allSettled(jobs);
}

function statusPill(s) {
  const m = STATUS_META[s] || { ico: "•", label: s };
  return `<span class="status-pill status-${s}">${m.ico} ${m.label}</span>`;
}

function cardTitle(t) {
  return (t.command[0] === "python" && t.command[1]) ? t.command[1] : (t.command[0] || "");
}

function cardRuntimeHtml(t) {
  if (t.status === "queued") return `<span class="card-runtime">等待调度</span>`;
  const est = t.est_seconds ? ` / <span class="est">~${fmtHMS(t.est_seconds)}</span>` : "";
  if (t.status === "running") {
    return `<span class="card-runtime" data-runtime="${t.id}"></span>${est}`;
  }
  if (t.started_at && t.finished_at) {
    return `<span class="card-runtime">${fmtHMS(toEpoch(t.finished_at) - toEpoch(t.started_at))}</span>${est}`;
  }
  return `<span class="card-runtime">-</span>`;
}

function sparkHtml(t) {
  if (t.status === "queued") {
    return `<div class="spark-grid"><div class="spark-empty span2">等待 GPU 调度 — 暂无指标</div></div>`;
  }
  return `<div class="spark-grid">${SPARKS.map((s) => `
    <div class="spark">
      <label><span>${s.label}</span><span id="spark-val-${t.id}-${s.key}">…</span></label>
      <canvas id="spark-${t.id}-${s.key}" width="120" height="40"></canvas>
    </div>`).join("")}</div>`;
}

function taskCardHtml(t) {
  const preview = (STATE.cache.logs[t.id]?.lines || []).slice(-1)[0] || "";
  return `
  <div class="task-card ${t.id === STATE.detailId ? "selected" : ""}" data-id="${t.id}">
    <div class="card-head">
      <span class="status-ico">${(STATUS_META[t.status] || {}).ico || "•"}</span>
      ${statusPill(t.status)}
      <span class="card-id">#${esc(t.id.slice(0, 8))}</span>
    </div>
    <div class="card-title" title="${esc(t.command.join(" "))}">${esc(cardTitle(t))}</div>
    <div class="card-meta">
      <span>👤 <b>${esc(t.username || "-")}</b></span>
      <span>🎯 <b>${esc(t.gpu_id ?? "auto")}</b></span>
      <span>⚡ <b>p${t.priority}</b></span>
      <span>🧠 <b>${t.vram_mb ? t.vram_mb + "M" : "-"}</b></span>
      <span>📦 <b>${esc(t.project || "-")}</b></span>
      ${t.version ? `<span>🔖 <b>${esc(t.version)}</b></span>` : ""}
    </div>
    ${cardRuntimeHtml(t)}
    ${sparkHtml(t)}
    <div class="card-log-preview" title="${esc(preview)}">${preview ? "📜 " + esc(preview) : "📜 暂无日志"}</div>
  </div>`;
}

function renderCards() {
  const wrap = $("#cards");
  const tasks = STATE.tasks;
  if (!tasks.length) {
    wrap.innerHTML = `<div class="panel muted">暂无任务。用 <code>gpuq submit --project demo --user you --vram 2000 -- python main.py</code> 或右上角「新建任务」提交一个。</div>`;
    return;
  }
  wrap.innerHTML = tasks.map(taskCardHtml).join("");
  wrap.querySelectorAll(".task-card").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.id)));
  // draw sparklines + fill latest values
  tasks.forEach((t) => {
    if (t.status === "queued") return;
    const series = STATE.cache.metrics[t.id] || [];
    SPARKS.forEach((s) => {
      const cv = document.getElementById(`spark-${t.id}-${s.key}`);
      if (cv) drawSpark(cv, series, s);
      const latest = series[series.length - 1];
      const valEl = document.getElementById(`spark-val-${t.id}-${s.key}`);
      if (valEl) {
        if (!latest) valEl.textContent = "-";
        else {
          const v = s.mb ? fmtMB(latest[s.key]) : fmtNum(latest[s.key]);
          valEl.textContent = v + (s.mb ? "" : s.unit);
        }
      }
    });
  });
  tickRuntimes();
}

/* lightweight sparkline: last 120 points, normalized */
function drawSpark(canvas, series, s) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pts = series.slice(-120).map((p) => p[s.key]);
  if (pts.length < 2) return;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = (max - min) || 1;
  const step = W / (pts.length - 1);
  const y = (v) => H - 3 - ((v - min) / span) * (H - 6);
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(i * step, y(v)) : ctx.moveTo(0, y(v))));
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = s.color + "22";
  ctx.fill();
}

/* 1s tick for running-task elapsed time on cards */
function tickRuntimes() {
  const now = Date.now() / 1000;
  STATE.tasks.forEach((t) => {
    if (t.status !== "running" || !t.started_at) return;
    const el = $(`[data-runtime="${t.id}"]`);
    if (el) el.textContent = `⏱ ${fmtClock(now - toEpoch(t.started_at))}`;
  });
}

/* ---------------- detail (split view) ---------------- */

async function openDetail(id) {
  STATE.detailId = id;
  location.hash = `#/tasks/${id}`;
  $("#board").classList.add("split");
  $("#rail").classList.remove("hidden");
  $("#detail").classList.remove("hidden");
  const task = STATE.tasks.find((t) => t.id === id) || await api("GET", `/api/tasks/${id}`);
  if (!STATE.tasks.find((t) => t.id === id)) STATE.tasks.push(task);
  // rail: compact selected card
  $("#rail").innerHTML = taskCardHtml(task);
  $("#rail .task-card").classList.add("selected");
  // refresh its live data then render detail
  await refreshDetailData(id);
  renderDetail(id);
  if (STATE.logTimer) clearInterval(STATE.logTimer);
  STATE.logTimer = setInterval(async () => {
    if (STATE.detailId !== id) return;
    await refreshDetailData(id);
    renderDetail(id);
  }, 3000);
}

async function refreshDetailData(id) {
  try { STATE.cache.metrics[id] = await api("GET", `/api/tasks/${id}/metrics`); } catch { /* noop */ }
  try { STATE.cache.logs[id] = await api("GET", `/api/tasks/${id}/logs?limit=2000`); } catch { /* noop */ }
}

function closeDetail() {
  STATE.detailId = null;
  STATE.vlineIdx = -1;
  if (STATE.logTimer) { clearInterval(STATE.logTimer); STATE.logTimer = null; }
  $("#board").classList.remove("split");
  $("#rail").classList.add("hidden");
  $("#rail").innerHTML = "";
  $("#detail").classList.add("hidden");
  if (location.hash.startsWith("#/tasks")) history.replaceState(null, "", "#");
}

function renderDetail(id) {
  const task = STATE.tasks.find((t) => t.id === id);
  if (!task) return;
  const agg = STATE.cache.metrics[id] ? taskAgg(task, STATE.cache.metrics[id]) : null;
  $("#detail-title").textContent = `任务 ${task.id.slice(0, 8)}`;
  const aggHtml = agg ? `
    <div class="detail-cell"><div class="k">平均利用率</div><div class="v">${fmtNum(agg.avg_util)}%</div></div>
    <div class="detail-cell"><div class="k">峰值显存</div><div class="v">${fmtMB(agg.peak_mem)}</div></div>
    <div class="detail-cell"><div class="k">最高温度</div><div class="v">${fmtNum(agg.max_temp)}°C</div></div>
    <div class="detail-cell"><div class="k">峰值功耗</div><div class="v">${fmtNum(agg.max_power)}W</div></div>
    <div class="detail-cell"><div class="k">峰值net_rx</div><div class="v">${fmtNum(agg.peak_net_rx / 1024 / 1024, 2)}MB/s</div></div>
    <div class="detail-cell"><div class="k">峰值net_tx</div><div class="v">${fmtNum(agg.peak_net_tx / 1024 / 1024, 2)}MB/s</div></div>
    <div class="detail-cell"><div class="k">峰值disk IO</div><div class="v">${fmtNum(agg.peak_disk_io / 1024 / 1024, 2)}MB/s</div></div>` : "";

  $("#detail-body").innerHTML = `
    <div class="detail-grid">
      <div class="detail-cell"><div class="k">状态</div><div class="v">${statusPill(task.status)}</div></div>
      <div class="detail-cell"><div class="k">GPU</div><div class="v">${esc(task.gpu_id ?? "auto")}</div></div>
      <div class="detail-cell"><div class="k">项目 / 用户</div><div class="v">${esc(task.project)} / ${esc(task.username)}</div></div>
      <div class="detail-cell"><div class="k">优先级</div><div class="v">${task.priority}</div></div>
      <div class="detail-cell"><div class="k">预估显存</div><div class="v">${task.vram_mb || 0} MB</div></div>
      <div class="detail-cell"><div class="k">预估时长</div><div class="v">${task.est_seconds ? fmtHMS(task.est_seconds) : "-"}</div></div>
      <div class="detail-cell"><div class="k">fallback_wait</div><div class="v">${task.fallback_wait_seconds}s</div></div>
      <div class="detail-cell"><div class="k">功耗上限</div><div class="v">${task.power_limit_w ?? "-"} W</div></div>
      <div class="detail-cell"><div class="k">版本</div><div class="v">${esc(task.version || "-")}</div></div>
      <div class="detail-cell"><div class="k">退出码</div><div class="v">${task.exit_code ?? "-"}</div></div>
      <div class="detail-cell"><div class="k">PID</div><div class="v">${task.pid ?? "-"}</div></div>
      <div class="detail-cell"><div class="k">日志文件</div><div class="v">${esc(task.log_file || "-")}</div></div>
      ${aggHtml}
    </div>
    <div class="detail-cmd"><div class="k muted" style="font-size:11px">命令</div><div class="v">${esc(task.command.join(" "))}</div></div>
    <div class="chart-box">
      <h4>任务运行窗口指标（悬浮日志行 ↔ 时间锁定）</h4>
      <canvas id="detail-chart" height="220"></canvas>
      <div id="vline-tip" class="hidden"></div>
    </div>
    <div class="log-tools">
      <b style="font-size:13px">日志</b>
      <input id="log-grep" placeholder="grep 过滤…">
      <button class="btn btn-sm" id="btn-log-refresh">刷新</button>
      <button class="btn btn-sm" id="btn-log-download">下载</button>
      <button class="btn btn-sm btn-danger" id="btn-detail-cancel">取消任务</button>
      ${["succeeded", "failed", "cancelled"].includes(task.status) ? `<button class="btn btn-sm" id="btn-detail-rerun">重跑</button>` : ""}
    </div>
    <div class="log-viewer" id="log-viewer"></div>`;

  $("#btn-detail-close").addEventListener("click", closeDetail);
  $("#btn-detail-cancel").addEventListener("click", () => cancelTask(id));
  const rerunBtn = $("#btn-detail-rerun");
  if (rerunBtn) rerunBtn.addEventListener("click", () => rerunTask(id));
  $("#btn-log-refresh").addEventListener("click", () => { refreshDetailData(id); renderDetail(id); });
  $("#btn-log-download").addEventListener("click", () => downloadLog(id));
  $("#log-grep").addEventListener("input", () => renderLogs(id));

  renderLogs(id);
  renderDetailChart(id);
}

/* ---------------- detail chart + timeline sync ---------------- */

function taskAgg(task, series) {
  if (!series || !series.length) return null;
  const avg = (f) => series.reduce((a, r) => a + (r[f] ?? 0), 0) / series.length;
  const max = (f) => series.reduce((a, r) => Math.max(a, r[f] ?? 0), 0);
  return {
    avg_util: +avg("gpu_util").toFixed(1),
    peak_mem: Math.round(max("mem_used")),
    max_temp: Math.round(max("temp")),
    max_power: Math.round(max("power_w")),
    peak_net_rx: Math.round(max("net_rx")),
    peak_net_tx: Math.round(max("net_tx")),
    peak_disk_io: Math.round(max("disk_io")),
  };
}

const COLORS = {
  util: "#4da3ff", mem: "#bc8cff", temp: "#f85149", power: "#d29922",
};

const vlinePlugin = {
  id: "vline",
  afterDraw(chart) {
    if (STATE.vlineIdx < 0 || !chart.scales.x) return;
    const idx = STATE.vlineIdx;
    const x = chart.scales.x.getPixelForValue(idx);
    if (x < chart.chartArea.left || x > chart.chartArea.right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(248,81,73,.85)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, chart.chartArea.top);
    ctx.lineTo(x, chart.chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function renderDetailChart(id) {
  const series = STATE.cache.metrics[id] || [];
  STATE.series = series;
  STATE.tsArr = series.map((r) => r.ts);
  STATE.vlineIdx = -1;
  STATE.vlinePinned = false;
  $("#vline-tip")?.classList.add("hidden");
  if (STATE.chart) { STATE.chart.destroy(); STATE.chart = null; }
  if (!series.length) {
    $("#detail-chart").closest(".chart-box").querySelector("h4").textContent =
      "任务运行窗口指标 — 该任务窗口内暂无采样点";
    return;
  }
  const labels = series.map((r) => new Date(r.ts * 1000).toLocaleTimeString("zh-CN", { hour12: false }));
  const ds = (name, color, axis, data) => ({
    label: name, data, yAxisID: axis, borderColor: color, backgroundColor: color + "22",
    fill: false, tension: 0.2, borderWidth: 1.5, pointRadius: 0,
  });
  const canvas = $("#detail-chart");
  STATE.chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        ds("util %", COLORS.util, "y", series.map((r) => r.gpu_util ?? 0)),
        ds("temp °C", COLORS.temp, "y1", series.map((r) => r.temp ?? 0)),
        ds("power W", COLORS.power, "y1", series.map((r) => r.power_w ?? 0)),
        ds("vram MB", COLORS.mem, "y2", series.map((r) => r.mem_used ?? 0)),
      ],
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#7d8794", boxWidth: 10 } } },
      scales: {
        x: { ticks: { color: "#7d8794", maxTicksLimit: 10, maxRotation: 0 }, grid: { color: "#232b36" } },
        y: { position: "left", title: { display: true, text: "%", color: "#7d8794" }, ticks: { color: "#7d8794" }, grid: { color: "#232b36" } },
        y1: { position: "right", title: { display: true, text: "°C / W", color: "#7d8794" }, ticks: { color: "#7d8794" }, grid: { display: false } },
        y2: { position: "right", title: { display: true, text: "MB", color: "#7d8794" }, ticks: { color: "#7d8794" }, grid: { display: false } },
      },
    },
    plugins: [vlinePlugin],
  });
}

/* ---------------- log viewer with timestamps ---------------- */

const TS_RE = /^\[?(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\]?\s*/;

function parseLineTs(line) {
  const m = line.match(TS_RE);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  return null;
}

/* Per-line epoch ts: parsed from the line when present, else interpolated
 * between the task start/end so the timeline still lines up. */
function lineTimestamps(task, lines) {
  const start = task.started_at ? toEpoch(task.started_at) : null;
  const end = task.finished_at ? toEpoch(task.finished_at) : (start || null);
  const out = [];
  let lastKnown = start;
  lines.forEach((line, i) => {
    const parsed = parseLineTs(line);
    if (parsed) { out.push(parsed); lastKnown = parsed; }
    else if (start && end) {
      const t = start + ((end - start) * i) / Math.max(1, lines.length - 1);
      out.push(t);
    } else {
      out.push(lastKnown || 0);
    }
  });
  return out;
}

function renderLogs(id) {
  const task = STATE.tasks.find((t) => t.id === id);
  const viewer = $("#log-viewer");
  if (!viewer) return;
  const raw = (STATE.cache.logs[id]?.lines || []).slice(0, 2000);
  const q = ($("#log-grep")?.value || "").trim();
  const lines = q ? raw.filter((l) => l.includes(q)) : raw;
  const ts = lineTimestamps(task, lines);
  STATE._logTs = ts;
  viewer.innerHTML = lines.map((line, i) => `
    <div class="log-row" data-ts="${ts[i] || 0}">
      <span class="log-ts">${ts[i] ? fmtLocal(ts[i]) : "      "}</span>
      <span class="log-line">${esc(line)}</span>
    </div>`).join("") || `<div class="muted" style="padding:8px">(暂无日志输出)</div>`;
  bindLogHover(viewer);
}

/* display timestamps as wall-clock local time */
function fmtLocal(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function bindLogHover(viewer) {
  viewer.querySelectorAll(".log-row").forEach((row) => {
    const setVline = (pin) => {
      const rowTs = +row.dataset.ts;
      if (!rowTs) return;
      let idx = -1, best = Infinity;
      STATE.tsArr.forEach((t, i) => {
        const d = Math.abs(t - rowTs);
        if (d < best) { best = d; idx = i; }
      });
      if (idx < 0) return;
      STATE.vlineIdx = idx;
      STATE.vlinePinned = pin;
      viewer.querySelectorAll(".log-row").forEach((r) => r.classList.remove("pinned"));
      if (pin) row.classList.add("pinned");
      showVlineTip(idx);
      if (STATE.chart) STATE.chart.update();
    };
    row.addEventListener("mouseenter", () => setVline(false));
    row.addEventListener("mouseleave", () => {
      if (STATE.vlinePinned) return;
      STATE.vlineIdx = -1;
      $("#vline-tip")?.classList.add("hidden");
      if (STATE.chart) STATE.chart.update();
    });
    row.addEventListener("click", () => setVline(!STATE.vlinePinned));
  });
}

function showVlineTip(idx) {
  const tip = $("#vline-tip");
  if (!tip || !STATE.chart) return;
  const p = STATE.series[idx];
  if (!p) return;
  const box = $("#detail-chart").closest(".chart-box");
  const x = STATE.chart.scales.x.getPixelForValue(idx);
  const left = $("#detail-chart").offsetLeft + x - box.getBoundingClientRect().left;
  const t = new Date(p.ts * 1000);
  const time = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
  tip.textContent = `${time} · util ${fmtNum(p.gpu_util)}% · vram ${fmtMB(p.mem_used)} · ${fmtNum(p.temp)}°C · ${fmtNum(p.power_w)}W`;
  tip.style.left = `${Math.max(60, Math.min(left, box.clientWidth - 120))}px`;
  tip.classList.remove("hidden");
}

function downloadLog(id) {
  const text = (STATE.cache.logs[id]?.lines || []).join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${id}.log`;
  a.click();
}

async function cancelTask(id) {
  if (!confirm(`取消任务 ${id.slice(0, 8)}？（运行中会被强杀）`)) return;
  try {
    await api("DELETE", `/api/tasks/${id}`);
    if (STATE.detailId === id) { refreshDetailData(id); renderDetail(id); }
    refreshTasks(); refreshSystem();
  } catch (e) { showError(e.message); }
}

async function rerunTask(id) {
  try {
    await api("POST", `/api/tasks/${id}/rerun`);
    refreshTasks(); refreshSystem();
  } catch (e) { showError(e.message); }
}

/* ---------------- new task form ---------------- */

function openNewModal() {
  $("#modal-new").classList.remove("hidden");
  $("#form-new").reset();
  $("#form-new").querySelector("[name=priority]").value = 5;
}

$("#form-new").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const val = (n) => f.querySelector(`[name=${n}]`).value.trim();
  const cmdStr = val("command");
  const cmd = cmdStr.match(/"[^"]*"|'[^']*'|\S+/g)?.map((s) => s.replace(/^["']|["']$/g, "")) || [];
  const body = {
    command: cmd,
    project: val("project"),
    username: val("username"),
    gpu_id: val("gpu_id") || null,
    vram_mb: parseInt(val("vram_mb") || "0", 10),
    est_seconds: parseInt(val("est_seconds") || "0", 10),
    priority: parseInt(val("priority") || "5", 10),
    fallback_wait_seconds: parseInt(val("fallback_wait_seconds") || "0", 10),
    power_limit_w: val("power_limit_w") ? parseInt(val("power_limit_w"), 10) : null,
    version: val("version"),
    cwd: val("cwd") || null,
  };
  const envStr = val("env");
  if (envStr) {
    try { body.env = JSON.parse(envStr); } catch { alert("环境变量必须是合法 JSON"); return; }
  }
  try {
    const t = await api("POST", "/api/tasks", body);
    $("#modal-new").classList.add("hidden");
    refreshTasks(); refreshSystem();
    openDetail(t.id);
  } catch (err) { alert(`提交失败：${err.message}`); }
});

/* ---------------- wiring ---------------- */

$$(".modal-close").forEach((el) =>
  el.addEventListener("click", () => {
    el.closest(".modal").classList.add("hidden");
    if (location.hash.startsWith("#/tasks")) history.replaceState(null, "", "#");
  }));

$$("#status-tabs .tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$("#status-tabs .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    STATE.filter = tab.dataset.status;
    refreshTasks();
  }));

$("#btn-refresh").addEventListener("click", () => { refreshTasks(); refreshSystem(); });
$("#btn-new").addEventListener("click", openNewModal);
$("#btn-resume").addEventListener("click", async () => {
  try { await api("POST", "/api/queue/resume"); refreshSystem(); } catch (e) { showError(e.message); }
});
$("#btn-detail-close")?.addEventListener("click", closeDetail);

function boot() {
  const onHash = () => {
    const m = location.hash.match(/^#\/tasks\/([^/]+)/);
    if (m && m[1] !== STATE.detailId) {
      const known = STATE.tasks.find((t) => t.id === m[1]);
      if (known) openDetail(m[1]);
    }
  };
  window.addEventListener("hashchange", onHash);
  if (location.hash) onHash();

  refreshSystem();
  refreshTasks();
  setInterval(refreshSystem, 5000);
  setInterval(refreshTasks, 5000);
  setInterval(() => {
    tickRuntimes();
    $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }, 1000);
}

boot();
