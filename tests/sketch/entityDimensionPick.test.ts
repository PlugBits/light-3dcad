// src/sketch/entityDimensionPick.ts の単体テスト(純粋TS、WASM不要)。
import { describe, expect, it } from "vitest";

import { createCircleEntity, createPolygonEntity, createRectangleEntity } from "../../src/model";
import { findEntityDimensionHit } from "../../src/sketch/entityDimensionPick";

describe("findEntityDimensionHit", () => {
  it("円の円周付近をクリックするとentity-radiusがヒットする", () => {
    const circle = createCircleEntity({ center: [0, 0], radius: 10 });
    const hit = findEntityDimensionHit([10, 0], [circle]);
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe("entity-radius");
    expect(hit?.entityId).toBe(circle.id);
    expect(hit?.dist).toBeCloseTo(0, 6);
  });

  it("円の中心付近(円周から離れた場所)は距離が大きくなる", () => {
    const circle = createCircleEntity({ center: [0, 0], radius: 10 });
    const hit = findEntityDimensionHit([0, 0], [circle]);
    expect(hit?.dist).toBeCloseTo(10, 6);
  });

  it("矩形の上辺(水平、長さ=width)付近をクリックするとentity-widthがヒットする", () => {
    const rect = createRectangleEntity({ center: [0, 0], width: 40, height: 20 });
    const hit = findEntityDimensionHit([0, 10], [rect]);
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe("entity-width");
    expect(hit?.entityId).toBe(rect.id);
    expect(hit?.dist).toBeCloseTo(0, 6);
  });

  it("矩形の右辺(垂直、長さ=height)付近をクリックするとentity-heightがヒットする", () => {
    const rect = createRectangleEntity({ center: [0, 0], width: 40, height: 20 });
    const hit = findEntityDimensionHit([20, 0], [rect]);
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe("entity-height");
    expect(hit?.dist).toBeCloseTo(0, 6);
  });

  it("複数entitiesがあれば最も近いものを返す", () => {
    const near = createCircleEntity({ center: [0, 0], radius: 5 });
    const far = createCircleEntity({ center: [100, 100], radius: 5 });
    const hit = findEntityDimensionHit([5, 0], [far, near]);
    expect(hit?.entityId).toBe(near.id);
  });

  it("polygon(entity-radius/width/heightの対象外)は無視され、他の対象があればそれを返す", () => {
    const polygon = createPolygonEntity({
      points: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
    });
    const circle = createCircleEntity({ center: [50, 50], radius: 5 });
    const hit = findEntityDimensionHit([0, 0], [polygon, circle]);
    expect(hit?.entityId).toBe(circle.id);
  });

  it("entitiesが空ならnullを返す", () => {
    expect(findEntityDimensionHit([0, 0], [])).toBeNull();
  });

  it("rectangle/circle以外しか無ければnullを返す", () => {
    const polygon = createPolygonEntity({
      points: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
    });
    expect(findEntityDimensionHit([0, 0], [polygon])).toBeNull();
  });

  it("円の境界ポリラインは閉じたループ(始点と終点が一致)になる", () => {
    const circle = createCircleEntity({ center: [1, 2], radius: 3 });
    const hit = findEntityDimensionHit([4, 2], [circle]);
    const pts = hit?.highlightPoints ?? [];
    expect(pts.length).toBeGreaterThan(2);
    expect(pts[0][0]).toBeCloseTo(pts[pts.length - 1][0], 6);
    expect(pts[0][1]).toBeCloseTo(pts[pts.length - 1][1], 6);
  });
});
