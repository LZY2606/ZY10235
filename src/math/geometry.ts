import type { Point } from "../types.js";

export interface Vec2 {
  x: number;
  y: number;
}

export function isPoint(p: Point | undefined): p is Vec2 {
  return p != null && Number.isFinite(p.x) && Number.isFinite(p.y);
}

export function centroid(points: Vec2[]): Vec2 {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / n, y: sy / n };
}

/** 到质心的均方根距离（centroid size 的平方形式）。 */
export function centroidSsd(points: Vec2[]): number {
  const c = centroid(points);
  let s = 0;
  for (const p of points) {
    s += (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
  }
  return s;
}

/**
 * 显式镜像：关于 y 轴翻转 x 坐标。
 * 这是唯一允许的“反射”入口；对齐算法自身永不产生反射。
 */
export function mirrorX(points: Point[]): Point[] {
  return points.map((p) => (isPoint(p) ? { x: -p.x, y: p.y } : null));
}

export function applyTransform(
  points: Point[],
  t: { scale: number; rotation: number; tx: number; ty: number }
): Point[] {
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return points.map((p) => {
    if (!isPoint(p)) return null;
    const x = t.scale * (cos * p.x - sin * p.y) + t.tx;
    const y = t.scale * (sin * p.x + cos * p.y) + t.ty;
    return { x, y };
  });
}
