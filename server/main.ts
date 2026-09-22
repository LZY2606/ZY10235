import { createServer } from "node:http";
import { resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import { isSeeded, seedFixtures } from "../src/db/store.js";

function parseArg(flag: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
}

const host = parseArg("--host", "127.0.0.1");
const port = Number(parseArg("--port", "5575"));
const dbPath = resolve(process.cwd(), parseArg("--db", "data/wing.db"));

const app = createApp(dbPath);
if (!isSeeded(app.db)) {
  seedFixtures(app.db);
}

const server = createServer((req, res) => {
  void app.handler(req, res);
});

server.listen(port, host, () => {
  console.log(`翼形共识室 已启动：http://${host}:${port}`);
  console.log(`SQLite 数据库：${dbPath}`);
});
