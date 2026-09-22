// @ts-check
/** 翼形共识室前端：Canvas 叠加 + 运行控制 + 对应/缺失确认 + 导入导出。 */

const state = {
  landmarks: [],
  configurations: [],
  runs: [],
  current: null,
  overrides: new Map(),
  view: "aligned"
};

const PALETTE = [
  "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c",
  "#0891b2", "#ca8a04", "#be185d", "#4d7c0f", "#7c2d12"
];
const CONSENSUS_COLOR = "#111827";

const $ = (id) => document.getElementById(id);
const canvas = $("board");
const ctx = canvas.getContext("2d");

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function colorOf(sampleId, operator) {
  const key = `${sampleId}/${operator}`;
  const index = state.configurations.findIndex(
    (c) => c.sampleId === sampleId && c.operator === operator
  );
  return PALETTE[(index >= 0 ? index : hash(key)) % PALETTE.length];
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

async function loadState() {
  const data = await api("/api/state");
  state.landmarks = data.landmarks;
  state.configurations = data.configurations;
  state.runs = data.runs;
  renderRunSelect();
  renderConfigTable();
  draw();
  if (state.runs.length > 0) {
    $("runSelect").selectedIndex = 0;
    await loadRun(state.runs[0].runId);
  }
}

function overrideKey(sampleId, operator) {
  return `${sampleId}|${operator}`;
}

function ensureOverride(sampleId, operator, n) {
  const key = overrideKey(sampleId, operator);
  if (!state.overrides.has(key)) {
    state.overrides.set(key, {
      sampleId,
      operator,
      permutation: Array.from({ length: n }, (_, i) => i),
      forceMissing: []
    });
  }
  return state.overrides.get(key);
}

function renderRunSelect() {
  const sel = $("runSelect");
  sel.innerHTML = "";
  for (const run of state.runs) {
    const opt = document.createElement("option");
    opt.value = run.runId;
    opt.textContent = `${run.runId}  ${run.mirrorEnabled ? "含镜像" : "不镜像"}  rss=${run.totalRss.toExponential(2)}`;
    sel.appendChild(opt);
  }
}

function renderConfigTable() {
  const root = $("configTable");
  root.innerHTML = "";
  const bySample = new Map();
  for (const c of state.configurations) {
    if (!bySample.has(c.sampleId)) bySample.set(c.sampleId, []);
    bySample.get(c.sampleId).push(c);
  }

  for (const [sampleId, configs] of bySample) {
    const wrap = document.createElement("div");
    wrap.className = "sample-block";
    const h = document.createElement("h3");
    h.textContent = `${sampleId} · ${configs[0].side === "R" ? "右翅" : "左翅"} · ${configs.length} 个操作者版本`;
    wrap.appendChild(h);

    for (const config of configs) {
      const row = document.createElement("div");
      row.className = "config-row";
      const title = document.createElement("div");
      title.className = "config-title";
      title.innerHTML = `<span class="dot" style="background:${colorOf(sampleId, config.operator)}"></span>${config.operator}`;
      row.appendChild(title);

      const cells = document.createElement("div");
      cells.className = "landmark-cells";
      config.points.forEach((p, i) => {
        const cell = document.createElement("div");
        cell.className = "lm-cell" + (p == null ? " missing" : "");
        const label = state.landmarks[i] ? state.landmarks[i].id : `LM${i}`;
        const ov = state.current
          ? state.overrides.get(overrideKey(sampleId, config.operator))
          : null;
        const forcedMissing = ov ? ov.forceMissing.includes(i) : false;
        const target = ov ? ov.permutation[i] : i;
        cell.innerHTML = `
          <div class="lm-name">${label}</div>
          <div class="lm-coord">${p == null ? "缺失" : `${p.x.toFixed(2)}, ${p.y.toFixed(2)}`}</div>
          <label class="lm-miss">
            <input type="checkbox" data-action="missing" data-sample="${sampleId}"
              data-op="${config.operator}" data-idx="${i}" ${p == null || forcedMissing ? "checked" : ""} />
            保留缺失
          </label>
          <label class="lm-map">
            →
            <select data-action="map" data-sample="${sampleId}" data-op="${config.operator}" data-idx="${i}">
              ${state.landmarks
                .map(
                  (lm, j) =>
                    `<option value="${j}" ${j === target ? "selected" : ""}>${lm.id}</option>`
                )
                .join("")}
            </select>
          </label>`;
        cells.appendChild(cell);
      });
      row.appendChild(cells);

      const status = document.createElement("div");
      status.className = "config-status";
      status.dataset.sample = sampleId;
      status.dataset.op = config.operator;
      row.appendChild(status);
      wrap.appendChild(row);
    }
    root.appendChild(wrap);
  }
  bindTableControls();
  renderAlignmentStatus();
}

function bindTableControls() {
  document.querySelectorAll('[data-action="missing"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const t = e.target;
      const config = state.configurations.find(
        (c) => c.sampleId === t.dataset.sample && c.operator === t.dataset.op
      );
      const ov = ensureOverride(t.dataset.sample, t.dataset.op, config.points.length);
      const idx = Number(t.dataset.idx);
      if (t.checked) {
        if (!ov.forceMissing.includes(idx)) ov.forceMissing.push(idx);
      } else {
        ov.forceMissing = ov.forceMissing.filter((v) => v !== idx);
      }
      draw();
    });
  });
  document.querySelectorAll('[data-action="map"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const t = e.target;
      const config = state.configurations.find(
        (c) => c.sampleId === t.dataset.sample && c.operator === t.dataset.op
      );
      const ov = ensureOverride(t.dataset.sample, t.dataset.op, config.points.length);
      const idx = Number(t.dataset.idx);
      ov.permutation[idx] = Number(t.value);
      draw();
    });
  });
}

function overridesPayload() {
  return [...state.overrides.values()].map((o) => {
    const config = state.configurations.find(
      (c) => c.sampleId === o.sampleId && c.operator === o.operator
    );
    const isIdentity = o.permutation.every((v, i) => v === i);
    const rawMissing = config.points.map((p, i) => (p == null ? i : -1)).filter((i) => i >= 0);
    const extraMissing = o.forceMissing.filter((i) => !rawMissing.includes(i));
    return {
      sampleId: o.sampleId,
      operator: o.operator,
      permutation: isIdentity && extraMissing.length === 0 ? undefined : o.permutation,
      forceMissing: extraMissing.length === 0 ? undefined : o.forceMissing
    };
  });
}

function renderAlignmentStatus() {
  for (const el of document.querySelectorAll(".config-status")) {
    el.innerHTML = "";
    const run = state.current;
    if (!run) continue;
    const a = run.alignments.find(
      (x) => x.sampleId === el.dataset.sample && x.operator === el.dataset.op
    );
    if (!a) continue;
    if (!a.included) {
      el.innerHTML = `<span class="tag excluded">不进入共识：${a.excludeReason}</span><span class="tag">原始版本保留</span>`;
      continue;
    }
    const tags = [];
    if (a.mirrored) tags.push('<span class="tag mirror">已显式镜像</span>');
    tags.push(`<span class="tag">残差/点 ${a.residual.toExponential(2)}</span>`);
    tags.push(`<span class="tag">θ=${((a.transform.rotation / Math.PI) * 180).toFixed(1)}°</span>`);
    tags.push(`<span class="tag">s=${a.transform.scale.toFixed(3)}</span>`);
    if (a.tie && !a.tie.unique) {
      tags.push('<span class="tag warn">并列最优旋转 · 非唯一</span>');
    }
    el.innerHTML = tags.join("");
  }
}

function activeOverrides() {
  const list = [];
  for (const o of state.overrides.values()) {
    const config = state.configurations.find(
      (c) => c.sampleId === o.sampleId && c.operator === o.operator
    );
    if (!config) continue;
    const rawMissing = new Set(config.points.map((p, i) => (p == null ? i : -1)).filter((i) => i >= 0));
    const changed =
      o.forceMissing.some((i) => !rawMissing.has(i)) ||
      o.permutation.some((v, i) => v !== i);
    if (changed) list.push(o);
  }
  return list;
}

function workPointsOf(config) {
  // 前端预览：仅应用“保留缺失”勾选；镜像由当前 radio 决定。
  const ov = state.overrides.get(overrideKey(config.sampleId, config.operator));
  const force = ov ? ov.forceMissing : [];
  const mirror = mirrorChoice() === true && config.side === "R";
  return config.points.map((p, i) => {
    if (p == null || force.includes(i)) return null;
    return mirror ? { x: -p.x, y: p.y } : { x: p.x, y: p.y };
  });
}

function mirrorChoice() {
  const checked = document.querySelector('input[name="mirror"]:checked');
  if (!checked) return null;
  return checked.value === "true";
}

function collectBox() {
  const pts = [];
  for (const c of state.configurations) {
    for (const p of workPointsOf(c)) pts.push(p);
  }
  if (state.current) {
    for (const cp of state.current.consensus) {
      if (!cp.missing) pts.push({ x: cp.x, y: cp.y });
    }
  }
  if (pts.length === 0) return null;
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  return { minX, maxX, minY, maxY };
}

function makeProjection() {
  const box = collectBox();
  const pad = 46;
  const w = canvas.width - pad * 2;
  const h = canvas.height - pad * 2;
  if (!box) return { x: (x) => x, y: (y) => y, k: 1 };
  const spanX = Math.max(box.maxX - box.minX, 1e-6);
  const spanY = Math.max(box.maxY - box.minY, 1e-6);
  const k = Math.min(w / spanX, h / spanY);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return {
    x: (x) => canvas.width / 2 + (x - cx) * k,
    y: (y) => canvas.height / 2 - (y - cy) * k,
    k
  };
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawGrid();

  const proj = makeProjection();
  const run = state.current;

  if ($("layerRaw").checked) {
    for (const config of state.configurations) {
      const alignment = run
        ? run.alignments.find(
            (a) => a.sampleId === config.sampleId && a.operator === config.operator
          )
        : null;
      if (alignment && !alignment.included && !$("layerExcluded").checked) continue;
      drawShape(config.points, proj, {
        color: colorOf(config.sampleId, config.operator),
        dashed: true,
        alpha: 0.28,
        radius: 3,
        width: 1
      });
    }
  }

  if ($("layerAligned").checked && run) {
    for (const a of run.alignments) {
      if (!a.included || !a.aligned) continue;
      drawShape(a.aligned, proj, {
        color: colorOf(a.sampleId, a.operator),
        dashed: false,
        alpha: 0.75,
        radius: 4,
        width: 1.6
      });
    }
  }

  if ($("layerExcluded").checked && run) {
    for (const a of run.alignments) {
      if (a.included) continue;
      const config = state.configurations.find(
        (c) => c.sampleId === a.sampleId && c.operator === a.operator
      );
      if (config) {
        drawShape(workPointsOf(config), proj, {
          color: "#9ca3af",
          dashed: true,
          alpha: 0.55,
          radius: 4,
          width: 1
        });
      }
    }
  }

  if ($("layerConsensus").checked && run) {
    const pts = run.consensus.map((c) => (c.missing ? null : { x: c.x, y: c.y }));
    drawShape(pts, proj, {
      color: CONSENSUS_COLOR,
      dashed: false,
      alpha: 1,
      radius: 6.5,
      width: 2.4,
      labels: run.consensus.map((c) => c.landmarkId)
    });
  }

  if ($("layerVariance").checked && run) drawVariance(run, proj);
  renderLegend(run);
}

function drawGrid() {
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  for (let x = 20; x < canvas.width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 20; y < canvas.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function drawShape(points, proj, style) {
  ctx.save();
  ctx.globalAlpha = style.alpha;
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.lineWidth = style.width;
  if (style.dashed) ctx.setLineDash([5, 5]);

  ctx.beginPath();
  let started = false;
  points.forEach((p) => {
    if (!p) {
      started = false;
      return;
    }
    const x = proj.x(p.x);
    const y = proj.y(p.y);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.setLineDash([]);

  points.forEach((p, i) => {
    if (!p) return;
    const x = proj.x(p.x);
    const y = proj.y(p.y);
    ctx.beginPath();
    ctx.arc(x, y, style.radius, 0, Math.PI * 2);
    ctx.fill();
    if (style.labels) {
      ctx.font = "11px ui-sans-serif, system-ui";
      ctx.fillText(style.labels[i], x + 8, y - 8);
    }
  });
  ctx.restore();
}

function drawVariance(run, proj) {
  const maxVar = Math.max(...run.consensus.map((c) => c.variance), 1e-12);
  for (const cp of run.consensus) {
    if (cp.missing) continue;
    const x = proj.x(cp.x);
    const y = proj.y(cp.y);
    const r = 6 + 16 * Math.sqrt(cp.variance / maxVar);
    ctx.save();
    ctx.strokeStyle = "rgba(220, 38, 38, 0.55)";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function renderLegend(run) {
  const items = [
    '<span><i style="background:#111827"></i>共识形状</span>',
    '<span><i style="border-color:#dc2626"></i>点级方差</span>',
    '<span><i style="background:repeating-linear-gradient(90deg,#94a3b8 0 4px,transparent 4px 8px)"></i>原始版本（未对齐）</span>'
  ];
  for (const c of state.configurations) {
    items.push(
      `<span><i style="background:${colorOf(c.sampleId, c.operator)}"></i>${c.sampleId}/${c.operator}${c.side === "R" ? "(R)" : ""}</span>`
    );
  }
  if (run) {
    items.push(`<span>固定样本集：${run.fixedSampleIds.join(", ") || "—"}</span>`);
    items.push(
      `<span>${run.mirrorEnabled ? "含对称分支（右翅显式镜像）" : "不含对称分支（未镜像）"}</span>`
    );
  }
  $("legend").innerHTML = items.join("");
}

async function loadRun(runId) {
  const data = await api(`/api/runs/${runId}`);
  state.current = data.run;
  state.overrides = new Map();
  for (const o of data.overrides) {
    state.overrides.set(overrideKey(o.sampleId, o.operator), {
      sampleId: o.sampleId,
      operator: o.operator,
      permutation: o.permutation,
      forceMissing: o.forceMissing
    });
  }
  const mirrorVal = data.run.mirrorEnabled ? "true" : "false";
  const radio = document.querySelector(`input[name="mirror"][value="${mirrorVal}"]`);
  if (radio) radio.checked = true;
  renderRunMeta(data.run);
  renderConfigTable();
  draw();
}

function renderRunMeta(run) {
  const nonUnique = run.alignments.filter((a) => a.tie && !a.tie.unique);
  const excluded = run.alignments.filter((a) => !a.included);
  $("runMeta").innerHTML = `
    <dl class="meta-grid">
      <dt>运行 ID</dt><dd>${run.runId}</dd>
      <dt>创建时间</dt><dd>${run.createdAt}</dd>
      <dt>镜像</dt><dd>${run.mirrorEnabled ? "显式启用" : "未启用"}</dd>
      <dt>点谱系指纹</dt><dd><code>${run.lineageHash}</code></dd>
      <dt>GPA 迭代</dt><dd>${run.iterations}</dd>
      <dt>总残差 RSS</dt><dd>${run.totalRss.toExponential(4)}</dd>
      <dt>非唯一旋转</dt><dd>${nonUnique.length} 个配置</dd>
      <dt>排除配置</dt><dd>${excluded.length} 个（原始版本保留）</dd>
    </dl>`;
  const notes = $("notesList");
  notes.innerHTML = "";
  for (const note of run.notes) {
    const li = document.createElement("li");
    li.textContent = note;
    notes.appendChild(li);
  }
  if (nonUnique.length > 0) {
    for (const a of nonUnique) {
      const li = document.createElement("li");
      li.className = "strong-warn";
      const cands = a.tie.candidates
        .map(
          (c) =>
            `θ=${((c.rotation / Math.PI) * 180).toFixed(2)}° ` +
            `置换[${c.permutation.join(",")}] rss=${c.rss.toExponential(3)}`
        )
        .join("；");
      li.textContent =
        `${a.sampleId}/${a.operator}：检测到对称造成的并列最优旋转（非唯一）。` +
        `候选：${cands}。稳定规则：${a.tie.stableRule}，已显示 θ=${(
          (a.tie.chosen.rotation / Math.PI) *
          180
        ).toFixed(2)}°。`;
      notes.appendChild(li);
    }
  }
  if (run.notes.length === 0 && nonUnique.length === 0) {
    notes.innerHTML = "<li>本次运行未检测到并列最优旋转。</li>";
  }
}

async function createRun() {
  const mirror = mirrorChoice();
  if (mirror === null) {
    setStatus("请先显式选择是否镜像右翅", true);
    return;
  }
  setStatus("运行中…");
  try {
    const overrides = overridesPayload();
    const run = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ mirrorEnabled: mirror, overrides })
    });
    state.runs = (await api("/api/state")).runs;
    renderRunSelect();
    $("runSelect").value = run.runId;
    await loadRun(run.runId);
    setStatus(`完成：${run.runId}`);
  } catch (err) {
    setStatus(err.message, true);
  }
}

function setStatus(text, isError = false) {
  const el = $("runStatus");
  el.textContent = text;
  el.className = "status" + (isError ? " error" : " ok");
}

function wireControls() {
  $("runBtn").addEventListener("click", createRun);
  $("runSelect").addEventListener("change", (e) => loadRun(e.target.value));
  for (const id of ["layerRaw", "layerAligned", "layerConsensus", "layerVariance", "layerExcluded"]) {
    $(id).addEventListener("change", draw);
  }
  document.querySelectorAll('input[name="mirror"]').forEach((el) =>
    el.addEventListener("change", draw)
  );

  $("exportBtn").addEventListener("click", async () => {
    const res = await fetch("/api/export");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wing-consensus-export.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      await api("/api/import", { method: "POST", body: JSON.stringify(bundle) });
      state.current = null;
      state.overrides = new Map();
      await loadState();
      setStatus("已清空并重新导入，可在历史运行中打开复核");
    } catch (err) {
      setStatus(`导入失败：${err.message}`, true);
    }
  });

  $("reseedBtn").addEventListener("click", async () => {
    await api("/api/admin/reseed", { method: "POST" });
    state.current = null;
    state.overrides = new Map();
    await loadState();
    setStatus("已重置为固定 fixture");
  });
}

wireControls();
loadState().catch((err) => setStatus(err.message, true));
