import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildExportBundle,
  listLocalizations,
  listSamples,
  openDb,
  replaceFromBundle,
  setActiveVersion,
  setConfirmed,
  wipeDatabase
} from '../src/server/db.js';
import {
  buildActiveInputs,
  createConsensusRun,
  replayRun
} from '../src/server/consensus-service.js';
import type { ExportBundle } from '../src/shared/types.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

describe('fixture 播种与数据口径', () => {
  it('播种 5 个样本与 6 个点谱系，左/右翅、缺失点、稀疏样本齐备', () => {
    const samples = listSamples(db);
    expect(samples.map((s) => s.id)).toEqual([
      'S1-A-left',
      'S2-B-right',
      'S3-C-symmetric-left',
      'S4-D-missing-right',
      'S5-E-sparse-left'
    ]);
    expect(samples.find((s) => s.id === 'S2-B-right')?.side).toBe('R');
    const locs = listLocalizations(db, 'S4-D-missing-right');
    const v1 = locs.filter((l) => l.version === 1);
    expect(v1.find((l) => l.pointIndex === 4)?.x).toBeNull();
    expect(v1.find((l) => l.pointIndex === 4)?.y).toBeNull();
  });

  it('未确认对应的点按缺失进入共识输入，但原始行保留', () => {
    // S1 默认 active 为最高版本 v3（全部确认）；切到 v2 后 point 2 未确认
    setActiveVersion(db, 'S1-A-left', 2);
    const inputs = buildActiveInputs(db);
    const s1 = inputs.find((s) => s.sampleId === 'S1-A-left')!;
    expect(s1.shape[2]).toBeNull();
    const raw = listLocalizations(db, 'S1-A-left').filter(
      (l) => l.version === 2 && l.pointIndex === 2
    );
    expect(raw).toHaveLength(1);
    expect(raw[0]!.x).not.toBeNull();
  });

  it('确认点对应后该点进入输入', () => {
    setActiveVersion(db, 'S1-A-left', 2);
    setConfirmed(db, 'S1-A-left', 2, true);
    const s1 = buildActiveInputs(db).find((s) => s.sampleId === 'S1-A-left')!;
    expect(s1.shape[2]).not.toBeNull();
  });
});

describe('共识运行持久化与两分支比较', () => {
  it('镜像开关显式区分，运行结果可读取且稀疏样本不进入共识', () => {
    const off = createConsensusRun(db, { mirrorRight: false, note: '不含对称分支' });
    const on = createConsensusRun(db, { mirrorRight: true, note: '含对称分支' });
    expect(off.runId).toBe(1);
    expect(on.runId).toBe(2);
    expect(off.mirrorRight).toBe(false);
    expect(on.mirrorRight).toBe(true);
    expect(on.includedSampleIds).not.toContain('S5-E-sparse-left');
    expect(on.excluded.find((e) => e.sampleId === 'S5-E-sparse-left')?.presentCount).toBe(2);
    expect(on.ambiguousSampleIds).toContain('S3-C-symmetric-left');
  });

  it('运行记录可按固定快照重放并逐字段一致', () => {
    const run = createConsensusRun(db, { mirrorRight: true });
    const outcome = replayRun(db, run.runId);
    expect(outcome.identical).toBe(true);
  });
});

describe('导出 / 清空 / 重新导入复核', () => {
  it('导出 -> 清空 -> 重新导入后，样本、定位、运行记录全部复原，且重放仍一致', () => {
    createConsensusRun(db, { mirrorRight: false });
    createConsensusRun(db, { mirrorRight: true });
    const bundle: ExportBundle = buildExportBundle(db);
    expect(bundle.runs).toHaveLength(2);

    wipeDatabase(db);
    expect(listSamples(db)).toHaveLength(0);
    // 清空后数据库为空：重新导入完整包即可复核
    // 重新导入
    replaceFromBundle(db, bundle);
    const samples = listSamples(db);
    expect(samples).toHaveLength(5);
    const s4 = listLocalizations(db, 'S4-D-missing-right').filter((l) => l.version === 1);
    expect(s4.find((l) => l.pointIndex === 4)?.x).toBeNull();
    const replay = replayRun(db, 2);
    expect(replay.identical).toBe(true);
    expect(replay.stored.mirrorRight).toBe(true);
  });
});
