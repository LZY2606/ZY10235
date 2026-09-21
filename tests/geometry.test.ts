import { describe, expect, it } from 'vitest';
import {
  mirrorShapeExplicit,
  procrustesAlign,
  rotationDet,
  TIE_REL_TOL,
  type Vec2
} from '../src/shared/geometry.js';
import type { Point } from '../src/shared/types.js';

const p = (x: number, y: number): Point => ({ x, y });

/** 已知平移/缩放/旋转生成的目标，应被精确还原。 */
function transform(
  shape: Point[],
  theta: number,
  k: number,
  tx: number,
  ty: number
): Point[] {
  return shape.map((q) => {
    if (q === null) return null;
    return {
      x: tx + k * (q.x * Math.cos(theta) - q.y * Math.sin(theta)),
      y: ty + k * (q.x * Math.sin(theta) + q.y * Math.cos(theta))
    };
  });
}

describe('procrustesAlign — 仅平移/缩放/旋转', () => {
  const source = [p(0, 0), p(1, 0), p(0, 2), p(3, 1), p(2, -2), p(-1, 1)];

  it('精确恢复已知旋转/缩放/平移，且 det 恒为 +1', () => {
    const theta = 0.42;
    const target = transform(source, theta, 1.7, 5.5, -3.2);
    const r = procrustesAlign(source, target, { mirrored: false });
    expect(r.ambiguity.kind).toBe('none');
    expect(r.rmsResidual).toBeLessThan(1e-9);
    expect(Math.abs(r.rotation - theta)).toBeLessThan(1e-9);
    expect(r.scale).toBeCloseTo(1.7, 9);
    expect(rotationDet(r.rotation)).toBeCloseTo(1, 12);
  });

  it('绝不偷偷使用反射：目标是源的镜像时仍返回 det=+1 旋转，并给出显式镜像提示', () => {
    const mirroredTarget = mirrorShapeExplicit(source);
    const r = procrustesAlign(source, mirroredTarget, { mirrored: false });
    expect(rotationDet(r.rotation)).toBeCloseTo(1, 12);
    // 正规旋转无法完美拟合镜像形状，残差显著
    expect(r.rmsResidual).toBeGreaterThan(1e-3);
    expect(r.ambiguity.kind).not.toBe('reflection_rotation_tie');
  });

  it('先显式镜像再对齐：镜像右翅后可完美重合（镜像不是对齐内部完成的）', () => {
    const mirrored = mirrorShapeExplicit(source);
    const mirroredTarget = transform(mirrored, 0.21, 1.3, 2, 2);
    const r = procrustesAlign(mirrored, mirroredTarget, { mirrored: true });
    expect(r.rmsResidual).toBeLessThan(1e-9);
    expect(rotationDet(r.rotation)).toBeCloseTo(1, 12);
    expect(r.ambiguity.kind).toBe('none');
  });

  it('镜像绕质心且保持缺失点缺失（不插值）', () => {
    const shape: Point[] = [p(0, 0), p(2, 0), null, p(0, 4)];
    const before = shape.filter((q): q is Vec2 => q !== null);
    const out = mirrorShapeExplicit(shape);
    expect(out[2]).toBeNull();
    const centroidX = (pts: Vec2[]) => pts.reduce((sum, q) => sum + q.x, 0) / pts.length;
    // 镜像保持质心位置不变（关于过质心纵轴翻转），缺失点保持缺失
    const present = out.filter((q): q is Vec2 => q !== null);
    expect(centroidX(present)).toBeCloseTo(centroidX(before), 10);
  });

  it('缺失点不参与拟合，但仍按同一变换显示，且不插值', () => {
    const target = transform(source, 0.3, 1.2, 1, 1);
    const gapped: Point[] = source.map((q, i) => (i === 2 ? null : q));
    const r = procrustesAlign(gapped, target, { mirrored: false });
    expect(r.aligned[2]).toBeNull();
    expect(Math.abs(r.rotation - 0.3)).toBeLessThan(1e-8);
  });

  it('近共线对称点列：旋转与镜像并列最优时报告非唯一并稳定裁决', () => {
    const arc = (noise: number): Point[] => {
      const offsets = [-20, -12, -4, 4, 12, 20];
      return offsets.map((ox, i) => ({
        x: 24 + ox + noise * 10 * ((i % 3) - 1),
        y: 8 + 1e-8 * (ox * ox / 400 - 1) + noise * 10 * ((i % 2) - 0.5)
      }));
    };
    const v1 = arc(0);
    const v2 = arc(1e-6);
    const r1 = procrustesAlign(v2, v1, { mirrored: false });
    expect(r1.ambiguity.kind).toBe('reflection_rotation_tie');
    expect(r1.ambiguity.relativeGap).toBeLessThanOrEqual(TIE_REL_TOL);
    expect(r1.ambiguity.candidateAngles.length).toBeGreaterThanOrEqual(2);
    // 稳定规则：相同输入再次运行给出完全相同的选择
    const r2 = procrustesAlign(v2, v1, { mirrored: false });
    expect(r2.ambiguity.chosenAngle).toBe(r1.ambiguity.chosenAngle);
    // 实际应用的矩阵仍为 det = +1
    expect(rotationDet(r1.rotation)).toBeCloseTo(1, 12);
  });

  it('普通非退化双侧翅形不会被误报为并列', () => {
    const a = [p(0, 0), p(12, 2), p(26, 1), p(40, 6), p(30, 14), p(10, 16)];
    const b = a.map((q) => (q ? { x: q.x + 0.2, y: q.y - 0.15 } : null));
    const r = procrustesAlign(b, a, { mirrored: false });
    expect(r.ambiguity.kind).toBe('none');
  });
});
