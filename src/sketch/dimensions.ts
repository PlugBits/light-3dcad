// 寸法駆動編集エンジン(Phase 10)。
// ReactにもThree.jsにも依存しない純粋関数のみで構成する(テスト容易性最優先。src/sketch/snapping.ts
// と同じ方針)。拘束ソルバは使わず、決定的な更新ルール(始点固定・終点のみ移動)でジオメトリを
// 更新する。ポリゴンの「辺」は points[edgeIndex] -> points[(edgeIndex+1) % points.length] として
// 定義する(最後の頂点から最初の頂点へ戻る辺も含む)。
import type { SketchEntity } from "../model/types";

export type Point2 = [number, number];

function assertPointsLength(points: Point2[]): void {
  if (points.length < 2) {
    throw new RangeError("辺を計算するには頂点が2点以上必要です");
  }
}

function assertEdgeIndex(points: Point2[], edgeIndex: number): void {
  if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= points.length) {
    throw new RangeError(`辺インデックス(${edgeIndex})が範囲外です(0〜${points.length - 1})`);
  }
}

/** edgeIndex番目の辺の始点・終点(次頂点)・終点のインデックスを返す(バリデーション込み)。 */
function edgeEndpoints(points: Point2[], edgeIndex: number): { start: Point2; end: Point2; endIndex: number } {
  assertPointsLength(points);
  assertEdgeIndex(points, edgeIndex);
  const endIndex = (edgeIndex + 1) % points.length;
  return { start: points[edgeIndex], end: points[endIndex], endIndex };
}

/** 辺(edgeIndex始点→次頂点)の長さ(mm)を返す。 */
export function edgeLength(points: Point2[], edgeIndex: number): number {
  const { start, end } = edgeEndpoints(points, edgeIndex);
  return Math.hypot(end[0] - start[0], end[1] - start[1]);
}

/** 辺(edgeIndex始点→次頂点)の水平からの角度(度、0以上360未満)を返す。 */
export function edgeAngle(points: Point2[], edgeIndex: number): number {
  const { start, end } = edgeEndpoints(points, edgeIndex);
  const deg = (Math.atan2(end[1] - start[1], end[0] - start[0]) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * 辺の始点を固定したまま、終点(edgeIndex+1側の頂点)のみを、始点からの方向を保って
 * newLength(mm、正の有限数)の位置に移動する。後続の頂点は動かさない(拘束伝播はしない)。
 * points自体は変更せず、新しい配列を返す。
 */
export function applyEdgeLength(points: Point2[], edgeIndex: number, newLength: number): Point2[] {
  const { start, end, endIndex } = edgeEndpoints(points, edgeIndex);
  if (!Number.isFinite(newLength) || newLength <= 0) {
    throw new RangeError("長さは正の有限数である必要があります");
  }
  const currentLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (currentLength === 0) {
    throw new RangeError("始点と終点が一致しているため方向を決定できません");
  }
  const ux = (end[0] - start[0]) / currentLength;
  const uy = (end[1] - start[1]) / currentLength;
  const next = points.slice() as Point2[];
  next[endIndex] = [start[0] + ux * newLength, start[1] + uy * newLength];
  return next;
}

/**
 * 辺の始点を中心に、終点(edgeIndex+1側の頂点)を回転させて水平からnewAngleDeg度の方向にする
 * (長さは維持)。後続の頂点は動かさない。points自体は変更せず、新しい配列を返す。
 */
export function applyEdgeAngle(points: Point2[], edgeIndex: number, newAngleDeg: number): Point2[] {
  const { start, end, endIndex } = edgeEndpoints(points, edgeIndex);
  if (!Number.isFinite(newAngleDeg)) {
    throw new RangeError("角度は有限数である必要があります");
  }
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (length === 0) {
    throw new RangeError("始点と終点が一致しているため角度を適用できません");
  }
  const rad = (newAngleDeg * Math.PI) / 180;
  const next = points.slice() as Point2[];
  next[endIndex] = [start[0] + Math.cos(rad) * length, start[1] + Math.sin(rad) * length];
  return next;
}

// ---- 寸法ラベルの構築(表示用、ReactにもThree.jsにも依存しない) ----

function polygonCentroid(points: Point2[]): Point2 {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  return [sx / points.length, sy / points.length];
}

/**
 * 辺の中点から外向き(多角形の重心と反対側)にoffsetだけ離れた位置を返す(ラベルのアンカー用)。
 * 辺の長さが0(始点=終点、通常は起こらない)の場合は中点をそのまま返す。
 */
function outwardEdgeAnchor(points: Point2[], edgeIndex: number, offset: number): Point2 {
  const { start, end } = edgeEndpoints(points, edgeIndex);
  const mid: Point2 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return mid;
  // 辺方向に直交するベクトル(2通りのうち、重心と反対側を選ぶ)。
  let nx = -dy / len;
  let ny = dx / len;
  const centroid = polygonCentroid(points);
  const toMid: Point2 = [mid[0] - centroid[0], mid[1] - centroid[1]];
  if (nx * toMid[0] + ny * toMid[1] < 0) {
    nx = -nx;
    ny = -ny;
  }
  return [mid[0] + nx * offset, mid[1] + ny * offset];
}

export interface PolygonEdgeDimension {
  kind: "polygon-edge";
  entityId: string;
  edgeIndex: number;
  length: number;
  angleDeg: number;
  /** ラベル表示位置(スケッチローカル2D、mm)。 */
  anchor: Point2;
}

export interface CircleRadiusDimension {
  kind: "circle-radius";
  entityId: string;
  radius: number;
  anchor: Point2;
}

export interface RectangleDimension {
  kind: "rect-width" | "rect-height";
  entityId: string;
  value: number;
  anchor: Point2;
}

export type SketchDimension = PolygonEdgeDimension | CircleRadiusDimension | RectangleDimension;

/** ラベルを図形本体から離すオフセット距離(mm)のデフォルト。 */
export const DEFAULT_DIMENSION_LABEL_OFFSET = 3;

/**
 * スケッチのentities(rectangle/circle/polygon)から表示すべき寸法(ラベルのアンカー座標込み)の
 * 一覧を作る。純粋関数(React/Three非依存)。座標はスケッチのローカル2D(mm)。
 * - rectangle: 幅(上辺中点付近)・高さ(右辺中点付近)の2件
 * - circle: 半径(中心付近)の1件
 * - polygon: 各辺(頂点数と同数)の長さ・角度
 */
export function computeSketchDimensions(
  entities: SketchEntity[],
  labelOffset: number = DEFAULT_DIMENSION_LABEL_OFFSET,
): SketchDimension[] {
  const dimensions: SketchDimension[] = [];
  for (const entity of entities) {
    if (entity.kind === "rectangle") {
      const [cx, cy] = entity.center;
      dimensions.push({
        kind: "rect-width",
        entityId: entity.id,
        value: entity.width,
        anchor: [cx, cy + entity.height / 2 + labelOffset],
      });
      dimensions.push({
        kind: "rect-height",
        entityId: entity.id,
        value: entity.height,
        anchor: [cx + entity.width / 2 + labelOffset, cy],
      });
    } else if (entity.kind === "circle") {
      dimensions.push({
        kind: "circle-radius",
        entityId: entity.id,
        radius: entity.radius,
        anchor: [entity.center[0], entity.center[1] + labelOffset],
      });
    } else if (entity.kind === "polygon") {
      for (let i = 0; i < entity.points.length; i += 1) {
        dimensions.push({
          kind: "polygon-edge",
          entityId: entity.id,
          edgeIndex: i,
          length: edgeLength(entity.points, i),
          angleDeg: edgeAngle(entity.points, i),
          anchor: outwardEdgeAnchor(entity.points, i, labelOffset),
        });
      }
    }
    // slot/regularPolygon(Phase 17)の寸法ラベルは今回のスコープ外(数値編集はSketchEditorで行う)。
  }
  return dimensions;
}

/** 寸法ラベルの表示テキストを返す(小数第1位まで)。例: "25.0" / "R10.0" / "W20.0" / "H15.0"。 */
export function formatDimensionLabel(dimension: SketchDimension): string {
  if (dimension.kind === "polygon-edge") return dimension.length.toFixed(1);
  if (dimension.kind === "circle-radius") return `R${dimension.radius.toFixed(1)}`;
  if (dimension.kind === "rect-width") return `W${dimension.value.toFixed(1)}`;
  return `H${dimension.value.toFixed(1)}`;
}

/**
 * SketchDimensionをdata-testid等に使う一意なキーに変換する。
 * polygon-edgeは`<entityId>-<edgeIndex>`(例のdim-label-<entityId>-<edgeIndex>に対応)、
 * それ以外は種別を示す接尾辞(`-r`/`-w`/`-h`)を付ける。
 */
export function dimensionKey(dimension: SketchDimension): string {
  if (dimension.kind === "polygon-edge") return `${dimension.entityId}-${dimension.edgeIndex}`;
  if (dimension.kind === "circle-radius") return `${dimension.entityId}-r`;
  if (dimension.kind === "rect-width") return `${dimension.entityId}-w`;
  return `${dimension.entityId}-h`;
}
