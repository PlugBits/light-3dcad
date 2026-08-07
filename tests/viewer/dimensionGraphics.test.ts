// src/viewer/dimensionGraphics.ts の単体テスト(純粋TS、three.js/WebGL不要、Phase 22)。
import { describe, expect, it } from "vitest";

import {
  computeAxisDimensionGraphics,
  computeLinearDimensionGraphics,
  computeRadiusDimensionGraphics,
  DEFAULT_LINEAR_DIMENSION_OFFSET,
} from "../../src/viewer/dimensionGraphics";

describe("computeLinearDimensionGraphics", () => {
  it("水平な辺(下向きに重心がある)の寸法線が法線側(+y)へオフセットされる", () => {
    const { lines, labelPos } = computeLinearDimensionGraphics([0, 0], [10, 0], { awayFrom: [5, -5] });
    // 寸法線本体(3本目)は両端ともy=offsetの高さにあるはず。
    const dimLine = lines[2];
    expect(dimLine[1]).toBeCloseTo(DEFAULT_LINEAR_DIMENSION_OFFSET);
    expect(dimLine[3]).toBeCloseTo(DEFAULT_LINEAR_DIMENSION_OFFSET);
    expect(labelPos[1]).toBeCloseTo(DEFAULT_LINEAR_DIMENSION_OFFSET);
    expect(labelPos[0]).toBeCloseTo(5);
  });

  it("重心が反対側(上)にあれば寸法線は-y側へオフセットされる", () => {
    const { labelPos } = computeLinearDimensionGraphics([0, 0], [10, 0], { awayFrom: [5, 5] });
    expect(labelPos[1]).toBeCloseTo(-DEFAULT_LINEAR_DIMENSION_OFFSET);
  });

  it("矢印は寸法線の内側(相手側)へ開く", () => {
    const { lines } = computeLinearDimensionGraphics([0, 0], [10, 0], { offset: 5 });
    // lines: [ext1, ext2, dimLine, arrow1a, arrow1b, arrow2a, arrow2b]
    const [o1x] = [lines[2][0], lines[2][1]];
    const [o2x] = [lines[2][2], lines[2][3]];
    const arrow1a = lines[3];
    const arrow1b = lines[4];
    const arrow2a = lines[5];
    const arrow2b = lines[6];
    // o1(左端)の矢印はo2(右)方向、つまりtipよりx座標が大きい側へ開く。
    expect(arrow1a[2]).toBeGreaterThan(o1x);
    expect(arrow1b[2]).toBeGreaterThan(o1x);
    // o2(右端)の矢印はo1(左)方向、つまりtipよりx座標が小さい側へ開く。
    expect(arrow2a[2]).toBeLessThan(o2x);
    expect(arrow2b[2]).toBeLessThan(o2x);
  });

  it("引出線は測定点(p1/p2)から寸法線を少し超えた位置まで伸びる", () => {
    const { lines } = computeLinearDimensionGraphics([0, 0], [10, 0], { offset: 5 });
    const ext1 = lines[0];
    // 始点は測定点p1そのもの。
    expect(ext1[0]).toBeCloseTo(0);
    expect(ext1[1]).toBeCloseTo(0);
    // 終点は寸法線(y=5)を僅かに超えている。
    expect(ext1[3]).toBeGreaterThan(5);
  });
});

describe("offsetVec(寸法ラベルのドラッグ移動、Phase 31a)", () => {
  it("computeLinearDimensionGraphicsはoffsetVecを渡すと既定のnormal*offsetの代わりにそのベクトルを使い、labelPos=mid(p1,p2)+offsetVecになる", () => {
    const { labelPos, offsetVec } = computeLinearDimensionGraphics([0, 0], [10, 0], { offsetVec: [3, 12] });
    expect(offsetVec).toEqual([3, 12]);
    expect(labelPos[0]).toBeCloseTo(5 + 3);
    expect(labelPos[1]).toBeCloseTo(0 + 12);
  });

  it("computeLinearDimensionGraphicsはoffsetVec未指定なら既定のオフセット(normal*offset)をoffsetVecとして返す(既存呼び出しとの後方互換)", () => {
    const { offsetVec } = computeLinearDimensionGraphics([0, 0], [10, 0], { awayFrom: [5, -5] });
    expect(offsetVec[0]).toBeCloseTo(0);
    expect(offsetVec[1]).toBeCloseTo(DEFAULT_LINEAR_DIMENSION_OFFSET);
  });

  it("computeLinearDimensionGraphicsは引出線(leader)をp1/p2からoffsetVec分だけ離れた点まで繋いだままにする(測定点との接続を保つ)", () => {
    const { lines } = computeLinearDimensionGraphics([0, 0], [10, 0], { offsetVec: [2, 6] });
    const ext1 = lines[0]; // p1(0,0) -> 寸法線側(少し超えた点)
    expect(ext1[0]).toBeCloseTo(0);
    expect(ext1[1]).toBeCloseTo(0);
    // 終点はp1+offsetVec付近(オーバーシュート分だけさらに離れる)。
    expect(ext1[2]).toBeCloseTo(2, 0);
    expect(ext1[3]).toBeGreaterThan(6);
  });

  it("computeRadiusDimensionGraphicsはoffsetVecを渡すとlabelPos=center+offsetVecになる(半径の外でも内でも可)", () => {
    const { labelPos, offsetVec } = computeRadiusDimensionGraphics([1, 1], 10, { offsetVec: [4, 3] });
    expect(offsetVec).toEqual([4, 3]);
    expect(labelPos[0]).toBeCloseTo(1 + 4);
    expect(labelPos[1]).toBeCloseTo(1 + 3);
  });

  it("computeAxisDimensionGraphicsはoffsetVec未指定なら既定([0,0])、指定すると寸法線(p1/p2)がその分だけ平行移動する", () => {
    const base = computeAxisDimensionGraphics([0, 0], [10, 4], "x");
    expect(base.offsetVec).toEqual([0, 0]);
    const moved = computeAxisDimensionGraphics([0, 0], [10, 4], "x", { offsetVec: [0, 5] });
    expect(moved.labelPos[1]).toBeCloseTo(base.labelPos[1] + 5);
    expect(moved.labelPos[0]).toBeCloseTo(base.labelPos[0]);
  });
});

describe("computeRadiusDimensionGraphics", () => {
  it("ラベル位置が中心から角度方向へ半径+オフセット分だけ離れた位置になる", () => {
    const { labelPos } = computeRadiusDimensionGraphics([0, 0], 10, { angleDeg: 0, labelOffset: 3 });
    expect(labelPos[0]).toBeCloseTo(13);
    expect(labelPos[1]).toBeCloseTo(0);
  });

  it("矢印は円周上から中心方向へ開く", () => {
    const { lines } = computeRadiusDimensionGraphics([0, 0], 10, { angleDeg: 0 });
    // lines[0]は引出線本体(中心→ラベル)、lines[1],[2]が矢印。
    const arrowA = lines[1];
    const arrowB = lines[2];
    // 矢印の先端(circlePoint、x=10)から見て、開いた側の点は中心方向(x<10)にある。
    expect(arrowA[0]).toBeCloseTo(10);
    expect(arrowA[2]).toBeLessThan(10);
    expect(arrowB[2]).toBeLessThan(10);
  });
});
