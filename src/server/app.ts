import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  clearRuns,
  exportBundle,
  getConfigurations,
  getLandmarks,
  getOverrides,
  getRun,
  importBundle,
  listRuns,
  openDatabase,
  reseed,
  saveOverrides,
  saveRun,
  type ExportBundle
} from "../db/store.js";
import { runConsensus, type CorrespondenceOverride } from "../consensus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolveWebDir();

function dirname(p: string): string {
  return p.split("/").slice(0, -1).join("/") || ".";
}

function resolveWebDir(): string {
  const candidates = [
    join(process.cwd(), "web"),
    join(HERE, "..", "..", "web"),
    join(HERE, "..", "web")
  ];
  return candidates.find((p) => existsSync(join(p, "index.html"))) ?? join(process.cwd(), "web");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

export function createApp(dbPath: string) {
  const db: DatabaseSync = openDatabase(dbPath);

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      serveStatic(url.pathname, res);
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const route = `${req.method ?? "GET"} ${url.pathname}`;

    if (route === "GET /api/state") {
      sendJson(res, {
        landmarks: getLandmarks(db),
        configurations: getConfigurations(db),
        runs: listRuns(db)
      });
      return;
    }

    if (route === "POST /api/runs") {
      const body = (await readJson(req)) as {
        runId?: string;
        mirrorEnabled?: unknown;
        overrides?: CorrespondenceOverride[];
      };
      // 镜像必须显式启用：拒绝缺省 / null / 字符串等隐式输入。
      if (typeof body.mirrorEnabled !== "boolean") {
        sendError(
          res,
          400,
          "mirrorEnabled 必须是显式布尔值（true=对右翅先镜像，false=不镜像）；不得缺省"
        );
        return;
      }
      validateOverrides(body.overrides);
      const configurations = getConfigurations(db);
      const landmarkIds = getLandmarks(db).map((l) => l.id);
      const runId = body.runId?.trim() || generateRunId(body.mirrorEnabled);
      const result = runConsensus({
        runId,
        configurations,
        landmarkIds,
        mirrorEnabled: body.mirrorEnabled,
        overrides: body.overrides ?? []
      });
      saveRun(db, result);
      if (body.overrides && body.overrides.length > 0) {
        saveOverrides(
          db,
          runId,
          body.overrides.map((o) => ({
            sampleId: o.sampleId,
            operator: o.operator,
            permutation: o.permutation ?? configurations
              .find((c) => c.sampleId === o.sampleId && c.operator === o.operator)
              ?.points.map((_, i) => i) ?? [],
            forceMissing: o.forceMissing ?? []
          }))
        );
      }
      sendJson(res, result);
      return;
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = getRun(db, runMatch[1]!);
      if (!run) {
        sendError(res, 404, "运行记录不存在");
        return;
      }
      sendJson(res, { run, overrides: getOverrides(db, run.runId) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/export") {
      const bundle = exportBundle(db);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition":
          'attachment; filename="wing-consensus-export.json"'
      });
      res.end(JSON.stringify(bundle, null, 2));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/import") {
      const bundle = (await readJson(req)) as ExportBundle;
      importBundle(db, bundle);
      sendJson(res, { ok: true, runs: listRuns(db).length });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/reseed") {
      reseed(db);
      sendJson(res, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/clear-runs") {
      clearRuns(db);
      sendJson(res, { ok: true });
      return;
    }

    sendError(res, 404, `未知接口：${route}`);
  }

  function validateOverrides(overrides: CorrespondenceOverride[] | undefined): void {
    if (!overrides) return;
    for (const o of overrides) {
      if (!o.sampleId || !o.operator) throw new Error("overrides 需要 sampleId 与 operator");
      if (o.permutation) {
        const sorted = [...o.permutation].sort((a, b) => a - b);
        const n = o.permutation.length;
        if (sorted.some((v, i) => v !== i)) {
          throw new Error(`${o.sampleId}/${o.operator} 的对应必须是 0..${n - 1} 的置换`);
        }
      }
      if (o.forceMissing?.some((v) => v < 0)) throw new Error("forceMissing 索引非法");
    }
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    const rel = pathname === "/" ? "/index.html" : pathname;
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(WEB_DIR, safe);
    if (!filePath.startsWith(WEB_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      sendError(res, 404, "Not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  }

  return { handler, db };
}

function generateRunId(mirrorEnabled: boolean): string {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${mirrorEnabled ? "mirror" : "plain"}-${stamp}-${rand}`;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}
