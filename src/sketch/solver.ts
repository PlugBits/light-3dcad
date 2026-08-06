// スケッチ拘束ソルバ(Phase 20a)。ReactにもThree.jsにもReplicad(OCCT)にも依存しない
// 純粋TypeScript(src/sketch/intersections.ts等と同じ方針)。寸法ドリブン編集(Phase 20b)の土台。
//
// 変数モデル: 全セグメントの両端点(p1・p2)の座標を独立変数として扱う(セグメント数N本なら
// 4N個のスカラー変数)。coincident拘束は端点を1つの変数にマージせず、常に残差(2点の座標差)として
// 表現する。これにより「どのセグメントがどの拘束を持つか」がsegments配列と1対1に保たれ、
// 実装・デバッグが単純になる(採用理由はdocs/PLAN.mdのPhase 20a節参照)。
//
// 解法: Levenberg-Marquardt法(自前実装、外部ライブラリ非依存)で残差二乗和を最小化する。
// ヤコビアンは各拘束の残差式から解析的に求める(数値微分はしない)。
// さらに「各変数の初期位置からの移動量」に弱い正則化(小さい重み)をかけた擬似残差を加えることで、
// 拘束が不足している(劣拘束)自由度については「入力形状に最も近い解」を選ぶ(SolidWorks等の
// スケッチソルバに倣った自然な挙動。無関係な点が意図せず動かないようにする効果もある)。
import type { CadDocument, FeatureId, PointRef, SketchConstraint, SketchSegment } from "../model/types";

export type Point2 = [number, number];

/** 収束判定: 全残差(拘束+正則化)のノルムがこれを下回れば打ち切る。 */
const CONVERGE_NORM = 1e-8;
/** LMの最大反復回数。 */
const MAX_ITERATIONS = 50;
/** 収束後、拘束由来の残差(正則化を除く)の絶対値最大がこれを超えていれば「矛盾(過拘束)」とみなす(mm)。 */
const CONFLICT_TOLERANCE = 1e-4;
/** 正則化(初期位置からの移動量)の重み。小さいほど拘束を優先し、大きいほど元形状を保つ。 */
const REGULARIZATION_WEIGHT = 1e-3;
/** 長さ・半径残差の分母に使う距離が退化(0近傍)するのを防ぐ下限(mm)。 */
const MIN_SAFE_LENGTH = 1e-9;
/** LMの減衰係数の初期値・上限。 */
const INITIAL_LAMBDA = 1e-3;
const MAX_LAMBDA = 1e12;

/** ソルバの成功結果。segmentsは入力と同じ順序・同じid・kind・bulgeを保ち、p1/p2のみ更新される。 */
export interface SolveSuccess {
  ok: true;
  segments: SketchSegment[];
}

/** ソルバの失敗結果。conflicting:trueは「拘束が矛盾(または過拘束)していて許容誤差内に収まらなかった」ことを表す。 */
export interface SolveFailure {
  ok: false;
  conflicting: boolean;
  message: string;
}

export type SolveResult = SolveSuccess | SolveFailure;

/** 1件の残差式: value(現在の残差値)と、変数インデックスごとの偏微分係数(疎な項のみ保持)。 */
interface ResidualTerm {
  index: number;
  coef: number;
}
interface ResidualEq {
  value: number;
  terms: ResidualTerm[];
}

/** セグメントid -> 変数ベースインデックス(x1=base, y1=base+1, x2=base+2, y2=base+3)。 */
type VarIndexMap = Map<string, number>;

function pointVarIndex(varIndex: VarIndexMap, ref: PointRef): [number, number] | null {
  const base = varIndex.get(ref.segmentId);
  if (base === undefined) return null;
  const offset = ref.end === "p1" ? 0 : 2;
  return [base + offset, base + offset + 1];
}

function lengthLikeResidual(
  x: number[],
  aIdx: [number, number],
  bIdx: [number, number],
  value: number,
  scale = 1,
): ResidualEq {
  const ax = x[aIdx[0]];
  const ay = x[aIdx[1]];
  const bx = x[bIdx[0]];
  const by = x[bIdx[1]];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  const safeLen = Math.max(len, MIN_SAFE_LENGTH);
  const k = scale / safeLen;
  return {
    value: scale * len - value,
    terms: [
      { index: aIdx[0], coef: -k * dx },
      { index: aIdx[1], coef: -k * dy },
      { index: bIdx[0], coef: k * dx },
      { index: bIdx[1], coef: k * dy },
    ],
  };
}

/**
 * radius拘束の残差式を作る。円弧のbulge(=tan(挟角/4))は固定値として扱い(端点移動では変えない)、
 * 挟角θ=4*atan(bulge)から半弦-半径比を求め、半径 = 弦長 / (2*sin(θ/2)) をvalueと比較する。
 * sin(θ/2)が0近傍(=ほぼ直線)の場合は数値的に不安定なため、符号を保った下限でクランプする。
 */
function radiusResidual(x: number[], base: number, value: number, bulge: number): ResidualEq {
  const theta = 4 * Math.atan(bulge);
  const sinHalf = Math.sin(theta / 2);
  const denom = 2 * sinHalf;
  const safeDenom = Math.abs(denom) < MIN_SAFE_LENGTH ? (denom >= 0 ? MIN_SAFE_LENGTH : -MIN_SAFE_LENGTH) : denom;
  const scale = 1 / safeDenom;
  return lengthLikeResidual(x, [base, base + 1], [base + 2, base + 3], value, scale);
}

/** 拘束由来の残差式一覧を作る(正則化は含まない)。参照先セグメントが見つからない拘束は無視する(呼び出し側でバリデーション済みの前提)。 */
function buildConstraintResiduals(
  constraints: readonly SketchConstraint[],
  segmentsById: Map<string, SketchSegment>,
  varIndex: VarIndexMap,
  x: number[],
): ResidualEq[] {
  const eqs: ResidualEq[] = [];

  for (const c of constraints) {
    switch (c.kind) {
      case "coincident": {
        const a = pointVarIndex(varIndex, c.a);
        const b = pointVarIndex(varIndex, c.b);
        if (!a || !b) break;
        eqs.push({
          value: x[a[0]] - x[b[0]],
          terms: [
            { index: a[0], coef: 1 },
            { index: b[0], coef: -1 },
          ],
        });
        eqs.push({
          value: x[a[1]] - x[b[1]],
          terms: [
            { index: a[1], coef: 1 },
            { index: b[1], coef: -1 },
          ],
        });
        break;
      }
      case "horizontal": {
        const base = varIndex.get(c.segmentId);
        if (base === undefined) break;
        const y1 = base + 1;
        const y2 = base + 3;
        eqs.push({
          value: x[y1] - x[y2],
          terms: [
            { index: y1, coef: 1 },
            { index: y2, coef: -1 },
          ],
        });
        break;
      }
      case "vertical": {
        const base = varIndex.get(c.segmentId);
        if (base === undefined) break;
        const x1 = base;
        const x2 = base + 2;
        eqs.push({
          value: x[x1] - x[x2],
          terms: [
            { index: x1, coef: 1 },
            { index: x2, coef: -1 },
          ],
        });
        break;
      }
      case "length": {
        const base = varIndex.get(c.segmentId);
        if (base === undefined) break;
        eqs.push(lengthLikeResidual(x, [base, base + 1], [base + 2, base + 3], c.value));
        break;
      }
      case "distance": {
        const a = pointVarIndex(varIndex, c.a);
        const b = pointVarIndex(varIndex, c.b);
        if (!a || !b) break;
        eqs.push(lengthLikeResidual(x, a, b, c.value));
        break;
      }
      case "radius": {
        const base = varIndex.get(c.segmentId);
        if (base === undefined) break;
        const segment = segmentsById.get(c.segmentId);
        if (!segment || segment.kind !== "arc" || !segment.bulge) break;
        eqs.push(radiusResidual(x, base, c.value, segment.bulge));
        break;
      }
      case "fix": {
        // fixは値を持たない: solveSketch呼び出し時点の初期座標が目標値になる(呼び出し元でinitXから生成)。
        break;
      }
    }
  }

  return eqs;
}

/** fix拘束の残差式(目標値=初期座標)を作る。buildConstraintResidualsとは別関数にして初期値配列を明示的に渡す。 */
function buildFixResiduals(constraints: readonly SketchConstraint[], varIndex: VarIndexMap, x: number[], initX: number[]): ResidualEq[] {
  const eqs: ResidualEq[] = [];
  for (const c of constraints) {
    if (c.kind !== "fix") continue;
    const p = pointVarIndex(varIndex, c.point);
    if (!p) continue;
    eqs.push({ value: x[p[0]] - initX[p[0]], terms: [{ index: p[0], coef: 1 }] });
    eqs.push({ value: x[p[1]] - initX[p[1]], terms: [{ index: p[1], coef: 1 }] });
  }
  return eqs;
}

/** 正則化残差(各変数について「初期位置からの移動量×sqrt(重み)」)を作る。 */
function buildRegularizationResiduals(x: number[], initX: number[], weight: number): ResidualEq[] {
  const sqrtWeight = Math.sqrt(weight);
  const eqs: ResidualEq[] = [];
  for (let k = 0; k < x.length; k += 1) {
    const diff = x[k] - initX[k];
    if (diff === 0) continue; // ゼロ項はJTJ/JTrに寄与しないため省略してよい(最適化)。
    eqs.push({ value: sqrtWeight * diff, terms: [{ index: k, coef: sqrtWeight }] });
  }
  return eqs;
}

function residualNorm(eqs: ResidualEq[]): number {
  let sum = 0;
  for (const eq of eqs) sum += eq.value * eq.value;
  return Math.sqrt(sum);
}

function residualCost(eqs: ResidualEq[]): number {
  let sum = 0;
  for (const eq of eqs) sum += eq.value * eq.value;
  return sum;
}

/** J^T*J(M×M)とJ^T*r(M)を疎な残差項から直接積み上げる(密行列だが各残差の非ゼロ項数は少数)。 */
function buildNormalEquations(eqs: ResidualEq[], m: number): { jtj: number[][]; jtr: number[] } {
  const jtj: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  const jtr: number[] = new Array(m).fill(0);
  for (const eq of eqs) {
    for (const t1 of eq.terms) {
      jtr[t1.index] += t1.coef * eq.value;
      for (const t2 of eq.terms) {
        jtj[t1.index][t2.index] += t1.coef * t2.coef;
      }
    }
  }
  return { jtj, jtr };
}

/** ガウスの消去法(部分ピボット選択)でAx=bを解く。特異(ピボットが0近傍)なら null。 */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m: number[][] = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let maxAbs = Math.abs(m[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(m[r][col]);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-14) return null;
    if (pivotRow !== col) {
      const tmp = m[col];
      m[col] = m[pivotRow];
      m[pivotRow] = tmp;
    }
    const pivotVal = m[col][col];
    for (let r = col + 1; r < n; r += 1) {
      const factor = m[r][col] / pivotVal;
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) {
        m[r][c] -= factor * m[col][c];
      }
    }
  }

  const result = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = m[i][n];
    for (let j = i + 1; j < n; j += 1) sum -= m[i][j] * result[j];
    const diag = m[i][i];
    if (Math.abs(diag) < 1e-14) return null;
    result[i] = sum / diag;
  }
  return result;
}

function segmentsFromVars(segments: readonly SketchSegment[], x: number[], varIndex: VarIndexMap): SketchSegment[] {
  return segments.map((seg) => {
    const base = varIndex.get(seg.id);
    if (base === undefined) return { ...seg };
    const p1: Point2 = [x[base], x[base + 1]];
    const p2: Point2 = [x[base + 2], x[base + 3]];
    return { ...seg, p1, p2 };
  });
}

/**
 * 与えられた残差ビルダーに対してLevenberg-Marquardt法を実行し、収束(または反復上限)した変数ベクトルを返す。
 * 減衰係数lambdaは各呼び出しでINITIAL_LAMBDAから開始する。
 * 各反復: 正規方程式(J^T*J + λ*diag(J^T*J))Δ = -J^T*r をガウス消去法で解き、コストが実際に下がる
 * 減衰係数が見つかるまでλを10倍ずつ増やす(見つかればλを1/10、Levenberg-Marquardtの標準的な更新則)。
 * コストを一度も下げられなかった反復で打ち切る(それ以上ここでは改善できない=収束or停滞)。
 */
function runLevenbergMarquardt(buildResiduals: (x: number[]) => ResidualEq[], x0: number[], m: number, maxIterations: number): number[] {
  let x = [...x0];
  let lambda = INITIAL_LAMBDA;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    const residuals = buildResiduals(x);
    if (residualNorm(residuals) < CONVERGE_NORM) break;

    const { jtj, jtr } = buildNormalEquations(residuals, m);
    const cost = residualCost(residuals);

    let improved = false;
    for (let attempt = 0; attempt < 20 && !improved; attempt += 1) {
      const damped = jtj.map((row, i) => row.map((v, j) => (i === j ? v + lambda * Math.max(v, 1e-6) : v)));
      const rhs = jtr.map((v) => -v);
      const delta = solveLinearSystem(damped, rhs);
      if (!delta) {
        lambda = Math.min(lambda * 10, MAX_LAMBDA);
        if (lambda >= MAX_LAMBDA) break;
        continue;
      }
      const xTry = x.map((v, i) => v + delta[i]);
      const costTry = residualCost(buildResiduals(xTry));
      if (costTry < cost) {
        x = xTry;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
      } else {
        lambda = Math.min(lambda * 10, MAX_LAMBDA);
        if (lambda >= MAX_LAMBDA) break;
      }
    }
    if (!improved) break;
  }

  return x;
}

/**
 * セグメント集合+拘束からLevenberg-Marquardt法で解を求める。2段階で解く:
 *
 * 1. 「暖機」段階: 拘束残差+正則化残差(初期位置からの移動量に弱い重みREGULARIZATION_WEIGHTを
 *    かけたもの)を合わせて最小化する。劣拘束(拘束だけでは解が一意に決まらない)自由度は、
 *    この段階で「入力形状に最も近い」方向に解が選ばれる。
 * 2. 「仕上げ」段階: 1で得た解を初期値に、今度は正則化を含めず拘束残差のみを最小化する。
 *    正則化はソフト制約として働くため、単独では拘束を厳密なゼロ残差まで追い込めない
 *    (正則化の重み×移動量の分だけ系統的なバイアスが残る。詳細は下記コメント参照)。
 *    仕上げ段階のNewton/Gauss-Newton補正は、暖機段階で選ばれた劣拘束方向(拘束のヤコビアンの
 *    零空間)にはほぼ寄与しない(その方向では拘束残差の勾配が0に近いため)ので、
 *    「劣拘束方向は暖機段階の解を維持したまま、拘束自体は正確に満たす」という設計意図を両立できる。
 *
 * - constraintsが空(または未指定)の場合は入力segmentsをそのまま返す(常にok:true、暖機/仕上げ段階は省略)。
 * - 拘束が参照するsegmentIdがsegments内に存在しない場合、その拘束の残差は無視する
 *   (呼び出し側が事前にsrc/model/validation.tsでバリデーション済みであることを前提とする防御的な扱い)。
 * - 収束後、拘束由来の残差(正則化を除く)の絶対値最大がCONFLICT_TOLERANCE(1e-4mm)を超えていれば
 *   矛盾(過拘束)とみなし ok:false, conflicting:true を返す。
 */
export function solveSketch(segments: readonly SketchSegment[], constraints: readonly SketchConstraint[] = []): SolveResult {
  if (segments.length === 0) {
    return { ok: true, segments: [] };
  }
  if (constraints.length === 0) {
    return { ok: true, segments: segments.map((s) => ({ ...s })) };
  }

  const varIndex: VarIndexMap = new Map();
  segments.forEach((seg, i) => varIndex.set(seg.id, i * 4));
  const segmentsById = new Map(segments.map((s) => [s.id, s]));
  const m = segments.length * 4;

  const initX = new Array(m);
  segments.forEach((seg, i) => {
    initX[i * 4] = seg.p1[0];
    initX[i * 4 + 1] = seg.p1[1];
    initX[i * 4 + 2] = seg.p2[0];
    initX[i * 4 + 3] = seg.p2[1];
  });

  const buildHardResiduals = (vars: number[]): ResidualEq[] => [
    ...buildConstraintResiduals(constraints, segmentsById, varIndex, vars),
    ...buildFixResiduals(constraints, varIndex, vars, initX),
  ];
  const buildWarmupResiduals = (vars: number[]): ResidualEq[] => [
    ...buildHardResiduals(vars),
    ...buildRegularizationResiduals(vars, initX, REGULARIZATION_WEIGHT),
  ];

  const warm = runLevenbergMarquardt(buildWarmupResiduals, initX, m, MAX_ITERATIONS);
  const x = runLevenbergMarquardt(buildHardResiduals, warm, m, MAX_ITERATIONS);

  const maxAbs = buildHardResiduals(x).reduce((acc, eq) => Math.max(acc, Math.abs(eq.value)), 0);

  if (maxAbs > CONFLICT_TOLERANCE) {
    return {
      ok: false,
      conflicting: true,
      message: `拘束が矛盾しています(残差 ${maxAbs.toFixed(4)}mm)`,
    };
  }

  return { ok: true, segments: segmentsFromVars(segments, x, varIndex) };
}

/** solveDocumentSketches()が矛盾を検出したときの詳細。 */
export interface SolveConflict {
  featureId: FeatureId;
  message: string;
}

export interface SolveDocumentResult {
  doc: CadDocument;
  conflict: SolveConflict | null;
}

/**
 * ドキュメント内の全sketchフィーチャーのうちconstraintsを持つものにsolveSketch()を適用し、
 * 解けたsegmentsで置き換えたドキュメントを返す(Phase 20a、src/state/store.tsのupdateDocumentから呼ぶ)。
 * いずれかのスケッチで矛盾(conflicting)が検出された場合、ドキュメントは変更せずそのまま返し、
 * conflictに最初に見つかったフィーチャーIDとメッセージを入れる(呼び出し側は評価をスキップして
 * featureId付きのエラーとして表示する想定)。
 */
export function solveDocumentSketches(doc: CadDocument): SolveDocumentResult {
  let conflict: SolveConflict | null = null;
  const features = doc.features.map((feature) => {
    if (conflict) return feature;
    if (feature.type !== "sketch" || !feature.constraints || feature.constraints.length === 0) return feature;
    const result = solveSketch(feature.segments ?? [], feature.constraints);
    if (!result.ok) {
      conflict = { featureId: feature.id, message: "拘束が矛盾しています" };
      return feature;
    }
    return { ...feature, segments: result.segments };
  });

  if (conflict) {
    return { doc, conflict };
  }
  return { doc: { ...doc, features }, conflict: null };
}
