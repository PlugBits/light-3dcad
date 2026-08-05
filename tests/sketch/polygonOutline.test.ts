// Phase 11: 頂点フィレット/面取りの幾何計算(src/sketch/polygonOutline.ts)の単体テスト。
// 純粋関数のみを対象とするため environment: "node" のまま(vitest.config.ts参照)テスト可能。
import { describe, expect, it } from "vitest";

import { computeCornerGeometry, DEFAULT_SEGMENTS_PER_ARC, polygonOutlinePoints } from "../../src/sketch/polygonOutline";

// 40x40正方形(反時計回り): (0,0)(40,0)(40,40)(0,40)。
const SQUARE: [number, number][] = [
  [0, 0],
  [40, 0],
  [40, 40],
  [0, 40],
];

describe("computeCornerGeometry", () => {
  it("直角(90度)頂点のfilletで接点が頂点からr離れた位置になる", () => {
    // 頂点1=(40,0)。前=(0,0)、次=(40,40)。r=5。
    const geometry = computeCornerGeometry([0, 0], [40, 0], [40, 40], { kind: "fillet", size: 5 });
    expect(geometry).not.toBeNull();
    if (!geometry) return;
    // 接点1: 前の辺(x軸)上、頂点から5mm手前 → (35, 0)
    expect(geometry.tangent1[0]).toBeCloseTo(35, 6);
    expect(geometry.tangent1[1]).toBeCloseTo(0, 6);
    // 接点2: 次の辺(x=40の辺)上、頂点から5mm先 → (40, 5)
    expect(geometry.tangent2[0]).toBeCloseTo(40, 6);
    expect(geometry.tangent2[1]).toBeCloseTo(5, 6);
    // 中心: 各辺からr=5離れた内側 → (35, 5)
    expect(geometry.center?.[0]).toBeCloseTo(35, 6);
    expect(geometry.center?.[1]).toBeCloseTo(5, 6);
  });

  it("直角頂点のfilletで弧の掃引角の大きさが90度(=π-φ, φ=90度)になる", () => {
    const geometry = computeCornerGeometry([0, 0], [40, 0], [40, 40], { kind: "fillet", size: 5 });
    expect(geometry).not.toBeNull();
    if (!geometry || geometry.startAngle === undefined || geometry.endAngle === undefined) return;
    const sweep = Math.abs(geometry.endAngle - geometry.startAngle);
    expect(sweep).toBeCloseTo(Math.PI / 2, 6);
    // 開始角(接点1: (35,0)、中心(35,5)から見て真下方向) = -π/2
    expect(geometry.startAngle).toBeCloseTo(-Math.PI / 2, 6);
    // 終了角(接点2: (40,5)、中心(35,5)から見て真右方向) = 0
    expect(geometry.endAngle).toBeCloseTo(0, 6);
  });

  it("直角頂点のchamferで接点間の直線距離(斜辺)がsize*sqrt(2)になる", () => {
    const geometry = computeCornerGeometry([0, 0], [40, 0], [40, 40], { kind: "chamfer", size: 5 });
    expect(geometry).not.toBeNull();
    if (!geometry) return;
    expect(geometry.center).toBeUndefined();
    const dx = geometry.tangent2[0] - geometry.tangent1[0];
    const dy = geometry.tangent2[1] - geometry.tangent1[1];
    expect(Math.hypot(dx, dy)).toBeCloseTo(5 * Math.SQRT2, 6);
    // 接点は頂点からそれぞれ5mm(直角なのでchamferの脚長=size)
    expect(Math.hypot(geometry.tangent1[0] - 40, geometry.tangent1[1] - 0)).toBeCloseTo(5, 6);
    expect(Math.hypot(geometry.tangent2[0] - 40, geometry.tangent2[1] - 0)).toBeCloseTo(5, 6);
  });

  it("直線状(内角180度)の頂点はnullを返す(退化ケース)", () => {
    const geometry = computeCornerGeometry([0, 0], [20, 0], [40, 0], { kind: "fillet", size: 5 });
    expect(geometry).toBeNull();
  });
});

describe("polygonOutlinePoints", () => {
  it("cornersが未指定なら頂点列をそのまま返す", () => {
    expect(polygonOutlinePoints(SQUARE, undefined)).toEqual(SQUARE);
  });

  it("全頂点nullなら頂点列をそのまま返す", () => {
    expect(polygonOutlinePoints(SQUARE, [null, null, null, null])).toEqual(SQUARE);
  });

  it("頂点0(始点)にfilletを指定すると輪郭点数が増え、角の頂点(0,0)自体は含まれなくなる(頂点0のスパイク回帰テスト)", () => {
    const outline = polygonOutlinePoints(SQUARE, [{ kind: "fillet", size: 5 }, null, null, null]);
    // 頂点0が弧(segments+1点)に置き換わり、他3頂点はそのまま。
    expect(outline.length).toBe(DEFAULT_SEGMENTS_PER_ARC + 1 + 3);
    expect(outline.some(([x, y]) => x === 0 && y === 0)).toBe(false);
    // 弧の始点(頂点0を挟む前の辺=(0,40)->(0,0)上の接点、頂点から5mm手前)は(0,5)。
    expect(outline[0][0]).toBeCloseTo(0, 6);
    expect(outline[0][1]).toBeCloseTo(5, 6);
    // 弧の終点(次の辺=(0,0)->(40,0)上の接点、頂点から5mm先)は(5,0)。
    const arcEndIndex = DEFAULT_SEGMENTS_PER_ARC;
    expect(outline[arcEndIndex][0]).toBeCloseTo(5, 6);
    expect(outline[arcEndIndex][1]).toBeCloseTo(0, 6);
    // 弧の直後は頂点1=(40,0)(cornersがnullのためそのまま)。
    expect(outline[arcEndIndex + 1]).toEqual([40, 0]);
  });

  it("全4頂点(0含む)フィレットで、輪郭が閉じたポリラインとして妥当(自己交差なし・凸)になる", () => {
    const corners = [
      { kind: "fillet" as const, size: 5 },
      { kind: "fillet" as const, size: 5 },
      { kind: "fillet" as const, size: 5 },
      { kind: "fillet" as const, size: 5 },
    ];
    const outline = polygonOutlinePoints(SQUARE, corners);
    // 4隅すべてが弧(segments+1点)に置き換わる。
    expect(outline.length).toBe((DEFAULT_SEGMENTS_PER_ARC + 1) * 4);
    // すべての点が正方形の範囲[0,40]内に収まる(フィレットは角を削るだけなので外にはみ出さない)。
    for (const [x, y] of outline) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(40 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(40 + 1e-9);
    }
    // どの点も四隅の頂点そのもの(かど)ではないこと(丸められている)。
    for (const [x, y] of outline) {
      const isCorner =
        (Math.abs(x - 0) < 1e-9 && Math.abs(y - 0) < 1e-9) ||
        (Math.abs(x - 40) < 1e-9 && Math.abs(y - 0) < 1e-9) ||
        (Math.abs(x - 40) < 1e-9 && Math.abs(y - 40) < 1e-9) ||
        (Math.abs(x - 0) < 1e-9 && Math.abs(y - 40) < 1e-9);
      expect(isCorner).toBe(false);
    }
  });

  it("面取り(chamfer)は直線2点のみで角を置き換える", () => {
    const outline = polygonOutlinePoints(SQUARE, [null, { kind: "chamfer", size: 5 }, null, null]);
    // 頂点1が2点(接点)に置き換わり、他3頂点はそのまま → 4-1+2 = 5点
    expect(outline.length).toBe(5);
  });

  it("segmentsPerArcを指定すると弧の分割数が変わる", () => {
    const outline = polygonOutlinePoints(SQUARE, [{ kind: "fillet", size: 5 }, null, null, null], 4);
    expect(outline.length).toBe(4 + 1 + 3);
  });
});
