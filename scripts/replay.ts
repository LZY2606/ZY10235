import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  exportBundle,
  getConfigurations,
  getLandmarks,
  openDatabase,
  saveRun,
  seedFixtures,
  isSeeded,
  clearRuns
} from "../src/db/store.js";
import { runConsensus } from "../src/consensus.js";

/**
 * 确定性重放：固定样本集与点谱系，分别重放
 *   - 含对称分支（mirrorEnabled=true，对右翅显式镜像）
 *   - 不含对称分支（mirrorEnabled=false）
 * 两次运行使用固定 runId，结果可重复比对，并写出导出包供清空后重新导入复核。
 */
const dbPath = resolve(process.cwd(), process.argv[2] ?? "data/wing.db");
const outPath = resolve(process.cwd(), process.argv[3] ?? "data/replay-export.json");

const db = openDatabase(dbPath);
if (!isSeeded(db)) seedFixtures(db);
clearRuns(db);

const configurations = getConfigurations(db);
const landmarkIds = getLandmarks(db).map((l) => l.id);
const stamp = new Date().toISOString();

for (const mirrorEnabled of [true, false]) {
  const runId = `replay-${mirrorEnabled ? "mirror" : "plain"}`;
  const result = runConsensus({
    runId,
    configurations,
    landmarkIds,
    mirrorEnabled,
    createdAt: stamp,
    notes: ["由 scripts/replay.ts 确定性重放生成"]
  });
  saveRun(db, result);
  console.log(
    `重放 ${runId}: 样本 ${result.fixedSampleIds.length} 组, 迭代 ${result.iterations}, ` +
      `总残差 ${result.totalRss.toFixed(8)}, 非唯一旋转 ${
        result.alignments.filter((a) => a.tie && !a.tie.unique).length
      } 个`
  );
}

const bundle = exportBundle(db);
writeFileSync(outPath, JSON.stringify(bundle, null, 2));
console.log(`导出包已写出：${outPath}`);
