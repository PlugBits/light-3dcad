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
import { constraintFullLabel } from "./constraintLabels";
import { polygonEdgePointsWithOffset, rectangleEdgePointsAtCenter, resolveLineRefPoints } from "./entityEdges";
// gcsAdapter.tsは実行時コストの大きいPlaneGCS(WASM)を静的importするため、solver.ts自体からは
// 型だけをimportし(erasedなのでバンドルに影響しない)、実体は呼び出し側(src/state/store.tsの
// initialize())が動的importで取得してregisterGcsAdapter()に渡す(メインバンドル増を数KBに抑える、
// Phase 35b-1)。Vitestはtests/sketch/solver.test.tsのbeforeAllで直接registerGcsAdapter()する。
import type * as GcsAdapterModule from "./gcsAdapter";

let gcsAdapter: typeof GcsAdapterModule | null = null;

/** src/state/store.tsのinitialize()、またはテストのbeforeAllから、動的importしたgcsAdapter.tsを登録する。 */
export function registerGcsAdapter(mod: typeof GcsAdapterModule): void {
  gcsAdapter = mod;
}

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
/**
 * LMの最大反復回数。50だと収束不足で誤って矛盾判定される既知の弱点があった(原点ピック常時有効化・
 * 原点=ワールド原点定義への変更[追加項目]の実機検証で発覚: distanceEntityOrigin/distancePointOriginは
 * 面上スケッチではoriginLocalが数十mm離れうるため、初期位置から目標円周までの移動量が大きい
 * 1点1残差の劣拘束問題[点→固定点への距離]でlambdaの縮小が早すぎて振動し、50回では収束しきらない
 * ケースがあった)。300に拡大しても、通常の(素早く収束する)ケースはCONVERGE_NORMで早期打ち切りされる
 * ため体感速度への影響は無く、真に矛盾する拘束はより多く反復しても残差が下がりきらないため
 * 矛盾判定の正しさ自体は変わらない(参考: tests/sketch/solver.test.tsの既存の矛盾検出テスト群)。
 */
const MAX_ITERATIONS = 300;
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
/**
 * ドラッグ目標(Phase 34、スケッチジオメトリのドラッグ編集)のソフト残差の重み。
 * 「掴んだ点(または対象の代表点)をカーソル位置へ近づけたい」という弱い希望を表す残差で、
 * 拘束(buildConstraintResiduals/buildFixResiduals、実質的な重み1)より弱く、正則化
 * (REGULARIZATION_WEIGHT=1e-3、形状をできるだけ変えたくない希望)より強くなるよう選ぶ
 * (1e-2〜1e-1の範囲で実験し、0.05を採用。REGULARIZATION_WEIGHTの50倍・拘束の1/20程度に
 * 収まるため、自由な要素はカーソルに大きく追従しつつ、拘束や他の要素の正則化を大きくは崩さない)。
 * finishing段階(hard残差のみ最小化)には加えない=ドラッグは常にソフトな希望のままで、
 * 拘束を厳密に満たす結果を妨げない(既存拘束はすべて維持、という設計要求どおり)。
 */
const DRAG_TARGET_WEIGHT = 0.05;
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

/**
 * スケッチジオメトリのドラッグ編集(Phase 34)の一時的なドラッグ目標。既存拘束はすべて維持したまま、
 * このターゲットに応じた弱いソフト残差(DRAG_TARGET_WEIGHT)を追加してsolveSketch()を解く
 * (呼び出し側=CadViewerが毎フレーム、カーソル位置に応じて新しいDragTargetを渡す想定)。
 *
 * どの種別も「デルタ(target - grabPoint)を、掴んだ対象の各変数へ初期値からの移動量として適用したい」
 * という同じ考え方(掴んだ点そのものがカーソル位置に一致するのではなく、掴んだ位置からの
 * 相対移動量をカーソル移動量に一致させる。ドラッグ開始位置がジオメトリ上の厳密な位置から
 * 多少ずれていても、ドラッグ開始時のオフセットを保ったまま追従する自然な挙動になる)。
 *
 * - kind:"point": 自由な線分(セグメント)の端点1つ(PointRef)を直接引っぱる(頂点ドラッグ)。
 *   一致拘束で他の端点と繋がっている場合はクラスタの代表点を渡すこと(呼び出し側の責務。
 *   src/sketch/pointClusters.tsのresolvePointClusterRepresentative()参照)。
 * - kind:"segment": セグメント本体をつかんだ場合。両端点(p1,p2)に同じデルタを適用し、
 *   セグメントを剛体的に動かす目標にする(既存拘束[horizontal/length等]がある分だけ実際の解は歪む)。
 * - kind:"entity": circle/rectangle/regularPolygon(中心)・polygon/slot(並進オフセット)の
 *   いずれかのエンティティ本体をつかんだ場合。中心または並進オフセット変数にデルタを適用する。
 */
export type DragTarget =
  | { kind: "point"; point: PointRef; grabPoint: Point2; target: Point2 }
  | { kind: "segment"; segmentId: string; grabPoint: Point2; target: Point2 }
  | { kind: "entity"; entityId: string; grabPoint: Point2; target: Point2 };

/** solveSketch()の追加オプション(Phase 34)。 */
export interface SolveOptions {
  /** 一時的なドラッグ目標(省略時は通常どおりの解法)。 */
  dragTarget?: DragTarget;
}

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
 * 2点間の距離のうち、片方の軸成分のみを対象にした残差式(distance/distanceEntityEntityの
 * axis:"x"/"y"、UI改善対応)。
 * signed=false(既定・旧データ、後方互換): 絶対値|b-a|-value。符号は残差評価のたび現在のx(引数)から
 * 都度決め直す(2点とも可変なのでpointToFixedLineResidualのような固定sign化はできないが、通常は
 * 拘束値が正でありb側がa側より大きい/小さいの向きが反復中に反転することは稀なため、この単純な実装で
 * 十分収束する)。
 * signed=true(寸法値の符号仕様の明確化、Phase 33、新規拘束のみ): 符号付き(b-a)-value。1点目(a)→
 * 2点目(b)のクリック順が符号の基準になり、value自体に符号(負も含む)・0(軸整列)を許容できる。
 * axisIndex 0=x, 1=y。
 */
function axisDistanceResidual(
  x: number[],
  aIdx: [number, number],
  bIdx: [number, number],
  value: number,
  axisIndex: 0 | 1,
  signed = false,
): ResidualEq {
  const ai = aIdx[axisIndex];
  const bi = bIdx[axisIndex];
  const d = x[bi] - x[ai];
  if (signed) {
    return {
      value: d - value,
      terms: [
        { index: ai, coef: -1 },
        { index: bi, coef: 1 },
      ],
    };
  }
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
 * 可変点(idx)から固定点(fixed)への距離のうち、片方の軸成分のみを対象にした残差式
 * (distance/distancePointOriginのaxis:"x"/"y"、頂点ベースの寸法指定、Phase 30)。
 * axisDistanceResidual(2点とも可変)の「片方が固定値」版。
 * signed=false(既定・旧データ、後方互換): 絶対値|point-fixed|-value。符号は現在のx(引数)から都度
 * 決め直す(axisDistanceResidualと同じ単純な実装で十分収束する、pointToFixedDistanceResidualと
 * 対になる関数)。
 * signed=true(Phase 33、新規拘束のみ): 符号付き(point-fixed)-value(fixed[=origin]を基準、pointが
 * 「2点目」)。
 * axisIndex 0=x, 1=y。
 */
function axisDistanceToFixedResidual(
  x: number[],
  idx: [number, number],
  fixed: Point2,
  value: number,
  axisIndex: 0 | 1,
  signed = false,
): ResidualEq {
  const ai = idx[axisIndex];
  const d = x[ai] - fixed[axisIndex];
  if (signed) {
    return {
      value: d - value,
      terms: [{ index: ai, coef: 1 }],
    };
  }
  const sign = d >= 0 ? 1 : -1;
  return {
    value: sign * d - value,
    terms: [{ index: ai, coef: sign }],
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
 * 可変点(idx)と固定点(fixed、動かない相手。原点等)の座標差そのものを2残差(x,y)として返す
 * (centerCoincidentResidualsの「片方が固定値」版。coincidentOrigin拘束、追加項目)。
 */
function pointToFixedCoincidentResiduals(idx: [number, number], fixed: Point2, x: number[]): ResidualEq[] {
  return [
    { value: x[idx[0]] - fixed[0], terms: [{ index: idx[0], coef: 1 }] },
    { value: x[idx[1]] - fixed[1], terms: [{ index: idx[1], coef: 1 }] },
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
        if (c.axis === "x") eqs.push(axisDistanceResidual(x, a, b, c.value, 0, c.signed === true));
        else if (c.axis === "y") eqs.push(axisDistanceResidual(x, a, b, c.value, 1, c.signed === true));
        else eqs.push(lengthLikeResidual(x, a, b, c.value));
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
        eqs.push(pointToFixedDistanceResidual(x, idx, c.originLocal ?? [0, 0], c.value));
        break;
      }
      case "distancePointOrigin": {
        const idx = pointVarIndex(varIndex, c.point);
        if (!idx) break;
        const origin = c.originLocal ?? [0, 0];
        if (c.axis === "x") eqs.push(axisDistanceToFixedResidual(x, idx, origin, c.value, 0, c.signed === true));
        else if (c.axis === "y") eqs.push(axisDistanceToFixedResidual(x, idx, origin, c.value, 1, c.signed === true));
        else eqs.push(pointToFixedDistanceResidual(x, idx, origin, c.value));
        break;
      }
      case "coincidentOrigin": {
        const idx = "segmentId" in c.point ? pointVarIndex(varIndex, c.point) : entityVarIndex(entityVarIdx, c.point);
        if (!idx) break;
        eqs.push(...pointToFixedCoincidentResiduals(idx, c.originLocal ?? [0, 0], x));
        break;
      }
      case "distanceEntityEntity": {
        const a = entityVarIndex(entityVarIdx, c.a);
        const b = entityVarIndex(entityVarIdx, c.b);
        if (!a || !b) break;
        if (c.axis === "x") eqs.push(axisDistanceResidual(x, a, b, c.value, 0, c.signed === true));
        else if (c.axis === "y") eqs.push(axisDistanceResidual(x, a, b, c.value, 1, c.signed === true));
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
      case "distancePointLine": {
        // 頂点↔線の距離拘束(Phase 30新設)。distanceEntityLineと完全に同形(idxがentityではなく
        // 端点の変数インデックスである点のみが異なる)なので、distanceEntityLineValue()をそのまま
        // 流用する。挙動の要(端点に付く線分に長さ拘束が無ければ伸び、あれば平行移動で追従)は
        // ソルバの自然な帰結であり、ここでは残差式を定義するだけでよい。
        const idx = pointVarIndex(varIndex, c.point);
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
          // 実機報告対応(Phase 32): sideが拘束に保存されていれば(addTangentSegmentConstraint参照)
          // それを使い、都度initXから符号を再計算しない(非凸性による反対側の解への意図しない
          // 収束を防ぐ)。省略されている拘束(旧バージョンのファイルを読み込んだ場合)は
          // 従来通りinitXから計算する後方互換フォールバック。
          const sign =
            target.side ??
            lineSideSign(initX, idx, [initX[lineBase], initX[lineBase + 1]], [initX[lineBase + 2], initX[lineBase + 3]]);
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

/**
 * 拘束1件だけの残差式を作る(実機報告対応、Phase 32。矛盾時のメッセージ用の残差ランキング、
 * および収束失敗時の初期値リトライのnudge計算で共用する)。fix/fixEntityはbuildFixResiduals、
 * それ以外はbuildConstraintResidualsに1件だけの配列を渡して流用する(残差式の定義自体は
 * 拘束の種類ごとに1箇所[buildConstraintResiduals/buildFixResiduals]にしか無いようにするため)。
 */
function constraintResidualEqs(
  c: SketchConstraint,
  segments: readonly SketchSegment[],
  segmentsById: Map<string, SketchSegment>,
  varIndex: VarIndexMap,
  entityVarIdx: EntityVarIndexMap,
  entities: readonly SketchEntity[],
  x: number[],
  initX: number[],
): ResidualEq[] {
  if (c.kind === "fix" || c.kind === "fixEntity") {
    return buildFixResiduals([c], varIndex, entityVarIdx, x, initX);
  }
  return buildConstraintResiduals([c], segments, segmentsById, varIndex, entityVarIdx, entities, x, initX);
}

function constraintResidualMaxAbs(
  c: SketchConstraint,
  segments: readonly SketchSegment[],
  segmentsById: Map<string, SketchSegment>,
  varIndex: VarIndexMap,
  entityVarIdx: EntityVarIndexMap,
  entities: readonly SketchEntity[],
  x: number[],
  initX: number[],
): number {
  return constraintResidualEqs(c, segments, segmentsById, varIndex, entityVarIdx, entities, x, initX).reduce(
    (acc, eq) => Math.max(acc, Math.abs(eq.value)),
    0,
  );
}

interface RankedConstraint {
  constraint: SketchConstraint;
  residual: number;
}

/** 拘束を残差の絶対値最大が大きい順に並べる(矛盾メッセージ・初期値リトライの対象選定に使う)。 */
function rankConstraintsByResidual(
  constraints: readonly SketchConstraint[],
  segments: readonly SketchSegment[],
  segmentsById: Map<string, SketchSegment>,
  varIndex: VarIndexMap,
  entityVarIdx: EntityVarIndexMap,
  entities: readonly SketchEntity[],
  x: number[],
  initX: number[],
): RankedConstraint[] {
  return constraints
    .map((constraint) => ({
      constraint,
      residual: constraintResidualMaxAbs(constraint, segments, segmentsById, varIndex, entityVarIdx, entities, x, initX),
    }))
    .sort((a, b) => b.residual - a.residual);
}

/**
 * 収束失敗時の初期値リトライ(実機報告対応、Phase 32②)向けに、指定した拘束1件をおおよそ満たす
 * 方向へ変数を大きく動かした初期値ベクトルを作る(x0自体は書き換えずコピーを返す)。
 *
 * tangent(円↔直線)は特別扱いで、円中心を動かさずに直線をその法線方向へ「剛体並進」させる
 * 厳密解を使う。直線を並進させたときの符号付き距離の変化は並進量に対して線形(角度が変わらない
 * 限り)なので、この1回の補正で当該tangent拘束の残差は理論上ちょうど0になる。これが重要な理由:
 * 「垂直+一致チェーンで繋がった直線をcircleに接するまで動かす」という典型ケースで、単純な
 * 最小二乗補正(疑似逆行列)だとp1/p2が独立に(=直線の形を歪めて)動いてしまい、warmup+LMの
 * 探索がその歪んだ方向の局所解(直線が退化してほぼ1点に潰れる、実機報告の根本原因だったパターン)
 * に迷い込みやすい。剛体並進なら「直線を動かす」というユーザーの意図に沿った良い初期値になり、
 * そこからの再solveがその近傍の(退化していない)解に収束しやすくなる。
 *
 * それ以外の拘束種別は、残差のヤコビアンから最小ノルム補正(1本の残差式ごとに
 * delta_i = -coef_i*value/Σcoef_j^2、疑似逆行列の単純な特殊形)を使う汎用フォールバック
 * (非線形な残差では厳密に0にはならないが、十分近い初期値を作れれば再solveのLM反復で
 * 収束しやすくなる、という統計的な効果を狙う)。
 *
 * 対象変数が見つからない、または既に残差がCONFLICT_TOLERANCE以下(nudgeする意味が無い)なら
 * nullを返す。
 */
function computeNudgedInitX(
  c: SketchConstraint,
  x0: readonly number[],
  segments: readonly SketchSegment[],
  segmentsById: Map<string, SketchSegment>,
  varIndex: VarIndexMap,
  entityVarIdx: EntityVarIndexMap,
  entities: readonly SketchEntity[],
  initX: readonly number[],
): number[] | null {
  if (c.kind === "tangent" && c.target.kind === "segment") {
    const idx = entityVarIndex(entityVarIdx, c.entity);
    const lineBase = varIndex.get(c.target.segmentId);
    const circle = entities.find((e): e is CircleEntity => e.kind === "circle" && e.id === c.entity.entityId);
    if (idx && lineBase !== undefined && circle) {
      const target = c.target;
      const sign =
        target.side ??
        lineSideSign(initX as number[], idx, [initX[lineBase], initX[lineBase + 1]], [initX[lineBase + 2], initX[lineBase + 3]]);
      const ax = x0[lineBase];
      const ay = x0[lineBase + 1];
      const bx = x0[lineBase + 2];
      const by = x0[lineBase + 3];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.max(Math.hypot(dx, dy), MIN_SAFE_LENGTH);
      const value = tangentLineValue(x0 as number[], idx, lineBase, circle.radius, sign);
      if (Math.abs(value) < CONFLICT_TOLERANCE) return null;
      // 直線をt*(nx,ny)だけ剛体並進させると符号付き距離がちょうど-sign*t変化する
      // (導出: cross'=(px-(ax+t*nx))*dy-(py-(ay+t*ny))*dx = cross - t*(nx*dy-ny*dx) = cross - t*len
      //  [nx=dy/len, ny=-dx/lenなのでnx*dy-ny*dx=(dy^2+dx^2)/len=len]。よってcross'/len = cross/len - t、
      //  sign*cross'/len = sign*cross/len - sign*t。value=0にするにはt=sign*value)。
      const t = sign * value;
      const nx = dy / len;
      const ny = -dx / len;
      const nudged = x0.slice();
      nudged[lineBase] += t * nx;
      nudged[lineBase + 1] += t * ny;
      nudged[lineBase + 2] += t * nx;
      nudged[lineBase + 3] += t * ny;
      return nudged;
    }
    return null;
  }

  const eqs = constraintResidualEqs(c, segments, segmentsById, varIndex, entityVarIdx, entities, x0 as number[], initX as number[]);
  const nudged = x0.slice();
  let touched = false;
  for (const eq of eqs) {
    if (Math.abs(eq.value) < CONFLICT_TOLERANCE) continue;
    let sumSq = 0;
    for (const t of eq.terms) sumSq += t.coef * t.coef;
    if (sumSq < 1e-12) continue;
    const factor = -eq.value / sumSq;
    for (const t of eq.terms) nudged[t.index] += factor * t.coef;
    touched = true;
  }
  return touched ? nudged : null;
}

/**
 * computeNudgedInitX()が作った初期値リトライのnudgeを、coincident拘束で繋がった端点の連鎖に
 * 沿って伝播させる(実機報告対応、Phase 32②。tangent(円↔直線)の剛体並進nudgeは対象の
 * セグメント自身の2端点しか動かさないため、そのままだと隣接セグメント(一致チェーンで繋がった
 * 相手側の端点)がattemptSolve()の正則化アンカー[regularizationAnchor=nudgedInitX]では
 * 「元の位置のまま」扱いになり、一致拘束(隣接セグメントの端点=移動した端点)と正則化(隣接
 * セグメントの端点を元の位置に留めたい)が綱引きになって、結局nudge前と同様の退化した解に
 * 迷い込みやすいことが実測でわかった)。coincident拘束をグラフの辺とみなし、nudgeで動いた
 * 端点(x0との差分が非ゼロ)を起点にBFSで「同じ変位」を隣接端点へ伝播する(端点同士が
 * coincidentで直接繋がっているなら、正則化アンカー上でも同じ量だけ動いているのが自然な仮定)。
 * 到達しない端点(一致チェーンで繋がっていない部分)は元のまま。
 */
function propagateNudgeThroughCoincidence(
  x0: readonly number[],
  nudged: number[],
  constraints: readonly SketchConstraint[],
  varIndex: VarIndexMap,
): number[] {
  const adjacency = new Map<number, number[]>();
  const addEdge = (a: number, b: number) => {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push(b);
    adjacency.get(b)!.push(a);
  };
  for (const c of constraints) {
    if (c.kind !== "coincident") continue;
    const a = pointVarIndex(varIndex, c.a);
    const b = pointVarIndex(varIndex, c.b);
    if (!a || !b) continue;
    addEdge(a[0], b[0]); // ノードidは端点のxインデックス(yは常にx+1として扱う)。
  }

  const result = nudged.slice();
  const visited = new Set<number>();
  const queue: number[] = [];
  for (const node of adjacency.keys()) {
    if (result[node] !== x0[node] || result[node + 1] !== x0[node + 1]) {
      visited.add(node);
      queue.push(node);
    }
  }
  while (queue.length > 0) {
    const node = queue.shift() as number;
    const dx = result[node] - x0[node];
    const dy = result[node + 1] - x0[node + 1];
    for (const nbr of adjacency.get(node) ?? []) {
      if (visited.has(nbr)) continue;
      result[nbr] += dx;
      result[nbr + 1] += dy;
      visited.add(nbr);
      queue.push(nbr);
    }
  }
  return result;
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

/**
 * DragTarget(Phase 34)1件から、対象変数(1点=2成分、segmentなら両端点=4成分)に対する
 * ソフト残差を作る。すべてのkindで「デルタ(target-grabPoint)を、対象変数の初期値(initX)からの
 * 移動量として適用したい」という同じ形の残差(重みDRAG_TARGET_WEIGHT)になる
 * (DragTargetの型コメント参照)。対象の変数インデックスが見つからない(=対象がこのsolveSketch()
 * 呼び出しのsegments/entitiesに存在しない)場合は空配列を返す(防御的、通常は起きない)。
 */
function buildDragTargetResiduals(
  dragTarget: DragTarget,
  varIndex: VarIndexMap,
  entityVarIdx: EntityVarIndexMap,
  x: number[],
  initX: number[],
): ResidualEq[] {
  const sqrtWeight = Math.sqrt(DRAG_TARGET_WEIGHT);
  const pull = (idx: [number, number], desired: Point2): ResidualEq[] => [
    { value: sqrtWeight * (x[idx[0]] - desired[0]), terms: [{ index: idx[0], coef: sqrtWeight }] },
    { value: sqrtWeight * (x[idx[1]] - desired[1]), terms: [{ index: idx[1], coef: sqrtWeight }] },
  ];
  const delta: Point2 = [dragTarget.target[0] - dragTarget.grabPoint[0], dragTarget.target[1] - dragTarget.grabPoint[1]];

  if (dragTarget.kind === "point") {
    const idx = pointVarIndex(varIndex, dragTarget.point);
    if (!idx) return [];
    return pull(idx, [initX[idx[0]] + delta[0], initX[idx[1]] + delta[1]]);
  }
  if (dragTarget.kind === "segment") {
    const base = varIndex.get(dragTarget.segmentId);
    if (base === undefined) return [];
    const p1: [number, number] = [base, base + 1];
    const p2: [number, number] = [base + 2, base + 3];
    return [
      ...pull(p1, [initX[p1[0]] + delta[0], initX[p1[1]] + delta[1]]),
      ...pull(p2, [initX[p2[0]] + delta[0], initX[p2[1]] + delta[1]]),
    ];
  }
  const idx = entityVarIndex(entityVarIdx, { entityId: dragTarget.entityId });
  if (!idx) return [];
  return pull(idx, [initX[idx[0]] + delta[0], initX[idx[1]] + delta[1]]);
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

/**
 * ガウスの消去法(部分ピボット選択)でAx=bを解く。特異(ピボットが0近傍)なら null。
 * exportしているのは src/assembly/mateSolver.ts(合致ソルバ、Phase 28c)が同じ実装を再利用するため
 * (LM法の正規方程式を解く部分は、対象がスケッチ変数か合致の部品位置/回転変数かによらず共通)。
 */
export function solveLinearSystem(a: number[][], b: number[]): number[] | null {
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
 * 減衰係数が見つかるまでλを10倍ずつ増やす(見つかればλをLAMBDA_SUCCESS_DIVISORで割る)。
 * コストを一度も下げられなかった反復で打ち切る(それ以上ここでは改善できない=収束or停滞)。
 *
 * LAMBDA_SUCCESS_DIVISOR(成功時のλ縮小率)は元々10だったが、原点ピック常時有効化・原点=ワールド原点
 * 定義への変更(追加項目)の実機検証で、distanceEntityOrigin/distancePointOrigin(点↔固定点の距離、
 * 1残差式+正則化2残差の劣拘束系)において、初期位置から目標円周までの移動量が大きい(面上スケッチの
 * originLocalは数十mm離れうる)場合に「λ=10前後で毎反復オーバーシュート→増大→縮小、を繰り返す
 * リミットサイクルに陥り、反復回数を増やしても収束しない」既知の弱点が見つかった(標準的な
 * 「成功のたびにλを1/10」という更新則が、この種の緩やかにしか非線形性が効かない1残差系では
 * 縮小し過ぎで、次反復のλ=10近辺の大きなステップが再びオーバーシュートする、という悪循環)。
 * 経験的な探索(-3〜3mm×3方向、原点距離8〜200mmの組み合わせ363通りを網羅)で、縮小率を1/5に
 * 緩めることでMAX_ITERATIONS=300以内に全ケースが収束することを確認した(1/10のままだと
 * 500反復でも363件中49件が未収束のまま)。既存の(小さな移動量で素早く収束する)ケースは
 * CONVERGE_NORMで早期打ち切りされるため、この変更による挙動の違いは事実上無い。
 */
const LAMBDA_SUCCESS_DIVISOR = 5;

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
        lambda = Math.max(lambda / LAMBDA_SUCCESS_DIVISOR, 1e-12);
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
 *
 * Phase 35b-1: PlaneGCS移行に伴い、この関数は「旧ソルバ」としてsrc/sketch/gcsAdapter.tsの初期化が
 * 完了する前のフォールバック専用に残されている(下記solveSketch()参照)。以後の新規挙動追加は
 * 原則gcsAdapter.ts側で行う想定(Phase 35cで旧ソルバの撤去を判断)。
 */
function solveSketchLegacy(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[] = [],
  entities: readonly SketchEntity[] = [],
  options: SolveOptions = {},
): SolveResult {
  const dragTarget = options.dragTarget;
  // 矩形・多角形をソルバで動かせるようにする改善: circleに加えrectangle/polygon/regularPolygon/slotも
  // entityVarIdxに積む(2変数ずつ。circle/rectangle/regularPolygonは中心、polygon/slotは並進オフセット)。
  const movableEntities: MovableEntity[] = entities.filter(isMovableEntity);

  if (segments.length === 0 && movableEntities.length === 0) {
    return { ok: true, segments: [], entities: entities.map((e) => ({ ...e })) };
  }
  // ドラッグ目標がある場合、拘束が空でも(自由な要素をドラッグしているだけでも)ドラッグ残差を
  // 解くためにショートカットせず先へ進む(Phase 34)。
  if (constraints.length === 0 && !dragTarget) {
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
  // ドラッグ中は拘束が既に満たされていてもカーソル位置が変わるたびに再solveする必要があるため、
  // 早期リターンはdragTargetが無い場合のみ行う(Phase 34)。
  if (initResidualMaxAbs < EARLY_RETURN_TOLERANCE && !dragTarget) {
    return { ok: true, segments: segments.map((s) => ({ ...s })), entities: entities.map((e) => ({ ...e })) };
  }

  const buildWarmupResiduals = (vars: number[]): ResidualEq[] => [
    ...buildHardResiduals(vars),
    ...buildRegularizationResiduals(vars, initX, REGULARIZATION_WEIGHT),
    ...(dragTarget ? buildDragTargetResiduals(dragTarget, varIndex, entityVarIdx, vars, initX) : []),
  ];

  /**
   * 与えた初期値x0からウォームアップ+仕上げの2段階LMを実行し、丸め済みの解と拘束残差の
   * 絶対値最大を返す(実機報告対応、Phase 32。従来1回しか呼ばれなかった処理を関数化し、
   * 下記の初期値リトライから複数回呼べるようにしたもの)。
   *
   * regularizationAnchor(正則化=「形状をできるだけ変えない」ソフト制約の目標形状)は通常initX
   * (従来通り、単独成功時の挙動・戻り値は変わらない)。初期値リトライ(computeNudgedInitX)で
   * x0を大きく動かした場合にregularizationAnchorをinitXのままにすると、ウォームアップの
   * 正則化項が「x0をinitXへ引き戻そう」とする力になり、せっかくのnudgeの効果を(部分的に)
   * 打ち消してしまう(実測: 打ち消された結果、nudge無しより悪化するケースがあった)。
   * そこでx0自体をregularizationAnchorとして渡せるようにし、「nudge後の形状の近くで
   * 形状をできるだけ変えない」ように正則化の基準点を移せるようにする。
   */
  function attemptSolve(x0: number[], regularizationAnchor: number[] = initX): { x: number[]; maxAbs: number } {
    const buildWarmupResidualsFrom =
      regularizationAnchor === initX
        ? buildWarmupResiduals
        : (vars: number[]): ResidualEq[] => [
            ...buildHardResiduals(vars),
            ...buildRegularizationResiduals(vars, regularizationAnchor, REGULARIZATION_WEIGHT),
            ...(dragTarget ? buildDragTargetResiduals(dragTarget, varIndex, entityVarIdx, vars, initX) : []),
          ];
    const warm = runLevenbergMarquardt(buildWarmupResidualsFrom, x0, m, MAX_ITERATIONS);
    const solved = runLevenbergMarquardt(buildHardResiduals, warm, m, MAX_ITERATIONS);
    // 累積ドリフト対策その2: 出力座標をROUND_GRIDに丸める。次回solveSketch()が同じ形状で呼ばれたとき
    // (=何も編集していないのに再solveされたとき)、丸められた「きりのいい」座標が
    // EARLY_RETURN_TOLERANCE判定を安定して通過するようにする(=座標が完全に不変になる)。
    // 丸め幅(1e-6mm)はCONFLICT_TOLERANCE(1e-4mm)より2桁小さいため、丸めによって矛盾判定が
    // 悪化することはない。
    const xr = solved.map(roundToGrid);
    const maxAbsR = buildHardResiduals(xr).reduce((acc, eq) => Math.max(acc, Math.abs(eq.value)), 0);
    return { x: xr, maxAbs: maxAbsR };
  }

  let best = attemptSolve(initX);

  // 実機報告対応(Phase 32②): 通常の初期値からの1回の解法では許容誤差内に収まらなかった場合、
  // 残差が最大の拘束(最大2件)を狙って初期値を大きく動かした状態から再solveする(最大2回の
  // リトライ)。問題なく収束する既存のケースはこのブロックに到達しないため挙動は変わらない。
  // 「残差が大きいまま停滞」(=初期値次第で解ける)と「真の矛盾」を判別する決定的な方法は
  // 無いが、少なくともこのリトライで解けるケースは前者だったと言える。
  if (best.maxAbs > CONFLICT_TOLERANCE) {
    const rankedAtInit = rankConstraintsByResidual(constraints, segments, segmentsById, varIndex, entityVarIdx, entities, initX, initX);
    const RETRY_CANDIDATE_COUNT = 2;
    for (const { constraint, residual } of rankedAtInit.slice(0, RETRY_CANDIDATE_COUNT)) {
      if (residual <= CONFLICT_TOLERANCE) break; // 降順ソート済みなのでこれ以降も対象外
      if (best.maxAbs <= CONFLICT_TOLERANCE) break;
      const nudgedInitX = computeNudgedInitX(constraint, initX, segments, segmentsById, varIndex, entityVarIdx, entities, initX);
      if (!nudgedInitX) continue;
      // nudgeで動かした端点にcoincidentで繋がる隣接端点にも同じ変位を伝播してから使う
      // (単独の端点だけ動かすと、隣接セグメントの反対側の端点が正則化アンカー上では
      // 「動いていない」ことになり、一致拘束との綱引きで元の悪い局所解に迷い込みやすいため)。
      const propagated = propagateNudgeThroughCoincidence(initX, nudgedInitX, constraints, varIndex);
      const attempt = attemptSolve(propagated, propagated);
      if (attempt.maxAbs < best.maxAbs) best = attempt;
    }
  }

  if (best.maxAbs > CONFLICT_TOLERANCE) {
    // 実機報告対応(Phase 32③): 残差が最大の拘束(上位1〜2件、best.xで評価)を人間可読な名前
    // (拘束一覧パネルと同じ表記、src/sketch/constraintLabels.ts)で特定し、メッセージに含める。
    const rankedAtBest = rankConstraintsByResidual(constraints, segments, segmentsById, varIndex, entityVarIdx, entities, best.x, initX);
    const offenders = rankedAtBest.filter((r) => r.residual > CONFLICT_TOLERANCE).slice(0, 2);
    const names = offenders.map((o) => `『${constraintFullLabel(segments, entities, o.constraint)}』`);
    const detail =
      names.length > 0
        ? `${names[0]}を満たす位置に到達できませんでした${names.length > 1 ? `(関連: ${names[1]})` : ""}。`
        : "";
    return {
      ok: false,
      conflicting: true,
      message: `${detail}拘束が矛盾しているか、現在の配置から解に到達できません(残差 ${best.maxAbs.toFixed(4)}mm)`,
    };
  }

  const x = best.x;
  return {
    ok: true,
    segments: segmentsFromVars(segments, x, varIndex),
    entities: entitiesFromVars(entities, x, entityVarIdx),
  };
}

/**
 * スケッチ拘束ソルバの公開エントリポイント(Phase 20a〜、Phase 35b-1でPlaneGCSへ移行)。
 * 入出力シグネチャ(SolveSuccess/SolveFailure/conflictingメッセージ等)は移行前と完全互換。
 *
 * src/state/store.tsのinitialize()がアプリ起動時にgcsAdapter.initGcs()を呼び、WASM初期化を
 * 開始する(非同期)。この関数自体は常に同期呼び出しのままにする必要がある
 * (store.tsのupdateDocument()がsolveDocumentSketches()経由で同期的に呼ぶ前提のため)。
 * 初期化が完了していれば(isGcsReady())GCSベースの実装(gcsAdapter.solveSketchGcs)を使い、
 * 完了前(起動直後の一瞬、または何らかの理由でWASM初期化に失敗した場合)は自前実装の
 * 旧ソルバ(solveSketchLegacy)にフォールバックする(Phase 35cで旧ソルバの撤去を判断するまで維持)。
 */
export function solveSketch(
  segments: readonly SketchSegment[],
  constraints: readonly SketchConstraint[] = [],
  entities: readonly SketchEntity[] = [],
  options: SolveOptions = {},
): SolveResult {
  if (gcsAdapter?.isGcsReady()) return gcsAdapter.solveSketchGcs(segments, constraints, entities, options);
  return solveSketchLegacy(segments, constraints, entities, options);
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
      // 実機報告対応(Phase 32③): solveSketch()が特定した具体的な原因(残差最大の拘束名)を
      // そのまま伝播する(以前はここで汎用メッセージに握りつぶしていた)。
      conflict = { featureId: feature.id, message: result.message };
      return feature;
    }
    return { ...feature, segments: result.segments, entities: result.entities };
  });

  if (conflict) {
    return { doc, conflict };
  }
  return { doc: { ...doc, features }, conflict: null };
}
