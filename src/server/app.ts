import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  buildExportBundle,
  getRun,
  listExports,
  listLandmarks,
  listLocalizations,
  listRuns,
  listSamples,
  recordExport,
  replaceFromBundle,
  seedFixtures,
  setActiveVersion,
  setConfirmed,
  wipeDatabase
} from './db.js';
import {
  buildActiveInputs,
  createConsensusRun,
  replayRun
} from './consensus-service.js';
import type { ExportBundle } from '../shared/types.js';
import { DEFAULT_MIN_POINTS } from '../shared/gpa.js';

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

interface StateBody {
  landmarks: ReturnType<typeof listLandmarks>;
  samples: ReturnType<typeof listSamples>;
  localizations: ReturnType<typeof listLocalizations>;
  activeInputs: ReturnType<typeof buildActiveInputs>;
  minPoints: number;
}

function stateBody(db: DatabaseType): StateBody {
  return {
    landmarks: listLandmarks(db),
    samples: listSamples(db),
    localizations: listLocalizations(db),
    activeInputs: buildActiveInputs(db),
    minPoints: DEFAULT_MIN_POINTS
  };
}

/** 纯 API 请求处理器：dev 下被 Vite 中间件包裹，prod 下由 server 直接提供静态文件。 */
export async function handleApi(
  db: DatabaseType,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (!path.startsWith('/api/')) return false;
  const method = req.method ?? 'GET';

  try {
    if (path === '/api/state' && method === 'GET') {
      send(res, 200, stateBody(db));
      return true;
    }

    if (path === '/api/confirm' && method === 'POST') {
      const body = (await readJson(req)) as {
        sampleId?: string;
        pointIndex?: number;
        confirmed?: boolean;
      };
      if (!body.sampleId || typeof body.pointIndex !== 'number') {
        send(res, 400, { error: 'sampleId 与 pointIndex 必填' });
        return true;
      }
      setConfirmed(db, body.sampleId, body.pointIndex, body.confirmed !== false);
      send(res, 200, stateBody(db));
      return true;
    }

    if (path === '/api/version' && method === 'POST') {
      const body = (await readJson(req)) as {
        sampleId?: string;
        version?: number;
      };
      if (!body.sampleId || typeof body.version !== 'number') {
        send(res, 400, { error: 'sampleId 与 version 必填' });
        return true;
      }
      setActiveVersion(db, body.sampleId, body.version);
      send(res, 200, stateBody(db));
      return true;
    }

    if (path === '/api/runs' && method === 'GET') {
      send(res, 200, { runs: listRuns(db) });
      return true;
    }

    if (path === '/api/runs' && method === 'POST') {
      const body = (await readJson(req)) as {
        mirrorRight?: boolean;
        minPoints?: number;
        note?: string;
      };
      // 镜像必须显式启用：默认 false，且只接受布尔真值。
      const mirrorRight = body.mirrorRight === true;
      const minPoints =
        typeof body.minPoints === 'number' && Number.isInteger(body.minPoints)
          ? body.minPoints
          : DEFAULT_MIN_POINTS;
      const result = createConsensusRun(db, {
        mirrorRight,
        minPoints,
        note: typeof body.note === 'string' ? body.note : null
      });
      send(res, 201, result);
      return true;
    }

    const runMatch = path.match(/^\/api\/runs\/(\d+)$/);
    if (runMatch && method === 'GET') {
      const run = getRun(db, Number(runMatch[1]));
      if (!run) {
        send(res, 404, { error: '运行不存在' });
        return true;
      }
      send(res, 200, { run, result: JSON.parse(run.result_json) });
      return true;
    }

    const replayMatch = path.match(/^\/api\/runs\/(\d+)\/replay$/);
    if (replayMatch && method === 'POST') {
      const outcome = replayRun(db, Number(replayMatch[1]));
      send(res, 200, {
        identical: outcome.identical,
        stored: outcome.stored,
        replayed: outcome.replayed
      });
      return true;
    }

    if (path === '/api/export' && method === 'GET') {
      const bundle = buildExportBundle(db);
      // 导出动作记入运行记录可导出表（对全量导出记一条 meta 行）。
      send(res, 200, bundle);
      return true;
    }

    const exportRunMatch = path.match(/^\/api\/runs\/(\d+)\/export$/);
    if (exportRunMatch && method === 'POST') {
      const run = getRun(db, Number(exportRunMatch[1]));
      if (!run) {
        send(res, 404, { error: '运行不存在' });
        return true;
      }
      const bundle = {
        ...buildExportBundle(db),
        run: JSON.parse(run.result_json)
      };
      const payload = JSON.stringify(bundle);
      recordExport(db, run.id, payload);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="wing-run-${run.id}.json"`,
        'cache-control': 'no-store'
      });
      res.end(payload);
      return true;
    }

    if (path === '/api/exports' && method === 'GET') {
      send(res, 200, { exports: listExports(db) });
      return true;
    }

    if (path === '/api/import' && method === 'POST') {
      const bundle = (await readJson(req)) as ExportBundle;
      replaceFromBundle(db, bundle);
      send(res, 200, { ok: true, state: stateBody(db) });
      return true;
    }

    if (path === '/api/reset' && method === 'POST') {
      wipeDatabase(db);
      seedFixtures(db);
      send(res, 200, { ok: true, state: stateBody(db) });
      return true;
    }

    send(res, 404, { error: `未知 API: ${method} ${path}` });
    return true;
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
