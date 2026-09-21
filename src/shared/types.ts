export type Side = 'L' | 'R';

/** A landmark observation. null means the point was explicitly retained missing (no interpolation). */
export type Point = { x: number; y: number } | null;

export interface LandmarkDef {
  id: number;
  name: string;
  /** Biological annotation; stable across L/R wings regardless of screen orientation. */
  note: string;
}

export interface LocalizationRow {
  id: number;
  sampleId: string;
  operator: string;
  version: number;
  side: Side;
  pointIndex: number;
  x: number | null;
  y: number | null;
  confirmed: 0 | 1;
}

export interface SampleSummary {
  id: string;
  side: Side;
  name: string;
  versions: number[];
  activeVersion: number;
  /** landmark index -> number of active-version localizations that have a coordinate */
  present: number[];
  /** landmark index -> whether correspondence is confirmed (all present localizations confirmed) */
  confirmed: boolean[];
  missingIndices: number[];
}

export interface AlignOptions {
  /** When true, right-wing observations are explicitly mirrored about the y axis
   *  BEFORE alignment. Alignment itself never uses a reflection. */
  mirrorRight: boolean;
}

export type AmbiguityKind = 'none' | 'reflection_rotation_tie' | 'isotropic';

export interface AmbiguityReport {
  kind: AmbiguityKind;
  /** Human-readable, stable explanation. */
  message: string;
  /** Equivalent candidate global rotation angles (radians) when non-unique. */
  candidateAngles: number[];
  /** Chosen angle according to the deterministic tie-break rule. */
  chosenAngle: number;
  /** Relative gap between best and the alternative (reflection) fit; ~0 means tie. */
  relativeGap: number;
  /** det of the actually used rotation matrix — always +1. */
  usedDeterminant: number;
}

export interface ProcrustesResult {
  /** per-landmark aligned source points (same null pattern as input) */
  aligned: Point[];
  /** rotation angle applied (radians) */
  rotation: number;
  scale: number;
  tx: number;
  ty: number;
  /** whether the explicit mirror was applied to this observation */
  mirrored: boolean;
  /** mean squared residual over paired points */
  rmsResidual: number;
  ambiguity: AmbiguityReport;
}

export interface ConsensusSample {
  sampleId: string;
  side: Side;
  operator: string;
  version: number;
  /** active-shape points for the run */
  shape: Point[];
  mask: boolean[];
  presentCount: number;
  included: boolean;
  excludeReason: 'included' | 'below_min_points';
  aligned: Point[];
  /** per-landmark squared residual vs consensus on paired points */
  residualSq: (number | null)[];
  rmsResidual: number | null;
  rotation: number;
  scale: number;
  mirrored: boolean;
  ambiguity: AmbiguityReport;
}

export interface RunResult {
  runId: number;
  createdAt: string;
  mirrorRight: boolean;
  minPoints: number;
  includedSampleIds: string[];
  excluded: { sampleId: string; reason: string; presentCount: number }[];
  /** consensus coordinates per landmark; null where no included sample had the point */
  consensus: Point[];
  /** per-landmark variance across aligned samples (null if <2 contributing) */
  pointVariance: (number | null)[];
  samples: ConsensusSample[];
  gpaIterations: number;
  gpaConverged: boolean;
  /** stable anchor landmark index used to fix the GPA rotation gauge */
  anchorIndex: number;
  /** ids of samples for which the optimal rotation is not uniquely identified */
  ambiguousSampleIds: string[];
  inputSignature: string;
}

export interface RunRecord {
  id: number;
  created_at: string;
  mirror_right: number;
  min_points: number;
  input_signature: string;
  status: string;
  result_json: string;
  note: string | null;
}

export interface ExportBundle {
  format: 'wing-consensus-chamber';
  schemaVersion: 1;
  exportedAt: string;
  samples: Array<{
    id: string;
    name: string;
    side: Side;
    active_version: number;
  }>;
  localizations: Array<{
    sample_id: string;
    operator: string;
    version: number;
    side: Side;
    point_index: number;
    x: number | null;
    y: number | null;
    confirmed: 0 | 1;
  }>;
  runs: RunRecord[];
}
