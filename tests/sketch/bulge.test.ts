// Phase 17: polygon辺の円弧ふくらみ(bulge)の純粋幾何計算(src/sketch/bulge.ts)の単体テスト。
import { describe, expect, it } from "vitest";

import { bulgeArcPoints, bulgeFromThreePoints, effectivePolygonBulges, sagPointForBulge } from "../../src/sketch/bulge";

describe("sagPointForBulge", () => {
  it("bulge=1(半円)のとき、経由点は弦の中点から半径ぶん離れた位置になる", () => {
    // p1=(0,0), p2=(10,0)。halfChord=5。leftPerp(方向(1,0))=(0,1)。
    // bulgeAsSagitta = -1*5 = -5 なので経由点は (5,-5)。
    const via = sagPointForBulge([0, 0], [10, 0], 1);
    expect(via[0]).toBeCloseTo(5, 6);
    expect(via[1]).toBeCloseTo(-5, 6);
  });
});

describe("bulgeArcPoints / bulgeFromThreePoints 往復", () => {
  it("bulge=-1(半円、スロットのキャップと同じ規約)の弧の半径・中心が正しく、往復でbulgeが復元される", () => {
    const p1: [number, number] = [0, 5];
    const p2: [number, number] = [0, -5];
    const bulge = -1;
    const points = bulgeArcPoints(p1, p2, bulge, 32);
    expect(points[0][0]).toBeCloseTo(p1[0], 9);
    expect(points[0][1]).toBeCloseTo(p1[1], 9);
    expect(points[points.length - 1][0]).toBeCloseTo(p2[0], 9);
    expect(points[points.length - 1][1]).toBeCloseTo(p2[1], 9);
    // 半円の頂点(中間点)は中心から半径5離れているはず。弦の中点は(0,0)、半円なので頂点は(±5,0)。
    const mid = points[Math.floor(points.length / 2)];
    expect(Math.hypot(mid[0], mid[1])).toBeCloseTo(5, 3);
    expect(Math.abs(mid[1])).toBeLessThan(1e-3);

    // 往復: (p1, 弧の中間点, p2)からbulgeを復元すると元の値に近い。
    const recovered = bulgeFromThreePoints(p1, mid, p2);
    expect(recovered).toBeCloseTo(bulge, 2);
  });

  it("bulge=0(またはnull/undefined)は直線(2点のみ)を返す", () => {
    expect(bulgeArcPoints([0, 0], [10, 0], 0)).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(bulgeArcPoints([0, 0], [10, 0], null)).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it("一直線上の3点からはbulge=0(直線)を返す(退化ケース)", () => {
    const bulge = bulgeFromThreePoints([0, 0], [5, 0], [10, 0]);
    expect(bulge).toBe(0);
  });
});

describe("effectivePolygonBulges", () => {
  it("cornersが指定された頂点に接する辺のbulgeはnullに強制される(corners優先)", () => {
    // 4頂点の正方形、頂点1にfilletがある場合、辺0(0→1)と辺1(1→2)のbulgeが無視される。
    const bulges = [0.5, 0.5, 0.5, 0.5];
    const corners = [null, { kind: "fillet" as const, size: 2 }, null, null];
    const result = effectivePolygonBulges(4, corners, bulges);
    expect(result).toEqual([null, null, 0.5, 0.5]);
  });

  it("cornersが未指定ならbulgesをそのまま返す(nullで長さを揃える)", () => {
    const result = effectivePolygonBulges(4, undefined, [0.5, null]);
    expect(result).toEqual([0.5, null, null, null]);
  });
});
