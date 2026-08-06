// src/sketch/trim.ts の単体テスト(純粋TS、WASM不要、Phase 19b)。
import { describe, expect, it } from "vitest";

import { createArcSegment, createCircleEntity, createLineSegment, createRectangleEntity } from "../../src/model";
import { trimEntityAtPoint, trimSegmentAtPoint } from "../../src/sketch/trim";

describe("trimSegmentAtPoint", () => {
  it("2箇所で交差する線分の中間区間を削除すると両側の2区間が残る(セグメント分割)", () => {
    const target = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const crossA = createLineSegment({ p1: [3, -5], p2: [3, 5] });
    const crossB = createLineSegment({ p1: [7, -5], p2: [7, 5] });
    const result = trimSegmentAtPoint([target, crossA, crossB], target.id, [5, 0]);

    expect(result).toHaveLength(4); // crossA, crossB, 左区間, 右区間
    const lines = result.filter((s) => s.id !== crossA.id && s.id !== crossB.id);
    expect(lines).toHaveLength(2);
    const xs = lines.flatMap((s) => [s.p1[0], s.p2[0]]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 6);
    expect(xs[1]).toBeCloseTo(3, 6);
    expect(xs[2]).toBeCloseTo(7, 6);
    expect(xs[3]).toBeCloseTo(10, 6);
  });

  it("1箇所で交差する線分の端点側区間をクリックすると、その区間が短縮される", () => {
    const target = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const cross = createLineSegment({ p1: [3, -5], p2: [3, 5] });
    const result = trimSegmentAtPoint([target, cross], target.id, [1, 0]);

    expect(result).toHaveLength(2); // cross, 短縮された残り区間
    const kept = result.find((s) => s.id !== cross.id);
    expect(kept).toBeDefined();
    const xs = [kept!.p1[0], kept!.p2[0]].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(3, 6);
    expect(xs[1]).toBeCloseTo(10, 6);
  });

  it("他セグメントと交点を持たないセグメントは全体が削除される", () => {
    const target = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const result = trimSegmentAtPoint([target], target.id, [5, 0]);
    expect(result).toHaveLength(0);
  });

  it("円弧セグメントも交点で区切ってトリムできる", () => {
    // 中心(0,0)半径5の上半円(p1=(-5,0) -> p2=(5,0)、bulge=-1で頂点(0,5)経由)。
    const target = createArcSegment({ p1: [-5, 0], p2: [5, 0], bulge: -1 });
    const cross = createLineSegment({ p1: [0, -1], p2: [0, 10] }); // x=0の縦線、弧の頂点(0,5)で交差
    const result = trimSegmentAtPoint([target, cross], target.id, [-3, 4]); // 左半分をクリック

    expect(result).toHaveLength(2); // cross, 右半分
    const kept = result.find((s) => s.id !== cross.id);
    expect(kept).toBeDefined();
    expect(kept!.kind).toBe("arc");
    // 残るのは頂点(0,5)から(5,0)までの右半分。
    const endpoints = [kept!.p1, kept!.p2].sort((a, b) => a[0] - b[0]);
    expect(endpoints[0][0]).toBeCloseTo(0, 5);
    expect(endpoints[0][1]).toBeCloseTo(5, 5);
    expect(endpoints[1][0]).toBeCloseTo(5, 5);
    expect(endpoints[1][1]).toBeCloseTo(0, 5);
  });

  it("T字交差(他方の端点がtargetの内部に接する)でもtargetを分割してトリムできる", () => {
    const target = createLineSegment({ p1: [0, 0], p2: [10, 0] });
    const stem = createLineSegment({ p1: [5, 0], p2: [5, 5] }); // targetの中点から生えるT字
    const result = trimSegmentAtPoint([target, stem], target.id, [2, 0]); // 左側をクリック

    expect(result).toHaveLength(2); // stem, 右側区間
    const kept = result.find((s) => s.id !== stem.id);
    expect(kept).toBeDefined();
    const xs = [kept!.p1[0], kept!.p2[0]].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(5, 6);
    expect(xs[1]).toBeCloseTo(10, 6);
  });

  it("円(entity)を横切る線分は円内部分だけをクリックすると内部区間だけが削除される(entitiesを境界に含める)", () => {
    // 中心(0,0)半径5の円と、それを横切るx軸上の線分(-10,0)->(10,0)。
    const circle = createCircleEntity({ center: [0, 0], radius: 5 });
    const target = createLineSegment({ p1: [-10, 0], p2: [10, 0] });
    const result = trimSegmentAtPoint([target], target.id, [0, 0], [circle]);

    // 円自体はtrim対象ではないため戻り値には含まれない(境界を提供するだけ)。
    expect(result).toHaveLength(2); // 左の外側区間、右の外側区間
    const xs = result.map((s) => [s.p1[0], s.p2[0]].sort((a, b) => a - b));
    xs.sort((a, b) => a[0] - b[0]);
    expect(xs[0][0]).toBeCloseTo(-10, 6);
    expect(xs[0][1]).toBeCloseTo(-5, 6);
    expect(xs[1][0]).toBeCloseTo(5, 6);
    expect(xs[1][1]).toBeCloseTo(10, 6);
  });

  it("円(entity)を横切る線分は外側部分だけをクリックすると外側区間だけが削除され円内部分が残る", () => {
    const circle = createCircleEntity({ center: [0, 0], radius: 5 });
    const target = createLineSegment({ p1: [-10, 0], p2: [10, 0] });
    const result = trimSegmentAtPoint([target], target.id, [8, 0], [circle]); // 右の外側区間をクリック

    expect(result).toHaveLength(2); // 左の外側区間、円内部分
    const xs = result.map((s) => [s.p1[0], s.p2[0]].sort((a, b) => a - b));
    xs.sort((a, b) => a[0] - b[0]);
    expect(xs[0][0]).toBeCloseTo(-10, 6);
    expect(xs[0][1]).toBeCloseTo(-5, 6);
    expect(xs[1][0]).toBeCloseTo(-5, 6);
    expect(xs[1][1]).toBeCloseTo(5, 6);
  });

  it("矩形(entity)の辺からはみ出した線分は、はみ出し部分だけをクリックすると削除され矩形内部分が残る", () => {
    // 中心(0,0)、幅10×高さ10の矩形(辺はx=-5,5 / y=-5,5)を横切るx軸上の線分。
    const rect = createRectangleEntity({ center: [0, 0], width: 10, height: 10 });
    const target = createLineSegment({ p1: [-8, 0], p2: [8, 0] });
    const result = trimSegmentAtPoint([target], target.id, [7, 0], [rect]); // 右のはみ出しをクリック

    expect(result).toHaveLength(2); // 左のはみ出し、矩形内部分
    const xs = result.map((s) => [s.p1[0], s.p2[0]].sort((a, b) => a - b));
    xs.sort((a, b) => a[0] - b[0]);
    expect(xs[0][0]).toBeCloseTo(-8, 6);
    expect(xs[0][1]).toBeCloseTo(-5, 6);
    expect(xs[1][0]).toBeCloseTo(-5, 6);
    expect(xs[1][1]).toBeCloseTo(5, 6);
  });
});

describe("trimEntityAtPoint(Phase 24: entity輪郭自体のトリム)", () => {
  it("円(entity)を横切る線分の、円周の線間(交点間)の弧をクリックするとその弧だけが消え、entityはsegmentsへ分解される", () => {
    // 中心(0,0)半径5の円を、y=3の水平線(-10,3)->(10,3)が横切る。交点は(-4,3)と(4,3)、
    // いずれも円の上半分(explodeCircleのleft(-5,0)->top(0,5)->right(5,0))上に乗る。
    const circle = createCircleEntity({ center: [0, 0], radius: 5 });
    const line = createLineSegment({ p1: [-10, 3], p2: [10, 3] });
    const result = trimEntityAtPoint([circle], circle.id, [line], [0, 5]); // 交点間の上部キャップ弧をクリック

    // circleエンティティ自体は消え、自由セグメント(line + 円の残り3本の弧)に置き換わる。
    expect(result.entities).toHaveLength(0);
    expect(result.segments).toHaveLength(4); // line, 左上の弧, 右上の弧, 下半分の弧

    const arcs = result.segments.filter((s) => s.id !== line.id);
    expect(arcs).toHaveLength(3);
    expect(arcs.every((s) => s.kind === "arc")).toBe(true);

    // 削除されたのは(-4,3)<->(4,3)間の弧: どの残存弧もこの2点を両端に持たない。
    const closeTo = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-5;
    const removedPair = arcs.some(
      (s) => (closeTo(s.p1, [-4, 3]) && closeTo(s.p2, [4, 3])) || (closeTo(s.p1, [4, 3]) && closeTo(s.p2, [-4, 3])),
    );
    expect(removedPair).toBe(false);

    // 下半分(right(5,0)->left(-5,0)、分割なし)は丸ごと残る。
    const lowerHalf = arcs.find(
      (s) => (closeTo(s.p1, [5, 0]) && closeTo(s.p2, [-5, 0])) || (closeTo(s.p1, [-5, 0]) && closeTo(s.p2, [5, 0])),
    );
    expect(lowerHalf).toBeDefined();

    // 交点(-4,3)・(4,3)は、それぞれ左上・右上の弧の片方の端点として残る(円周の連続性)。
    const hasEndpointNear = (p: [number, number]) => arcs.some((s) => closeTo(s.p1, p) || closeTo(s.p2, p));
    expect(hasEndpointNear([-4, 3])).toBe(true);
    expect(hasEndpointNear([4, 3])).toBe(true);
  });

  it("矩形(entity)の辺をクリックすると横切る線分との交点で分割され、クリックした側の区間だけが消える", () => {
    // 中心(0,0)、幅10×高さ10の矩形を、x=0の縦線(0,-8)->(0,8)が下辺(0,-5)・上辺(0,5)で横切る。
    const rect = createRectangleEntity({ center: [0, 0], width: 10, height: 10 });
    const line = createLineSegment({ p1: [0, -8], p2: [0, 8] });
    const result = trimEntityAtPoint([rect], rect.id, [line], [2, -5]); // 下辺の右半分(0,-5)->(5,-5)をクリック

    expect(result.entities).toHaveLength(0);
    // line + 矩形の残り5区間(下辺左半分, 右辺まるごと, 上辺2区間, 左辺まるごと)。
    expect(result.segments).toHaveLength(6);

    const closeTo = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
    const kept = result.segments.filter((s) => s.id !== line.id);
    expect(kept).toHaveLength(5);
    expect(kept.every((s) => s.kind === "line")).toBe(true);

    // 削除された(0,-5)->(5,-5)区間は残っていない。
    const removed = kept.some(
      (s) => (closeTo(s.p1, [0, -5]) && closeTo(s.p2, [5, -5])) || (closeTo(s.p1, [5, -5]) && closeTo(s.p2, [0, -5])),
    );
    expect(removed).toBe(false);

    // クリックしなかった側(-5,-5)->(0,-5)は残る。
    const keptHalf = kept.some(
      (s) => (closeTo(s.p1, [-5, -5]) && closeTo(s.p2, [0, -5])) || (closeTo(s.p1, [0, -5]) && closeTo(s.p2, [-5, -5])),
    );
    expect(keptHalf).toBe(true);
  });
});
