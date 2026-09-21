import type {
  AmbiguityReport,
  ConsensusSample,
  Point,
  RunResult,
  Side
} from './types.js';
import {
  isPresent,
  mirrorShapeExplicit,
  procrustesAlign,
  rot,
  sub,
  type Vec2
} from './geometry.js';

export const DEFAULT_MIN_POINTS = 3;
const MAX_ITER = 500;
const CONV_TOL = 1e-14;

export interface GpaSampleInput {
  sampleId: string;
  side: Side;
  operator: string;
  version: number;
  shape: Point[];
}

export interface GpaOptions {
  mirrorRight: boolean;
  minPoints?: number;
  runId?: number;
  createdAt?: string;
}

function meanPoint(points: Vec2[]): Vec2 {
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length
  };
}

/** 质心置零；RMS 半径缩放到 1。 */
function centerAndUnit(shape: Point[]): Point[] {
  const pts = shape.filter(isPresent) as Vec2[];
  if (pts.length === 0) return shape.map(() => null);
  const c = meanPoint(pts);
  const r =
    Math.sqrt(pts.reduce((s, p) => {
      const d = sub(p, c);
      return s + d.x * d.x + d.y * d.y;
    }, 0) / pts.length) || 1;
  return shape.map((p) =>
    isPresent(p) ? { x: (p.x - c.x) / r, y: (p.y - c.y) / r } : null
  );
}

function averageShapes(shapes: Point[][]): Point[] {
  const firstShape = shapes[0];
  const n = firstShape ? firstShape.length : 0;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const vals: Vec2[] = [];
    for (const sh of shapes) {
      const p = sh[i];
      if (isPresent(p)) vals.push(p);
    }
    out.push(vals.length ? meanPoint(vals) : null);
  }
  return out;
}

function shapeDelta(a: Point[], b: Point[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    if (isPresent(pa) && isPresent(pb)) {
      sum += (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** gauge 锚定：编号最小的共有存在点始终位于 +x 方向，消除整体旋转自由度。 */
function anchorToPlusX(shape: Point[]): { shape: Point[]; rotation: number } {
  const pts = shape.filter(isPresent) as Vec2[];
  if (pts.length === 0) return { shape, rotation: 0 };
  const c = meanPoint(pts);
  const idx = shape.findIndex((p) => isPresent(p));
  const anchor = shape[idx];
  if (!isPresent(anchor)) return { shape, rotation: 0 };
  const theta = -Math.atan2(anchor.y - c.y, anchor.x - c.x);
  return {
    rotation: theta,
    shape: shape.map((p) =>
      isPresent(p)
        ? (() => {
            const rd = rot(sub(p, c), theta);
            return { x: c.x + rd.x, y: c.y + rd.y };
          })()
        : null
    )
  };
}

export function signatureOf(
  inputs: GpaSampleInput[],
  opts: { mirrorRight: boolean; minPoints: number }
): string {
  const payload = JSON.stringify({
    m: opts.mirrorRight ? 1 : 0,
    k: opts.minPoints,
    s: inputs
      .map((s) => ({
        id: s.sampleId,
        v: s.version,
        sh: s.shape.map((p) =>
          p === null ? null : [Number(p.x.toFixed(9)), Number(p.y.toFixed(9))]
        )
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `sig_${(h >>> 0).toString(16).padStart(8, '0')}_${payload.length}`;
}

export function runGpa(rawInputs: GpaSampleInput[], options: GpaOptions): RunResult {
  const minPoints = options.minPoints ?? DEFAULT_MIN_POINTS;
  const landmarkCount = rawInputs[0]?.shape.length ?? 0;

  const samples: ConsensusSample[] = rawInputs.map((input) => {
    const mirrored = options.mirrorRight && input.side === 'R';
    const shape = mirrored
      ? mirrorShapeExplicit(input.shape)
      : input.shape.map((p) => p);
    const presentCount = (shape.filter(isPresent) as Vec2[]).length;
    const included = presentCount >= minPoints;
    return {
      sampleId: input.sampleId,
      side: input.side,
      operator: input.operator,
      version: input.version,
      shape,
      mask: shape.map((p) => isPresent(p)),
      presentCount,
      included,
      excludeReason: included ? 'included' : 'below_min_points',
      aligned: shape.map(() => null),
      residualSq: shape.map(() => null),
      rmsResidual: null,
      rotation: 0,
      scale: 1,
      mirrored,
      ambiguity: {
        kind: 'none',
        message: '',
        candidateAngles: [0],
        chosenAngle: 0,
        relativeGap: 1,
        usedDeterminant: 1
      }
    };
  });

  const active = samples.filter((s) => s.included);
  const nullAmbiguity: AmbiguityReport = {
    kind: 'none',
    message: '样本未进入共识（可识别点少于门槛）；原始定位版本完整保留。',
    candidateAngles: [],
    chosenAngle: 0,
    relativeGap: 1,
    usedDeterminant: 1
  };
  for (const s of samples) {
    if (!s.included) s.ambiguity = nullAmbiguity;
  }

  const excluded = samples
    .filter((s) => !s.included)
    .map((s) => ({
      sampleId: s.sampleId,
      reason: 'below_min_points',
      presentCount: s.presentCount
    }));

  let consensus: Point[] = Array.from({ length: landmarkCount }, () => null);
  let iterations = 0;
  let converged = false;

  if (active.length > 0) {
    // 初值：各样本中心化+单位化，取逐点均值，再中心化+单位化+gauge 锚定。
    let alignedShapes = active.map((s) => centerAndUnit(s.shape));
    let prevConsensus = anchorToPlusX(centerAndUnit(averageShapes(alignedShapes))).shape;

    for (; iterations < MAX_ITER; iterations++) {
      // 1) 每个样本对齐到当前共识（仅平移/缩放/旋转，det 恒 +1）
      const fitted: Point[][] = active.map((s) =>
        procrustesAlign(s.shape, prevConsensus, { mirrored: false }).aligned
      );
      // 2) 逐点平均 -> 新共识，标准化并锚定 gauge
      const anchored = anchorToPlusX(centerAndUnit(averageShapes(fitted)));
      consensus = anchored.shape;
      // 3) 以锚定后的共识重新统一朝向（稳定比较所需）
      alignedShapes = fitted.map((sh) => {
        const pts = sh.filter(isPresent) as Vec2[];
        if (pts.length === 0) return sh;
        const c = meanPoint(pts);
        const idx = sh.findIndex((p) => isPresent(p));
        const ap = sh[idx];
        if (!isPresent(ap)) return sh;
        const theta = -Math.atan2(ap.y - c.y, ap.x - c.x);
        return sh.map((p) => {
          if (!isPresent(p)) return null;
          const rd = rot(sub(p, c), theta);
          return { x: c.x + rd.x, y: c.y + rd.y };
        });
      });

      const delta = shapeDelta(consensus, prevConsensus);
      prevConsensus = consensus;
      if (delta < CONV_TOL) {
        converged = true;
        iterations++;
        break;
      }
    }
  }

  // 终轮对齐：收集逐样本变换、残差与不唯一性报告。
  const ambiguousSampleIds: string[] = [];
  for (const s of samples) {
    if (!s.included) continue;
    const res = procrustesAlign(s.shape, consensus, { mirrored: false });
    s.aligned = res.aligned;
    s.rotation = res.rotation;
    s.scale = res.scale;
    s.ambiguity = res.ambiguity;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < landmarkCount; i++) {
      const a = res.aligned[i];
      const c = consensus[i];
      if (isPresent(a) && isPresent(c) && isPresent(s.shape[i])) {
        const d2 = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
        s.residualSq[i] = d2;
        sum += d2;
        n++;
      }
    }
    s.rmsResidual = n > 0 ? Math.sqrt(sum / n) : null;
    if (res.ambiguity.kind !== 'none') ambiguousSampleIds.push(s.sampleId);
  }

  const pointVariance: (number | null)[] = [];
  for (let i = 0; i < landmarkCount; i++) {
    const vals = active
      .map((s) => s.aligned[i])
      .filter(isPresent) as Vec2[];
    const c = consensus[i];
    if (vals.length < 2 || !isPresent(c)) {
      pointVariance.push(null);
      continue;
    }
    pointVariance.push(
      vals.reduce((sum, p) => sum + (p.x - c.x) ** 2 + (p.y - c.y) ** 2, 0) /
        (vals.length - 1)
    );
  }

  const inputSignature = signatureOf(rawInputs, {
    mirrorRight: options.mirrorRight,
    minPoints
  });

  return {
    runId: options.runId ?? -1,
    createdAt: options.createdAt ?? new Date(0).toISOString(),
    mirrorRight: options.mirrorRight,
    minPoints,
    includedSampleIds: active.map((s) => s.sampleId),
    excluded,
    consensus,
    pointVariance,
    samples,
    gpaIterations: iterations,
    gpaConverged: converged,
    anchorIndex: consensus.findIndex((p) => isPresent(p)),
    ambiguousSampleIds,
    inputSignature
  };
}
