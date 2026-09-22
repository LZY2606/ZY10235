import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ConfigurationAlignment,
  ConsensusPoint,
  LandmarkInfo,
  RawConfiguration,
  RunResult
} from "../types.js";
import { buildFixtures, FIXTURE_VERSION, LANDMARKS } from "../fixtures.js";

export interface ExportBundle {
  format: "wing-consensus-chamber/v1";
  exportedAt: string;
  fixtureVersion: number;
  landmarks: LandmarkInfo[];
  configurations: RawConfiguration[];
  runs: RunResult[];
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS landmarks (
      ordinal INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL
    );

    -- 分层 1/2：操作者原始定位版本（永不修改、永不自动插值）
    CREATE TABLE IF NOT EXISTS raw_configurations (
      config_id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id TEXT NOT NULL,
      operator TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('L', 'R')),
      ordinal INTEGER NOT NULL,
      x REAL,
      y REAL,
      missing INTEGER NOT NULL DEFAULT 0,
      UNIQUE (sample_id, operator, ordinal)
    );

    -- 分层 5：共识运行（显式镜像开关 + 固定点谱系指纹）
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      mirror_enabled INTEGER NOT NULL CHECK (mirror_enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      lineage_hash TEXT NOT NULL,
      fixed_sample_ids TEXT NOT NULL,
      landmark_ids TEXT NOT NULL,
      total_rss REAL NOT NULL,
      iterations INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      notes_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs_raw (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      sample_id TEXT NOT NULL,
      operator TEXT NOT NULL,
      PRIMARY KEY (run_id, sample_id, operator)
    );

    -- 用户在某次运行上确认的点对应 / 显式保留缺失
    CREATE TABLE IF NOT EXISTS correspondence_overrides (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      sample_id TEXT NOT NULL,
      operator TEXT NOT NULL,
      permutation_json TEXT NOT NULL,
      force_missing_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (run_id, sample_id, operator)
    );
  `);
}

export function isSeeded(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'fixture_version'").get() as
    | { value: string }
    | undefined;
  return row != null && Number(row.value) === FIXTURE_VERSION;
}

export function seedFixtures(db: DatabaseSync): void {
  const tx = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fixture_version', ?)");
  tx.run(String(FIXTURE_VERSION));

  const insLandmark = db.prepare(
    "INSERT OR REPLACE INTO landmarks (ordinal, id, label) VALUES (?, ?, ?)"
  );
  LANDMARKS.forEach((l, i) => insLandmark.run(i, l.id, l.label));

  const insPoint = db.prepare(
    `INSERT OR REPLACE INTO raw_configurations
       (sample_id, operator, side, ordinal, x, y, missing)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const config of buildFixtures()) {
    config.points.forEach((p, ordinal) => {
      insPoint.run(
        config.sampleId,
        config.operator,
        config.side,
        ordinal,
        p == null ? null : p.x,
        p == null ? null : p.y,
        p == null ? 1 : 0
      );
    });
  }
}

export function reseed(db: DatabaseSync): void {
  db.exec("DELETE FROM correspondence_overrides; DELETE FROM runs_raw; DELETE FROM runs;");
  db.exec("DELETE FROM raw_configurations; DELETE FROM landmarks;");
  seedFixtures(db);
}

export function getLandmarks(db: DatabaseSync): LandmarkInfo[] {
  const rows = db
    .prepare("SELECT id, label FROM landmarks ORDER BY ordinal")
    .all() as { id: string; label: string }[];
  return rows.map((r) => ({ id: r.id, label: r.label }));
}

export function getConfigurations(db: DatabaseSync): RawConfiguration[] {
  const rows = db
    .prepare(
      `SELECT sample_id AS sampleId, operator, side, ordinal, x, y, missing
         FROM raw_configurations
        ORDER BY sample_id, operator, ordinal`
    )
    .all() as {
    sampleId: string;
    operator: string;
    side: "L" | "R";
    ordinal: number;
    x: number | null;
    y: number | null;
    missing: number;
  }[];

  const map = new Map<string, RawConfiguration>();
  for (const row of rows) {
    const key = `${row.sampleId}|${row.operator}`;
    let config = map.get(key);
    if (!config) {
      config = { sampleId: row.sampleId, operator: row.operator, side: row.side, points: [] };
      map.set(key, config);
    }
    config.points[row.ordinal] =
      row.missing || row.x == null || row.y == null ? null : { x: row.x, y: row.y };
  }
  return [...map.values()];
}

export function getOverrides(
  db: DatabaseSync,
  runId: string
): { sampleId: string; operator: string; permutation: number[]; forceMissing: number[] }[] {
  const rows = db
    .prepare(
      `SELECT sample_id AS sampleId, operator, permutation_json AS permJson,
              force_missing_json AS missingJson
         FROM correspondence_overrides WHERE run_id = ?`
    )
    .all(runId) as { sampleId: string; operator: string; permJson: string; missingJson: string }[];
  return rows.map((r) => ({
    sampleId: r.sampleId,
    operator: r.operator,
    permutation: JSON.parse(r.permJson) as number[],
    forceMissing: JSON.parse(r.missingJson) as number[]
  }));
}

export function saveOverrides(
  db: DatabaseSync,
  runId: string,
  overrides: { sampleId: string; operator: string; permutation: number[]; forceMissing: number[] }[]
): void {
  const del = db.prepare("DELETE FROM correspondence_overrides WHERE run_id = ?");
  const ins = db.prepare(
    `INSERT INTO correspondence_overrides
       (run_id, sample_id, operator, permutation_json, force_missing_json)
     VALUES (?, ?, ?, ?, ?)`
  );
  del.run(runId);
  for (const o of overrides) {
    ins.run(runId, o.sampleId, o.operator, JSON.stringify(o.permutation), JSON.stringify(o.forceMissing));
  }
}

export function saveRun(db: DatabaseSync, run: RunResult): void {
  const delRaw = db.prepare("DELETE FROM runs_raw WHERE run_id = ?");
  const delRun = db.prepare("DELETE FROM runs WHERE run_id = ?");
  const insRun = db.prepare(
    `INSERT INTO runs
       (run_id, mirror_enabled, created_at, lineage_hash, fixed_sample_ids,
        landmark_ids, total_rss, iterations, result_json, notes_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insRaw = db.prepare(
    "INSERT OR IGNORE INTO runs_raw (run_id, sample_id, operator) VALUES (?, ?, ?)"
  );

  delRaw.run(run.runId);
  delRun.run(run.runId);
  insRun.run(
    run.runId,
    run.mirrorEnabled ? 1 : 0,
    run.createdAt,
    run.lineageHash,
    JSON.stringify(run.fixedSampleIds),
    JSON.stringify(run.landmarkIds),
    run.totalRss,
    run.iterations,
    JSON.stringify(run),
    JSON.stringify(run.notes)
  );
  for (const a of run.alignments) insRaw.run(run.runId, a.sampleId, a.operator);
}

export function listRuns(db: DatabaseSync): {
  runId: string;
  mirrorEnabled: boolean;
  createdAt: string;
  lineageHash: string;
  totalRss: number;
  iterations: number;
  fixedSampleIds: string[];
}[] {
  const rows = db
    .prepare(
      `SELECT run_id AS runId, mirror_enabled AS mirror, created_at AS createdAt,
              lineage_hash AS lineageHash, fixed_sample_ids AS fixedJson,
              total_rss AS totalRss, iterations
         FROM runs ORDER BY created_at DESC, run_id DESC`
    )
    .all() as {
    runId: string;
    mirror: number;
    createdAt: string;
    lineageHash: string;
    fixedJson: string;
    totalRss: number;
    iterations: number;
  }[];
  return rows.map((r) => ({
    runId: r.runId,
    mirrorEnabled: r.mirror === 1,
    createdAt: r.createdAt,
    lineageHash: r.lineageHash,
    totalRss: r.totalRss,
    iterations: r.iterations,
    fixedSampleIds: JSON.parse(r.fixedJson) as string[]
  }));
}

export function getRun(db: DatabaseSync, runId: string): RunResult | null {
  const row = db.prepare("SELECT result_json AS json FROM runs WHERE run_id = ?").get(runId) as
    | { json: string }
    | undefined;
  return row ? (JSON.parse(row.json) as RunResult) : null;
}

export function clearRuns(db: DatabaseSync): void {
  db.exec("DELETE FROM correspondence_overrides; DELETE FROM runs_raw; DELETE FROM runs;");
}

export function clearAll(db: DatabaseSync): void {
  db.exec(
    `DELETE FROM correspondence_overrides; DELETE FROM runs_raw; DELETE FROM runs;
     DELETE FROM raw_configurations; DELETE FROM landmarks; DELETE FROM meta;`
  );
}

export function exportBundle(db: DatabaseSync): ExportBundle {
  const runs = listRuns(db)
    .map((r) => getRun(db, r.runId))
    .filter((r): r is RunResult => r != null);
  return {
    format: "wing-consensus-chamber/v1",
    exportedAt: new Date().toISOString(),
    fixtureVersion: FIXTURE_VERSION,
    landmarks: getLandmarks(db),
    configurations: getConfigurations(db),
    runs
  };
}

/** 清空后重新导入导出包（复核重放）：fixture 与运行记录全部以导入为准。 */
export function importBundle(db: DatabaseSync, bundle: ExportBundle): void {
  if (bundle.format !== "wing-consensus-chamber/v1") {
    throw new Error(`不支持的导出格式：${bundle.format}`);
  }
  clearAll(db);

  const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  meta.run("fixture_version", String(bundle.fixtureVersion));

  const insLandmark = db.prepare(
    "INSERT INTO landmarks (ordinal, id, label) VALUES (?, ?, ?)"
  );
  bundle.landmarks.forEach((l, i) => insLandmark.run(i, l.id, l.label));

  const insPoint = db.prepare(
    `INSERT INTO raw_configurations
       (sample_id, operator, side, ordinal, x, y, missing)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const config of bundle.configurations) {
    config.points.forEach((p, ordinal) => {
      insPoint.run(
        config.sampleId,
        config.operator,
        config.side,
        ordinal,
        p == null ? null : p.x,
        p == null ? null : p.y,
        p == null ? 1 : 0
      );
    });
  }
  for (const run of bundle.runs) saveRun(db, run);
}

export type { ConfigurationAlignment, ConsensusPoint };
