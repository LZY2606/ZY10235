import type { OpaResult, Point, ProcrustesTransform } from "../types.js";
import { applyTransform, centroid, centroidSsd, isPoint, mirrorX } from "./geometry.js";

export interface OpaOptions {
  /** 是否在对齐之前显式镜像 source（右翅 -> 左翅方向）。 */
  mirrored: boolean;
  /**
   * 点谱系对应：source 的第 i 个可识别点对齐到 target[correspondence[i]]。
   * 缺省为恒等对应。两侧任一缺失的点不参与。
   */
  correspondence?: number[];
}

/**
 * 二维 Ordinary Procrustes Analysis（闭式解）。
 *
 * 只允许：平移（质心归一化）、均匀缩放 s = ||Y||/||X||、旋转
 *   θ = atan2( Σ(x_i y'_i - y_i x'_i), Σ(x_i x'_i + y_i y'_i) )。
 *
 * 该解恒为正常旋转 R = [[cos,-sin],[sin,cos]]，det(R) = +1；
 * 因此镜像不可能被负行列式“偷偷吸收”——镜像只能通过 mirrored:true
 * 在对齐之前显式完成。
 */
export function opa(sourceIn: Point[], targetIn: Point[], options: OpaOptions): OpaResult {
  const n = Math.min(sourceIn.length, targetIn.length);
  const correspondence = options.correspondence ?? sourceIn.map((_, i) => i);

  const source = options.mirrored ? mirrorX(sourceIn) : sourceIn;

  const srcPts: { x: number; y: number }[] = [];
  const tgtPts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const s = source[i];
    const t = targetIn[correspondence[i]];
    if (isPoint(s) && isPoint(t)) {
      srcPts.push(s);
      tgtPts.push(t);
    }
  }

  if (srcPts.length === 0) {
    return {
      transform: { scale: 1, rotation: 0, tx: 0, ty: 0, mirrored: options.mirrored },
      rss: Number.POSITIVE_INFINITY,
      used: 0,
      aligned: source.map((p) => (isPoint(p) ? { ...p } : null))
    };
  }

  const cs = centroid(srcPts);
  const ct = centroid(tgtPts);
  let a = 0;
  let b = 0;
  for (let k = 0; k < srcPts.length; k++) {
    const x = srcPts[k]!.x - cs.x;
    const y = srcPts[k]!.y - cs.y;
    const xp = tgtPts[k]!.x - ct.x;
    const yp = tgtPts[k]!.y - ct.y;
    a += x * xp + y * yp; // tr(H)
    b += x * yp - y * xp; // 使 R 把 source 转到 target 的反对称项
  }
  const rotation = Math.atan2(b, a);

  const srcSsd = centroidSsd(srcPts);
  const tgtSsd = centroidSsd(tgtPts);
  const scale = srcSsd > 0 ? Math.sqrt(tgtSsd / srcSsd) : 1;

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const tx = ct.x - scale * (cos * cs.x - sin * cs.y);
  const ty = ct.y - scale * (sin * cs.x + cos * cs.y);

  const transform: ProcrustesTransform = { scale, rotation, tx, ty, mirrored: options.mirrored };
  const aligned = applyTransform(source, transform);

  let rss = 0;
  for (let i = 0; i < n; i++) {
    const ap = aligned[i];
    const t = targetIn[correspondence[i]];
    if (isPoint(ap) && isPoint(t)) {
      rss += (ap.x - t.x) ** 2 + (ap.y - t.y) ** 2;
    }
  }

  return { transform, rss, used: srcPts.length, aligned };
}

/** 解包后的旋转角，归一化到 (-pi, pi]。 */
export function normalizedAngle(theta: number): number {
  let a = theta % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}
