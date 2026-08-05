import { generateId } from "./id";
import type { PolygonCorner, SketchEntity } from "./types";

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

/**
 * ID付きの多角形エンティティを作成する。points は順序付き頂点列(閉ループ、3点以上)。
 * corners は頂点ごとのフィレット/面取り指定(省略可、省略時は全頂点が角のまま)。
 */
export function createPolygonEntity(params: {
  points: [number, number][];
  corners?: PolygonCorner[];
}): SketchEntity {
  return {
    kind: "polygon",
    id: generateId("entity"),
    points: params.points,
    ...(params.corners ? { corners: params.corners } : {}),
  };
}
