import { buildFixtures, LANDMARKS } from "../src/fixtures.js";
import { runConsensus, detectRotationTie, MIN_DISTINCT_POINTS } from "../src/consensus.js";
import { opa } from "../src/math/procrustes.js";
import { rotationalSymmetries } from "../src/math/symmetry.js";
import { isPoint, mirrorX } from "../src/math/geometry.js";

const cfgs = buildFixtures();
const ids = LANDMARKS.map((l) => l.id);
for (const mirrorEnabled of [true, false]) {
  const r = runConsensus({ runId: "x", configurations: cfgs, landmarkIds: ids, mirrorEnabled });
  console.log("=== mirror", mirrorEnabled);
  console.log("consensus symmetries:", rotationalSymmetries(r.consensus.map(c=>c.missing?null:{x:c.x,y:c.y}), 0.03).map(p=>p.join("")));
  for (const a of r.alignments) {
    if (!a.included) continue;
    console.log(a.sampleId, a.operator, "rss=", a.rss!.toFixed(6), "tieCands:",
      a.tie!.candidates.map(c=>`r=${(c.rotation/Math.PI).toFixed(3)}pi rss=${c.rss.toFixed(5)} gap=${c.gap.toFixed(4)}`).join(" | "));
  }
}
