import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FIXTURE_REVISION, FIXTURE_SAMPLES, LANDMARKS } from '../shared/fixtures.js';
import type { ExportBundle, RunRecord, Side } from '../shared/types.js';

export interface AppDb {
  db: DatabaseType;
  close(): void;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS landmark (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  note  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sample (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  side           TEXT NOT NULL CHECK (side IN ('L','R')),
  active_version INTEGER NOT NULL DEFAULT 1,
  is_fixture     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS localization (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id   TEXT NOT NULL REFERENCES sample(id) ON DELETE CASCADE,
  operator    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('L','R')),
  point_index INTEGER NOT NULL CHECK (point_index >= 0 AND point_index < 6),
  x           REAL,
  y           REAL,
  confirmed   INTEGER NOT NULL DEFAULT 1 CHECK (confirmed IN (0,1)),
  UNIQUE (sample_id, operator, version, point_index)
);

CREATE INDEX IF NOT EXISTS idx_localization_sample
  ON localization(sample_id, version);

CREATE TABLE IF NOT EXISTS consensus_run (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL,
  mirror_right    INTEGER NOT NULL CHECK (mirror_right IN (0,1)),
  min_points      INTEGER NOT NULL,
  input_signature TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ok',
  note            TEXT,
  result_json     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_signature ON consensus_run(input_signature);

CREATE TABLE IF NOT EXISTS run_export (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES consensus_run(id) ON DELETE CASCADE,
  exported_at TEXT NOT NULL,
  payload    TEXT NOT NULL
);
`;

export function openDb(filename: string): DatabaseType {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  seedIfEmpty(db);
  return db;
}

/** 无条件播种固定 fixture（用于 /api/reset）。 */
export function seedFixtures(db: DatabaseType): void {
  const tx = db.transaction(() => {
    for (const lm of LANDMARKS) {
      db.prepare('INSERT OR REPLACE INTO landmark (id, name, note) VALUES (?, ?, ?)').run(
        lm.id,
        lm.name,
        lm.note
      );
    }
    const insSample = db.prepare(
      'INSERT INTO sample (id, name, side, active_version, is_fixture) VALUES (?, ?, ?, ?, 1)'
    );
    const insLoc = db.prepare(
      `INSERT INTO localization
         (sample_id, operator, version, side, point_index, x, y, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const sample of FIXTURE_SAMPLES) {
      const maxVersion = Math.max(...sample.localizations.map((l) => l.version));
      insSample.run(sample.id, sample.name, sample.side, maxVersion);
      for (const loc of sample.localizations) {
        loc.points.forEach((p, i) => {
          insLoc.run(
            sample.id,
            loc.operator,
            loc.version,
            loc.side,
            i,
            p ? p.x : null,
            p ? p.y : null,
            loc.confirmed[i] ? 1 : 0
          );
        });
      }
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'seeded',
      FIXTURE_REVISION
    );
  });
  tx();
}

/** 仅在空库时播种固定 fixture。 */
export function seedIfEmpty(db: DatabaseType): void {
  const seeded = db.prepare('SELECT value FROM meta WHERE key = ?').get('seeded') as
    | { value: string }
    | undefined;
  if (seeded) return;
  seedFixtures(db);
}

export function listLandmarks(db: DatabaseType) {
  return db.prepare('SELECT id, name, note FROM landmark ORDER BY id').all() as Array<{
    id: number;
    name: string;
    note: string;
  }>;
}

export function listSamples(db: DatabaseType) {
  const rows = db
    .prepare('SELECT id, name, side, active_version FROM sample ORDER BY id')
    .all() as Array<{
    id: string;
    name: string;
    side: Side;
    active_version: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    side: r.side,
    activeVersion: r.active_version
  }));
}

export function listLocalizations(db: DatabaseType, sampleId?: string) {
  const rows = sampleId
    ? db
        .prepare(
          'SELECT id, sample_id AS sampleId, operator, version, side, point_index AS pointIndex, x, y, confirmed FROM localization WHERE sample_id = ? ORDER BY version, point_index'
        )
        .all(sampleId)
    : db
        .prepare(
          'SELECT id, sample_id AS sampleId, operator, version, side, point_index AS pointIndex, x, y, confirmed FROM localization ORDER BY sample_id, version, point_index'
        )
        .all();
  return rows as Array<{
    id: number;
    sampleId: string;
    operator: string;
    version: number;
    side: Side;
    pointIndex: number;
    x: number | null;
    y: number | null;
    confirmed: 0 | 1;
  }>;
}

export function setActiveVersion(db: DatabaseType, sampleId: string, version: number): void {
  const res = db
    .prepare('UPDATE sample SET active_version = ? WHERE id = ?')
    .run(version, sampleId);
  if (res.changes === 0) throw new Error(`未知样本: ${sampleId}`);
}

export function setConfirmed(
  db: DatabaseType,
  sampleId: string,
  pointIndex: number,
  confirmed: boolean
): void {
  const res = db
    .prepare(
      'UPDATE localization SET confirmed = ? WHERE sample_id = ? AND point_index = ? AND version = (SELECT active_version FROM sample WHERE id = ?)'
    )
    .run(confirmed ? 1 : 0, sampleId, pointIndex, sampleId);
  if (res.changes === 0) throw new Error('该点在当前版本没有定位记录');
}

export function insertRun(
  db: DatabaseType,
  params: {
    mirrorRight: boolean;
    minPoints: number;
    inputSignature: string;
    resultJson: string;
    note: string | null;
  }
): number {
  const info = db
    .prepare(
      `INSERT INTO consensus_run
         (created_at, mirror_right, min_points, input_signature, status, note, result_json)
       VALUES (?, ?, ?, ?, 'ok', ?, ?)`
    )
    .run(
      new Date().toISOString(),
      params.mirrorRight ? 1 : 0,
      params.minPoints,
      params.inputSignature,
      params.note,
      params.resultJson
    );
  return Number(info.lastInsertRowid);
}

export function listRuns(db: DatabaseType): RunRecord[] {
  return db
    .prepare(
      'SELECT id, created_at, mirror_right, min_points, input_signature, status, result_json, note FROM consensus_run ORDER BY id'
    )
    .all() as RunRecord[];
}

export function getRun(db: DatabaseType, id: number): RunRecord | undefined {
  return db
    .prepare(
      'SELECT id, created_at, mirror_right, min_points, input_signature, status, result_json, note FROM consensus_run WHERE id = ?'
    )
    .get(id) as RunRecord | undefined;
}

export function recordExport(db: DatabaseType, runId: number, payload: string): void {
  db.prepare(
    'INSERT INTO run_export (run_id, exported_at, payload) VALUES (?, ?, ?)'
  ).run(runId, new Date().toISOString(), payload);
}

export function listExports(db: DatabaseType) {
  return db
    .prepare('SELECT id, run_id AS runId, exported_at AS exportedAt FROM run_export ORDER BY id')
    .all() as Array<{ id: number; runId: number; exportedAt: string }>;
}

export function buildExportBundle(db: DatabaseType): ExportBundle {
  return {
    format: 'wing-consensus-chamber',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    samples: listSamples(db).map((s) => ({
      id: s.id,
      name: s.name,
      side: s.side,
      active_version: s.activeVersion
    })),
    localizations: (
      db
        .prepare(
          `SELECT sample_id, operator, version, side, point_index, x, y, confirmed
             FROM localization ORDER BY sample_id, version, point_index`
        )
        .all() as Array<{
        sample_id: string;
        operator: string;
        version: number;
        side: Side;
        point_index: number;
        x: number | null;
        y: number | null;
        confirmed: 0 | 1;
      }>
    ).map((r) => ({
      sample_id: r.sample_id,
      operator: r.operator,
      version: r.version,
      side: r.side,
      point_index: r.point_index,
      x: r.x,
      y: r.y,
      confirmed: r.confirmed
    })),
    runs: listRuns(db)
  };
}

/** 清空并按导入包重建：用于“清空数据库后重新导入复核”。 */
export function replaceFromBundle(db: DatabaseType, bundle: ExportBundle): void {
  if (bundle.format !== 'wing-consensus-chamber' || bundle.schemaVersion !== 1) {
    throw new Error('导入包格式或版本不支持');
  }
  const tx = db.transaction(() => {
    db.exec(`
      DELETE FROM run_export;
      DELETE FROM consensus_run;
      DELETE FROM localization;
      DELETE FROM sample;
      DELETE FROM landmark;
      DELETE FROM meta;
    `);
    for (const lm of LANDMARKS) {
      db.prepare('INSERT INTO landmark (id, name, note) VALUES (?, ?, ?)').run(
        lm.id,
        lm.name,
        lm.note
      );
    }
    const insSample = db.prepare(
      'INSERT INTO sample (id, name, side, active_version, is_fixture) VALUES (?, ?, ?, ?, 0)'
    );
    for (const s of bundle.samples) {
      insSample.run(s.id, s.name, s.side, s.active_version);
    }
    const insLoc = db.prepare(
      `INSERT INTO localization
         (sample_id, operator, version, side, point_index, x, y, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const loc of bundle.localizations) {
      insLoc.run(
        loc.sample_id,
        loc.operator,
        loc.version,
        loc.side,
        loc.point_index,
        loc.x,
        loc.y,
        loc.confirmed
      );
    }
    const insRun = db.prepare(
      `INSERT INTO consensus_run
         (id, created_at, mirror_right, min_points, input_signature, status, note, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const run of bundle.runs) {
      insRun.run(
        run.id,
        run.created_at,
        run.mirror_right,
        run.min_points,
        run.input_signature,
        run.status,
        run.note,
        run.result_json
      );
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'seeded',
      `import:${bundle.exportedAt}`
    );
  });
  tx();
}

export function wipeDatabase(db: DatabaseType): void {
  db.exec(`
    DELETE FROM run_export;
    DELETE FROM consensus_run;
    DELETE FROM localization;
    DELETE FROM sample;
    DELETE FROM landmark;
    DELETE FROM meta;
  `);
}
