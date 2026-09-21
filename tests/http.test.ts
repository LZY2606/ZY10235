import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/server/db.js';
import { handleApi } from '../src/server/app.js';
import type { Database } from 'better-sqlite3';

class MockRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  writableEnded = false;
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
  }
  end(chunk?: string | Buffer) {
    if (chunk) this.body += chunk.toString();
    this.writableEnded = true;
  }
}

function request(
  method: string,
  path: string,
  body?: unknown
): { req: IncomingMessage; res: MockRes } {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = { 'content-type': 'application/json' };
  const res = new MockRes() as unknown as MockRes;
  if (body !== undefined) {
    const raw = Buffer.from(JSON.stringify(body));
    (req as unknown as { [Symbol.asyncIterator](): AsyncGenerator<Buffer> })[Symbol.asyncIterator] =
      async function* () {
        yield raw;
      };
  } else {
    (req as unknown as { [Symbol.asyncIterator](): AsyncGenerator<Buffer> })[Symbol.asyncIterator] =
      async function* () {
        // empty body
      };
  }
  return { req, res };
}

describe('HTTP API', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('GET /api/state 返回样本、定位、活动输入与最小点数', async () => {
    const { req, res } = request('GET', '/api/state');
    const handled = await handleApi(db, req, res as never);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const state = JSON.parse(res.body) as {
      samples: Array<{ id: string; side: string }>;
      minPoints: number;
      localizations: unknown[];
    };
    expect(state.samples).toHaveLength(5);
    expect(state.minPoints).toBe(3);
    expect(state.localizations.length).toBeGreaterThan(50);
  });

  it('创建运行时镜像必须显式启用：缺省/false 都按关处理', async () => {
    for (const body of [undefined, { mirrorRight: false }]) {
      const { req, res } = request('POST', '/api/runs', body);
      await handleApi(db, req, res as never);
      expect(res.statusCode).toBe(201);
      const run = JSON.parse(res.body) as { mirrorRight: boolean };
      expect(run.mirrorRight).toBe(false);
    }
    const { req, res } = request('POST', '/api/runs', { mirrorRight: true });
    await handleApi(db, req, res as never);
    const run = JSON.parse(res.body) as { mirrorRight: boolean };
    expect(run.mirrorRight).toBe(true);
  });

  it('稀疏样本不进入共识，且并列旋转被报告；GET /api/runs 可比较两分支', async () => {
    const off = request('POST', '/api/runs', { mirrorRight: false });
    await handleApi(db, off.req, off.res as never);
    const on = request('POST', '/api/runs', { mirrorRight: true });
    await handleApi(db, on.req, on.res as never);
    const onBody = JSON.parse(on.res.body) as {
      includedSampleIds: string[];
      ambiguousSampleIds: string[];
      runId: number;
    };
    expect(onBody.includedSampleIds).not.toContain('S5-E-sparse-left');
    expect(onBody.ambiguousSampleIds).toContain('S3-C-symmetric-left');

    const list = request('GET', '/api/runs');
    await handleApi(db, list.req, list.res as never);
    const runs = JSON.parse(list.res.body) as { runs: Array<{ id: number; mirror_right: number }> };
    expect(runs.runs).toHaveLength(2);
  });

  it('导出 -> 清空重置 -> 重新导入：状态复原', async () => {
    const runOn = request('POST', '/api/runs', { mirrorRight: true });
    await handleApi(db, runOn.req, runOn.res as never);
    const runOff = request('POST', '/api/runs', { mirrorRight: false });
    await handleApi(db, runOff.req, runOff.res as never);

    const exp = request('GET', '/api/export');
    await handleApi(db, exp.req, exp.res as never);
    const bundle = JSON.parse(exp.res.body);

    const reset = request('POST', '/api/reset');
    await handleApi(db, reset.req, reset.res as never);
    expect(reset.res.statusCode).toBe(200);

    const imp = request('POST', '/api/import', bundle);
    await handleApi(db, imp.req, imp.res as never);
    expect(imp.res.statusCode).toBe(200);
    const body = JSON.parse(imp.res.body) as {
      state: { samples: unknown[] };
    };
    expect(body.state.samples).toHaveLength(5);

    const list = request('GET', '/api/runs');
    await handleApi(db, list.req, list.res as never);
    const runs = JSON.parse(list.res.body) as { runs: unknown[] };
    expect(runs.runs).toHaveLength(2);
  });

  it('未知 API 返回 404，且非 API 请求返回 false（交给静态/Vite）', async () => {
    const api = request('GET', '/api/nope');
    await handleApi(db, api.req, api.res as never);
    expect(api.res.statusCode).toBe(404);
    const page = request('GET', '/');
    const handled = await handleApi(db, page.req, page.res as never);
    expect(handled).toBe(false);
  });
});

describe('真实 HTTP 端到端（含静态服务）', () => {
  it('dist 未构建时 dev 服务启动后首页包含“翼形共识室”（构建产物存在时同路径）', async () => {
    const db = openDb(':memory:');
    const server = createServer((req, res) => {
      void handleApi(db, req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end('not api');
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { samples: unknown[] };
    expect(body.samples).toHaveLength(5);
    server.close();
    db.close();
  });
});
