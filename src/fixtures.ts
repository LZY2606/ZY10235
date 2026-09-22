import type { LandmarkInfo, Point, RawConfiguration } from "./types.js";

/**
 * 固定 fixture：翼形共识室验收数据集（种子固定，任何机器重放结果一致）。
 *
 * 点谱系（5 个翅脉交点，抽象命名，避免生物学争议）：
 *   LM0 前缘近端交点   (-2,  1)
 *   LM1 前缘远端交点   ( 2,  1)
 *   LM2 中脉偏心交点   ( 0, -0.55)   —— 偏离质心，打破 C2 旋转对称
 *   LM3 后缘近端交点   (-2, -1)
 *   LM4 后缘远端交点   ( 2, -1)
 *
 * 参考形状关于 y 轴镜像对称（LM0<->LM1, LM3<->LM4, LM2 在轴上），
 * 但由于 LM2 偏心，形状是手性的：镜像无法由任何正常旋转复刻，
 * 因此“是否镜像右翅”是一个有实际区别、必须显式选择的假设。
 *
 * 样本：
 *   W01 左翅，opA/opB 两个操作者版本（不同平移/旋转/缩放与抖动）
 *   W02 右翅，opA（镜像后与左翅一致；不镜像时残差明显变大）
 *   W03 右翅，opA，缺失 LM2（保留为缺失，不自动插值）
 *   W04 右翅，opA，近完全 C2 对称样本 -> 并列最优旋转（0 与 π）
 *   W05 左翅，opA，仅 1 个可识别点 -> 不进入共识形状，原版本保留
 */
export const LANDMARKS: LandmarkInfo[] = [
  { id: "LM0", label: "前缘近端交点" },
  { id: "LM1", label: "前缘远端交点" },
  { id: "LM2", label: "中脉偏心交点" },
  { id: "LM3", label: "后缘近端交点" },
  { id: "LM4", label: "后缘远端交点" }
];

/** 左翅参考形状（点谱系顺序）。 */
export const BASE_LEFT: Point[] = [
  { x: -2, y: 1 },
  { x: 2, y: 1 },
  { x: 0, y: -0.55 },
  { x: -2, y: -1 },
  { x: 2, y: -1 }
];

/**
 * 近完全 C2（180° 旋转）对称形状：LM2 位于质心附近。
 * 该配置在 OPA 下恒等对应与 π 旋转对应 [4,3,2,1,0] 近似并列最优。
 */
export const BASE_C2: Point[] = [
  { x: -2, y: 1 },
  { x: 2, y: 1 },
  { x: 0, y: 0 },
  { x: -2, y: -1 },
  { x: 2, y: -1 }
];

/** 确定性 LCG，保证 fixture 与重放跨机器一致。 */
function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface Similarity {
  tx: number;
  ty: number;
  rotation: number;
  scale: number;
  /** 生成右翅：先关于 y 轴镜像。 */
  mirrored: boolean;
}

function applySimilarity(p: { x: number; y: number }, s: Similarity) {
  const x0 = s.mirrored ? -p.x : p.x;
  const y0 = p.y;
  const cos = Math.cos(s.rotation);
  const sin = Math.sin(s.rotation);
  return {
    x: s.scale * (cos * x0 - sin * y0) + s.tx,
    y: s.scale * (sin * x0 + cos * y0) + s.ty
  };
}

function jittered(
  base: Point[],
  similarity: Similarity,
  jitter: number,
  seed: number,
  missing: number[] = []
): Point[] {
  const rng = makeRng(seed);
  return base.map((p, i) => {
    if (p == null || missing.includes(i)) return null;
    const q = applySimilarity(p, similarity);
    return {
      x: q.x + (rng() - 0.5) * 2 * jitter,
      y: q.y + (rng() - 0.5) * 2 * jitter
    };
  });
}

/**
 * 近完全 C2 对称抖动：成对构造 (i, τ(i)) 的扰动，
 * 仅带极小失配（5e-5 量级），因此两个旋转并列最优但严格意义上“近”对称。
 * τ = [4,3,2,1,0]。
 */
function nearSymmetricJitter(
  base: Point[],
  similarity: Similarity,
  pairJitter: number,
  mismatch: number,
  seed: number
): Point[] {
  const rng = makeRng(seed);
  const tau = [4, 3, 2, 1, 0];
  const noise: ({ x: number; y: number } | null)[] = [null, null, null, null, null];
  const done = new Set<number>();
  for (let i = 0; i < 5; i++) {
    if (done.has(i)) continue;
    const j = tau[i]!;
    done.add(i);
    done.add(j);
    const vx = (rng() - 0.5) * 2 * pairJitter;
    const vy = (rng() - 0.5) * 2 * pairJitter;
    if (i === j) {
      noise[i] = { x: vx, y: vy };
    } else {
      // C2 下对应扰动近似反向：e_j ≈ -e_i，附加极小失配。
      noise[i] = {
        x: vx + (rng() - 0.5) * 2 * mismatch,
        y: vy + (rng() - 0.5) * 2 * mismatch
      };
      noise[j] = {
        x: -vx + (rng() - 0.5) * 2 * mismatch,
        y: -vy + (rng() - 0.5) * 2 * mismatch
      };
    }
  }
  return base.map((p, i) => {
    if (p == null) return null;
    const q = applySimilarity(p, similarity);
    const e = noise[i]!;
    return { x: q.x + e.x, y: q.y + e.y };
  });
}

export const FIXTURE_VERSION = 1;

export function buildFixtures(): RawConfiguration[] {
  return [
    {
      sampleId: "W01",
      operator: "opA",
      side: "L",
      points: jittered(
        BASE_LEFT,
        { tx: 12.4, ty: -7.1, rotation: 0.31, scale: 1.62, mirrored: false },
        0.12,
        101
      )
    },
    {
      sampleId: "W01",
      operator: "opB",
      side: "L",
      points: jittered(
        BASE_LEFT,
        { tx: 12.0, ty: -6.6, rotation: 0.34, scale: 1.58, mirrored: false },
        0.13,
        202
      )
    },
    {
      sampleId: "W02",
      operator: "opA",
      side: "R",
      points: jittered(
        BASE_LEFT,
        { tx: -30.2, ty: 18.8, rotation: -0.22, scale: 2.1, mirrored: true },
        0.12,
        303
      )
    },
    {
      sampleId: "W03",
      operator: "opA",
      side: "R",
      points: jittered(
        BASE_LEFT,
        { tx: 5.6, ty: 31.5, rotation: 0.12, scale: 1.24, mirrored: true },
        0.12,
        404,
        [1]
      )
    },
    {
      sampleId: "W04",
      operator: "opA",
      side: "R",
      points: nearSymmetricJitter(
        BASE_C2,
        { tx: 48.0, ty: 63.0, rotation: 0.05, scale: 1.0, mirrored: true },
        0.003,
        5e-5,
        505
      )
    },
    {
      sampleId: "W05",
      operator: "opA",
      side: "L",
      // 仅 LM0 可识别，其余缺失：不足 2 个不同点，不进入共识。
      points: (() => {
        const pts: Point[] = jittered(
          BASE_LEFT,
          { tx: 100, ty: 100, rotation: 0, scale: 1, mirrored: false },
          0.0,
          606
        );
        return [pts[0], null, null, null, null];
      })()
    }
  ];
}
