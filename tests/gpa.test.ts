import { describe, expect, it } from 'vitest';
import { DEFAULT_MIN_POINTS, runGpa, signatureOf, type GpaSampleInput } from '../src/shared/gpa.js';
import { FIXTURE_SAMPLES } from '../src/shared/fixtures.js';
import { rotationDet } from '../src/shared/geometry.js';
import type { Point } from '../src/shared/types.js';

function fixtureInputs(overrides?: Record<string, Point[]>): GpaSampleInput[] {
  return FIXTURE_SAMPLES.map((s) => {
    const version = Math.max(...s.localizations.map((l) => l.version));
    const loc = s.localizations.find((l) => l.version === version) ?? s.localizations[0]!;
    const shape = overrides?.[s.id] ?? loc.points.map((q, i) => (loc.confirmed[i] && q ? q : null));
    return {
      sampleId: s.id,
      side: s.side,
      operator: loc.operator,
      version,
      shape
    };
  });
}

describe('GPA 共识 — 固定样本集 / 镜像显式 / 入组门槛', () => {
  it('少于可识别点数的样本不进入共识，但保留在结果里', () => {
    const inputs = fixtureInputs();
    const run = runGpa(inputs, { mirrorRight: false, minPoints: DEFAULT_MIN_POINTS });
    const sparse = run.excluded.find((e) => e.sampleId === 'S5-E-sparse-left');
    expect(sparse).toBeDefined();
    expect(sparse?.presentCount).toBe(2);
    expect(run.includedSampleIds).not.toContain('S5-E-sparse-left');
    const kept = run.samples.find((s) => s.sampleId === 'S5-E-sparse-left');
    expect(kept).toBeDefined();
    expect(kept?.included).toBe(false);
    expect(kept?.excludeReason).toBe('below_min_points');
    expect(kept?.shape.filter((q) => q !== null)).toHaveLength(2);
  });

  it('镜像默认关闭：右翅不经镜像直接参与，且所有对齐矩阵 det=+1', () => {
    const run = runGpa(fixtureInputs(), { mirrorRight: false });
    for (const s of run.samples.filter((q) => q.included)) {
      expect(rotationDet(s.rotation)).toBeCloseTo(1, 12);
      expect(s.mirrored).toBe(false);
    }
    const right = run.samples.find((s) => s.sampleId === 'S2-B-right');
    expect(right?.mirrored).toBe(false);
  });

  it('显式开启镜像后右翅形状被镜像，且两分支给出不同输入签名/结果', () => {
    const inputs = fixtureInputs();
    const off = runGpa(inputs, { mirrorRight: false });
    const on = runGpa(inputs, { mirrorRight: true });
    const rightOn = on.samples.find((s) => s.sampleId === 'S2-B-right');
    expect(rightOn?.mirrored).toBe(true);
    const rightOff = off.samples.find((s) => s.sampleId === 'S2-B-right');
    expect(rightOff?.mirrored).toBe(false);
    expect(on.inputSignature).not.toBe(off.inputSignature);
    // 含对称分支右翅残差应显著小于未镜像分支
    expect((rightOn?.rmsResidual ?? 1) < (rightOff?.rmsResidual ?? 0)).toBe(true);
  });

  it('近完全对称样本产生并列最优旋转：稳定显示且报告非唯一', () => {
    const run = runGpa(fixtureInputs(), { mirrorRight: false });
    const s3 = run.samples.find((s) => s.sampleId === 'S3-C-symmetric-left');
    expect(s3?.ambiguity.kind).toBe('reflection_rotation_tie');
    expect(run.ambiguousSampleIds).toContain('S3-C-symmetric-left');
    // 稳定规则：候选角按绝对转角最小排序，且仍只用 det=+1
    const angles = s3!.ambiguity.candidateAngles;
    const sorted = [...angles].sort((a, b) => Math.abs(a) - Math.abs(b));
    expect(angles).toEqual(sorted);
    expect(rotationDet(s3!.rotation)).toBeCloseTo(1, 12);
  });

  it('同一输入重复运行逐字段确定（可重放）', () => {
    const inputs = fixtureInputs();
    const a = runGpa(inputs, { mirrorRight: true, minPoints: 3, runId: 9, createdAt: 't' });
    const b = runGpa(inputs, { mirrorRight: true, minPoints: 3, runId: 9, createdAt: 't' });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.gpaConverged).toBe(true);
  });

  it('签名只由固定样本集、版本、形状、镜像开关、门槛决定', () => {
    const inputs = fixtureInputs();
    const sig1 = signatureOf(inputs, { mirrorRight: false, minPoints: 3 });
    const sig2 = signatureOf(inputs, { mirrorRight: false, minPoints: 3 });
    const sig3 = signatureOf(inputs, { mirrorRight: true, minPoints: 3 });
    expect(sig1).toBe(sig2);
    expect(sig1).not.toBe(sig3);
  });

  it('点级方差在缺失点处为 null，其余为有限非负', () => {
    const run = runGpa(fixtureInputs(), { mirrorRight: true });
    for (const v of run.pointVariance) {
      if (v !== null) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
