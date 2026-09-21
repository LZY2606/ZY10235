import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { openDb } from './db.js';
import { handleApi } from './app.js';

function cliArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const HOST = cliArg('host') ?? process.env.HOST ?? '127.0.0.1';
const PORT = Number(cliArg('port') ?? process.env.PORT ?? 5575);
const DB_PATH = process.env.WING_DB ?? resolve('data/wing.db');
const DIST_DIR = resolve('dist');

type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void
) => void;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const clean = urlPath === '/' ? '/index.html' : urlPath;
  const file = join(DIST_DIR, clean);
  if (!file.startsWith(DIST_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    const fallback = join(DIST_DIR, 'index.html');
    if (urlPath.startsWith('/api/') || !existsSync(fallback)) return false;
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(readFileSync(fallback));
    return true;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store'
  });
  res.end(readFileSync(file));
  return true;
}

async function makeViteMiddleware(server: ReturnType<typeof createServer>): Promise<ConnectMiddleware> {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    configFile: resolve('vite.config.ts'),
    appType: 'spa'
  });
  server.on('close', () => void vite.close());
  return vite.middlewares as ConnectMiddleware;
}

async function main(): Promise<void> {
  const db = openDb(DB_PATH);
  const distBuilt = existsSync(join(DIST_DIR, 'index.html'));

  const server = createServer((req, res) => {
    void (async () => {
      const handled = await handleApi(db, req, res);
      if (handled) return;
      if (distBuilt) {
        if (serveStatic(res, new URL(req.url ?? '/', 'http://x').pathname)) return;
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const middleware = await middlewareReady;
      middleware(req, res, () => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      });
    })();
  });

  const middlewareReady: Promise<ConnectMiddleware> = distBuilt
    ? Promise.resolve(((..._args: unknown[]) => undefined) as unknown as ConnectMiddleware)
    : makeViteMiddleware(server);

  await new Promise<void>((listenDone) => {
    server.listen(PORT, HOST, () => listenDone());
  });
  if (!distBuilt) await middlewareReady;

  console.log(
    `翼形共识室 http://${HOST}:${PORT}${distBuilt ? '（dist 生产模式）' : '（Vite dev 模式）'}`
  );
  console.log(`数据库: ${DB_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
