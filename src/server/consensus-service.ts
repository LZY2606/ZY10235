import type { Database as DatabaseType } from 'better-sqlite3';
import type { Point, RunResult } from '../shared/types.js';
import { DEFAULT_MIN_POINTS, runGpa, type GpaSampleInput } from '../shared/gpa.js';
import { mirrorShapeExplicit } from '../shared/geometry.js';
import { getRun, insertRun, listLocalizations, listSamples } from './db.js';

interface ActiveShapeRow {
  sampleId: string;
  side: 'L' | 'R';
  operator: string;
  version: number;
  shape: Point[];
}

/**
 * 固定样本集 + 固定点谱系：每次运行都基于“当前 active 版本 + 当前确认状态”
 * 形成输入快照。镜像仅由显式开关控制，对齐矩阵恒为 det = +1。
 * 未确认对应的点按缺失处理（不插值），但原始定位记录保留。
 */
export function buildActiveInputs(db: DatabaseType, landmarkCount = 6): ActiveShapeRow[] {
  const samples = listSamples(db);
  const localizations = listLocalizations(db);
  const out: ActiveShapeRow[] = [];

  for (const sample of samples) {
    const rows = localizations.filter(
      (l) => l.sampleId === sample.id && l.version === sample.activeVersion
    );
    // 多操作者可能在同一版本号下定位；取该版本最近一条操作者作为代表（fixture 中版本即操作者版本）。
    const operators = [...new Set(rows.map((r) => r.operator))];
    const operator = operators[operators.length - 1] ?? 'unknown';
    const shape: Point[] = Array.from({ length: landmarkCount }, () => null);
    for (const row of rows) {
      if (row.x === null || row.y === null || row.confirmed !== 1) {
        shape[row.pointIndex] = null; // 缺失或对应未确认：保留为缺失，不自动插值
      } else {
        shape[row.pointIndex] = { x: row.x, y: row.y };
      }
    }
    out.push({
      sampleId: sample.id,
      side: sample.side,
      operator,
      version: sample.activeVersion,
      shape
    });
  }
  return out;
}

export interface CreateRunOptions {
  mirrorRight: boolean;
  minPoints?: number;
  note?: string | null;
}

export function createConsensusRun(db: DatabaseType, opts: CreateRunOptions): RunResult {
  const minPoints = opts.minPoints ?? DEFAULT_MIN_POINTS;
  const active = buildActiveInputs(db);
  const inputs: GpaSampleInput[] = active.map((a) => ({
    sampleId: a.sampleId,
    side: a.side,
    operator: a.operator,
    version: a.version,
    shape: a.shape
  }));
  const provisional = runGpa(inputs, {
    mirrorRight: opts.mirrorRight,
    minPoints
  });
  const createdAt = new Date().toISOString();
  const base: RunResult = { ...provisional, createdAt };
  const id = insertRun(db, {
    mirrorRight: opts.mirrorRight,
    minPoints,
    inputSignature: base.inputSignature,
    resultJson: JSON.stringify(base),
    note: opts.note ?? null
  });
  // 回填 runId 后再持久化，保证导出/重放快照里带稳定主键。
  const result: RunResult = { ...base, runId: id };
  db.prepare('UPDATE consensus_run SET result_json = ? WHERE id = ?').run(
    JSON.stringify(result),
    id
  );
  return result;
}

/** 重放：对已保存的运行快照重新执行 GPA，要求逐字段一致。 */
export function replayRun(
  db: DatabaseType,
  runId: number
): { stored: RunResult; replayed: RunResult; identical: boolean } {
  const row = getRun(db, runId);
  if (!row) throw new Error(`未知运行: ${runId}`);
  const stored = JSON.parse(row.result_json) as RunResult;
  const inputs: GpaSampleInput[] = stored.samples.map((s) => ({
    sampleId: s.sampleId,
    side: s.side,
    operator: s.operator,
    version: s.version,
    // 用“镜像前”的形状重放：右翅镜像后的形状需要翻回去
    shape:
      stored.mirrorRight && s.side === 'R'
        ? mirrorShapeExplicit(s.shape)
        : s.shape.map((p) => p)
  }));
  const replayed = runGpa(inputs, {
    mirrorRight: stored.mirrorRight,
    minPoints: stored.minPoints,
    runId,
    createdAt: stored.createdAt
  });
  const identical = JSON.stringify(replayed) === JSON.stringify(stored);
  return { stored, replayed, identical };
}
