// 製図風の寸法線グラフィックス(引出線・寸法線・矢印)を計算する純粋関数群(Phase 22)。
// ReactにもThree.jsにも依存しない(src/sketch/dimensions.ts, snapping.ts と同じ方針)。
// 入力・出力ともスケッチのローカル2D座標(mm)。CadViewer側でPlaneBasisを使ってワールド座標へ
// 変換し、専用色の細線(depthTest:false)として描画する。ラベル位置はDimensionOverlayが
// HTMLピルの表示位置として使う。
export type Point2 = [number, number];
/** 線分1本(u1, v1, u2, v2)。CadViewer側でワールド座標に変換してLineSegmentsの頂点にする。 */
export type Segment = [number, number, number, number];

export interface DimensionGraphics {
  /** 引出線2本+寸法線1本+矢印2組(各2本)を合わせた線分リスト。 */
  lines: Segment[];
  /** 寸法線中央(ラベル表示位置)。 */
  labelPos: Point2;
}

/** 線形寸法(辺・2点間)のオフセット距離(mm)の既定値。 */
export const DEFAULT_LINEAR_DIMENSION_OFFSET = 8;
/** 半径寸法のラベルまでの追加オフセット距離(mm)の既定値(円周から)。 */
export const DEFAULT_RADIUS_LABEL_OFFSET = 3;
/** 半径寸法の引出線の既定角度(度、水平から反時計回り)。 */
export const DEFAULT_RADIUS_ANGLE_DEG = 45;
/** 矢印(三角形を線分2本で表現)の腕の長さ(mm)。 */
const ARROW_SIZE = 1.6;
/** 矢印の開き角(片側、ラジアン)。 */
const ARROW_HALF_ANGLE = Math.PI / 9; // 20度
/** 引出線が寸法線を少し超えて伸びる長さ(mm、製図の慣習的なオーバーシュート)。 */
const EXT_LINE_OVERSHOOT = 1;

function sub(a: Point2, b: Point2): Point2 {
  return [a[0] - b[0], a[1] - b[1]];
}
function add(a: Point2, b: Point2): Point2 {
  return [a[0] + b[0], a[1] + b[1]];
}
function scale(a: Point2, s: number): Point2 {
  return [a[0] * s, a[1] * s];
}
function length(a: Point2): number {
  return Math.hypot(a[0], a[1]);
}
function normalize(a: Point2): Point2 {
  const l = length(a);
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
}
function rotate(v: Point2, angle: number): Point2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}
function seg(a: Point2, b: Point2): Segment {
  return [a[0], a[1], b[0], b[1]];
}

/**
 * tip(矢印の先端)に、dirIntoLine(先端から見た「線の内側」方向の単位ベクトル)を軸に
 * 開いた矢印(V字、線分2本)を作る。寸法線の両端で使う(矢印は寸法線の内側に向かって開く)。
 */
function arrowHeadLines(tip: Point2, dirIntoLine: Point2, size: number = ARROW_SIZE): Segment[] {
  const wing1 = rotate(dirIntoLine, ARROW_HALF_ANGLE);
  const wing2 = rotate(dirIntoLine, -ARROW_HALF_ANGLE);
  const p1 = add(tip, scale(wing1, size));
  const p2 = add(tip, scale(wing2, size));
  return [seg(tip, p1), seg(tip, p2)];
}

/**
 * 2点間(辺の始点・終点、または2つの測定点)の線形寸法の描画データを計算する。
 * 引出線2本(測定点→オフセット線上の点、寸法線を少し超えてオーバーシュート)+その先端を結ぶ
 * 寸法線1本+両端の矢印(線分2本ずつ)を返す。offset方向は、opts.awayFromが与えられれば
 * それと反対側(多角形の重心と反対側に置く既存のoutwardEdgeAnchor()と同じ考え方)、
 * なければp1→p2を左回りに90度回した向き(opts.sideで反転可)。
 */
export function computeLinearDimensionGraphics(
  p1: Point2,
  p2: Point2,
  opts: { offset?: number; side?: 1 | -1; awayFrom?: Point2 } = {},
): DimensionGraphics {
  const offset = opts.offset ?? DEFAULT_LINEAR_DIMENSION_OFFSET;
  const dir = normalize(sub(p2, p1));
  if (dir[0] === 0 && dir[1] === 0) {
    // 始点=終点(縮退)の場合は矢印・寸法線を描けないため、ラベルだけp1に置く。
    return { lines: [], labelPos: p1 };
  }
  let normal: Point2 = [-dir[1], dir[0]];
  if (opts.awayFrom) {
    const mid = scale(add(p1, p2), 0.5);
    const toMid = sub(mid, opts.awayFrom);
    if (normal[0] * toMid[0] + normal[1] * toMid[1] < 0) normal = scale(normal, -1);
  } else if (opts.side === -1) {
    normal = scale(normal, -1);
  }

  const o1 = add(p1, scale(normal, offset));
  const o2 = add(p2, scale(normal, offset));
  const overshoot = scale(normal, EXT_LINE_OVERSHOOT);

  const lines: Segment[] = [
    seg(p1, add(o1, overshoot)), // 引出線1(測定点p1→寸法線を少し超えた点)
    seg(p2, add(o2, overshoot)), // 引出線2
    seg(o1, o2), // 寸法線本体
    ...arrowHeadLines(o1, dir), // o1側の矢印(o2方向へ開く)
    ...arrowHeadLines(o2, scale(dir, -1)), // o2側の矢印(o1方向へ開く)
  ];
  return { lines, labelPos: scale(add(o1, o2), 0.5) };
}

/**
 * 半径寸法の描画データを計算する。中心から角度angleDeg方向へ、円周を超えてラベル位置まで
 * 伸びる引出線(1本)+円周位置に矢印(先端は円周上、中心方向へ開く)を返す。
 */
export function computeRadiusDimensionGraphics(
  center: Point2,
  radius: number,
  opts: { angleDeg?: number; labelOffset?: number } = {},
): DimensionGraphics {
  const angleDeg = opts.angleDeg ?? DEFAULT_RADIUS_ANGLE_DEG;
  const labelOffset = opts.labelOffset ?? DEFAULT_RADIUS_LABEL_OFFSET;
  const rad = (angleDeg * Math.PI) / 180;
  const dir: Point2 = [Math.cos(rad), Math.sin(rad)];
  const circlePoint = add(center, scale(dir, radius));
  const labelPos = add(center, scale(dir, radius + labelOffset));

  const lines: Segment[] = [
    seg(center, labelPos), // 引出線(中心→ラベル位置、円周をまたいで描く)
    ...arrowHeadLines(circlePoint, scale(dir, -1)), // 円周上の矢印、中心方向へ開く
  ];
  return { lines, labelPos };
}
