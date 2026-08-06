// Phase 14: クリック作図ツール(矩形・円)の2点→ジオメトリ変換(src/sketch/shapeFromPoints.ts)の単体テスト。
import { describe, expect, it } from "vitest";

import { circleRadiusFromPoints, rectangleCornerPoints, rectangleFromCorners } from "../../src/sketch/shapeFromPoints";

describe("rectangleFromCorners", () => {
  it("対角2点から中心・幅・高さを計算する(向き問わず正の幅・高さになる)", () => {
    expect(rectangleFromCorners([-10, -5], [10, 5])).toEqual({ center: [0, 0], width: 20, height: 10 });
  });

  it("2点目が1点目より左下でも幅・高さは正になる", () => {
    expect(rectangleFromCorners([10, 5], [-10, -5])).toEqual({ center: [0, 0], width: 20, height: 10 });
  });
});

describe("rectangleCornerPoints", () => {
  it("対角2点から矩形の4頂点(閉ループ)を返す", () => {
    expect(rectangleCornerPoints([0, 0], [4, 2])).toEqual([
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ]);
  });
});

describe("circleRadiusFromPoints", () => {
  it("中心から円周上の点までの距離を半径として返す", () => {
    expect(circleRadiusFromPoints([0, 0], [3, 4])).toBe(5);
  });
});
