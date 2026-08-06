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
import type { CadDocument, EntityRef, FeatureId, LineRef, PointRef, SketchConstraint, SketchEntity, SketchSegment } from "../model/types";
import { polygonEdgePointsWithOffset, rectangleEdgePointsAtCenter, resolveLineRefPoints } from "./entityEdges";

export type Point2 = [number, number];

/** circleエンティティのみを抜き出す型ガード(solverの変数対象、Phase 22)。 */
type CircleEntity = Extract<SketchEntity, { kind: "circle" }>;

/**
 * ソルバの変数として動かせるエンティティ種別(矩形・多角形をソルバで動かせるようにする改善)。
 * circle/rectangle/regularPolygonは中心(cx,cy)を、polygon/slotは剛体並進オフセット(dx,dy、
 * 全頂点/始終点が一緒に動く。頂点間の相対位置=コーナーのフィレット形状は保たれる)を2変数として持つ。
 * 回転・変形(頂点ごとの独立移動)は変数にしない(v1、既知の制限)。
 */
type MovableEntity = Extract<SketchEntity, { kind: "circle" | "rectangle" | "polygon" | "regularPolygon" | "slot" }>;

function isMovableEntity(entity: SketchEntity): entity is MovableEntity {
  return (
    entity.kind === "circle" ||
    entity.kind === "rectangle" ||
    entity.kind === "polygon" ||
    entity.kind === "regularPolygon" ||
    entity.kind === "slot"
  );
}

/** 収束判定: 全残差(拘束+正則化)のノルムがこれを下回れば打ち切る。 */
const CONVERGE_NORM = 1e-8;
/** LMの最大反復回数。 */
const MAX_ITERATIONS = 50;
/** 収束後、拘束由来の残差(正則化を除く)の絶対値最大がこれを超えていれば「矛盾(過拘束)」とみなす(mm)。 */
const CONFLICT_TOLERANCE = 1e-4;
/**
 * 早期リターン判定の許容値(mm、累積ドリフト対策)。solveSketch()の入口で拘束残差の絶対値最大が
 * これを下回っていれば、ウォームアップ+LM反復を一切行わず入力segments/entitiesをそのまま返す。
 * 「拘束は既に満たされているのに、正則化ウォームアップの数値誤差でわずかに動いてしまい、
 * ドキュメント更新のたびに座標が少しずつずれていく」問題(円中心 -10 が編集の度に -9.99999999888
 * のようにドリフトする)への対策。CONVERGE_NORM(LMの収束先の残差スケール、~1e-8)より一桁大きく、
 * かつ後述のROUND_GRIDでの丸め誤差(最大でも各成分5e-7mm程度)を安定して吸収できる値として1e-7を選ぶ。
 */
const EARLY_RETURN_TOLERANCE = 1e-7;
/**
 * 解いた座標を丸めるグリッド幅(mm)。浮動小数点演算の丸め誤差でLMの解が「きれいな値」から
 * ごくわずかにずれるのを吸収し、次回solveSketch()呼び出し時にEARLY_RETURN_TOLERANCE判定が
 * 安定して成立するようにする(=同じドキュメントを再solveしても座標が完全に不変になる)。
 * 1e-6mmはCAD用途の実務精度(表示は小数3桁=1e-3mm)に対して十分小さく、丸めによる残差の増加も
 * 高々グリッド幅程度(数百分の1のCONFLICT_TOLERANCE)に収まるため、矛盾判定を悪化させない。
 */
const ROUND_GRID = 1e-6;
/** 正則化(初期位置からの移動量)の重み。小さいほど拘束を優先し、大きいほど元形状を保つ。 */
const REGULARIZATION_WEIGHT = 1e-3;
/** 長さ・半径残差の分母に使う距離が退化(0近傍)するのを防ぐ下限(mm)。 */
const MIN_SAFE_LENGTH = 1e-9;
/** LMの減衰係数の初期値・上限。 */
const INITIAL_LAMBDA = 1e-3;
const MAX_LAMBDA = 1e12;

/**
 * ソルバの成功結果。segmentsは入力と同じ順序・同じid・kind・bulgeを保ち、p1/p2のみ更新される。
 * entities(Phase 22)は入力と同じ順序・同じ内容を保つが、circleエンティティのcenterのみ
 * 解いた座標に更新される(circle以外・非circleフィールドは素通し)。呼び出し側がentitiesを
 * 渡さなかった場合は空配列を返す。
 */
export interface SolveSuccess {
  ok: true;
  segments: SketchSegment[];
  entities: SketchEntity[];
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
/** circleエンティティid -> 変数ベースインデックス(cx=base, cy=base+1、Phase 22)。 */
type EntityVarIndexMap = Map<string, number>;

function pointVarIndex(varIndex: VarIndexMap, ref: PointRef): [number, number] | null {
  const base = varIndex.get(ref.segmentId);
  if (base === undefined) return null;
  const offset = ref.end === "p1" ? 0 : 2;
  return [base + offset, base + offset + 1];
}

function entityVarIndex(entityVarIdx: EntityVarIndexMap, ref: EntityRef): [number, number] | null {
  const base = entityVarIdx.get(ref.entityId);
  if (base === undefined) return null;
  return [base, base + 1];
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
 * 2点間の距離のうち、片方の軸成分のみを対象にした残差式(distanceEntityEntityのaxis:"x"/"y"、
 * UI改善対応)。絶対値の符号は残差評価のたび現在のx(引数)から都度決め直す(2点とも可変なので
 * pointToFixedLineResidualのような固定sign化はできないが、通常は拘束値が正でありb側がa側より
 * 大きい/小さいの向きが反復中に反転することは稀なため、この単純な実装で十分収束する)。
 * axisIndex 0=x, 1=y。
 */
function axisDistanceResidual(
  x: number[],
  aIdx: [number, number],
  bIdx: [number, number],
  value: number,
  axisIndex: 0 | 1,
): ResidualEq {
  const ai = aIdx[axisIndex];
  const bi = bIdx[axisIndex];
  const d = x[bi] - x[ai];
  const sign = d >= 0 ? 1 : -1;
  return {
    value: sign * d - value,
    terms: [
      { index: ai, coef: -sign },
      { index: bi, coef: sign },
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

/**
 * 可変点(idx)から固定点(fixed、動かない相手。原点など)への距離残差(Phase 22)。
 * lengthLikeResidual の a を「固定値」に置き換えた版(固定側は変数を持たないので偏微分項も無い)。
 */
function pointToFixedDistanceResidual(x: number[], idx: [number, number], fixed: Point2, value: number): ResidualEq {
  const ax = x[idx[0]];
  const ay = x[idx[1]];
  const dx = ax - fixed[0];
  const dy = ay - fixed[1];
  const len = Math.hypot(dx, dy);
  const safeLen = Math.max(len, MIN_SAFE_LENGTH);
  const k = 1 / safeLen;
  return {
    value: len - value,
    terms: [
      { index: idx[0], coef: k * dx },
      { index: idx[1], coef: k * dy },
    ],
  };
}

/**
 * 可変点(idx)から固定直線(a,bを通る無限直線、動かない)への符号付き垂直距離残差(Phase 22)。
 * sign は解く前(初期位置)にどちら側にあったかで決め、反復中は固定する(距離0をまたいで
 * 符号が反転すると微分不連続になり収束が不安定になるため。src/sketch/positionDimensions.tsの
 * moveCenterToLineDistance()が採用する「現在の側を保つ」考え方と同じ)。
 */
function pointToFixedLineResidual(
  x: number[],
  idx: [number, number],
  a: Point2,
  b: Point2,
  value: number,
  sign: number,
): ResidualEq {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lineLen = Math.hypot(dx, dy);
  const safeLen = Math.max(lineLen, MIN_SAFE_LENGTH);
  const px = x[idx[0]];
  const py = x[idx[1]];
  const cross = (px - a[0]) * dy - (py - a[1]) * dx;
  const k = sign / safeLen;
  return {
    value: k * cross - value,
    terms: [
      { index: idx[0], coef: k * dy },
      { index: idx[1], coef: -k * dx },
    ],
  };
}

/** pointToFixedLineResidual()のsignを初期位置(initX)から決める。直線上(距離0近傍)なら+1をデフォルトにする。 */
function lineSideSign(initX: number[], idx: [number, number], a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cross = (initX[idx[0]] - a[0]) * dy - (initX[idx[1]] - a[1]) * dx;
  return cross < 0 ? -1 : 1;
}

/**
 * LineRefを、entities配列の元の形状ではなく「ソルバの現在の変数値x」から解決する
 * (矩形・多角形をソルバで動かせるようにする改善)。rectangle/regularPolygonはentityVarIdxに
 * 積んだ中心(cx,cy)、polygonは並進オフセット(dx,dy)を使って辺の座標を組み立てる。
 * segmentEdge(自由な線分)はvarIndexに積んだ両端点(p1,p2)そのものを使う(ユーザー報告対応:
 * 矩形を線分チェーンとして描いた場合にdistanceEntityLineが常にrefEdge[固定]扱いされていた
 * バグの修正。線分の端点は元々ソルバの変数なので、rectangle/polygonの辺と同様に動かせる)。
 * refEdge(ボディ端面参照のスナップショット)は常に固定座標のままなのでvarsを見ない。
 * entityVarIdx/varIndexに載っていないentity/segment(=このソルバ呼び出しの対象外)は
 * 元のentities側の値を使う(通常は起きないが、防御的なフォールバック)。
 */
function resolveLineRefPointsFromVars(
  line: LineRef,
  entities: readonly SketchEntity[],
  entityVarIdx: EntityVarIndexMap,
  varIndex: VarIndexMap,
  x: number[],
): [Point2, Point2] | null {
  if (line.kind === "refEdge") return [line.p1, line.p2];
  if (line.kind === "segmentEdge") {
    const base = varIndex.get(line.segmentId);
    if (base === undefined) return null;
    return [
      [x[base], x[base + 1]],
      [x[base + 2], x[base + 3]],
    ];
  }
  const entity = entities.find((e) => e.id === line.entityId);
  if (!entity) return null;
  const base = entityVarIdx.get(entity.id);
  if (entity.kind === "rectangle") {
    const center: Point2 = base !== undefined ? [x[base], x[base + 1]] : entity.center;
    return rectangleEdgePointsAtCenter(center, entity.width, entity.height, line.edgeIndex);
  }
  if (entity.kind === "polygon") {
    const offset: Point2 = base !== undefined ? [x[base], x[base + 1]] : [0, 0];
    return polygonEdgePointsWithOffset(entity.points, offset, line.edgeIndex);
  }
  return null;
}

/**
 * circleエンティティの中心↔辺(LineRef)の符号付き垂直距離(distanceEntityLine拘束の残差値)。
 * lineの辺は「今の変数値」から解決する(resolveLineRefPointsFromVars)ため、entity側(円)だけで
 * なくline側(rectangle/polygonの辺、または自由な線分)が変数として動いてもこの値は正しく追従する。
 * 解析的な偏微分の導出はentity+line両方が可変になったことで煩雑なため、tangent/distanceLineLine
 * と同じくnumericResidual(中心差分)でヤコビアンを近似する(value自体は厳密値)。
 */
function distanceEntityLineValue(
  x: number[],
  idx: [number, number],
  line: LineRef,
  entities: readonly SketchEntity[],
  entityVarIdx: EntityVarIndexMap,
  varIndex: VarIndexMap,
  sign: number,
): number {
  const pts = resolveLineRefPointsFromVars(line, entities, entityVarIdx, varIndex, x);
  if (!pts) return 0;
  const [a, b] = pts;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.max(Math.hypot(dx, dy), MIN_SAFE_LENGTH);
  const px = x[idx[0]];
  const py = x[idx[1]];
  const cross = (px - a[0]) * dy - (py - a[1]) * dx;
  return (sign * cross) / len;
}

/**
 * 中心差の座標そのものを2残差(x,y)として返す(coincidentと同じ形。concentric拘束、Phase 23)。
 */
function centerCoincidentResiduals(aIdx: [number, number], bIdx: [number, number], x: number[]): ResidualEq[] {
  return [
    {
      value: x[aIdx[0]] - x[bIdx[0]],
      terms: [
        { index: aIdx[0], coef: 1 },
        { index: bIdx[0], coef: -1 },
      ],
    },
    {
      value: x[aIdx[1]] - x[bIdx[1]],
      terms: [
        { index: aIdx[1], coef: 1 },
        { index: bIdx[1], coef: -1 },
      ],
    },
  ];
}

/**
 * 中心差分方式の垂直微分ステップ(mm)。座標の典型スケール(mm、通常1〜数百)に対して十分小さく、
 * かつ浮動小数点の丸め誤差に埋もれない大きさ。
 */
const NUMERIC_DIFF_H = 1e-6;

/**
 * 解析的な偏微分の導出が煩雑な残差(perpendicular・tangent[circle-line])向けの、
 * 中心差分によるヤコビアン近似ヘルパー(仕様上、この2種はソルバのコメントの原則
 * 「ヤコビアンは解析的に求める」の明示的な例外として数値微分を許可されている。
 * value自体は厳密値のまま渡すため、LMの収束判定・矛盾判定[CONFLICT_TOLERANCE]には影響しない。
 * 勾配の近似誤差は探索方向にのみ影響し、実用上の収束性・精度は十分[中心差分はO(h^2)]。
 */
function numericResidual(computeValue: (vars: number[]) => number, x: number[], varIndices: number[]): ResidualEq {
  const value = computeValue(x);
  const terms: ResidualTerm[] = varIndices.map((idx) => {
    const plus = x.slice();
    plus[idx] += NUMERIC_DIFF_H;
    const minus = x.slice();
    minus[idx] -= NUMERIC_DIFF_H;
    const coef = (computeValue(plus) - computeValue(minus)) / (2 * NUMERIC_DIFF_H);
    return { index: idx, coef };
  });
  return { value, terms };
}

/** 2本の直線の方向ベクトルの正規化内積(perpendicular拘束、Phase 23)。目標値は0(=垂直)。 */
function perpendicularValue(x: number[], aBase: number, bBase: number): number {
  const dax = x[aBase + 2] - x[aBase];
  const day = x[aBase + 3] - x[aBase + 1];
  const dbx = x[bBase + 2] - x[bBase];
  const dby = x[bBase + 3] - x[bBase + 1];
  const la = Math.max(Math.hypot(dax, day), MIN_SAFE_LENGTH);
  const lb = Math.max(Math.hypot(dbx, dby), MIN_SAFE_LENGTH);
  return (dax * dbx + day * dby) / (la * lb);
}

/** circleの中心から直線セグメント(無限直線扱い)への符号付き距離 − 半径(tangent拘束、Phase 23)。 */
function tangentLineValue(x: number[], centerIdx: [number, number], lineBase: number, radius: number, sign: number): number {
  const ax = x[lineBase];
  const ay = x[lineBase + 1];
  const bx = x[lineBase + 2];
  const by = x[lineBase + 3];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(Math.hypot(dx, dy), MIN_SAFE_LENGTH);
  const px = x[centerIdx[0]];
  const py = x[centerIdx[1]];
  const cross = (px - ax) * dy - (py - ay) * dx;
  return (sign * cross) / len - radius;
}

/**
 * 点(pointIdx、変数)から直線セグメント(lineBase、両端点とも変数)への符号付き垂直距離 − value
 * (distanceLineLine拘束、Phase 24)。tangentLineValueと同形だが、対象が円の半径ではなく
 * 平行距離拘束のvalueである点のみが異なる(circleの中心↔線分は片方だけ変数、こちらは
 * 点・線分ともに変数という違いはあるが、cross/len自体の式は共通のため関数は共有できる)。
 */
function pointToVariableLineDistanceValue(
  x: number[],
  pointIdx: [number, number],
  lineBase: number,
  value: number,
  sign: number,
): number {
  return tangentLineValue(x, pointIdx, lineBase, value, sign);
}

/**
 * 2本の直線(方向ベクトル)のなす角(度、0〜180)。atan2(|cross|, dot)を使うことで
 * 直線に向きの区別が無いことを反映する(方向を反転しても同じ角度になる)。
 * 数値微分(numericResidual)前提の値なので、角度の折り返し境界(0度・180度ぴったり)付近の
 * 微分不連続は実用上は初期形状からの小さな反復では問題にならない(既知の制限)。
 */
function angleLineLineValueDeg(x: number[], aBase: number, bBase: number): number {
  const dax = x[aBase + 2] - x[aBase];
  const day = x[aBase + 3] - x[aBase + 1];
  const dbx = x[bBase + 2] - x[bBase];
  const dby = x[bBase + 3] - x[bBase + 1];
  const cross = dax * dby - day * dbx;
  const dot = dax * dbx + day * dby;
  return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
}

/**
 * 直線セグメント(aBase、変数)↔固定線(bDx/bDy、方向ベクトル定数)のなす角(度、0〜180)。
 * angleLineLineValueDegと同形だが、b側が変数でなく固定の方向ベクトルである点のみが異なる
 * (angleLineRefEdge拘束、Phase 24)。
 */
function angleLineFixedValueDeg(x: number[], aBase: number, bDx: number, bDy: number): number {
  const dax = x[aBase + 2] - x[aBase];
  const day = x[aBase + 3] - x[aBase + 1];
  const cross = dax * bDy - day * bDx;
  const dot = dax * bDx + day * bDy;
  return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
}

/** 拘束由来の残差式一覧を作る(正則化は含まない)。参照先セグメントが見つからない拘束は無視する(呼び出し側でバリデーション済みの前提)。 */
function buildConstraintResiduals(
  constraints: readonly SketchConstraint[],
  segments: readonly SketchSegment[],
  segmentsById: Map<string, SketchSegment>,
  varIndex: VarIndexMap,
  entityVarIdx: EntityVarIndexMap,
  entities: readonly SketchEntity[],
  x: number[],
  initX: number[],
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
      case "fix":
      case "fixEntity": {
        // 値を持たない: solveSketch呼び出し時点の初期座標が目標値になる(buildFixResidualsが扱う)。
        break;
      }
      case "distanceEntityOrigin": {
        const idx = entityVarIndex(entityVarIdx, c.entity);
        if (!idx) break;
        eqs.push(pointToFixedDistanceResidual(x, idx, [0, 0], c.value));
        break;
      }
      case "distanceEntityEntity": {
        const a = entityVarIndex(entityVarIdx, c.a);
        const b = entityVarIndex(entityVarIdx, c.b);
        if (!a || !b) break;
        if (c.axis === "x") eqs.push(axisDistanceResidual(x, a, b, c.value, 0));
        else if (c.axis === "y") eqs.push(axisDistanceResidual(x, a, b, c.value, 1));
        else eqs.push(lengthLikeResidual(x, a, b, c.value));
        break;
      }
      case "distanceEntityLine": {
        // 矩形・多角形をソルバで動かせるようにする改善: lineがrectangle/polygonの辺(entityEdge)を
        // 参照している場合、その辺の座標もソルバの変数(entityVarIdx)から解決するため、円の中心
        // だけでなく辺(の親エンティティ)も拘束に応じて動く(例: 円を固定して距離を指定すると
        // 矩形側が並進する)。segmentEdge(自由な線分、ユーザー報告対応)も同様にvarIndexから解決し、
        // 線分の両端点そのものが動く。refEdge(ボディ端面参照)は常に固定なのでvarIndicesに追加しない。
        const idx = entityVarIndex(entityVarIdx, c.entity);
        if (!idx) break;
        const line0 = resolveLineRefPoints(c.line, entities, segments);
        if (!line0) break;
        const sign = lineSideSign(initX, idx, line0[0], line0[1]);
        const varIndices: number[] = [idx[0], idx[1]];
        if (c.line.kind === "entityEdge") {
          const lineBase = entityVarIdx.get(c.line.entityId);
          if (lineBase !== undefined) varIndices.push(lineBase, lineBase + 1);
        } else if (c.line.kind === "segmentEdge") {
          const lineBase = varIndex.get(c.line.segmentId);
          if (lineBase !== undefined) varIndices.push(lineBase, lineBase + 1, lineBase + 2, lineBase + 3);
        }
        eqs.push(
          numericResidual(
            (vars) => distanceEntityLineValue(vars, idx, c.line, entities, entityVarIdx, varIndex, sign) - c.value,
            x,
            varIndices,
          ),
        );
        break;
      }
      case "perpendicular": {
        const baseA = varIndex.get(c.a);
        const baseB = varIndex.get(c.b);
        if (baseA === undefined || baseB === undefined) break;
        eqs.push(
          numericResidual((vars) => perpendicularValue(vars, baseA, baseB), x, [
            baseA,
            baseA + 1,
            baseA + 2,
            baseA + 3,
            baseB,
            baseB + 1,
            baseB + 2,
            baseB + 3,
          ]),
        );
        break;
      }
      case "concentric": {
        const a = entityVarIndex(entityVarIdx, c.a);
        const b = entityVarIndex(entityVarIdx, c.b);
        if (!a || !b) break;
        eqs.push(...centerCoincidentResiduals(a, b, x));
        break;
      }
      case "tangent": {
        const idx = entityVarIndex(entityVarIdx, c.entity);
        if (!idx) break;
        const circle = entities.find((e): e is CircleEntity => e.kind === "circle" && e.id === c.entity.entityId);
        if (!circle) break;
        const target = c.target;
        if (target.kind === "segment") {
          const lineBase = varIndex.get(target.segmentId);
          if (lineBase === undefined) break;
          const a0: Point2 = [initX[lineBase], initX[lineBase + 1]];
          const b0: Point2 = [initX[lineBase + 2], initX[lineBase + 3]];
          const sign = lineSideSign(initX, idx, a0, b0);
          eqs.push(
            numericResidual((vars) => tangentLineValue(vars, idx, lineBase, circle.radius, sign), x, [
              idx[0],
              idx[1],
              lineBase,
              lineBase + 1,
              lineBase + 2,
              lineBase + 3,
            ]),
          );
        } else {
          const other = entities.find((e): e is CircleEntity => e.kind === "circle" && e.id === target.entityId);
          const bIdx = entityVarIndex(entityVarIdx, { entityId: target.entityId });
          if (!other || !bIdx) break;
          const value = target.mode === "internal" ? Math.abs(circle.radius - other.radius) : circle.radius + other.radius;
          eqs.push(lengthLikeResidual(x, idx, bIdx, value));
        }
        break;
      }
      case "distanceLineLine": {
        const baseA = varIndex.get(c.a);
        const baseB = varIndex.get(c.b);
        if (baseA === undefined || baseB === undefined) break;
        const lineA0: Point2 = [initX[baseB], initX[baseB + 1]];
        const lineB0: Point2 = [initX[baseB + 2], initX[baseB + 3]];
        const signP1 = lineSideSign(initX, [baseA, baseA + 1], lineA0, lineB0);
        const signP2 = lineSideSign(initX, [baseA + 2, baseA + 3], lineA0, lineB0);
        eqs.push(
          numericResidual(
            (vars) => pointToVariableLineDistanceValue(vars, [baseA, baseA + 1], baseB, c.value, signP1),
            x,
            [baseA, baseA + 1, baseB, baseB + 1, baseB + 2, baseB + 3],
          ),
        );
        eqs.push(
          numericResidual(
            (vars) => pointToVariableLineDistanceValue(vars, [baseA + 2, baseA + 3], baseB, c.value, signP2),
            x,
            [baseA + 2, baseA + 3, baseB, baseB + 1, baseB + 2, baseB + 3],
          ),
        );
        break;
      }
      case "angleLineLine": {
        const baseA = varIndex.get(c.a);
        const baseB = varIndex.get(c.b);
        if (baseA === undefined || baseB === undefined) break;
        eqs.push(
          numericResidual((vars) => angleLineLineValueDeg(vars, baseA, baseB) - c.value, x, [
            baseA,
            baseA + 1,
            baseA + 2,
            baseA + 3,
            baseB,
            baseB + 1,
            baseB + 2,
            baseB + 3,
          ]),
        );
        break;
      }
      case "distanceLineRefEdge": {
        const base = varIndex.get(c.segmentId);
        if (base === undefined) break;
        const line = resolveLineRefPoints(c.line, entities);
        if (!line) break;
        const signP1 = lineSideSign(initX, [base, base + 1], line[0], line[1]);
        const signP2 = lineSideSign(initX, [base + 2, base + 3], line[0], line[1]);
        eqs.push(pointToFixedLineResidual(x, [base, base + 1], line[0], line[1], c.value, signP1));
        eqs.push(pointToFixedLineResidual(x, [base + 2, base + 3], line[0], line[1], c.value, signP2));
        break;
      }
      case "angleLineRefEdge": {
        const base = varIndex.get(c.segmentId);
        if (base === undefined) break;
        const line = resolveLineRefPoints(c.line, entities);
        if (!line) break;
        const bDx = line[1][0] - line[0][0];
        const bDy = line[1][1] - line[0][1];
        eqs.push(
          numericResidual((vars) => angleLineFixedValueDeg(vars, base, bDx, bDy) - c.value, x, [
            base,
            base + 1,
            base + 2,
            base + 3,
          ]),
        );
        break;
      }
    }
  }

  return eqs;
}

/** fix/fixEntity拘束の残差式(目標値=初期座標)を作る。buildConstraintResidualsとは別関数にして初期値配列を明示的に渡す。 */
function buildFixResiduals(
  constraints: readonly SketchConstraint[],
  varIndex: VarIndexMap,
  entityVarIdx: EntityVarIndexMap,
  x: number[],
  initX: number[],
): ResidualEq[] {
  const eqs: ResidualEq[] = [];
  for (const c of constraints) {
    if (c.kind === "fix") {
      const p = pointVarIndex(varIndex, c.point);
      if (!p) continue;
      eqs.push({ value: x[p[0]] - initX[p[0]], terms: [{ index: p[0], coef: 1 }] });
      eqs.push({ value: x[p[1]] - initX[p[1]], terms: [{ index: p[1], coef: 1 }] });
    } else if (c.kind === "fixEntity") {
      const idx = entityVarIndex(entityVarIdx, c.entity);
      if (!idx) continue;
      eqs.push({ value: x[idx[0]] - initX[idx[0]], terms: [{ index: idx[0], coef: 1 }] });
      eqs.push({ value: x[idx[1]] - initX[idx[1]], terms: [{ index: idx[1], coef: 1 }] });
    }
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

/** 値をROUND_GRID(mm)グリッドに丸める(累積ドリフト対策、solveSketch()の出力座標に適用)。 */
function roundToGrid(v: number): number {
  return Math.round(v / ROUND_GRID) * ROUND_GRID;
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
 * 可動エンティティ(circle/rectangle/regularPolygon/polygon/slot)の座標を解いた変数値に置き換える
 * (それ以外はそのままコピー)。circle/rectangle/regularPolygonは中心(center)を変数値そのものに、
 * polygon/slotは並進オフセット(dx,dy)を元の頂点・始終点に加算する(コーナーのフィレット形状や
 * 各頂点の相対位置は変わらない)。
 */
function entitiesFromVars(entities: readonly SketchEntity[], x: number[], entityVarIdx: EntityVarIndexMap): SketchEntity[] {
  return entities.map((entity) => {
    const base = entityVarIdx.get(entity.id);
    if (base === undefined) return { ...entity };
    if (entity.kind === "circle" || entity.kind === "rectangle" || entity.kind === "regularPolygon") {
      const center: Point2 = [x[base], x[base + 1]];
      return { ...entity, center };
    }
    const dx = x[base];
    const dy = x[base + 1];
    if (dx === 0 && dy === 0) return { ...entity };
    if (entity.kind === "polygon") {
      const points: [number, number][] = entity.points.map((p) => [p[0] + dx, p[1] + dy]);
      return { ...entity, points };
    }
    if (entity.kind === "slot") {
      return {
        ...entity,
        start: [entity.start[0] + dx, entity.start[1] + dy] as [number, number],
        end: [entity.end[0] + dx, entity.end[1] + dy] as [number, number],
      };
    }
    return entity;
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
export function solveSketch(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[] = [],
  entities: readonly SketchEntity[] = [],
): SolveResult {
  // 矩形・多角形をソルバで動かせるようにする改善: circleに加えrectangle/polygon/regularPolygon/slotも
  // entityVarIdxに積む(2変数ずつ。circle/rectangle/regularPolygonは中心、polygon/slotは並進オフセット)。
  const movableEntities: MovableEntity[] = entities.filter(isMovableEntity);

  if (segments.length === 0 && movableEntities.length === 0) {
    return { ok: true, segments: [], entities: entities.map((e) => ({ ...e })) };
  }
  if (constraints.length === 0) {
    return { ok: true, segments: segments.map((s) => ({ ...s })), entities: entities.map((e) => ({ ...e })) };
  }

  const varIndex: VarIndexMap = new Map();
  segments.forEach((seg, i) => varIndex.set(seg.id, i * 4));
  const segmentsById = new Map(segments.map((s) => [s.id, s]));
  const segVarCount = segments.length * 4;

  const entityVarIdx: EntityVarIndexMap = new Map();
  movableEntities.forEach((e, i) => entityVarIdx.set(e.id, segVarCount + i * 2));
  const m = segVarCount + movableEntities.length * 2;

  const initX = new Array(m);
  segments.forEach((seg, i) => {
    initX[i * 4] = seg.p1[0];
    initX[i * 4 + 1] = seg.p1[1];
    initX[i * 4 + 2] = seg.p2[0];
    initX[i * 4 + 3] = seg.p2[1];
  });
  movableEntities.forEach((e, i) => {
    const base = segVarCount + i * 2;
    // 絶対中心(circle/rectangle/regularPolygon)は現在のcenterから、並進オフセット(polygon/slot)は
    // 0,0(=まだ動いていない)から始める。
    const init: Point2 = e.kind === "circle" || e.kind === "rectangle" || e.kind === "regularPolygon" ? e.center : [0, 0];
    initX[base] = init[0];
    initX[base + 1] = init[1];
  });

  const buildHardResiduals = (vars: number[]): ResidualEq[] => [
    ...buildConstraintResiduals(constraints, segments, segmentsById, varIndex, entityVarIdx, entities, vars, initX),
    ...buildFixResiduals(constraints, varIndex, entityVarIdx, vars, initX),
  ];

  // 累積ドリフト対策その1: 拘束が既に(許容誤差内で)満たされているなら、ウォームアップ+LM反復を
  // 一切行わず入力をそのまま返す。数値解法を経由すると収束先が理論値からごくわずかにずれることが
  // あり、それがドキュメント更新のたびに繰り返し適用されると座標が少しずつ動いてしまうため
  // (例: 円中心-10が編集の度に-9.99999999888のようにドリフトする)、「動かす必要が無いなら
  // 何も動かさない」を最優先する。
  const initResidualMaxAbs = buildHardResiduals(initX).reduce((acc, eq) => Math.max(acc, Math.abs(eq.value)), 0);
  if (initResidualMaxAbs < EARLY_RETURN_TOLERANCE) {
    return { ok: true, segments: segments.map((s) => ({ ...s })), entities: entities.map((e) => ({ ...e })) };
  }

  const buildWarmupResiduals = (vars: number[]): ResidualEq[] => [
    ...buildHardResiduals(vars),
    ...buildRegularizationResiduals(vars, initX, REGULARIZATION_WEIGHT),
  ];

  const warm = runLevenbergMarquardt(buildWarmupResiduals, initX, m, MAX_ITERATIONS);
  const solved = runLevenbergMarquardt(buildHardResiduals, warm, m, MAX_ITERATIONS);

  // 累積ドリフト対策その2: 出力座標をROUND_GRIDに丸める。次回solveSketch()が同じ形状で呼ばれたとき
  // (=何も編集していないのに再solveされたとき)、丸められた「きりのいい」座標が
  // EARLY_RETURN_TOLERANCE判定を安定して通過するようにする(=座標が完全に不変になる)。
  // 丸め幅(1e-6mm)はCONFLICT_TOLERANCE(1e-4mm)より2桁小さいため、丸めによって矛盾判定が
  // 悪化することはない。
  const x = solved.map(roundToGrid);

  const maxAbs = buildHardResiduals(x).reduce((acc, eq) => Math.max(acc, Math.abs(eq.value)), 0);

  if (maxAbs > CONFLICT_TOLERANCE) {
    return {
      ok: false,
      conflicting: true,
      message: `拘束が矛盾しています(残差 ${maxAbs.toFixed(4)}mm)`,
    };
  }

  return {
    ok: true,
    segments: segmentsFromVars(segments, x, varIndex),
    entities: entitiesFromVars(entities, x, entityVarIdx),
  };
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
    const result = solveSketch(feature.segments ?? [], feature.constraints, feature.entities);
    if (!result.ok) {
      conflict = { featureId: feature.id, message: "拘束が矛盾しています" };
      return feature;
    }
    return { ...feature, segments: result.segments, entities: result.entities };
  });

  if (conflict) {
    return { doc, conflict };
  }
  return { doc: { ...doc, features }, conflict: null };
}
