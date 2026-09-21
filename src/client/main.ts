import type { Point, RunResult } from '../shared/types.js';

interface StateResponse {
  landmarks: Array<{ id: number; name: string; note: string }>;
  samples: Array<{ id: string; name: string; side: 'L' | 'R'; active_version: number }>;
  localizations: Array<{
    id: number;
    sampleId: string;
    operator: string;
    version: number;
    side: 'L' | 'R';
    pointIndex: number;
    x: number | null;
    y: number | null;
    confirmed: 0 | 1;
  }>;
  activeInputs: Array<{
    sampleId: string;
    side: 'L' | 'R';
    operator: string;
    version: number;
    shape: Point[];
  }>;
  minPoints: number;
}

interface RunListResponse {
  runs: Array<{
    id: number;
    created_at: string;
    mirror_right: number;
    input_signature: string;
    result_json: string;
  }>;
}

const VERSION_COLORS = ['#e06f6f', '#6fd0e0', '#8de08d', '#d98de0', '#e0c06f', '#9fa8b5'];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function isPresent(p: Point | undefined): p is { x: number; y: number } {
  return p !== null && p !== undefined;
}

interface Bounds { minX: number; maxX: number; minY: number; maxY: number; }

function boundsOf(shapes: Point[][]): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    for (const p of shape) {
      if (!isPresent(p)) continue;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  return { minX, maxX, minY, maxY };
}

function makeTransform(b: Bounds, w: number, h: number, pad = 36) {
  const sx = (w - 2 * pad) / Math.max(1e-9, b.maxX - b.minX);
  const sy = (h - 2 * pad) / Math.max(1e-9, b.maxY - b.minY);
  const k = Math.min(sx, sy);
  const ox = (w - k * (b.maxX + b.minX)) / 2;
  const oy = (h + k * (b.maxY + b.minY)) / 2; // y 轴翻转
  return {
    k,
    to: (p: { x: number; y: number }) => ({ x: ox + k * p.x, y: oy - k * p.y })
  };
}

function drawAxes(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.strokeStyle = '#23303f';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 24);
  ctx.lineTo(w, h - 24);
  ctx.moveTo(24, 0);
  ctx.lineTo(24, h);
  ctx.stroke();
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Point[],
  color: string,
  tf: ReturnType<typeof makeTransform>,
  opts: { radius?: number; labels?: boolean; labelColor?: string } = {}
): void {
  const radius = opts.radius ?? 4;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  for (let i = 0; i < shape.length; i++) {
    const p = shape[i];
    if (!isPresent(p)) continue;
    const s = tf.to(p);
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (opts.labels) {
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = opts.labelColor ?? '#93a3b5';
      ctx.fillText(String(i), s.x + 6, s.y - 6);
      ctx.fillStyle = color;
    }
  }
}

function drawVarianceBubbles(
  ctx: CanvasRenderingContext2D,
  consensus: Point[],
  variance: (number | null)[],
  tf: ReturnType<typeof makeTransform>,
  maxVar: number
): void {
  for (let i = 0; i < consensus.length; i++) {
    const c = consensus[i];
    const v = variance[i];
    if (!isPresent(c) || v === null || v === undefined) continue;
    const s = tf.to(c);
    const r = 4 + 16 * Math.sqrt(v / Math.max(1e-12, maxVar));
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(240,179,78,0.85)';
    ctx.lineWidth = 1.5;
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawMissingMarks(
  ctx: CanvasRenderingContext2D,
  shape: Point[],
  tf: ReturnType<typeof makeTransform>
): void {
  const present = shape.filter(isPresent);
  if (present.length === 0) return;
  const cx = present.reduce((s, p) => s + p.x, 0) / present.length;
  const cy = present.reduce((s, p) => s + p.y, 0) / present.length;
  const ghost = tf.to({ x: cx, y: cy });
  for (let i = 0; i < shape.length; i++) {
    if (shape[i] !== null) continue;
    ctx.strokeStyle = '#ef6f6f';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(ghost.x, ghost.y, 7, 0, Math.PI * 2);
    ctx.moveTo(ghost.x - 5, ghost.y - 5);
    ctx.lineTo(ghost.x + 5, ghost.y + 5);
    ctx.stroke();
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#ef6f6f';
    ctx.fillText(`缺${i}`, ghost.x + 9, ghost.y - 8);
  }
}

let state: StateResponse | null = null;
let selectedRunId: number | null = null;
let currentRun: RunResult | null = null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function versionsOf(sampleId: string): number[] {
  const vs = new Set<number>();
  for (const loc of state?.localizations ?? []) {
    if (loc.sampleId === sampleId) vs.add(loc.version);
  }
  return [...vs].sort((a, b) => a - b);
}

function activeShape(sampleId: string): Point[] {
  return state?.activeInputs.find((a) => a.sampleId === sampleId)?.shape ?? [];
}

function renderSamples(): void {
  const root = $('#sample-list');
  root.innerHTML = '';
  if (!state) return;
  for (const sample of state.samples) {
    const versions = versionsOf(sample.id);
    const card = document.createElement('div');
    card.className = 'sample-card';
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div>${sample.name}<br><span class="mono" style="color:var(--muted)">${sample.id}</span></div>
      <span class="side-tag ${sample.side}">${sample.side === 'L' ? '左翅' : '右翅'}</span>`;
    card.appendChild(row);

    const tabs = document.createElement('div');
    tabs.className = 'version-tabs';
    for (const v of versions) {
      const btn = document.createElement('button');
      btn.textContent = `v${v}`;
      if (v === sample.active_version) btn.classList.add('active');
      btn.title = state.localizations
        .filter((l) => l.sampleId === sample.id && l.version === v)
        .map((l) => l.operator)
        .join(', ');
      btn.addEventListener('click', () =>
        api<StateResponse>('/api/version', {
          method: 'POST',
          body: JSON.stringify({ sampleId: sample.id, version: v })
        }).then((next) => {
          state = next;
          renderAll();
        })
      );
      tabs.appendChild(btn);
    }
    card.appendChild(tabs);

    const grid = document.createElement('div');
    grid.className = 'point-grid';
    const locs = state.localizations.filter(
      (l) => l.sampleId === sample.id && l.version === sample.active_version
    );
    for (let i = 0; i < state.landmarks.length; i++) {
      const lm = state.landmarks[i];
      const loc = locs.find((l) => l.pointIndex === i);
      const missing = !loc || loc.x === null || loc.y === null;
      const confirmed = loc?.confirmed === 1;
      const chip = document.createElement('div');
      chip.className = `point-chip ${missing ? 'missing' : confirmed ? 'confirmed' : 'unconfirmed'}`;
      chip.textContent = missing ? `${i} 缺失` : confirmed ? `${i} 已对应` : `${i} 待确认`;
      chip.title = lm ? `${lm.name} · ${lm.note}` : '';
      if (!missing) {
        chip.addEventListener('click', () =>
          api<StateResponse>('/api/confirm', {
            method: 'POST',
            body: JSON.stringify({
              sampleId: sample.id,
              pointIndex: i,
              confirmed: !confirmed
            })
          }).then((next) => {
            state = next;
            renderAll();
          })
        );
      }
      grid.appendChild(chip);
    }
    card.appendChild(grid);
    root.appendChild(card);
  }
}

function renderRuns(): void {
  void api<RunListResponse>('/api/runs').then((data) => {
    const root = $('#run-list');
    root.innerHTML = '';
    for (const run of [...data.runs].reverse()) {
      const result = JSON.parse(run.result_json) as RunResult;
      const item = document.createElement('div');
      item.className = 'run-item';
      if (result.ambiguousSampleIds.length > 0) item.classList.add('warn');
      if (run.id === selectedRunId) item.classList.add('active');
      const branch = run.mirror_right ? '含对称（镜像开）' : '不含对称（镜像关）';
      item.innerHTML = `<div>#${run.id} · ${branch}</div>
        <div class="meta">${run.created_at.replace('T', ' ').slice(0, 19)} ·
          入组 ${result.includedSampleIds.length}/${result.samples.length} ·
          签名 <span class="mono">${run.input_signature.slice(4, 12)}</span></div>`;
      item.title = `固定样本集签名: ${run.input_signature}`;
      item.addEventListener('click', () => {
        selectedRunId = run.id;
        currentRun = result;
        renderAll();
      });
      root.appendChild(item);
    }
  });
}

function renderRawCanvas(): void {
  const canvas = $<HTMLCanvasElement>('raw-canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx || !state) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawAxes(ctx, canvas.width, canvas.height);

  const allShapes: Point[][] = [];
  for (const sample of state.samples) {
    for (const v of versionsOf(sample.id)) {
      const shape: Point[] = state.localizations
        .filter((l) => l.sampleId === sample.id && l.version === v)
        .map(() => null);
      const rows = state.localizations.filter(
        (l) => l.sampleId === sample.id && l.version === v
      );
      for (const r of rows) shape[r.pointIndex] = r.x === null ? null : { x: r.x, y: r.y ?? 0 };
      allShapes.push(shape);
    }
  }
  const tf = makeTransform(boundsOf(allShapes), canvas.width, canvas.height);
  let colorIdx = 0;
  const legend = $('#raw-legend');
  legend.innerHTML = '';
  for (const sample of state.samples) {
    for (const v of versionsOf(sample.id)) {
      const rows = state.localizations.filter(
        (l) => l.sampleId === sample.id && l.version === v
      );
      const shape: Point[] = Array.from({ length: state.landmarks.length }, () => null);
      for (const r of rows) shape[r.pointIndex] = r.x === null ? null : { x: r.x, y: r.y ?? 0 };
      const color = VERSION_COLORS[colorIdx++ % VERSION_COLORS.length] ?? '#999999';
      drawShape(ctx, shape, color, tf, { radius: 3.5 });
      drawMissingMarks(ctx, shape, tf);
      const item = document.createElement('span');
      const ops = [...new Set(rows.map((r) => r.operator))].join('/');
      item.innerHTML = `<span class="swatch" style="background:${color}"></span>${sample.id.slice(0, 6)} v${v}（${ops}）`;
      legend.appendChild(item);
    }
  }
}

function renderGpaCanvas(): void {
  const canvas = $<HTMLCanvasElement>('gpa-canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawAxes(ctx, canvas.width, canvas.height);
  const legend = $('#gpa-legend');
  legend.innerHTML = '';
  if (!currentRun) {
    ctx.fillStyle = '#93a3b5';
    ctx.font = '13px sans-serif';
    ctx.fillText('尚未选择共识运行。', 120, canvas.height / 2);
    return;
  }
  const run = currentRun;
  const shapes = run.samples.filter((s) => s.included).map((s) => s.aligned);
  shapes.push(run.consensus);
  const tf = makeTransform(boundsOf(shapes), canvas.width, canvas.height);
  const maxVar = Math.max(...run.pointVariance.map((v) => v ?? 0));
  run.samples.forEach((s, idx) => {
    if (!s.included) return;
    const color = VERSION_COLORS[idx % VERSION_COLORS.length] ?? '#999999';
    drawShape(ctx, s.aligned, color, tf, { radius: 3 });
    const item = document.createElement('span');
    item.innerHTML = `<span class="swatch" style="background:${color}"></span>${s.sampleId.slice(0, 8)}${s.mirrored ? '（镜像）' : ''}`;
    legend.appendChild(item);
  });
  drawVarianceBubbles(ctx, run.consensus, run.pointVariance, tf, maxVar);
  drawShape(ctx, run.consensus, '#ffffff', tf, { radius: 6, labels: true, labelColor: '#cfd8e3' });
  const ci = document.createElement('span');
  ci.innerHTML = '<span class="swatch" style="background:#ffffff"></span>共识形状';
  legend.appendChild(ci);
  const cv = document.createElement('span');
  cv.innerHTML = '<span class="swatch" style="background:transparent;border:1.5px solid #f0b34e;border-radius:2px"></span>点级方差';
  legend.appendChild(cv);
}

function renderBannerAndTable(): void {
  const banner = $('#ambiguity-banner');
  const tableWrap = $('#residual-table');
  if (!currentRun) {
    banner.classList.add('hidden');
    tableWrap.innerHTML = '';
    return;
  }
  const run = currentRun;
  const messages = run.samples
    .filter((s) => s.included && s.ambiguity.kind !== 'none')
    .map((s) => `· ${s.sampleId}：${s.ambiguity.message}`);
  if (messages.length > 0) {
    banner.classList.remove('hidden');
    banner.textContent =
      `报告：${messages.length} 个样本最优旋转非唯一（稳定规则已用于显示，实际变换 det 恒为 +1）。\n` +
      messages.join('\n');
  } else {
    banner.classList.add('hidden');
  }

  const rows = run.samples
    .map((s) => {
      const amb = s.ambiguity.kind !== 'none';
      const res = s.rmsResidual === null ? '—' : s.rmsResidual.toFixed(4);
      const det = s.included ? (Math.cos(s.rotation) * Math.cos(s.rotation) + Math.sin(s.rotation) * Math.sin(s.rotation)).toFixed(6) : '—';
      return `<tr class="${s.included ? amb ? 'amb' : '' : 'excluded'}">
        <td class="name">${s.sampleId}${s.mirrored ? ' 🔁' : ''}</td>
        <td>v${s.version}</td>
        <td>${s.side}</td>
        <td>${s.presentCount}</td>
        <td>${s.included ? '入组' : `排除(${s.excludeReason})`}</td>
        <td class="mono">${res}</td>
        <td class="mono">${s.included ? ((s.rotation * 180) / Math.PI).toFixed(2) + '°' : '—'}</td>
        <td class="mono">${det}</td>
        <td>${s.included ? s.ambiguity.kind : '—'}</td>
      </tr>`;
    })
    .join('');
  tableWrap.innerHTML = `<table>
    <thead><tr>
      <th class="name">样本</th><th>版本</th><th>侧别</th><th>点数</th><th>共识状态</th>
      <th>RMS 残差</th><th>旋转角</th><th>det 校验</th><th>不唯一性</th>
    </tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderAll(): void {
  renderSamples();
  renderRuns();
  renderRawCanvas();
  renderGpaCanvas();
  renderBannerAndTable();
}

function bindControls(): void {
  $('#btn-refresh').addEventListener('click', () =>
    api<StateResponse>('/api/state').then((next) => {
      state = next;
      renderAll();
    })
  );
  const run = async (mirrorRight: boolean) => {
    const note = mirrorRight ? '含对称分支（显式镜像右翅）' : '不含对称分支';
    const result = await api<RunResult>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ mirrorRight, note })
    });
    selectedRunId = result.runId;
    currentRun = result;
    renderAll();
  };
  $('#btn-run-mirror-off').addEventListener('click', () => void run(false));
  $('#btn-run-mirror-on').addEventListener('click', () => void run(true));

  $('#btn-export').addEventListener('click', async () => {
    const res = await fetch('/api/export');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wing-consensus-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('#file-import').addEventListener('change', async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const bundle = JSON.parse(text) as unknown;
    const result = await api<{ state: StateResponse }>('/api/import', {
      method: 'POST',
      body: JSON.stringify(bundle)
    });
    state = result.state;
    selectedRunId = null;
    currentRun = null;
    input.value = '';
    renderAll();
  });

  $('#btn-reset').addEventListener('click', async () => {
    const result = await api<{ state: StateResponse }>('/api/reset', { method: 'POST' });
    state = result.state;
    selectedRunId = null;
    currentRun = null;
    renderAll();
  });
}

void api<StateResponse>('/api/state').then((next) => {
  state = next;
  bindControls();
  renderAll();
});
