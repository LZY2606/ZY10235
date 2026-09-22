import { createHash } from "node:crypto";
import type {
  ConfigurationAlignment,
  ConsensusPoint,
  Point,
  RawConfiguration,
  RotationCandidate,
  RunResult
} from "./types.js";
import { isPoint, mirrorX } from "./math/geometry.js";
import { opa, normalizedAngle } from "./math/procrustes.js";
import { rotationalSymmetries } from "./math/symmetry.js";

/** 进入共识形状所需的最小可识别点数（两个不同的点才能定义尺度与旋转）。 */
export const MIN_DISTINCT_POINTS = 2;

/** 并列最优旋转判定阈值（相对最优 rss）。 */
export const TIE_REL_TOLERANCE = 0.02;
/**
 * 对称形状探测容差（相对质心尺度）。
 * 常规样本操作者抖动 ~4% 尺度（π 错位约 5% 尺度，判为非对称）；
 * 近完全对称样本失配 <0.1%（判为 C2 对称）。取 1.5% 留出两侧余量。
 */
export const SYMMETRY_REL_TOLERANCE = 0.015;

const MAX_ITERATIONS = 200;
const CONVERGENCE = 1e-12;

export interface CorrespondenceOverride {
  sampleId: string;
  operator: string;
  /** 用户确认的点谱系置换；缺省表示恒等。 */
  permutation?: number[];
  /** 用户将某点明确保留为缺失（不自动插值），按源 landmark 索引。 */
  forceMissing?: number[];
}

export interface RunConsensusOptions {
  runId: string;
  configurations: RawConfiguration[];
  landmarkIds: string[];
  /** 必须显式给出：是否对右翅先做镜像。无默认值、不可由对齐自身吸收。 */
  mirrorEnabled: boolean;
  overrides?: CorrespondenceOverride[];
  createdAt?: string;
  notes?: string[];
}

function distinctPointCount(points: Point[]): number {
  const seen = new Set<string>();
  for (const p of points) {
    if (isPoint(p)) seen.add(`${p.x.toFixed(9)},${p.y.toFixed(9)}`);
  }
  return seen.size;
}

function preprocess(config: RawConfiguration, mirrorEnabled: boolean, forceMissing: number[]): Point[] {
  let pts = config.points.map((p) => (p == null ? null : { ...p }));
  for (const idx of forceMissing) pts[idx] = null;
  if (mirrorEnabled && config.side === "R") pts = mirrorX(pts);
  return pts;
}

export function lineageHash(configurations: RawConfiguration[], mirrorEnabled: boolean): string {
  const h = createHash("sha256");
  h.update(`mirror=${mirrorEnabled ? 1 : 0};`);
  for (const c of configurations) {
    h.update(`${c.sampleId}|${c.operator}|${c.side}|`);
    h.update(
      c.points
        .map((p) => (p == null ? "M" : `${p.x.toFixed(12)},${p.y.toFixed(12)}`))
        .join(";")
    );
    h.update(";;");
  }
  return h.digest("hex").slice(0, 16);
}

interface Prepared {
  raw: RawConfiguration;
  work: Point[];
  correspondence: number[];
  included: boolean;
  excludeReason?: string;
}

function prepareAll(options: RunConsensusOptions): Prepared[] {
  const overrideMap = new Map(
    (options.overrides ?? []).map((o) => [`${o.sampleId} ${o.operator}`, o])
  );
  return options.configurations.map((raw) => {
    const override = overrideMap.get(`${raw.sampleId} ${raw.operator}`);
    const correspondence =
      override?.permutation && override.permutation.length === raw.points.length
        ? override.permutation.slice()
        : raw.points.map((_, i) => i);
    const forceMissing = override?.forceMissing ?? [];
    const work = preprocess(raw, options.mirrorEnabled, forceMissing);
    const distinct = distinctPointCount(work);
    const present = work.filter(isPoint).length;
    if (present < MIN_DISTINCT_POINTS) {
      return {
        raw,
        work,
        correspondence,
        included: false,
        excludeReason: `可识别点 ${present} 个，少于最小要求 ${MIN_DISTINCT_POINTS} 个`
      };
    }
    if (distinct < MIN_DISTINCT_POINTS) {
      return {
        raw,
        work,
        correspondence,
        included: false,
        excludeReason: `不同位置的点 ${distinct} 个，无法确定尺度与旋转`
      };
    }
    return { raw, work, correspondence, included: true };
  });
}

function meanConfiguration(configs: Point[][], n: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sy = 0;
    let k = 0;
    for (const cfg of configs) {
      const p = cfg[i];
      if (isPoint(p)) {
        sx += p.x;
        sy += p.y;
        k++;
      }
    }
    out.push(k > 0 ? { x: sx / k, y: sy / k } : null);
  }
  return out;
}

/** 居中并按质心尺度归一化（缺失点不参与）。 */
function normalizeShape(points: Point[]): Point[] {
  const valid = points.filter(isPoint);
  if (valid.length === 0) return points.map(() => null);
  const cx = valid.reduce((s, p) => s + p.x, 0) / valid.length;
  const cy = valid.reduce((s, p) => s + p.y, 0) / valid.length;
  let ssd = 0;
  for (const p of valid) ssd += (p.x - cx) ** 2 + (p.y - cy) ** 2;
  const scale = Math.sqrt(ssd) || 1;
  return points.map((p) => (isPoint(p) ? { x: (p.x - cx) / scale, y: (p.y - cy) / scale } : null));
}

export interface TieReport {
  unique: boolean;
  tolerance: number;
  stableRule: string;
  chosen: RotationCandidate;
  candidates: RotationCandidate[];
}

/**
 * 检测并列最优旋转：枚举共识形状的离散正常旋转对称置换，
 * 与用户确认的点对应复合后逐个做 OPA 比较 rss。
 * 稳定规则：rss 最小者并列时，取旋转角归一化后绝对值最小（恒等优先）；
 * 仍相同则取置换字典序最小。角度固定归一化到 (-pi, pi]。
 */
export function detectRotationTie(
  work: Point[],
  consensus: Point[],
  baseCorrespondence: number[]
): TieReport {
  // 并列旋转既可能来自配置自身的旋转对称（C = Rπ·A 时两次 OPA 最优值相同），
  // 也可能来自共识形状的旋转对称；取两侧对称群候选的并集。
  const symmetries = [
    ...rotationalSymmetries(work, SYMMETRY_REL_TOLERANCE),
    ...rotationalSymmetries(consensus, SYMMETRY_REL_TOLERANCE)
  ];
  const evaluated: RotationCandidate[] = [];
  const seen = new Set<string>();

  for (const sym of symmetries) {
    const composed = work.map((_, i) => baseCorrespondence[sym[i]!]!);
    const key = composed.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const r = opa(work, consensus, { mirrored: false, correspondence: composed });
    evaluated.push({
      permutation: composed,
      rotation: normalizedAngle(r.transform.rotation),
      rss: r.rss,
      gap: 0
    });
  }

  evaluated.sort((a, b) => a.rss - b.rss);
  const bestRss = evaluated[0]!.rss;
  const scaleRss = Math.max(bestRss, 1e-12);
  const candidates = evaluated
    .map((c) => ({ ...c, gap: Math.abs(c.rss - bestRss) / scaleRss }))
    .filter((c) => c.gap <= TIE_REL_TOLERANCE);

  const stableRule =
    "并列最优时取归一化旋转角绝对值最小（恒等对应优先）；仍相同则置换字典序最小";
  const chosen = candidates.slice().sort((a, b) => {
    if (Math.abs(a.rotation) !== Math.abs(b.rotation)) {
      return Math.abs(a.rotation) - Math.abs(b.rotation);
    }
    const ak = a.permutation.join(",");
    const bk = b.permutation.join(",");
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  })[0]!;
  return {
    unique: candidates.length === 1,
    tolerance: TIE_REL_TOLERANCE,
    stableRule,
    chosen,
    candidates: candidates.sort((a, b) => a.rss - b.rss)
  };
}

export function runConsensus(options: RunConsensusOptions): RunResult {
  const n = options.landmarkIds.length;
  const notes = options.notes ? options.notes.slice() : [];
  const prepared = prepareAll(options);
  const included = prepared.filter((p) => p.included);
  const fixedSampleIds = Array.from(new Set(included.map((p) => p.raw.sampleId))).sort();

  if (included.length === 0) {
    notes.push("没有点数达标的配置：不产生共识形状，所有原版本仍完整保留");
  }

  // 标准 Generalized Procrustes Analysis：每个配置先各自居中并归一化到
  // 单位质心尺度；GPA 只在旋转（必要时的显式镜像已在预处理完成）上迭代。
  const unitWork = included.map((item) => normalizeShape(item.work));

  let consensus: Point[] =
    included.length > 0 ? unitWork[0]!.map((p) => (p == null ? null : { ...p })) : Array.from({ length: n }, () => null);

  let iterations = 0;
  let totalRss = Number.POSITIVE_INFINITY;

  for (; iterations < MAX_ITERATIONS; iterations++) {
    const aligned: Point[][] = [];
    let rss = 0;
    for (let k = 0; k < included.length; k++) {
      const item = included[k]!;
      const r = opa(unitWork[k]!, consensus, {
        mirrored: false,
        correspondence: item.correspondence
      });
      aligned.push(r.aligned);
      rss += r.rss;
    }
    // 均值形状保持单位质心尺度（GPA 相似形状空间约定），避免尺度漂移。
    const next = normalizeShape(meanConfiguration(aligned, n));
    let drift = 0;
    for (let i = 0; i < n; i++) {
      if (isPoint(next[i]) && isPoint(consensus[i])) {
        drift += (next[i]!.x - consensus[i]!.x) ** 2 + (next[i]!.y - consensus[i]!.y) ** 2;
      }
    }
    consensus = next;
    totalRss = rss;
    if (drift < CONVERGENCE) {
      iterations++;
      break;
    }
  }

  const alignments: ConfigurationAlignment[] = prepared.map((item) => {
    const base: ConfigurationAlignment = {
      sampleId: item.raw.sampleId,
      operator: item.raw.operator,
      side: item.raw.side,
      correspondence: item.correspondence,
      mirrored: options.mirrorEnabled && item.raw.side === "R",
      included: item.included,
      excludeReason: item.excludeReason
    };
    if (!item.included) return base;

    const unit = normalizeShape(item.work);
    const tie = detectRotationTie(unit, consensus, item.correspondence);
    const r = opa(unit, consensus, {
      mirrored: false,
      correspondence: tie.chosen.permutation
    });
    const residual = r.used > 0 ? r.rss / r.used : Number.POSITIVE_INFINITY;

    return {
      ...base,
      transform: r.transform,
      rss: r.rss,
      aligned: r.aligned,
      residual,
      tie
    };
  });

  const consensusPoints: ConsensusPoint[] = [];
  for (let i = 0; i < n; i++) {
    const cp = consensus[i];
    const alignedHere = alignments
      .filter((a) => a.included && isPoint(a.aligned?.[i]))
      .map((a) => a.aligned![i]!);
    if (!isPoint(cp) || alignedHere.length === 0) {
      consensusPoints.push({
        landmarkId: options.landmarkIds[i]!,
        x: 0,
        y: 0,
        variance: 0,
        n: 0,
        missing: true
      });
      continue;
    }
    const variance =
      alignedHere.reduce((s, p) => s + (p.x - cp.x) ** 2 + (p.y - cp.y) ** 2, 0) /
      alignedHere.length;
    consensusPoints.push({
      landmarkId: options.landmarkIds[i]!,
      x: cp.x,
      y: cp.y,
      variance,
      n: alignedHere.length,
      missing: false
    });
  }

  for (const a of alignments) {
    if (!a.tie || a.tie.unique) continue;
    const angles = a.tie.candidates
      .map((c) => `${(c.rotation / Math.PI).toFixed(4)}π`)
      .join(", ");
    notes.push(
      `${a.sampleId}/${a.operator} 存在并列最优旋转（非唯一）：候选角度 ${angles}；` +
        `按稳定规则显示 ${(a.tie.chosen.rotation / Math.PI).toFixed(4)}π` +
        `（${a.tie.candidates.length} 个并列，容差 ${TIE_REL_TOLERANCE * 100}%）`
    );
  }

  return {
    runId: options.runId,
    mirrorEnabled: options.mirrorEnabled,
    createdAt: options.createdAt ?? new Date().toISOString(),
    fixedSampleIds,
    landmarkIds: options.landmarkIds.slice(),
    consensus: consensusPoints,
    alignments,
    totalRss,
    iterations,
    lineageHash: lineageHash(options.configurations, options.mirrorEnabled),
    notes
  };
}
