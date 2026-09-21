import type { AmbiguityReport, Point } from './types.js';

/**
 * 相对容差：归一化（质心零、单位尺度）之后，低于该 RMS 差距即视为并列最优。
 * 近完全对称样本的非对称噪声小于该尺度，从而被报告为“非唯一”。
 */
export const TIE_REL_TOL = 1e-6;

export interface Vec2 {
  x: number;
  y: number;
}

export function isPresent(p: Point | undefined): p is Vec2 {
  return p != null && Number.isFinite(p.x) && Number.isFinite(p.y);
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(p: Vec2, k: number): Vec2 {
  return { x: p.x * k, y: p.y * k };
}

export function rot(p: Vec2, theta: number): Vec2 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y };
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** 把角度规范到 [-PI, PI)。 */
export function wrapAngle(theta: number): number {
  let t = theta % (2 * Math.PI);
  if (t >= Math.PI) t -= 2 * Math.PI;
  if (t < -Math.PI) t += 2 * Math.PI;
  return t;
}

/**
 * 显式镜像：绕“过质心的纵轴（y 轴）”翻转 x。
 * 只用于用户明确开启 mirrorRight 的右翅样本；缺失点保持缺失，绝不插值。
 */
export function mirrorShapeExplicit(shape: Point[]): Point[] {
  const present = shape.filter(isPresent) as Vec2[];
  if (present.length === 0) return shape.map(() => null);
  const cx = present.reduce((s, p) => s + p.x, 0) / present.length;
  return shape.map((p) => (isPresent(p) ? { x: 2 * cx - p.x, y: p.y } : null));
}

export interface Mat2 {
  a: number;
  b: number;
  c: number;
  d: number;
}

function det2(m: Mat2): number {
  return m.a * m.d - m.b * m.c;
}

/**
 * 仅允许平移 + 各向同性缩放 + 旋转（det = +1）的二维 Procrustes。
 *
 * 对齐目标/源在交点 index 上一一对应；任何一方缺失的点不参与拟合
 * （源中存在但目标缺失的点仍按同一变换显示，残差不计）。
 *
 * 非唯一性检测（数值、稳定、可报告）：
 *  - 最优旋转角由 tr(R(θ)H) 的解析极大值给出（二维无需 SVD）；
 *  - 同时计算“最优反射（det = -1）”拟合成本；
 *  - 若负行列式拟合同样好 => reflection_rotation_tie：
 *    对称形状下旋转/反射等价，但系统绝不偷偷采用反射，只报告并列；
 *  - 若正交方向信息量整体消失（近似各向同性）=> isotropic：
 *    所有旋转等价。
 * 稳定显示规则：并列时统一选取绝对转角最小者；绝对值相同取非负。
 */
export function procrustesAlign(
  source: Point[],
  target: Point[],
  opts: { mirrored: boolean; mask?: boolean[] } = { mirrored: false }
): {
  aligned: Point[];
  rotation: number;
  scale: number;
  tx: number;
  ty: number;
  rmsResidual: number;
  ambiguity: AmbiguityReport;
} {
  const n = Math.min(source.length, target.length);
  const paired: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = source[i];
    const t = target[i];
    const allowed = opts.mask ? opts.mask[i] !== false : true;
    if (allowed && isPresent(s) && isPresent(t)) paired.push(i);
  }

  const k = paired.length;
  if (k === 0) {
    return {
      aligned: source.map(() => null),
      rotation: 0,
      scale: 1,
      tx: 0,
      ty: 0,
      rmsResidual: Number.NaN,
      ambiguity: {
        kind: 'isotropic',
        message: '没有可配对的点，旋转无法识别；按稳定规则显示为 0。',
        candidateAngles: [0],
        chosenAngle: 0,
        relativeGap: 1,
        usedDeterminant: 1
      }
    };
  }

  const centroidOf = (pts: Vec2[]): Vec2 => ({
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length
  });

  const srcPts = paired.map((i) => source[i] as Vec2);
  const tgtPts = paired.map((i) => target[i] as Vec2);
  const cs = centroidOf(srcPts);
  const ct = centroidOf(tgtPts);

  const z = srcPts.map((p) => sub(p, cs));
  const x = tgtPts.map((p) => sub(p, ct));
  const sz = Math.sqrt(z.reduce((s, p) => s + p.x * p.x + p.y * p.y, 0));
  const nx = Math.sqrt(x.reduce((s, p) => s + p.x * p.x + p.y * p.y, 0));

  if (sz === 0 || nx === 0) {
    return {
      aligned: source.map((p) => (isPresent(p) ? add(ct, sub(p, cs)) : null)),
      rotation: 0,
      scale: 0,
      tx: ct.x - cs.x,
      ty: ct.y - cs.y,
      rmsResidual: nx / Math.sqrt(k),
      ambiguity: {
        kind: 'isotropic',
        message: '点云尺度退化为零，旋转不可识别；按稳定规则显示为 0。',
        candidateAngles: [0],
        chosenAngle: 0,
        relativeGap: 1,
        usedDeterminant: 1
      }
    };
  }

  const Z = z.map((p) => scale(p, 1 / sz));
  const X = x.map((p) => scale(p, 1 / nx));

  // H = Z^T X （单位归一化点云）
  let h00 = 0;
  let h01 = 0;
  let h10 = 0;
  let h11 = 0;
  for (let i = 0; i < k; i++) {
    const zz = Z[i] as Vec2;
    const xx = X[i] as Vec2;
    h00 += zz.x * xx.x;
    h01 += zz.x * xx.y;
    h10 += zz.y * xx.x;
    h11 += zz.y * xx.y;
  }

  // 正规（旋转）拟合：tr(R(θ) H) = a cosθ + b sinθ
  // R(θ) = [[c,-s],[s,c]]
  const a = h00 + h11;
  const b = h10 - h01;
  const amp = Math.hypot(a, b);
  // tr(RH) = a cosθ − b sinθ，极大角满足 (cosθ,sinθ) = (a,−b)/amp
  const thetaP = wrapAngle(Math.atan2(-b, a));

  // 反射拟合：Q = R(θ) diag(1,-1) = [[c,-s],[-s,-c]]，det Q = -1
  // tr(Q H) = ar cosθ + br sinθ
  const ar = h00 - h11;
  const br = -(h10 + h01);
  const ampR = Math.hypot(ar, br);
  // tr(QH) = ar cosθ + br sinθ，极大角满足 (cosθ,sinθ) = (ar,br)/ampR
  const thetaR = wrapAngle(Math.atan2(br, ar));

  // 点云按总范数归一（Σ‖Z‖² = Σ‖X‖² = 1），完美拟合时 amp = 1。
  // 残余 ∈ [0,1]：0 = 该候选（旋转/反射）完全拟合；1 = 完全无关。
  const residualP = 1 - amp;
  const residualR = 1 - ampR;
  // det=+1 相对 det=-1 的残余拟合优势（正：旋转更好；≈0：并列）。
  const reflectionAdvantage = residualR - residualP;
  // ≈0 表示各向同性：连“自身恒等”都无法识别角度，任意旋转等价。
  const rotationalInformation = amp;
  // 源形状自身的几何退化度：中心化点云协方差阵的最小/最大特征值。
  // 各向同性 ≈1（任意旋转等价）；近共线 ≈0（旋转与镜像可并列）。
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const zz of Z) {
    sxx += zz.x * zz.x;
    syy += zz.y * zz.y;
    sxy += zz.x * zz.y;
  }
  const eigHi = (sxx + syy + Math.hypot(sxx - syy, 2 * sxy)) / 2;
  const eigLo = (sxx + syy - Math.hypot(sxx - syy, 2 * sxy)) / 2;
  const anisotropy = eigHi > 0 ? eigLo / eigHi : 0;
  const geometricallyDegenerate = anisotropy <= TIE_REL_TOL;

  const applyTheta = (theta: number): Point[] =>
    source.map((p) => {
      if (!isPresent(p)) return null;
      const v = scale(rot(sub(p, cs), theta), nx / sz);
      return { x: ct.x + v.x, y: ct.y + v.y };
    });

  let ambiguity: AmbiguityReport;

  if (rotationalInformation <= TIE_REL_TOL) {
    // 各向同性：任意正规旋转等价（连续不唯一）。
    const chosen = 0;
    ambiguity = {
      kind: 'isotropic',
      message:
        '形状近似各向同性，最优旋转连续不唯一；按稳定规则显示为转角 0，旋转不可识别。',
      candidateAngles: [chosen],
      chosenAngle: chosen,
      relativeGap: 0,
      usedDeterminant: det2({ a: 1, b: 0, c: 0, d: 1 })
    };
  } else if (geometricallyDegenerate && reflectionAdvantage <= TIE_REL_TOL) {
    // 近共线退化且两种变换并列最优；普通双侧近对称但非共线的翅形不会落入此分支。
    // 对称/共线退化：det -1 的镜像拟合与 det +1 的旋转拟合并列。
    // 稳定规则：候选转角按“绝对转角最小，平手取非负”排序，正规旋转优先采用。
    const candidates = [thetaP, thetaR]
      .map(wrapAngle)
      .sort((u, v) => Math.abs(u) - Math.abs(v) || (u > v ? -1 : 1));
    const chosen = candidates[0] as number;
    ambiguity = {
      kind: 'reflection_rotation_tie',
      message:
        '对称形状导致并列最优：一个负行列式（镜像）变换与正规旋转拟合同样好。' +
        '镜像必须显式启用，系统不采用 det = -1 的变换；' +
        `候选转角 ${candidates
          .map((t) => (t * 180) / Math.PI)
          .map((d) => `${d.toFixed(3)}°`)
          .join(' / ')}，按稳定规则采用 ${(
          (chosen * 180) /
          Math.PI
        ).toFixed(3)}°。`,
      candidateAngles: candidates,
      chosenAngle: chosen,
      relativeGap: reflectionAdvantage,
      usedDeterminant: 1
    };
  } else {
    const hint =
      residualR + TIE_REL_TOL < residualP
        ? ' 注意：镜像（det=-1）拟合明显更好，但镜像必须由用户显式启用，对齐仍只采用 det=+1 旋转。'
        : '';
    ambiguity = {
      kind: 'none',
      message: `最优旋转唯一。${hint}`,
      candidateAngles: [thetaP],
      chosenAngle: thetaP,
      relativeGap: reflectionAdvantage,
      usedDeterminant: 1
    };
  }

  const aligned = applyTheta(thetaP);
  let residualSum = 0;
  for (const i of paired) {
    residualSum += dist2(aligned[i] as Vec2, target[i] as Vec2);
  }

  return {
    aligned,
    rotation: thetaP,
    scale: nx / sz,
    tx: ct.x - nx / sz * (Math.cos(thetaP) * cs.x - Math.sin(thetaP) * cs.y),
    ty: ct.y - nx / sz * (Math.sin(thetaP) * cs.x + Math.cos(thetaP) * cs.y),
    rmsResidual: Math.sqrt(residualSum / k),
    ambiguity
  };
}

/** det = +1 校验：用于断言对齐矩阵从未被反射污染。 */
export function rotationDet(theta: number): number {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return det2({ a: c, b: -s, c: s, d: c });
}
