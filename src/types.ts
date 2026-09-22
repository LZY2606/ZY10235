/**
 * 翼形共识室 — 领域类型
 *
 * 分层口径（从原始到派生）：
 *  1. raw_coordinates：操作者记录的原始坐标，永不修改、永不自动插值；
 *  2. operator_versions：同一样本的多次操作者定位版本；
 *  3. mirror hypothesis：镜像右翅必须显式启用；镜像在对齐之前单独完成，
 *     对齐本身只允许平移、均匀缩放与行列式为 +1 的旋转；
 *  4. Procrustes 对齐结果：每个配置相对共识形状的旋转/缩放/平移与残差；
 *  5. consensus：仅由可识别点数达标的配置产生的共识形状与点级方差。
 */

/** 二维点；缺失点用 null 表示，不会被自动插值。 */
export type Point = { x: number; y: number } | null;

/** 一个操作者版本：按固定点谱系（landmark id）存放的原始坐标序列。 */
export interface RawConfiguration {
  /** 样本编号，例如 W01。 */
  sampleId: string;
  /** 操作者/版本编号，例如 opA。 */
  operator: string;
  /** 左翅或右翅。 */
  side: "L" | "R";
  /**
   * 点谱系：数组顺序即为全局统一的 landmark 谱系，
   * 缺失交点记为 null（保留为缺失，不插值）。
   */
  points: Point[];
}

export interface LandmarkInfo {
  id: string;
  label: string;
}

/** OPA（Ordinary Procrustes Analysis）输出：只含平移、均匀缩放、旋转。 */
export interface ProcrustesTransform {
  /** 均匀缩放（始终为正）。 */
  scale: number;
  /** 旋转角（弧度）。det(rotation) 恒为 +1。 */
  rotation: number;
  /** 平移分量。 */
  tx: number;
  ty: number;
  /**
   * 本结果是否在对齐前显式应用了 x 轴镜像。
   * false 时镜像绝对不会被负行列式偷偷吸收。
   */
  mirrored: boolean;
}

export interface OpaResult {
  transform: ProcrustesTransform;
  /** Procrustes 残差（平方和，基于两侧共同存在的点）。 */
  rss: number;
  /** 参与对齐的点对数。 */
  used: number;
  /** 对齐到参考系后的配置坐标（仅参与点；缺失仍为 null）。 */
  aligned: Point[];
}

/**
 * 并列最优旋转候选项。
 * 当形状存在离散对称（点谱系置换后形状等价）时，多个旋转可能并列最优。
 */
export interface RotationCandidate {
  /** 点谱系置换：配置点 i 对齐到共识 landmark permutation[i]。 */
  permutation: number[];
  rotation: number;
  rss: number;
  /** 与稳定规则选中的最优值之差（相对值）。 */
  gap: number;
}

export interface ConfigurationAlignment {
  sampleId: string;
  operator: string;
  side: "L" | "R";
  /** 用户确认的点对应（landmark 谱系置换），缺省为恒等。 */
  correspondence: number[];
  /** 该配置是否显式镜像（由用户在运行上选择的镜像策略决定）。 */
  mirrored: boolean;
  included: boolean;
  /** 不足可识别点数时给出排除原因；原版本仍完整保留。 */
  excludeReason?: string;
  transform?: ProcrustesTransform;
  rss?: number;
  aligned?: Point[];
  residual?: number;
  /** 并列最优旋转（对称形状非唯一性）。 */
  tie?: {
    unique: boolean;
    tolerance: number;
    stableRule: string;
    chosen: RotationCandidate;
    candidates: RotationCandidate[];
  };
}

export interface ConsensusPoint {
  landmarkId: string;
  x: number;
  y: number;
  /** 该 landmark 的点级方差（各配置对齐坐标的均值方差）。 */
  variance: number;
  /** 有多少配置在此 landmark 提供了可识别点。 */
  n: number;
  missing: boolean;
}

export interface RunResult {
  runId: string;
  /** 镜像是否被显式启用（必须由请求方明确给出，无默认值）。 */
  mirrorEnabled: boolean;
  createdAt: string;
  fixedSampleIds: string[];
  landmarkIds: string[];
  consensus: ConsensusPoint[];
  alignments: ConfigurationAlignment[];
  /** 收敛后的 GPA 总残差。 */
  totalRss: number;
  iterations: number;
  /** 共识运行所固定的点谱系（raw 坐标指纹），保证可重放。 */
  lineageHash: string;
  notes: string[];
}
