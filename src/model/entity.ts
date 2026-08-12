import { generateId } from "./id";
import type { PolygonCorner, SketchEntity, SketchSegment } from "./types";

/** ID付きの矩形エンティティを作成する。 */
export function createRectangleEntity(params: {
  center?: [number, number];
  width: number;
  height: number;
}): SketchEntity {
  return {
    kind: "rectangle",
    id: generateId("entity"),
    center: params.center ?? [0, 0],
    width: params.width,
    height: params.height,
  };
}

/** ID付きの円エンティティを作成する。 */
export function createCircleEntity(params: { center?: [number, number]; radius: number }): SketchEntity {
  return {
    kind: "circle",
    id: generateId("entity"),
    center: params.center ?? [0, 0],
    radius: params.radius,
  };
}

/** ID付きの点エンティティを作成する(Phase 47、SolidWorksスケッチの「点」相当)。 */
export function createPointEntity(params: { position?: [number, number] }): SketchEntity {
  return {
    kind: "point",
    id: generateId("entity"),
    position: params.position ?? [0, 0],
  };
}

/**
 * ID付きの多角形エンティティを作成する。points は順序付き頂点列(閉ループ、3点以上)。
 * corners は頂点ごとのフィレット/面取り指定(省略可、省略時は全頂点が角のまま)。
 * bulges は辺ごとの円弧ふくらみ指定(省略可、省略時は全辺が直線のまま、Phase 17)。
 */
export function createPolygonEntity(params: {
  points: [number, number][];
  corners?: PolygonCorner[];
  bulges?: (number | null)[];
}): SketchEntity {
  return {
    kind: "polygon",
    id: generateId("entity"),
    points: params.points,
    ...(params.corners ? { corners: params.corners } : {}),
    ...(params.bulges ? { bulges: params.bulges } : {}),
  };
}

/** ID付きのスロット(長円)エンティティを作成する(Phase 17)。start/endは中心線の両端、widthは全幅。 */
export function createSlotEntity(params: { start: [number, number]; end: [number, number]; width: number }): SketchEntity {
  return {
    kind: "slot",
    id: generateId("entity"),
    start: params.start,
    end: params.end,
    width: params.width,
  };
}

/** ID付きの正多角形エンティティを作成する(Phase 17)。radiusは外接円半径、sidesは辺数(3〜24)。 */
export function createRegularPolygonEntity(params: {
  center?: [number, number];
  radius: number;
  sides: number;
  rotation?: number;
}): SketchEntity {
  return {
    kind: "regularPolygon",
    id: generateId("entity"),
    center: params.center ?? [0, 0],
    radius: params.radius,
    sides: params.sides,
    ...(params.rotation !== undefined ? { rotation: params.rotation } : {}),
  };
}

/** ID付きの直線セグメントを作成する(Phase 19a、SketchFeature.segments用)。 */
export function createLineSegment(params: { p1: [number, number]; p2: [number, number] }): SketchSegment {
  return { kind: "line", id: generateId("segment"), p1: params.p1, p2: params.p2 };
}

/** ID付きの円弧セグメントを作成する(Phase 19a、SketchFeature.segments用)。bulgeの定義はsrc/sketch/bulge.tsと同一。 */
export function createArcSegment(params: { p1: [number, number]; p2: [number, number]; bulge: number }): SketchSegment {
  return { kind: "arc", id: generateId("segment"), p1: params.p1, p2: params.p2, bulge: params.bulge };
}
