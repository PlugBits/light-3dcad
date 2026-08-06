// Phase 14/17: クリック作図ツール(矩形・円・スロット・正多角形)の2点→ジオメトリ変換
// (src/sketch/shapeFromPoints.ts)の単体テスト。
import { describe, expect, it } from "vitest";

import {
  circleRadiusFromPoints,
  rectangleCornerPoints,
  rectangleFromCorners,
  regularPolygonFromCenterVertex,
  regularPolygonVertices,
  slotOutlinePoints,
} from "../../src/sketch/shapeFromPoints";

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

describe("regularPolygonFromCenterVertex / regularPolygonVertices", () => {
  it("中心と頂点から半径・回転角を計算する", () => {
    const { radius, rotation } = regularPolygonFromCenterVertex([0, 0], [10, 0]);
    expect(radius).toBeCloseTo(10, 6);
    expect(rotation).toBeCloseTo(0, 6);
  });

  it("正六角形の頂点は外接円上に等間隔(60度ごと)で並ぶ", () => {
    const vertices = regularPolygonVertices([0, 0], 10, 6);
    expect(vertices).toHaveLength(6);
    vertices.forEach((p) => expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 6));
    // 頂点0は回転0なので(10,0)。
    expect(vertices[0][0]).toBeCloseTo(10, 6);
    expect(vertices[0][1]).toBeCloseTo(0, 6);
    // 頂点1は60度: (5, 5*sqrt(3))。
    expect(vertices[1][0]).toBeCloseTo(5, 6);
    expect(vertices[1][1]).toBeCloseTo(5 * Math.sqrt(3), 6);
  });
});

describe("slotOutlinePoints", () => {
  it("水平スロットの輪郭が始点・終点の左右幅/2離れた4隅を通る(閉ループ、両端は半円近似)", () => {
    const points = slotOutlinePoints([-10, 0], [10, 0], 6, 8);
    // 先頭2点は始点側の左上コーナー(A)・終点側の左上コーナー(B)。
    expect(points[0]).toEqual([-10, 3]);
    expect(points[1]).toEqual([10, 3]);
    // 全点が中心線からwidth/2=3以内(近似誤差込みでわずかに超えないことを確認)。
    for (const [x, y] of points) {
      const distToAxis = Math.abs(y); // 中心線はy=0上の線分(x=-10..10)なので、キャップ部分はx軸方向にはみ出る。
      // キャップ部分(|x|>10)は中心(±10,0)からの距離が3であるべき、直線部(|x|<=10)はy=±3であるべき。
      if (Math.abs(x) <= 10 + 1e-6) {
        expect(distToAxis).toBeCloseTo(3, 3);
      } else {
        const capCenterX = x > 0 ? 10 : -10;
        expect(Math.hypot(x - capCenterX, y)).toBeCloseTo(3, 3);
      }
    }
  });
});
