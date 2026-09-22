import { buildFixtures, LANDMARKS } from "/Users/lzy/pro/Pair-wiseGSB/workspace/1238/runs/A/work/src/fixtures.js";
import { runConsensus } from "/Users/lzy/pro/Pair-wiseGSB/workspace/1238/runs/A/work/src/consensus.js";

const cfgs = buildFixtures();
const ids = LANDMARKS.map((l) => l.id);
for (const mirrorEnabled of [true, false]) {
  const r = runConsensus({
    runId: `scratch-${mirrorEnabled}`,
    configurations: cfgs,
    landmarkIds: ids,
    mirrorEnabled
  });
  console.log("mirror:", mirrorEnabled, "iters:", r.iterations, "rss:", r.totalRss.toFixed(6));
  for (const a of r.alignments) {
    console.log(
      " ",
      a.sampleId, a.operator, a.side,
      "inc:", a.included,
      "res:", a.residual === undefined ? "-" : a.residual.toFixed(5),
      "tie:", a.tie ? `${a.tie.unique ? "unique" : "NONUNIQUE"} cands=${a.tie.candidates.map(c=>c.rotation.toFixed(3)).join("/")}` : "-",
      "reason:", a.excludeReason ?? ""
    );
  }
  console.log("variance:", r.consensus.map(c=>c.variance.toFixed(4)).join(", "));
  console.log("notes:", r.notes);
  const det = r.alignments.filter(a=>a.transform).map(a=>{const t=a.transform!;const d=Math.cos(t.rotation)*Math.cos(t.rotation)+Math.sin(t.rotation)*Math.sin(t.rotation);return d;});
  console.log("R^T R diag (should be 1):", det.join(","));
}
