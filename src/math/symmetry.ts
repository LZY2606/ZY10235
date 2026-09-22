import { centroid, isPoint } from "./geometry.js";
import type { Point } from "../types.js";

export interface PresentPoint {
  index: number;
  p: { x: number; y: number };
}

/**
 * 检测形状自身绕质心旋转 angle 后是否重合（正常旋转，det=+1，绝不含反射）。
 * 仅对存在的点进行唯一最近邻匹配；匹配容差为 relTol × 质心尺度。
 * 返回置换 perm，perm[i] = j 表示旋转后 landmark i 重合到原 landmark j。
 */
export function rotationSymmetryPermutation(
  points: Point[],
  angle: number,
  relTol = 1e-6
): number[] | null {
  const present: PresentPoint[] = [];
  points.forEach((p, index) => {
    if (isPoint(p)) present.push({ index, p });
  });
  if (present.length < 2) return null;

  const c = centroid(present.map((e) => e.p));
  const size = Math.sqrt(
    present.reduce((s, e) => s + (e.p.x - c.x) ** 2 + (e.p.y - c.y) ** 2, 0)
  );
  const tol = Math.max(relTol * size, 1e-9);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const perm = new Array(points.length).fill(-1);
  const used = new Set<number>();

  for (const { index, p } of present) {
    const rx = c.x + cos * (p.x - c.x) - sin * (p.y - c.y);
    const ry = c.y + sin * (p.x - c.x) + cos * (p.y - c.y);
    let best = -1;
    let bestD = Infinity;
    for (const t of present) {
      if (used.has(t.index)) continue;
      const d = (rx - t.p.x) ** 2 + (ry - t.p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t.index;
      }
    }
    if (best < 0 || Math.sqrt(bestD) > tol) return null;
    used.add(best);
    perm[index] = best;
  }
  return perm;
}

/**
 * 枚举形状的离散正常旋转对称群（绝不含反射）：
 * 平面内有限旋转对称群必为循环群，阶 m 不超过点数 n。
 * 恒等置换始终作为第一个结果。缺失点位置在置换中保持恒等（不参与匹配）。
 */
export function rotationalSymmetries(points: Point[], relTol = 1e-6): number[][] {
  const n = points.length;
  const identity = points.map((_, i) => i);
  const result: number[][] = [identity];
  const seen = new Set<string>([identity.join(",")]);

  for (let m = 2; m <= n; m++) {
    const angle = (2 * Math.PI) / m;
    const perm = rotationSymmetryPermutation(points, angle, relTol);
    if (!perm) continue;
    const full = points.map((_, i) => (perm[i] === undefined || perm[i] === -1 ? i : perm[i]));
    const key = full.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(full);
  }
  return result;
}
