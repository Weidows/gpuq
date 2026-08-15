/* dev-only harness: exercise the mock backend the way app.js does (node >= 18) */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "mock-api.js"), "utf8");
const fn = new Function("require", src);
fn(require);

const mock = globalThis.__gpuqMock;
const { fetch } = mock;

function check(name, cond, extra) {
  if (!cond) {
    console.error("FAIL:", name, extra !== undefined ? JSON.stringify(extra) : "");
    process.exitCode = 1;
  } else {
    console.log("ok  :", name);
  }
}

(async () => {
  // /api/system shape used by app.js renderGpuCards / renderBanner
  const sys = (await (await fetch("/api/system")).json()).data;
  check("system.gpus is array of 4", Array.isArray(sys.gpus) && sys.gpus.length === 4);
  check("gpu card fields", ["index", "name", "gpu_util", "mem_used", "mem_total", "temp", "power_w", "sm_clock"].every((k) => k in sys.gpus[0]));
  check("queue state", "paused" in sys.queue && "running_gpu" in sys.queue);
  check("host_available", sys.host_available === true);

  // /api/tasks list
  const tasks = (await (await fetch("/api/tasks?limit=200")).json()).data;
  check("tasks is array", Array.isArray(tasks) && tasks.length >= 5);
  const t0 = tasks.find((t) => t.status === "running");
  check("running task fields", t0 && Array.isArray(t0.command) && t0.gpu_id !== undefined && t0.vram_mb !== undefined);

  // task detail + agg
  const detail = (await (await fetch(`/api/tasks/${t0.id}`)).json()).data;
  check("detail has agg", detail.agg && typeof detail.agg.avg_util === "number");

  // logs
  const logs = (await (await fetch(`/api/tasks/${t0.id}/logs?limit=1000`)).json()).data;
  check("logs lines array", Array.isArray(logs.lines) && logs.lines.length > 0, logs.lines.slice(0, 2));
  check("log lines non-empty strings", logs.lines.every((l) => typeof l === "string" && l.length > 0));

  // task metrics window
  const met = (await (await fetch(`/api/tasks/${t0.id}/metrics`)).json()).data;
  check("task metrics array", Array.isArray(met) && met.length > 0);
  check("metric point fields", met.length === 0 || ("gpu_util" in met[0] && "ts" in met[0]));

  // chart series
  const from = Math.floor(Date.now() / 1000) - 3600;
  const chart = (await (await fetch(`/api/metrics?from=${from}&step=30`)).json()).data;
  const gpuKeys = Object.keys(chart.gpus);
  check("metrics.gpus keys = 4 gpu ids", gpuKeys.length === 4, gpuKeys);
  check("metrics.host array", Array.isArray(chart.host) && chart.host.length > 0);
  check("gpu series has data", gpuKeys.every((k) => Array.isArray(chart.gpus[k]) && chart.gpus[k].length > 0));

  // create task (form flow in app.js)
  const body = {
    command: ["python", "train.py", "--model", "tiny", "--epochs", "2"],
    project: "demo", username: "harness", gpu_id: null, vram_mb: 4096,
    est_seconds: 60, priority: 5, fallback_wait_seconds: 0, version: "abc",
  };
  const created = (await (await fetch("/api/tasks", { method: "POST", body: JSON.stringify(body) })).json()).data;
  check("create returns task", created && created.status === "queued" && Array.isArray(created.command));

  // wait a tick so scheduler can pick it up
  mock.tick();
  await new Promise((r) => setTimeout(r, 2500));
  mock.tick();
  const after = (await (await fetch(`/api/tasks/${created.id}`)).json()).data;
  console.log("  created task now:", after.status, after.gpu_id);

  // delete / rerun
  const rerun = (await (await fetch(`/api/tasks/${created.id}/rerun`, { method: "POST" })).json()).data;
  check("rerun creates queued clone", rerun && rerun.status === "queued" && rerun.id !== created.id);
  const del = (await (await fetch(`/api/tasks/${rerun.id}`, { method: "DELETE" })).json()).data;
  check("delete returns id", del && del.deleted === rerun.id);

  // pause/resume
  await fetch("/api/queue/pause", { method: "POST", body: JSON.stringify({ reason: "harness" }) });
  const pausedSys = (await (await fetch("/api/system")).json()).data;
  check("queue paused", pausedSys.queue.paused === true && pausedSys.queue.pause_reason === "harness");
  await fetch("/api/queue/resume", { method: "POST" });
  const resumedSys = (await (await fetch("/api/system")).json()).data;
  check("queue resumed", resumedSys.queue.paused === false);

  // metrics pruning keeps things bounded
  const hist = mock.state.history;
  const totalPoints = Object.keys(hist).reduce((acc, k) => acc + hist[k].length, 0);
  console.log("  history points:", totalPoints, "per-gpu:", hist[0].length, "host:", hist.host.length);
  check("history bounded (< 60000 total)", totalPoints < 60000);

  console.log(process.exitCode ? "\nsome checks FAILED" : "\nall checks passed");
})();
