/* gpuq dashboard app — vanilla JS, no build step */
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

const STATE = {
  system: null,
  tasks: [],
  statusFilter: "",
  range: "1h",
  charts: {},
  detailTaskId: null,
  logTimer: null,
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
    renderGpuCards();
    renderBanner();
    $("#host-badge").textContent = "server ok";
    $("#host-metrics-badge").textContent =
      STATE.system.host_available ? "host metrics: on" : "host metrics: off (no psutil)";
  } catch (e) {
    $("#host-badge").textContent = "offline";
    showError(`无法连接 gpuq 服务：${e.message}`);
  }
}

function renderBanner() {
  const q = STATE.system.queue;
  const banner = $("#paused-banner");
  if (q.paused) {
    $("#pause-reason").textContent = q.pause_reason || "";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function renderGpuCards() {
  const wrap = $("#gpu-cards");
  const gpus = STATE.system.gpus || [];
  wrap.innerHTML = gpus.map((g, i) => {
    const util = g.gpu_util ?? 0;
    const memPct = g.mem_total ? (100 * (g.mem_used ?? 0)) / g.mem_total : 0;
    const running = STATE.system.queue.running_gpu === String(g.index);
    return `
    <div class="gpu-card">
      <div class="gpu-name">GPU ${g.index}</div>
      <div class="gpu-sub">${esc(g.name)}</div>
      <div class="row"><span>util</span><span class="big">${fmtNum(util)}%</span></div>
      <div class="util-bar ${util > 90 ? "hot" : ""}"><div style="width:${Math.min(util, 100)}%"></div></div>
      <div class="row"><span>显存</span><span>${fmtMB(g.mem_used)} / ${fmtMB(g.mem_total)} (${fmtNum(memPct)}%)</span></div>
      <div class="row"><span>温度</span><span>${fmtNum(g.temp)}°C</span></div>
      <div class="row"><span>功耗</span><span>${fmtNum(g.power_w)} / ${fmtNum(g.power_limit)} W</span></div>
      <div class="row"><span>SM 时钟</span><span>${fmtNum(g.sm_clock)} MHz</span></div>
      ${running ? `<div class="running-chip">▶ 运行中任务占用</div>` : ""}
    </div>`;
  }).join("");
  if (!gpus.length) {
    wrap.innerHTML = `<div class="panel muted">未检测到 GPU（nvidia-smi 不可用）</div>`;
  }
}

/* ---------------- tasks table ---------------- */

async function refreshTasks() {
  try {
    const params = new URLSearchParams();
    if (STATE.statusFilter) params.set("status", STATE.statusFilter);
    params.set("limit", "200");
    STATE.tasks = await api("GET", "/api/tasks?" + params);
    renderTasks();
  } catch (e) {
    showError(`加载任务失败：${e.message}`);
  }
}

function statusPill(s) {
  const label = { queued: "排队", running: "运行中", succeeded: "成功", failed: "失败", cancelled: "已取消" }[s] || s;
  return `<span class="status-pill status-${s}">${label}</span>`;
}

function renderTasks() {
  const rows = STATE.tasks;
  const tbody = $("#task-table tbody");
  $("#tasks-empty").classList.toggle("hidden", rows.length > 0);
  tbody.innerHTML = rows.map((t) => `
    <tr>
      <td><span class="task-link" data-id="${t.id}">${esc(t.id.slice(0, 8))}</span></td>
      <td>${statusPill(t.status)}</td>
      <td>${esc(t.gpu_id ?? "auto")}</td>
      <td>${t.priority}</td>
      <td>${t.vram_mb ? t.vram_mb + "M" : "-"}</td>
      <td>${esc(duration(t))}</td>
      <td>${esc(t.project)}</td>
      <td>${esc(t.username)}</td>
      <td>${esc(t.version || "")}</td>
      <td class="cmd-cell" title="${esc(t.command.join(" "))}">${esc(t.command.join(" "))}</td>
      <td class="actions">
        ${t.status === "running" ? `<button class="btn btn-sm btn-danger" data-cancel="${t.id}">取消</button>` : ""}
        ${t.status === "queued" ? `<button class="btn btn-sm btn-danger" data-cancel="${t.id}">取消</button>` : ""}
        ${["succeeded", "failed", "cancelled"].includes(t.status) ? `<button class="btn btn-sm" data-rerun="${t.id}">重跑</button>` : ""}
      </td>
    </tr>`).join("");

  tbody.querySelectorAll(".task-link").forEach((el) =>
    el.addEventListener("click", () => openDetail(el.dataset.id)));
  tbody.querySelectorAll("[data-cancel]").forEach((el) =>
    el.addEventListener("click", () => cancelTask(el.dataset.cancel)));
  tbody.querySelectorAll("[data-rerun]").forEach((el) =>
    el.addEventListener("click", () => rerunTask(el.dataset.rerun)));
}

function duration(t) {
  if (t.started_at && t.finished_at) {
    const a = new Date(t.started_at), b = new Date(t.finished_at);
    const s = Math.round((b - a) / 1000);
    return s >= 60 ? Math.round(s / 60) + "m" + (s % 60) + "s" : s + "s";
  }
  if (t.status === "running" && t.started_at) {
    return "…" + Math.round((Date.now() - new Date(t.started_at)) / 1000) + "s";
  }
  return "-";
}

async function cancelTask(id) {
  if (!confirm(`取消任务 ${id.slice(0, 8)}？（运行中会被强杀）`)) return;
  try {
    await api("DELETE", `/api/tasks/${id}`);
    refreshTasks(); refreshSystem();
  } catch (e) { showError(e.message); }
}

async function rerunTask(id) {
  try {
    await api("POST", `/api/tasks/${id}/rerun`);
    refreshTasks(); refreshSystem();
  } catch (e) { showError(e.message); }
}

/* ---------------- charts ---------------- */

const RANGES = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 };
const COLORS = {
  util: "#4da3ff", mem: "#bc8cff", temp: "#f85149", power: "#d29922",
  sm: "#3fb950", rx: "#4da3ff", tx: "#bc8cff", disk: "#d29922", cpu: "#3fb950",
};

function makeChart(key, label, unit) {
  const box = document.createElement("div");
  box.className = "chart-box";
  box.innerHTML = `<h4>${label}</h4><canvas></canvas>`;
  $("#charts").appendChild(box);
  const ctx = box.querySelector("canvas").getContext("2d");
  const chart = new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [] },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#7d8794", maxTicksLimit: 8 }, grid: { color: "#232b36" } },
        y: { ticks: { color: "#7d8794", callback: (v) => v + unit }, grid: { color: "#232b36" } },
      },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.5, tension: 0.2 } },
    },
  });
  chart.gpuLabel = label;
  return chart;
}

function dataset(name, color) {
  return {
    label: name,
    data: [],
    borderColor: color,
    backgroundColor: color + "22",
    fill: false,
    tension: 0.2,
    borderWidth: 1.5,
    pointRadius: 0,
  };
}

async function refreshCharts() {
  const range = RANGES[STATE.range] || 3600;
  const from = Math.floor(Date.now() / 1000) - range;
  const step = range <= 3600 ? 30 : range <= 21600 ? 120 : 600;
  try {
    const data = await api("GET", `/api/metrics?from=${from}&step=${step}`);
    const hasData = Object.values(data.gpus).some((s) => s.length > 0);
    $("#charts-empty").classList.toggle("hidden", hasData);
    if (!hasData) { $("#charts").innerHTML = ""; STATE.charts = {}; return; }

    const gpuIds = Object.keys(data.gpus);
    const need = gpuIds.length * 4 + 1; // per gpu: util/mem/temp/power + 1 host chart
    if (Object.keys(STATE.charts).length !== need) {
      $("#charts").innerHTML = "";
      STATE.charts = {};
      gpuIds.forEach((gid) => {
        STATE.charts[`g${gid}-util`] = makeChart(`GPU ${gid} 利用率`, "GPU 利用率", "%");
        STATE.charts[`g${gid}-mem`] = makeChart(`GPU ${gid} 显存`, "显存", "MB");
        STATE.charts[`g${gid}-temp`] = makeChart(`GPU ${gid} 温度 / 功耗`, "温度 / 功耗", "");
        STATE.charts[`g${gid}-sm`] = makeChart(`GPU ${gid} SM 时钟`, "SM 时钟", "MHz");
      });
      STATE.charts.host = makeChart("宿主机 net / disk / cpu", "宿主机 IO / CPU", "");
      STATE.charts.host.data = { labels: [], datasets: [] };
    }

    gpuIds.forEach((gid) => {
      const series = data.gpus[gid];
      const labels = series.map((r) => new Date(r.ts * 1000).toLocaleTimeString("zh-CN", { hour12: false }));
      const util = series.map((r) => r.gpu_util ?? 0);
      const mem = series.map((r) => r.mem_used ?? 0);
      const temp = series.map((r) => r.temp ?? 0);
      const power = series.map((r) => r.power_w ?? 0);
      const sm = series.map((r) => r.sm_clock ?? 0);
      setChart(STATE.charts[`g${gid}-util`], labels, [dataset("util", COLORS.util)], [util]);
      setChart(STATE.charts[`g${gid}-mem`], labels, [dataset("mem", COLORS.mem)], [mem]);
      setChart(STATE.charts[`g${gid}-temp`], labels,
        [dataset("temp", COLORS.temp), dataset("power", COLORS.power)], [temp, power]);
      setChart(STATE.charts[`g${gid}-sm`], labels, [dataset("sm", COLORS.sm)], [sm]);
    });

    const hostSeries = data.host || [];
    const hostLabels = hostSeries.map((r) => new Date(r.ts * 1000).toLocaleTimeString("zh-CN", { hour12: false }));
    const netRx = hostSeries.map((r) => ((r.net_rx ?? 0) / 1024 / 1024).toFixed(2));
    const netTx = hostSeries.map((r) => ((r.net_tx ?? 0) / 1024 / 1024).toFixed(2));
    const disk = hostSeries.map((r) => ((r.disk_io ?? 0) / 1024 / 1024).toFixed(2));
    const cpu = hostSeries.map((r) => r.cpu ?? 0);
    const hostChart = STATE.charts.host;
    if (!data.host_available) {
      hostChart.gpuLabel = "宿主机指标（psutil 未安装，仅 GPU 可用）";
      setChart(hostChart, hostLabels, [dataset("cpu", COLORS.cpu)], [cpu]);
    } else {
      hostChart.gpuLabel = "宿主机 net(MB/s) / disk(MB/s) / cpu(%)";
      setChart(hostChart, hostLabels,
        [dataset("net_rx", COLORS.rx), dataset("net_tx", COLORS.tx),
         dataset("disk", COLORS.disk), dataset("cpu", COLORS.cpu)],
        [netRx, netTx, disk, cpu]);
    }
  } catch (e) {
    showError(`加载指标失败：${e.message}`);
  }
}

function setChart(chart, labels, datasets, series) {
  datasets.forEach((ds, i) => { ds.data = series[i]; });
  chart.data.labels = labels;
  chart.data.datasets = datasets;
  chart.options.plugins.legend.display = datasets.length > 1;
  if (datasets.length > 1) {
    chart.options.plugins.legend.labels = { color: "#7d8794" };
  }
  chart.update();
}

/* ---------------- task detail ---------------- */

async function openDetail(id) {
  STATE.detailTaskId = id;
  location.hash = `#/tasks/${id}`;
  const modal = $("#modal-detail");
  modal.classList.remove("hidden");
  $("#detail-body").innerHTML = `<div class="muted">加载中…</div>`;
  await loadDetail(id);
  if (STATE.logTimer) clearInterval(STATE.logTimer);
  STATE.logTimer = setInterval(() => loadLogs(id, true), 3000);
}

async function loadDetail(id) {
  try {
    const [t, logs] = await Promise.all([
      api("GET", `/api/tasks/${id}`),
      api("GET", `/api/tasks/${id}/logs?limit=1000`),
    ]);
    $("#detail-title").textContent = `任务 ${t.id.slice(0, 8)} — ${t.status}`;
    const agg = t.agg;
    const aggHtml = agg ? `
      <div class="detail-cell"><div class="k">平均利用率</div><div class="v">${fmtNum(agg.avg_util)}%</div></div>
      <div class="detail-cell"><div class="k">峰值显存</div><div class="v">${fmtMB(agg.peak_mem)}</div></div>
      <div class="detail-cell"><div class="k">最高温度</div><div class="v">${fmtNum(agg.max_temp)}°C</div></div>
      <div class="detail-cell"><div class="k">峰值功耗</div><div class="v">${fmtNum(agg.max_power)}W</div></div>
      <div class="detail-cell"><div class="k">峰值net_rx</div><div class="v">${fmtNum(agg.peak_net_rx / 1024 / 1024, 2)}MB/s</div></div>
      <div class="detail-cell"><div class="k">峰值net_tx</div><div class="v">${fmtNum(agg.peak_net_tx / 1024 / 1024, 2)}MB/s</div></div>
      <div class="detail-cell"><div class="k">峰值disk IO</div><div class="v">${fmtNum(agg.peak_disk_io / 1024 / 1024, 2)}MB/s</div></div>
    ` : "";
    const cmds = esc(t.command.join(" "));
    const logText = logs.lines.join("\n") || "(暂无日志输出)";
    $("#detail-body").innerHTML = `
      <div class="detail-grid">
        <div class="detail-cell"><div class="k">状态</div><div class="v">${statusPill(t.status)}</div></div>
        <div class="detail-cell"><div class="k">GPU</div><div class="v">${esc(t.gpu_id ?? "auto")}</div></div>
        <div class="detail-cell"><div class="k">项目 / 用户</div><div class="v">${esc(t.project)} / ${esc(t.username)}</div></div>
        <div class="detail-cell"><div class="k">优先级</div><div class="v">${t.priority}</div></div>
        <div class="detail-cell"><div class="k">预估显存</div><div class="v">${t.vram_mb || 0} MB</div></div>
        <div class="detail-cell"><div class="k">预估时长</div><div class="v">${t.est_seconds ? t.est_seconds + "s" : "-"}</div></div>
        <div class="detail-cell"><div class="k">fallback_wait</div><div class="v">${t.fallback_wait_seconds}s</div></div>
        <div class="detail-cell"><div class="k">功耗上限</div><div class="v">${t.power_limit_w ?? "-"} W</div></div>
        <div class="detail-cell"><div class="k">版本</div><div class="v">${esc(t.version || "-")}</div></div>
        <div class="detail-cell"><div class="k">退出码</div><div class="v">${t.exit_code ?? "-"}</div></div>
        <div class="detail-cell"><div class="k">PID</div><div class="v">${t.pid ?? "-"}</div></div>
        <div class="detail-cell"><div class="k">日志文件</div><div class="v">${esc(t.log_file || "-")}</div></div>
        ${aggHtml}
      </div>
      <div class="detail-cell" style="margin-bottom:10px">
        <div class="k">命令</div><div class="v">${cmds}</div>
      </div>
      <div class="log-tools">
        <b style="font-size:13px">日志</b>
        <input id="log-grep" placeholder="grep 过滤…">
        <button class="btn btn-sm" id="btn-log-refresh">刷新</button>
      </div>
      <div class="log-viewer" id="log-viewer">${esc(logText)}</div>
      <div class="modal-foot">
        <button class="btn btn-sm" id="btn-log-download">下载日志</button>
        <button class="btn btn-sm btn-danger" id="btn-detail-cancel">取消任务</button>
        <button class="btn btn-sm modal-close" data-close="modal-detail">关闭</button>
      </div>`;
    $("#log-grep").addEventListener("input", () => applyLogGrep());
    $("#btn-log-refresh").addEventListener("click", () => loadLogs(id, true));
    $("#btn-detail-cancel").addEventListener("click", () => cancelTask(id));
    $("#btn-log-download").addEventListener("click", () => {
      const blob = new Blob([logText], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${t.id}.log`;
      a.click();
    });
    applyLogGrep();
    await loadTaskMetrics(id);
  } catch (e) {
    $("#detail-body").innerHTML = `<div class="muted">加载失败：${esc(e.message)}</div>`;
  }
}

async function loadLogs(id, append) {
  if (!STATE.detailTaskId || STATE.detailTaskId !== id) return;
  try {
    const logs = await api("GET", `/api/tasks/${id}/logs?limit=1000`);
    const viewer = $("#log-viewer");
    if (!viewer) return;
    const text = logs.lines.join("\n");
    if (text) {
      viewer.textContent = text;
      if (append) viewer.scrollTop = viewer.scrollHeight;
      applyLogGrep();
    }
  } catch (e) { /* ignore transient */ }
}

function applyLogGrep() {
  const q = ($("#log-grep")?.value || "").trim();
  const viewer = $("#log-viewer");
  if (!viewer) return;
  const lines = viewer.textContent.split("\n");
  if (!q) { return; }
  const filtered = lines.filter((l) => l.includes(q));
  viewer.textContent = filtered.length ? filtered.join("\n") : `(无匹配 "${q}")`;
  viewer.scrollTop = 0;
}

async function loadTaskMetrics(id) {
  try {
    const series = await api("GET", `/api/tasks/${id}/metrics`);
    const holder = document.createElement("div");
    holder.id = "task-metrics-chart";
    holder.className = "chart-box";
    holder.innerHTML = `<h4>任务运行窗口指标</h4><canvas style="height:180px"></canvas>`;
    $("#detail-body").appendChild(holder);
    if (!series.length) { holder.innerHTML = `<h4>任务运行窗口指标</h4><div class="muted">该任务窗口内无采样点</div>`; return; }
    const labels = series.map((r) => new Date(r.ts * 1000).toLocaleTimeString("zh-CN", { hour12: false }));
    new Chart(holder.querySelector("canvas").getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          { ...dataset("util", COLORS.util), yAxisID: "y", data: series.map((r) => r.gpu_util ?? 0) },
          { ...dataset("temp", COLORS.temp), yAxisID: "y1", data: series.map((r) => r.temp ?? 0) },
          { ...dataset("power", COLORS.power), yAxisID: "y1", data: series.map((r) => r.power_w ?? 0) },
          { ...dataset("mem", COLORS.mem), yAxisID: "y2", data: series.map((r) => r.mem_used ?? 0) },
        ],
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: "#7d8794" } } },
        scales: {
          x: { ticks: { color: "#7d8794", maxTicksLimit: 8 }, grid: { color: "#232b36" } },
          y: { position: "left", title: { display: true, text: "%", color: "#7d8794" }, ticks: { color: "#7d8794" }, grid: { color: "#232b36" } },
          y1: { position: "right", title: { display: true, text: "°C / W", color: "#7d8794" }, ticks: { color: "#7d8794" }, grid: { display: false } },
          y2: { position: "right", title: { display: true, text: "MB", color: "#7d8794" }, ticks: { color: "#7d8794" }, grid: { display: false } },
        },
      },
    });
  } catch (e) { /* ignore */ }
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
  // shell-like split for the textarea
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
    if (STATE.logTimer) { clearInterval(STATE.logTimer); STATE.logTimer = null; }
    if (location.hash.startsWith("#/tasks")) history.replaceState(null, "", "#");
  }));

$$("#status-tabs .tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$("#status-tabs .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    STATE.statusFilter = tab.dataset.status;
    refreshTasks();
  }));

$$("#range-buttons .btn").forEach((b) =>
  b.addEventListener("click", () => {
    $$("#range-buttons .btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    STATE.range = b.dataset.range;
    refreshCharts();
  }));

$("#btn-refresh").addEventListener("click", () => { refreshTasks(); refreshSystem(); });
$("#btn-new").addEventListener("click", openNewModal);
$("#btn-resume").addEventListener("click", async () => {
  try { await api("POST", "/api/queue/resume"); refreshSystem(); } catch (e) { showError(e.message); }
});

function boot() {
  const onHash = () => {
    const m = location.hash.match(/^#\/tasks\/([^/]+)/);
    if (m) openDetail(m[1]);
  };
  window.addEventListener("hashchange", onHash);
  if (location.hash) onHash();

  refreshSystem();
  refreshTasks();
  refreshCharts();
  setInterval(refreshSystem, 5000);
  setInterval(refreshTasks, 5000);
  setInterval(refreshCharts, 30000);
  setInterval(() => { $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false }); }, 1000);
}

boot();
