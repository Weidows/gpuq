/* gpuq WebUI — in-browser simulated backend for the GitHub Pages live demo.
 *
 * GitHub Pages can't run the real gpuq server, so this file stands in for it:
 * it replaces window.fetch for every /api/* route with realistic mock data
 * (a 4-GPU lab, a live task queue, per-task logs, and streaming GPU/host
 * metrics) so the real dashboard (app.js) runs unmodified against it.
 *
 * The simulated world keeps evolving on a timer: running tasks progress and
 * append log lines, GPU cards fluctuate, queued tasks get scheduled onto free
 * GPUs, finished tasks land in succeeded/failed/cancelled. All write actions
 * (new task / cancel / rerun / pause / resume) work too.
 */
"use strict";
(function () {
  const root = typeof window !== "undefined" ? window : globalThis;
  const IS_BROWSER = typeof document !== "undefined";

  const now = () => Math.floor(Date.now() / 1000);
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const hex = (n) =>
    Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  const fmtTs = (ts) => new Date(ts * 1000).toISOString().slice(0, 19).replace("T", " ");

  /* ------------------------- hardware ------------------------------------- */

  const GPU_SPECS = {
    0: { name: "NVIDIA GeForce RTX 4090", mem_total: 24564, power_limit: 450, power_max: 450, power_min: 100, sm_clock: 2520, mem_clock: 10501, pcie_gen: 4 },
    1: { name: "NVIDIA GeForce RTX 4090", mem_total: 24564, power_limit: 450, power_max: 450, power_min: 100, sm_clock: 2520, mem_clock: 10501, pcie_gen: 4 },
    2: { name: "NVIDIA A100 80GB PCIe", mem_total: 81920, power_limit: 300, power_max: 300, power_min: 100, sm_clock: 1410, mem_clock: 1593, pcie_gen: 4 },
    3: { name: "NVIDIA RTX A6000", mem_total: 49140, power_limit: 300, power_max: 300, power_min: 100, sm_clock: 1860, mem_clock: 8001, pcie_gen: 4 },
  };

  /* ------------------------- task log generators --------------------------- */

  function progressBar(pct, width) {
    const filled = Math.round((pct / 100) * width);
    return "█".repeat(filled) + " ".repeat(width - filled);
  }

  // Deterministic fake training logs for a task that has run `secs` seconds.
  // Sparse by design (~maxLines across the whole run) so logs stay small.
  function genTrainLog(secs, opts) {
    const o = Object.assign({ epochs: 3, total_steps: 2341, it_s: 17.4, start: 0, maxLines: 600 }, opts);
    const lines = [];
    const stepDur = 1 / o.it_s; // simulated seconds per training step
    const totalSteps = o.total_steps * o.epochs;
    const nSteps = Math.min(totalSteps, Math.floor(secs / stepDur));
    const every = Math.max(1, Math.ceil(Math.max(totalSteps, nSteps) / o.maxLines));
    for (let step = 1; step <= nSteps; step += every) {
      const epoch = Math.min(Math.floor(step / o.total_steps) + 1, o.epochs);
      const inEpoch = step % o.total_steps || o.total_steps;
      const pct = (inEpoch / o.total_steps) * 100;
      const elapsed = step * stepDur;
      const eta = ((o.total_steps - inEpoch) + (o.epochs - epoch) * o.total_steps) * stepDur;
      const loss = clamp(2.6 - (step / 8000) * 1.9 - Math.sin(step / 300) * 0.05, 0.4, 2.6).toFixed(3);
      lines.push(
        `[${fmtTs(o.start + Math.floor(elapsed))}] Epoch ${epoch}/${o.epochs}: ${String(Math.floor(pct)).padStart(3)}%|${progressBar(pct, 18)}| ${inEpoch}/${o.total_steps} [${fmtDur(elapsed)}<${fmtDur(Math.max(0, eta))}, ${o.it_s.toFixed(2)}it/s, loss=${loss}, lr=${(2e-5 * (1 - step / totalSteps)).toExponential(1)}]`
      );
    }
    return lines;
  }

  function fmtDur(s) {
    const sec = Math.floor(s) % 60;
    const min = Math.floor(s / 60) % 60;
    const hr = Math.floor(s / 3600);
    return hr > 0 ? `${hr}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function genEvalLog(secs, opts) {
    const o = Object.assign({ benches: ["mmlu", "gsm8k", "humaneval"], seed: 1 }, opts);
    const lines = [];
    const per = Math.max(6, secs / 8);
    let t = 0, i = 0;
    while (t < secs) {
      const bench = o.benches[i % o.benches.length];
      const pct = Math.min(100, (t / secs) * 100);
      const score = bench === "mmlu" ? rand(0.68, 0.72) : bench === "gsm8k" ? rand(0.71, 0.76) : rand(0.55, 0.62);
      lines.push(`[${fmtTs(o.start + Math.floor(t))}] Evaluating ${bench}@5-shot: ${String(Math.floor(pct)).padStart(3)}%|${progressBar(pct, 18)}| ${Math.floor(t / per)}/8 [${fmtDur(t)}<${fmtDur(Math.max(0, secs - t))}, ${score.toFixed(3)}]`);
      t += per; i++;
    }
    return lines;
  }

  const OOM_LOG = [
    "[{ts}] Loading model shards: 100%|██████████| 4/4 [00:12<00:00]",
    "[{ts}]   /work/models/llama-3-8b/shard-2.safetensors",
    "[{ts}]   /work/models/llama-3-8b/shard-3.safetensors",
    "[{ts}] Traceback (most recent call last):",
    "[{ts}]   File \"/work/train.py\", line 42, in <module>",
    "[{ts}]     model = model.to(\"cuda\")",
    "[{ts}] torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 512.00 MiB",
    "[{ts}] (GPU 1; 24.39 GiB total capacity; 23.51 GiB already allocated; 512.00 MiB free;",
    "[{ts}]  ... 12.04 GiB reserved in total by PyTorch)",
  ];
  const CANCEL_LOG = [
    "[{ts}] Task received SIGTERM — cancelling (queue: manual cancel by weidows)",
    "[{ts}] Cleaning up worker processes...",
  ];

  /* ------------------------- state ------------------------------------------ */

  const BOOT = now();
  const S = {
    gpus: {},           // index -> live state
    history: {},        // index -> fine-grained metric points (also "host")
    tasks: [],          // task objects
    paused: false,
    pause_reason: null,
    boot: BOOT,
    lastTick: BOOT,
    tickNo: 0,
  };

  // live per-GPU state, seeded from spec
  Object.keys(GPU_SPECS).forEach((i) => {
    const sp = GPU_SPECS[i];
    S.gpus[i] = {
      index: +i, name: sp.name, uuid: "GPU-" + hex(8).toUpperCase(),
      mem_total: sp.mem_total, power_limit: sp.power_limit,
      power_max: sp.power_max, power_min: sp.power_min,
      sm_clock: sp.sm_clock, mem_clock: sp.mem_clock, pcie_gen: sp.pcie_gen,
      gpu_util: 0, mem_util: 0, mem_used: Math.round(rand(600, 2200)),
      temp: Math.round(rand(36, 46)), power_w: Math.round(rand(28, 70)),
    };
    S.history[i] = [];
  });
  S.history.host = [];

  function mkTask(o) {
    const t = Object.assign({
      id: hex(12), project: "unnamed", username: "weidows", gpu_id: null,
      vram_mb: 0, est_seconds: 0, priority: 5, command: ["echo", "hello"],
      cwd: null, env: {}, fallback_wait_seconds: 0, api_key: "", version: "",
      power_limit_w: null, status: "queued",
      created_at: null, started_at: null, finished_at: null,
      exit_code: null, pid: null, log_file: null,
    }, o);
    t.log_file = t.log_file || `data/logs/${t.id}.log`;
    t.env = Object.assign({ CUDA_VISIBLE_DEVICES: t.gpu_id ?? "auto" }, t.env || {});
    t.log = o.log || [];
    t._series = o._series || []; // metric points inside the task's run window
    return t;
  }

  function taskById(id) { return S.tasks.find((t) => t.id === id); }

  /* Seed a believable day on a busy ML lab box. */
  function seed() {
    const b = BOOT;
    const t0 = BOOT - 3600;

    // --- history: one hour of metrics at ~30s resolution per GPU + host
    Object.keys(S.gpus).forEach((i) => {
      const g = S.gpus[i];
      for (let ts = t0; ts <= b; ts += 30) {
        const busy = i === "0" || i === "2"; // GPUs that were running jobs this hour
        const util = busy ? clamp(85 + Math.sin(ts / 200) * 8 + rand(-6, 6), 60, 99) : rand(0, 5);
        const mem = busy ? (i === "2" ? 56000 + rand(-800, 800) : 21000 + rand(-400, 400)) : rand(600, 2200);
        S.history[i].push(mkPoint(i, ts, util, mem, busy ? 74 + rand(-3, 3) : 40 + rand(-4, 4),
          busy ? 340 + rand(-30, 30) : 45 + rand(-10, 10), busy ? g.sm_clock - rand(0, 120) : 210 + rand(0, 120)));
      }
    });
    for (let ts = t0; ts <= b; ts += 30) {
      S.history.host.push({
        ts, net_rx: rand(8, 60) * 1024 * 1024, net_tx: rand(3, 40) * 1024 * 1024,
        disk_io: rand(2, 30) * 1024 * 1024, cpu: rand(8, 42),
      });
    }

    // --- task list
    S.tasks = [
      // running
      mkTask({
        id: "9f2c1a7d4e01", project: "llm-finetune", username: "alice", gpu_id: "0",
        vram_mb: 21000, est_seconds: 5400, priority: 9, version: "9f2c1a7",
        command: ["python", "train.py", "--model", "llama-3.1-8b", "--dataset", "sft-corpus-v3",
                  "--lr", "2e-5", "--epochs", "3", "--per-device-bs", "4", "--grad-accum", "8"],
        status: "running", created_at: b - 1560, started_at: b - 1500, pid: 18231,
        fallback_wait_seconds: 300,
      }),
      mkTask({
        id: "b41d0ef2c890", project: "eval-rag", username: "bob", gpu_id: "2",
        vram_mb: 60000, est_seconds: 900, priority: 7, version: "b41d0ef",
        command: ["python", "eval.py", "--checkpoint", "runs/final", "--bench", "mmlu,gsm8k,humaneval", "--shots", "5"],
        status: "running", created_at: b - 480, started_at: b - 420, pid: 19307,
        fallback_wait_seconds: 60,
      }),
      // queued
      mkTask({
        id: "7e3aa90c1b2d", project: "diffusion-train", username: "carol", gpu_id: null,
        vram_mb: 16000, est_seconds: 3600, priority: 6, version: "7e3aa90",
        command: ["python", "train_unet.py", "--config", "configs/sd2-xl.yaml", "--steps", "120000"],
        status: "queued", created_at: b - 120,
      }),
      mkTask({
        id: "d99f201e5a6b", project: "data-prep", username: "dave", gpu_id: null,
        vram_mb: 2048, est_seconds: 1800, priority: 3, version: "d99f201",
        command: ["python", "scripts/tokenize.py", "--input", "corpus", "--out", "shards", "--workers", "32"],
        status: "queued", created_at: b - 45,
      }),
      mkTask({
        id: "3c8e55bf7a9d", project: "ablation-lora", username: "alice", gpu_id: "0",
        vram_mb: 12000, est_seconds: 2100, priority: 5, version: "3c8e55b",
        command: ["python", "train_lora.py", "--base", "llama-3.1-8b", "--rank", "64", "--epochs", "2"],
        status: "succeeded", created_at: b - 6500, started_at: b - 6400, finished_at: b - 4300,
        exit_code: 0, pid: 14092,
        log: genTrainLog(2100, { epochs: 2, total_steps: 1417, it_s: 11.2, start: b - 6400, seed: 2 }),
        _series: genWindowSeries("0", b - 6400, b - 4300, 30, { utilBase: 86, memBase: 12000, tempBase: 72, powerBase: 300 }),
      }),
      mkTask({
        id: "aa1c9d4e0f12", project: "baseline-resnet", username: "eve", gpu_id: "1",
        vram_mb: 8000, est_seconds: 3800, priority: 4, version: "aa1c9d4",
        command: ["python", "train_cv.py", "--arch", "resnet-152", "--data", "imagenet-1k", "--bs", "256"],
        status: "succeeded", created_at: b - 9000, started_at: b - 8900, finished_at: b - 5100,
        exit_code: 0, pid: 13877,
        log: genTrainLog(3800, { epochs: 90, total_steps: 50045, it_s: 220, start: b - 8900, maxLines: 900 }),
        _series: genWindowSeries("1", b - 8900, b - 5100, 30, { utilBase: 88, memBase: 8000, tempBase: 70, powerBase: 280 }),
      }),
      mkTask({
        id: "f5e6d7c8b9a0", project: "inference-bench", username: "bob", gpu_id: "1",
        vram_mb: 14000, est_seconds: 600, priority: 6, version: "b41d0ef",
        command: ["python", "bench.py", "--model", "llama-3-8b", "--batch", "32", "--mode", "offline"],
        status: "failed", created_at: b - 5400, started_at: b - 5320, finished_at: b - 5308,
        exit_code: 1, pid: 15810,
        log: OOM_LOG.map((l) => l.replace("{ts}", fmtTs(b - 5315))),
        _series: genWindowSeries("1", b - 5320, b - 5308, 5, { utilBase: 30, memBase: 22000, tempBase: 68, powerBase: 250, spike: true }),
      }),
      mkTask({
        id: "e7f2bb3c4d5e", project: "backup-migrate", username: "frank", gpu_id: "3",
        vram_mb: 4000, est_seconds: 3600, priority: 1, version: "e7f2bb3",
        command: ["python", "scripts/migrate.py", "--from", "nfs:/data/v1", "--to", "lustre:/data/v2"],
        status: "cancelled", created_at: b - 3000, started_at: b - 2900, finished_at: b - 2850,
        exit_code: -9, pid: 14888,
        log: CANCEL_LOG.map((l) => l.replace("{ts}", fmtTs(b - 2852))),
        _series: genWindowSeries("3", b - 2900, b - 2850, 5, { utilBase: 12, memBase: 4000, tempBase: 44, powerBase: 80 }),
      }),
    ];

    // running tasks: seed their logs + in-window series
    const run0 = taskById("9f2c1a7d4e01");
    run0.log = genTrainLog(1500, { epochs: 3, total_steps: 2341, it_s: 17.4, start: b - 1500, seed: 1 });
    run0._series = genWindowSeries("0", b - 1500, b, 30, { utilBase: 88, memBase: 21000, tempBase: 76, powerBase: 360 });
    const run1 = taskById("b41d0ef2c890");
    run1.log = genEvalLog(420, { start: b - 420, seed: 4 });
    run1._series = genWindowSeries("2", b - 420, b, 30, { utilBase: 62, memBase: 60000, tempBase: 58, powerBase: 180 });
  }

  /* ---------------- external seed data (scripts/gen_mock_data.py) ----------
   *
   * When docs/mock-data.js is loaded (it defines window.__GPUQ_MOCK_DATA) use
   * that snapshot instead of the built-in seed above. The snapshot is
   * time-aligned to page load: all timestamps are shifted by the gap between
   * generation and load so the demo always looks fresh, log-line timestamps
   * are rewritten to match, and running durations stay natural. */
  const SEED_TS_RE = /^\[?(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\]?\s*/;

  function shiftLogTs(line, delta) {
    const m = line.match(SEED_TS_RE);
    if (!m) return line;
    const epoch = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 + delta;
    const iso = new Date(epoch * 1000).toISOString().slice(0, 19).replace("T", " ");
    const head = line.startsWith("[") ? "[" : "";
    const tail = line.slice(m[0].length).replace(/^\s+/, "");
    return head + iso + "] " + tail;
  }

  function loadSeedData() {
    const d = root.__GPUQ_MOCK_DATA;
    if (!d || !d.tasks) return false;
    const delta = Math.floor(now() - (d.boot || 0));
    Object.keys(d.gpus || {}).forEach((i) => {
      if (S.gpus[i]) Object.assign(S.gpus[i], d.gpus[i]);
    });
    Object.keys(d.history || {}).forEach((k) => {
      S.history[k] = d.history[k].map((p) => (delta ? { ...p, ts: p.ts + delta } : p));
    });
    S.tasks = d.tasks.map((t) => {
      const t2 = { ...t, log: [], _series: [] };
      for (const k of ["created_at", "started_at", "finished_at"]) if (t2[k]) t2[k] += delta;
      t2.log = (t.log || []).map((l) => (delta ? shiftLogTs(l, delta) : l));
      t2._series = (t._series || []).map((p) => (delta ? { ...p, ts: p.ts + delta } : p));
      t2._lastLogSecs = null; // tick() lazily initializes from started_at
      return t2;
    });
    return true;
  }

  if (!loadSeedData()) {
    seed();
  }

  /* Deterministic synthetic in-window series for finished/seed tasks. */
  function genWindowSeries(gpu, from, to, step, p) {
    const out = [];
    for (let ts = from; ts <= to; ts += step) {
      const jitter = Math.sin(ts / 90) * 8 + rand(-5, 5);
      const util = clamp(p.utilBase + jitter, 5, 99.9);
      const mem = p.memBase + (p.spike ? (ts > to - 20 ? 24000 : 0) : 0) + rand(-p.memBase * 0.05, p.memBase * 0.05);
      out.push({
        ts, gpu_id: gpu, gpu_util: util, mem_used: mem,
        temp: clamp(p.tempBase + jitter / 4 + rand(-2, 2), 30, 90),
        power_w: clamp(p.powerBase + jitter * 1.5 + rand(-20, 20), 30, 460),
        sm_clock: Math.round((p.utilBase > 60 ? 2400 : 1200) + rand(-150, 150)),
        net_rx: rand(4, 30) * 1024 * 1024, net_tx: rand(2, 20) * 1024 * 1024,
        disk_io: rand(2, 40) * 1024 * 1024,
      });
    }
    return out;
  }

  function mkPoint(gpu, ts, util, mem, temp, power, sm) {
    return {
      ts, gpu_id: gpu, gpu_util: Math.round(clamp(util, 0, 100) * 10) / 10,
      mem_used: Math.round(mem), mem_total: GPU_SPECS[gpu].mem_total,
      temp: Math.round(temp), power_w: Math.round(power), sm_clock: Math.round(sm),
      net_rx: rand(6, 50) * 1024 * 1024, net_tx: rand(3, 30) * 1024 * 1024,
      disk_io: rand(2, 25) * 1024 * 1024,
    };
  }

  /* ------------------------- simulation tick ------------------------------- */

  function runningTasks() { return S.tasks.filter((t) => t.status === "running"); }
  function queuedTasks() { return S.tasks.filter((t) => t.status === "queued"); }
  function taskOnGpu(gpuIdx) { return S.tasks.find((t) => t.status === "running" && t.gpu_id === String(gpuIdx)); }

  function tick() {
    const t = now();
    if (t - S.lastTick < 2) return; // don't spam on rapid refreshes
    const dt = t - S.lastTick;
    S.lastTick = t;
    S.tickNo++;

    // 1. progress running tasks: advance logs, maybe finish them
    runningTasks().forEach((task) => {
      const runSecs = t - task.started_at;
      // throttle log appends so a long-lived tab doesn't accumulate megabytes
      if (!task._lastLogSecs) task._lastLogSecs = task.started_at;
      if (runSecs - task._lastLogSecs >= 4) {
        const line = nextLogLine(task, runSecs);
        if (line && task.log[task.log.length - 1] !== line) task.log.push(line);
        task._lastLogSecs = runSecs;
      }
      if (runSecs >= task.est_seconds && task.status === "running") {
        task.status = "succeeded";
        task.finished_at = t;
        task.exit_code = 0;
        task.log.push(`[${fmtTs(t)}] Finished successfully (${fmtDur(runSecs)} elapsed).`);
      }
    });

    // 2. scheduler: start the best queued task on any free GPU
    if (!S.paused) {
      Object.keys(GPU_SPECS).forEach((i) => {
        if (taskOnGpu(i)) return;
        const free = GPU_SPECS[i].mem_total - S.gpus[i].mem_used;
        const fit = queuedTasks()
          .filter((q) => q.vram_mb <= free)
          .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
        if (!fit.length) return;
        const job = fit[0];
        job.status = "running";
        job.gpu_id = String(i);
        job.started_at = t;
        job.pid = 20000 + Math.floor(rand(0, 20000));
        job.env.CUDA_VISIBLE_DEVICES = String(i);
        job.log = [`[${fmtTs(t)}] starting: ${job.command.join(" ")}`];
        job._series = [];
      });
    }

    // 3. live GPU state (driven by whichever task owns each GPU)
    Object.keys(GPU_SPECS).forEach((i) => {
      const g = S.gpus[i];
      const task = taskOnGpu(i);
      if (task) {
        const train = /train/.test((task.command[1] || "") + task.command[0]);
        const targetUtil = train ? 92 : 64;
        const targetMem = task.vram_mb * 0.92;
        const targetTemp = train ? 80 : 62;
        const targetPower = train ? GPU_SPECS[i].power_limit * 0.82 : 200;
        g.gpu_util = clamp(g.gpu_util + (targetUtil - g.gpu_util) * 0.35 + rand(-3, 3), 5, 99);
        g.mem_used = clamp(g.mem_used + (targetMem - g.mem_used) * 0.3 + rand(-200, 200), 0, GPU_SPECS[i].mem_total);
        g.temp = clamp(g.temp + (targetTemp - g.temp) * 0.05 + rand(-0.8, 0.8), 35, 92);
        g.power_w = clamp(g.power_w + (targetPower - g.power_w) * 0.3 + rand(-25, 25), 40, GPU_SPECS[i].power_limit + 20);
        g.sm_clock = train ? Math.round(GPU_SPECS[i].sm_clock * (0.9 + rand(0, 0.1))) : Math.round(GPU_SPECS[i].sm_clock * 0.62);
      } else {
        g.gpu_util = clamp(g.gpu_util + (rand(0, 2.2) - g.gpu_util) * 0.4, 0, 6);
        g.mem_used = clamp(g.mem_used + rand(-60, 60), 400, 2600);
        g.temp = clamp(g.temp + (44 - g.temp) * 0.05 + rand(-0.6, 0.6), 34, 60);
        g.power_w = clamp(g.power_w + (50 - g.power_w) * 0.2 + rand(-6, 6), 25, 90);
        g.sm_clock = Math.round(210 + rand(0, 150));
      }
      g.mem_util = (g.mem_used / g.mem_total) * 100;
      g.free_mb = g.mem_total - g.mem_used;
      g.uuid = g.uuid || "GPU-" + hex(8).toUpperCase();

      // append a fine-grained metric point for the charts
      S.history[i].push(mkPoint(i, t, g.gpu_util, g.mem_used, g.temp, g.power_w, g.sm_clock));

      // per-task in-window series (30s cadence)
      if (task && task._series && t - (task._series[task._series.length - 1]?.ts || task.started_at) >= 30) {
        task._series.push(mkPoint(i, t, g.gpu_util, g.mem_used, g.temp, g.power_w, g.sm_clock));
      }
    });

    // host metrics
    S.history.host.push({
      ts: t, net_rx: rand(8, 70) * 1024 * 1024, net_tx: rand(4, 45) * 1024 * 1024,
      disk_io: rand(3, 35) * 1024 * 1024, cpu: clamp(12 + S.tickNo % 7 * 3 + rand(0, 8), 5, 80),
    });

    // prune so a long-lived tab doesn't grow forever (keep ~1 day)
    const cut = t - 86400;
    Object.keys(S.history).forEach((k) => { S.history[k] = S.history[k].filter((p) => p.ts > cut); });
  }

  function nextLogLine(task, runSecs) {
    const cmd = task.command[1] || "";
    if (/eval|bench/.test(cmd)) {
      return genEvalLog(runSecs + 1, { start: task.started_at, seed: task.id.charCodeAt(0) }).slice(-1)[0] || null;
    }
    if (/train/.test(cmd)) {
      return genTrainLog(runSecs + 1, { epochs: 3, total_steps: 2341, it_s: 17.4, start: task.started_at, seed: task.id.charCodeAt(1) }).slice(-1)[0] || null;
    }
    return `[${fmtTs(now())}] ${cmd}: working... (${runSecs}s)`;
  }

  /* ------------------------- aggregation ------------------------------------ */

  function taskAgg(task) {
    const s = task._series || [];
    if (!s.length) return null;
    const avg = (f) => s.reduce((acc, r) => acc + (r[f] ?? 0), 0) / s.length;
    const max = (f) => s.reduce((acc, r) => Math.max(acc, r[f] ?? 0), 0);
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

  /* Downsample a sorted point list to `step` buckets between from..to. */
  function downsample(points, from, to, step) {
    if (!points.length || !step) return points.filter((p) => p.ts >= from);
    const out = [];
    let i = 0, prevI = 0;
    for (let b = from; b <= to + step; b += step) {
      while (i < points.length && points[i].ts <= b) i++;
      if (i > prevI && i > 0 && points[i - 1].ts >= from) out.push(points[i - 1]);
      prevI = i;
    }
    return out;
  }

  /* ------------------------- API routes ------------------------------------- */

  function systemPayload() {
    const running = runningTasks();
    return {
      gpus: Object.keys(GPU_SPECS).map((i) => {
        const g = S.gpus[i];
        return {
          index: g.index, name: g.name, uuid: g.uuid,
          gpu_util: +g.gpu_util.toFixed(1), mem_util: +g.mem_util.toFixed(1),
          mem_used: Math.round(g.mem_used), mem_total: g.mem_total,
          temp: Math.round(g.temp), power_w: Math.round(g.power_w), power_limit: g.power_limit,
          power_max: g.power_max, power_min: g.power_min,
          sm_clock: g.sm_clock, mem_clock: g.mem_clock, pcie_gen: g.pcie_gen,
          free_mb: Math.round(g.free_mb),
        };
      }),
      queue: {
        paused: S.paused, pause_reason: S.pause_reason,
        running_task_id: running[0]?.id ?? null,
        running_gpu: running[0]?.gpu_id ?? null,
      },
      counts: { queued: queuedTasks().length, running: running.length, total: S.tasks.length },
      host_available: true,
      server: { version: "0.1.3", host: "demo (simulated)", port: 8765, uptime: now() - S.boot },
    };
  }

  function publicTask(t) {
    const { log, _series, _lastLogSecs, ...pub } = t;
    // the real server stores timestamps as ISO-8601 strings (app.js does new Date(...))
    for (const k of ["created_at", "started_at", "finished_at"]) {
      if (pub[k]) pub[k] = new Date(pub[k] * 1000).toISOString();
    }
    return pub;
  }

  function route(method, path, q, rawBody) {
    tick();
    const b = now();

    // ---- tasks collection
    if (method === "GET" && path === "/api/tasks") {
      let list = S.tasks.slice();
      const status = q.get("status");
      if (status) list = list.filter((t) => t.status === status);
      if (q.get("project")) list = list.filter((t) => t.project === q.get("project"));
      if (q.get("user")) list = list.filter((t) => t.username === q.get("user"));
      const limit = Math.min(parseInt(q.get("limit") || "100", 10) || 100, 1000);
      return list.slice(-limit).map(publicTask);
    }

    if (method === "POST" && path === "/api/tasks") {
      const body = JSON.parse(rawBody || "{}");
      if (!body.command) throw new Error("'command' is required (list of program + args, or a string)");
      const cmd = Array.isArray(body.command) ? body.command : String(body.command).split(" ");
      if (!cmd.length || !cmd.every((c) => typeof c === "string")) throw new Error("'command' must be a non-empty list of strings");
      const task = mkTask({
        id: hex(12),
        project: String(body.project ?? ""),
        username: String(body.username ?? ""),
        gpu_id: body.gpu_id ?? null,
        vram_mb: parseInt(body.vram_mb ?? "0", 10) || 0,
        est_seconds: parseInt(body.est_seconds ?? "0", 10) || 0,
        priority: parseInt(body.priority ?? "5", 10) || 5,
        command: cmd,
        cwd: body.cwd || null,
        env: body.env && typeof body.env === "object" ? body.env : {},
        fallback_wait_seconds: parseInt(body.fallback_wait_seconds ?? "0", 10) || 0,
        api_key: String(body.api_key ?? ""),
        version: String(body.version ?? ""),
        power_limit_w: body.power_limit_w != null ? parseInt(body.power_limit_w, 10) : null,
        status: "queued", created_at: b,
      });
      S.tasks.push(task);
      return publicTask(task);
    }

    // ---- single task
    const mTask = path.match(/^\/api\/tasks\/([^/]+)$/);
    const mLogs = path.match(/^\/api\/tasks\/([^/]+)\/logs$/);
    const mMetrics = path.match(/^\/api\/tasks\/([^/]+)\/metrics$/);
    const mRerun = path.match(/^\/api\/tasks\/([^/]+)\/rerun$/);

    if (mTask) {
      const task = taskById(mTask[1]);
      if (!task) throw new Error(`task '${mTask[1]}' not found`);
      if (method === "GET") {
        const out = publicTask(task);
        out.agg = taskAgg(task);
        return out;
      }
      if (method === "PATCH") {
        if (task.status !== "queued") throw new Error("only queued tasks can be edited");
        const body = JSON.parse(rawBody || "{}");
        ["project", "username", "gpu_id", "vram_mb", "est_seconds", "priority", "version"].forEach((k) => {
          if (body[k] !== undefined) task[k] = body[k];
        });
        return publicTask(task);
      }
      if (method === "DELETE") {
        if (task.status === "running") {
          task.status = "cancelled";
          task.finished_at = b;
          task.exit_code = -15;
          task.log.push(`[${fmtTs(b)}] cancelled (SIGTERM from API)`);
        } else if (task.status === "queued") {
          task.status = "cancelled";
          task.finished_at = b;
        } else {
          S.tasks = S.tasks.filter((t) => t.id !== task.id);
        }
        return { deleted: task.id };
      }
    }

    if (mLogs && method === "GET") {
      const task = taskById(mLogs[1]);
      if (!task) throw new Error("task not found");
      const limit = Math.min(parseInt(q.get("limit") || "500", 10) || 500, 5000);
      const wantQ = q.get("q") || "";
      let lines = task.log.slice(-limit);
      if (wantQ) lines = lines.filter((l) => l.includes(wantQ));
      return { offset: 0, next_offset: 0, total: task.log.length, lines, task_id: task.id, status: task.status };
    }

    if (mMetrics && method === "GET") {
      const task = taskById(mMetrics[1]);
      if (!task) throw new Error("task not found");
      return task._series || [];
    }

    if (mRerun && method === "POST") {
      const src = taskById(mRerun[1]);
      if (!src) throw new Error("task not found");
      const clone = mkTask({
        id: hex(12),
        project: src.project, username: src.username, gpu_id: null,
        vram_mb: src.vram_mb, est_seconds: src.est_seconds, priority: src.priority,
        command: src.command, cwd: src.cwd, env: src.env,
        fallback_wait_seconds: src.fallback_wait_seconds, api_key: src.api_key,
        version: src.version, power_limit_w: src.power_limit_w,
        status: "queued", created_at: b,
      });
      S.tasks.push(clone);
      return publicTask(clone);
    }

    // ---- metrics / queue / system
    if (method === "GET" && path === "/api/metrics") {
      const from = parseFloat(q.get("from") || "0") || 0;
      const to = parseFloat(q.get("to") || "0") || b;
      const step = parseInt(q.get("step") || "0", 10) || 0;
      const gpus = {};
      Object.keys(GPU_SPECS).forEach((i) => { gpus[i] = downsample(S.history[i], from, to, step); });
      return { gpus, host: downsample(S.history.host, from, to, step), step, host_available: true };
    }

    if (method === "POST" && path === "/api/queue/pause") {
      const body = JSON.parse(rawBody || "{}");
      S.paused = true;
      S.pause_reason = body.reason || "paused by API";
      return { paused: true, reason: S.pause_reason };
    }
    if (method === "POST" && path === "/api/queue/resume") {
      S.paused = false;
      S.pause_reason = null;
      return { paused: false };
    }
    if (method === "GET" && path === "/api/system") return systemPayload();
    if (method === "GET" && path === "/api/openapi.json") {
      return { openapi: "3.0.0", info: { title: "gpuq", version: "0.1.3" }, paths: {} };
    }

    throw new Error(`no such endpoint: ${method} ${path}`);
  }

  /* ------------------------- fetch shim -------------------------------------- */

  async function mockFetch(input, init) {
    const url = new URL(input, "http://demo.local");
    const method = (init && init.method ? init.method : "GET").toUpperCase();
    let status = 200;
    let payload;
    try {
      if (url.pathname.startsWith("/api")) {
        payload = { ok: true, data: route(method, url.pathname, url.searchParams, init && init.body) };
        if (method === "POST" && url.pathname === "/api/tasks") status = 201;
      } else {
        status = 404;
        payload = { ok: false, error: `not found: ${method} ${url.pathname}` };
      }
    } catch (e) {
      status = 400;
      payload = { ok: false, error: e.message };
    }
    const R = typeof Response !== "undefined" ? Response
      : class { constructor(body, o) { this._b = body; this.status = o.status; this.ok = o.status >= 200 && o.status < 300; } async json() { return JSON.parse(this._b); } };
    return new R(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  /* ------------------------- wiring ------------------------------------------- */

  if (IS_BROWSER) {
    root.fetch = mockFetch;
    // simulation clock: keep the demo alive even when the tab is idle
    root.setInterval(() => { try { tick(); } catch (e) { /* noop */ } }, 2500);
    // expose a global so the demo page can show what's happening under the hood
    root.__gpuqDemo = { get state() { return S; }, now, systemPayload };
  }

  root.__gpuqMock = { fetch: mockFetch, tick, state: S };
})();
