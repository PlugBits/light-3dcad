import { generateId } from "./id";
import type { SketchEntity } from "./types";

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
