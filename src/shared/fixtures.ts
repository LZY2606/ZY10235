import type { LandmarkDef, Point, Side } from './types.js';

/**
 * 固定点谱系（landmark lineage）：6 个翅脉交点，编号/含义在左右翅、
 * 所有操作者版本之间保持一致。点对应一旦建立，不随镜像/旋转改变。
 */
export const LANDMARKS: LandmarkDef[] = [
  { id: 0, name: '前缘脉基点', note: 'costa base（左右翅同一解剖点）' },
  { id: 1, name: '肩横脉点', note: 'humeral crossvein' },
  { id: 2, name: '径脉分叉点', note: 'radius fork' },
  { id: 3, name: '径中横脉端', note: 'r-m crossvein end' },
  { id: 4, name: '中脉中点', note: 'media midpoint' },
  { id: 5, name: '肘脉端', note: 'cubitus tip' }
];

export const FIXTURE_REVISION = 'fixture-v1';

export interface FixtureLocalization {
  operator: string;
  version: number;
  side: Side;
  points: Point[];
  /** 与 LANDMARKS 的对应是否已确认；false 的点不进入共识 */
  confirmed: boolean[];
}

export interface FixtureSample {
  id: string;
  name: string;
  side: Side;
  localizations: FixtureLocalization[];
}

const pt = (x: number, y: number): Point => ({ x, y });

/** 左翅原型（6 点）。 */
const leftBase: Point[] = [
  pt(0, 0),
  pt(12, 2),
  pt(26, 1),
  pt(40, 6),
  pt(30, 14),
  pt(10, 16)
];

/** 右翅原型 = 左翅关于纵轴（y 轴）镜像，方便构造近对称样本。 */
const rightBase: Point[] = leftBase.map((p) =>
  p === null ? null : { x: -p.x, y: p.y }
);

function jittered(base: Point[], d: (i: number) => [number, number]): Point[] {
  return base.map((p, i) => {
    if (p === null) return null;
    const [dx, dy] = d(i);
    return { x: p.x + dx, y: p.y + dy };
  });
}

function withMissing(shape: Point[], index: number): Point[] {
  return shape.map((p, i) => (i === index ? null : p));
}

const allConfirmed = [true, true, true, true, true, true];

/**
 * 近共线且关于中点对称的点列：沿 x 轴等距六个点，y 为极小弧形隆起 eps·f(x)。
 * noise 为操作者版本之间的微扰。该退化构型下旋转与镜像拟合并列最优。
 */
function arcPoints(eps: number, noise: number): Point[] {
  const cx = 24;
  const cy = 8;
  const offsets = [-20, -12, -4, 4, 12, 20];
  return offsets.map((ox, i) => ({
    x: cx + ox + noise * 10 * ((i % 3) - 1),
    y: cy + eps * ((ox * ox) / 400 - 1) + noise * 10 * ((i % 2) - 0.5)
  }));
}


export const FIXTURE_SAMPLES: FixtureSample[] = [
  {
    id: 'S1-A-left',
    name: 'A 号标本 · 左翅',
    side: 'L',
    localizations: [
      {
        operator: '形态组-甲',
        version: 1,
        side: 'L',
        points: leftBase,
        confirmed: allConfirmed
      },
      {
        operator: '形态组-乙',
        version: 2,
        side: 'L',
        points: jittered(leftBase, (i) => [0.35 * (i - 2), -0.2 * (i % 2)]),
        // 第 3 点（index 2）对应尚未确认：用户可在页面上确认/否认。
        confirmed: [true, true, false, true, true, true]
      },
      {
        operator: '形态组-丙',
        version: 3,
        side: 'L',
        points: jittered(leftBase, (i) => [-0.18 * (i % 3), 0.22 * ((i + 1) % 2)]),
        confirmed: allConfirmed
      }
    ]
  },
  {
    id: 'S2-B-right',
    name: 'B 号标本 · 右翅',
    side: 'R',
    localizations: [
      {
        operator: '形态组-甲',
        version: 1,
        side: 'R',
        points: rightBase,
        confirmed: allConfirmed
      },
      {
        operator: '形态组-乙',
        version: 2,
        side: 'R',
        points: jittered(rightBase, (i) => [0.3 * ((i + 1) % 2) - 0.12, 0.28 * (i % 2) - 0.1]),
        confirmed: allConfirmed
      }
    ]
  },
  {
    id: 'S3-C-symmetric-left',
    name: 'C 号标本 · 近完全对称左翅',
    side: 'L',
    localizations: [
      {
        operator: '形态组-甲',
        version: 1,
        side: 'L',
        // 近完全对称的退化标本：六个翅脉交点近似排在一条微弯弧线（轴脉）上，
        // 且点列关于中点近似镜像对称。此时 det=-1 的镜像变换与 det=+1 的
        // 旋转拟合达到同一最优（差距 < 1e-6），最优旋转并列、不可唯一识别。
        points: arcPoints(1e-8, 0),
        confirmed: allConfirmed
      },
      {
        operator: '形态组-乙',
        version: 2,
        side: 'L',
        // 1e-6 量级操作者间扰动：仍近完全对称，稳定报告并列最优旋转。
        points: arcPoints(1e-8, 1e-6),
        confirmed: allConfirmed
      }
    ]
  },
  {
    id: 'S4-D-missing-right',
    name: 'D 号标本 · 右翅（缺一个点）',
    side: 'R',
    localizations: [
      {
        operator: '形态组-甲',
        version: 1,
        side: 'R',
        points: withMissing(rightBase, 4), // 中脉中点保留为缺失，不自动插值
        confirmed: [true, true, true, true, true, true]
      },
      {
        operator: '形态组-乙',
        version: 2,
        side: 'R',
        points: withMissing(
          jittered(rightBase, (i) => [0.2 * (i - 1), -0.15 * (i % 2)]),
          4
        ),
        confirmed: allConfirmed
      }
    ]
  },
  {
    id: 'S5-E-sparse-left',
    name: 'E 号标本 · 左翅（仅两点，不可识别）',
    side: 'L',
    localizations: [
      {
        operator: '形态组-丙',
        version: 1,
        side: 'L',
        // 只有 2 个可识别点 < minPoints(3)：不进入共识形状，但原始版本完整保留。
        points: [pt(1, 1), null, null, null, pt(29, 13), null],
        confirmed: [true, true, true, true, true, true]
      }
    ]
  }
];
