// Phase 10: 寸法駆動編集エンジン(src/sketch/dimensions.ts)の単体テスト。
// 純粋関数のみを対象とするため environment: "node" のまま(vitest.config.ts参照)テスト可能。
import { describe, expect, it } from "vitest";

import {
  applyEdgeAngle,
  applyEdgeLength,
  computeSketchDimensions,
  dimensionKey,
  edgeAngle,
  edgeLength,
  formatDimensionLabel,
  type Point2,
} from "../../src/sketch/dimensions";

// 一辺20mmの正方形(反時計回り): 辺0=下辺(水平)、辺1=右辺(垂直)、辺2=上辺、辺3=左辺。
const square: Point2[] = [
  [0, 0],
  [20, 0],
  [20, 20],
  [0, 20],
];

describe("edgeLength / edgeAngle", () => {
  it("水平な辺の長さ・角度を返す", () => {
    expect(edgeLength(square, 0)).toBeCloseTo(20);
    expect(edgeAngle(square, 0)).toBeCloseTo(0);
  });

  it("垂直な辺の角度は90度", () => {
    expect(edgeLength(square, 1)).toBeCloseTo(20);
    expect(edgeAngle(square, 1)).toBeCloseTo(90);
  });

  it("最後の頂点から最初の頂点へ戻る辺(wrap-around)も計算できる", () => {
    // 辺3: (0,20) -> (0,0)、角度は270度(下向き)。
    expect(edgeLength(square, 3)).toBeCloseTo(20);
    expect(edgeAngle(square, 3)).toBeCloseTo(270);
  });

  it("角度は常に0以上360未満の範囲で返す(負方向の辺)", () => {
    const points: Point2[] = [
      [0, 0],
      [-10, 0],
    ];
    expect(edgeAngle(points, 0)).toBeCloseTo(180);
  });

  it("辺インデックスが範囲外なら例外を投げる", () => {
    expect(() => edgeLength(square, 4)).toThrow(RangeError);
    expect(() => edgeLength(square, -1)).toThrow(RangeError);
  });

  it("頂点が2点未満なら例外を投げる", () => {
    expect(() => edgeLength([[0, 0]], 0)).toThrow(RangeError);
  });
});

describe("applyEdgeLength", () => {
  it("始点を固定し、方向を保ったまま終点のみを新しい長さの位置に移動する", () => {
    const next = applyEdgeLength(square, 0, 50);
    expect(next[0]).toEqual([0, 0]); // 始点は不変
    expect(next[1][0]).toBeCloseTo(50);
    expect(next[1][1]).toBeCloseTo(0);
    // 後続の頂点(辺0の終点以外)は変更されない。
    expect(next[2]).toEqual([20, 20]);
    expect(next[3]).toEqual([0, 20]);
  });

  it("斜めの辺でも方向を保って長さだけ変える", () => {
    const points: Point2[] = [
      [0, 0],
      [3, 4], // 長さ5の辺(3-4-5)
    ];
    const next = applyEdgeLength(points, 0, 10);
    expect(next[1][0]).toBeCloseTo(6);
    expect(next[1][1]).toBeCloseTo(8);
  });

  it("長さが0以下なら例外を投げる", () => {
    expect(() => applyEdgeLength(square, 0, 0)).toThrow(RangeError);
    expect(() => applyEdgeLength(square, 0, -5)).toThrow(RangeError);
  });

  it("長さがNaN/Infinityなら例外を投げる", () => {
    expect(() => applyEdgeLength(square, 0, Number.NaN)).toThrow(RangeError);
    expect(() => applyEdgeLength(square, 0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("始点と終点が一致している辺には適用できない", () => {
    const degenerate: Point2[] = [
      [1, 1],
      [1, 1],
    ];
    expect(() => applyEdgeLength(degenerate, 0, 10)).toThrow(RangeError);
  });

  it("元のpoints配列を変更しない(非破壊)", () => {
    const original: Point2[] = [
      [0, 0],
      [20, 0],
    ];
    const snapshot = original.map((p) => [...p]);
    applyEdgeLength(original, 0, 99);
    expect(original).toEqual(snapshot);
  });
});

describe("applyEdgeAngle", () => {
  it("始点を中心に終点を回転させ、長さは維持する", () => {
    const next = applyEdgeAngle(square, 0, 90);
    expect(next[0]).toEqual([0, 0]);
    expect(next[1][0]).toBeCloseTo(0);
    expect(next[1][1]).toBeCloseTo(20);
    expect(next[2]).toEqual([20, 20]); // 後続頂点は不変
  });

  it("角度0で水平方向に戻す", () => {
    const points: Point2[] = [
      [0, 0],
      [0, 5],
    ];
    const next = applyEdgeAngle(points, 0, 0);
    expect(next[1][0]).toBeCloseTo(5);
    expect(next[1][1]).toBeCloseTo(0);
  });

  it("角度がNaN/Infinityなら例外を投げる", () => {
    expect(() => applyEdgeAngle(square, 0, Number.NaN)).toThrow(RangeError);
    expect(() => applyEdgeAngle(square, 0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("始点と終点が一致している辺には適用できない", () => {
    const degenerate: Point2[] = [
      [1, 1],
      [1, 1],
    ];
    expect(() => applyEdgeAngle(degenerate, 0, 45)).toThrow(RangeError);
  });

  it("長さ変更→角度変更の順で適用しても、角度変更→長さ変更の順で適用しても最終結果は一致する", () => {
    const a = applyEdgeAngle(applyEdgeLength(square, 0, 30), 0, 45);
    const b = applyEdgeLength(applyEdgeAngle(square, 0, 45), 0, 30);
    expect(a[1][0]).toBeCloseTo(b[1][0]);
    expect(a[1][1]).toBeCloseTo(b[1][1]);
    expect(edgeLength(a, 0)).toBeCloseTo(30);
    expect(edgeAngle(a, 0)).toBeCloseTo(45);
  });
});

describe("computeSketchDimensions", () => {
  it("rectangleは幅・高さの2件を返す(上辺中点付近・右辺中点付近にアンカー)", () => {
    const dims = computeSketchDimensions([{ kind: "rectangle", id: "r1", center: [0, 0], width: 20, height: 10 }]);
    expect(dims).toHaveLength(2);
    const width = dims.find((d) => d.kind === "rect-width");
    const height = dims.find((d) => d.kind === "rect-height");
    expect(width?.value).toBe(20);
    expect(height?.value).toBe(10);
    // 幅ラベルは上辺(y = height/2)より外側、高さラベルは右辺(x = width/2)より外側。
    expect(width?.anchor[1]).toBeGreaterThan(5);
    expect(height?.anchor[0]).toBeGreaterThan(10);
  });

  it("circleは半径1件を返す(中心付近にアンカー)", () => {
    const dims = computeSketchDimensions([{ kind: "circle", id: "c1", center: [5, 5], radius: 8 }]);
    expect(dims).toHaveLength(1);
    expect(dims[0]).toMatchObject({ kind: "circle-radius", entityId: "c1", radius: 8 });
  });

  it("polygonは頂点数と同数の辺寸法を返す", () => {
    const dims = computeSketchDimensions([{ kind: "polygon", id: "p1", points: square }]);
    expect(dims).toHaveLength(4);
    expect(dims.every((d) => d.kind === "polygon-edge")).toBe(true);
  });

  it("複数エンティティを組み合わせても正しく集計される", () => {
    const dims = computeSketchDimensions([
      { kind: "rectangle", id: "r1", center: [0, 0], width: 20, height: 10 },
      { kind: "circle", id: "c1", center: [0, 0], radius: 5 },
      { kind: "polygon", id: "p1", points: square },
    ]);
    expect(dims).toHaveLength(2 + 1 + 4);
  });
});

describe("formatDimensionLabel / dimensionKey", () => {
  it("polygon-edgeは小数第1位までの数値のみ", () => {
    const dims = computeSketchDimensions([{ kind: "polygon", id: "p1", points: square }]);
    expect(formatDimensionLabel(dims[0])).toBe("20.0");
    expect(dimensionKey(dims[0])).toBe("p1-0");
  });

  it("circle-radiusは`R`接頭辞付き", () => {
    const dims = computeSketchDimensions([{ kind: "circle", id: "c1", center: [0, 0], radius: 10 }]);
    expect(formatDimensionLabel(dims[0])).toBe("R10.0");
    expect(dimensionKey(dims[0])).toBe("c1-r");
  });

  it("rect-width/rect-heightはそれぞれ`W`/`H`接頭辞付き", () => {
    const dims = computeSketchDimensions([{ kind: "rectangle", id: "r1", center: [0, 0], width: 20, height: 15 }]);
    const width = dims.find((d) => d.kind === "rect-width")!;
    const height = dims.find((d) => d.kind === "rect-height")!;
    expect(formatDimensionLabel(width)).toBe("W20.0");
    expect(formatDimensionLabel(height)).toBe("H15.0");
    expect(dimensionKey(width)).toBe("r1-w");
    expect(dimensionKey(height)).toBe("r1-h");
  });
});
