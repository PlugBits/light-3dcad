// src/viewer/dimensionGraphics.ts の単体テスト(純粋TS、three.js/WebGL不要、Phase 22)。
import { describe, expect, it } from "vitest";

import {
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
