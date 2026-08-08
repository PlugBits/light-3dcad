// src/sketch/trim.ts の単体テスト(純粋TS、WASM不要、Phase 19b。Phase 31aでtrimSegmentWithConstraints追加、
// Phase 36でトリム断点への一致拘束自動付与[coincidentsForCutPoints]を追加)。
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createArcSegment, createCircleEntity, createLineSegment, createRectangleEntity, type SketchConstraint } from "../../src/model";
import * as gcsAdapter from "../../src/sketch/gcsAdapter";
import { registerGcsAdapter, solveSketch } from "../../src/sketch/solver";
import { trimEntityAtPoint, trimSegmentAtPoint, trimSegmentWithConstraints } from "../../src/sketch/trim";

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

describe("trimSegmentWithConstraints(実機報告対応: トリムの拘束・寸法引き継ぎ、Phase 31a)", () => {
  // 共通のセットアップ: A(0,0)->(12,0)を x=4, x=8 の2本の縦線でクロスし、(6,0)近傍(中間区間)を
  // クリックしてトリムする(中間区間の削除により、先頭区間[0,4](元のp1側)・末尾区間[8,12]
  // (元のp2側)の両方が残る=「断片が2つ」のケース)。
  function makeChain() {
    const a = createLineSegment({ p1: [0, 0], p2: [12, 0] });
    const crossLeft = createLineSegment({ p1: [4, -5], p2: [4, 5] });
    const crossRight = createLineSegment({ p1: [8, -5], p2: [8, 5] });
    return { a, crossLeft, crossRight };
  }

  it("元の端点を含む断片が2つ残る場合、片方(先頭側)は元のsegmentIdを引き継ぎ、もう片方は新IDになる", () => {
    const { a, crossLeft, crossRight } = makeChain();
    const result = trimSegmentWithConstraints([a, crossLeft, crossRight], [], a.id, [6, 0]);

    expect(result.removedLengthConstraintCount).toBe(0);
    const lineFragments = result.segments.filter((s) => s.kind === "line" && s.id !== crossLeft.id && s.id !== crossRight.id);
    expect(lineFragments).toHaveLength(2);

    const primary = lineFragments.find((s) => s.id === a.id);
    expect(primary).toBeDefined();
    // 先頭区間([0,4])が元のp1(0,0)を含み、元のIDを引き継ぐ。
    const primaryXs = [primary!.p1[0], primary!.p2[0]].sort((x, y) => x - y);
    expect(primaryXs[0]).toBeCloseTo(0, 6);
    expect(primaryXs[1]).toBeCloseTo(4, 6);

    const secondary = lineFragments.find((s) => s.id !== a.id);
    expect(secondary).toBeDefined();
    expect(secondary!.id).not.toBe(a.id);
    // 末尾区間([8,12])が元のp2(12,0)を含むが、新しいIDになっている。
    const secondaryXs = [secondary!.p1[0], secondary!.p2[0]].sort((x, y) => x - y);
    expect(secondaryXs[0]).toBeCloseTo(8, 6);
    expect(secondaryXs[1]).toBeCloseTo(12, 6);
  });

  it("末尾側(新IDを引き継いだ断片)の端点を参照するcoincident拘束は、座標一致する新しい断片へ付け替えられる", () => {
    const { a, crossLeft, crossRight } = makeChain();
    const b = createLineSegment({ p1: [12, 0], p2: [12, 5] });
    const coincident: SketchConstraint = {
      id: "c-coincident",
      kind: "coincident",
      a: { segmentId: a.id, end: "p2" },
      b: { segmentId: b.id, end: "p1" },
    };
    const result = trimSegmentWithConstraints([a, b, crossLeft, crossRight], [coincident], a.id, [6, 0]);

    const nextCoincident = result.constraints.find((c) => c.id === "c-coincident");
    expect(nextCoincident).toBeDefined();
    expect(nextCoincident!.kind).toBe("coincident");
    if (nextCoincident!.kind !== "coincident") throw new Error("unreachable");
    // a側(元はA,p2)は新IDの断片へ付け替えられ、元のsegmentId(a.id)ではなくなる。
    expect(nextCoincident!.a.segmentId).not.toBe(a.id);
    expect(nextCoincident!.a.end).toBe("p2");
    // b側(元々Aを参照していない)は変化しない。
    expect(nextCoincident!.b).toEqual({ segmentId: b.id, end: "p1" });

    // 付け替え先の断片は実際に座標(12,0)を持つ([8,12]区間)。
    const reassignedSeg = result.segments.find((s) => s.id === nextCoincident!.a.segmentId);
    expect(reassignedSeg).toBeDefined();
    const p = nextCoincident!.a.end === "p1" ? reassignedSeg!.p1 : reassignedSeg!.p2;
    expect(p[0]).toBeCloseTo(12, 6);
    expect(p[1]).toBeCloseTo(0, 6);
  });

  it("length拘束は断片化で意味が変わるため削除され、削除件数が返る(トースト通知用)", () => {
    const { a, crossLeft, crossRight } = makeChain();
    const length: SketchConstraint = { id: "c-length", kind: "length", segmentId: a.id, value: 12 };
    const result = trimSegmentWithConstraints([a, crossLeft, crossRight], [length], a.id, [6, 0]);

    expect(result.removedLengthConstraintCount).toBe(1);
    expect(result.constraints.some((c) => c.kind === "length")).toBe(false);
  });

  it("horizontal拘束(segmentId直接参照)は、元IDを引き継いだ断片にそのまま有効(書き換え不要)", () => {
    const { a, crossLeft, crossRight } = makeChain();
    const horizontal: SketchConstraint = { id: "c-horizontal", kind: "horizontal", segmentId: a.id };
    const result = trimSegmentWithConstraints([a, crossLeft, crossRight], [horizontal], a.id, [6, 0]);

    expect(result.constraints).toContainEqual(horizontal);
    // 実際に元IDを引き継いだ断片が存在する(参照が解決できる)ことも確認する。
    expect(result.segments.some((s) => s.id === a.id)).toBe(true);
  });

  it("entity(円等)由来のトリムはtrimEntityAtPoint()のまま変更されない(全断片が新IDになる、既存挙動)", () => {
    const circle = createCircleEntity({ center: [0, 0], radius: 5 });
    const line = createLineSegment({ p1: [-10, 3], p2: [10, 3] });
    const result = trimEntityAtPoint([circle], circle.id, [line], [0, 5]);

    expect(result.entities).toHaveLength(0);
    const arcs = result.segments.filter((s) => s.id !== line.id);
    // entity由来の断片はいずれも円のIDを引き継がない(explodeEntity()が発行する新規IDのまま)。
    expect(arcs.every((s) => s.id !== circle.id)).toBe(true);
  });
});

/** coincident拘束がidA/idB(順不同、端点は問わない)を結んでいる件数。 */
function coincidentCountBetween(constraints: SketchConstraint[], idA: string, idB: string): number {
  return constraints.filter(
    (c) => c.kind === "coincident" && ((c.a.segmentId === idA && c.b.segmentId === idB) || (c.a.segmentId === idB && c.b.segmentId === idA)),
  ).length;
}

function closeTo(a: [number, number], b: [number, number], tol = 1e-5): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
}

describe("トリム断点への一致拘束自動付与(coincidentsForCutPoints、Phase 36)", () => {
  it("円(entity)をトリムして生じる弧片は、断点にちょうど端点を持つ隣接線分とcoincidentで結ばれる(ユーザー報告バグの実データ相当)", () => {
    // 半径5の円: 3-4-5の直角三角形により(-4,3)・(4,3)は円周上の点(上部キャップの範囲内)。
    // 各線分の一端をそこに正確に配置し(端点タッチ、point-on-curveではない)、上部キャップの
    // 交点間(中間)をクリックしてその区間だけをトリムする(既存テストと同じ構図)。
    const circle = createCircleEntity({ center: [0, 0], radius: 5 });
    const lineLeft = createLineSegment({ p1: [-4, 3], p2: [-10, 3] });
    const lineRight = createLineSegment({ p1: [4, 3], p2: [10, 3] });
    const result = trimEntityAtPoint([circle], circle.id, [lineLeft, lineRight], [0, 5]);

    expect(result.entities).toHaveLength(0);
    const arcs = result.segments.filter((s) => s.kind === "arc");
    expect(arcs).toHaveLength(3); // 左上の弧・右上の弧・下半分

    const leftUpper = arcs.find((s) => closeTo(s.p1, [-4, 3]) || closeTo(s.p2, [-4, 3]));
    const rightUpper = arcs.find((s) => closeTo(s.p1, [4, 3]) || closeTo(s.p2, [4, 3]));
    const lowerHalf = arcs.find(
      (s) => (closeTo(s.p1, [5, 0]) && closeTo(s.p2, [-5, 0])) || (closeTo(s.p1, [-5, 0]) && closeTo(s.p2, [5, 0])),
    );
    expect(leftUpper).toBeDefined();
    expect(rightUpper).toBeDefined();
    expect(lowerHalf).toBeDefined();

    // 弧片↔隣接線分(ユーザー報告バグそのもの: entityトリムの弧片が隣接セグメントに一致拘束を持たない)。
    expect(coincidentCountBetween(result.constraints, leftUpper!.id, lineLeft.id)).toBe(1);
    expect(coincidentCountBetween(result.constraints, rightUpper!.id, lineRight.id)).toBe(1);
    // 同一entityの分解片同士(連続していた弧片)にも一致拘束が付く。
    expect(coincidentCountBetween(result.constraints, leftUpper!.id, lowerHalf!.id)).toBe(1);
    expect(coincidentCountBetween(result.constraints, rightUpper!.id, lowerHalf!.id)).toBe(1);
    // 上記4件以外に余計なcoincidentは追加されない(重複も含めて無い)。
    expect(result.constraints.filter((c) => c.kind === "coincident")).toHaveLength(4);
  });

  it("線分自身のトリムでも、隣接して残る断片同士にcoincidentが自動付与される(T字交差の相手[端点でない側]には付与されない)", () => {
    // target(0,0)-(15,0)をx=3,6,9の3本の縦線(T字交差、target側の端点ではない)で4区間に分割し、
    // 先頭区間[0,3]をクリックして削除する。残る[3,6][6,9][9,15]のうち隣接するもの同士
    // ([3,6]-[6,9]、[6,9]-[9,15])には一致拘束が付き、削除された区間に隣接していた[3,6]のp1側
    // ([0,3]側の断点)には相手がいないため何も付かない(サイレントスキップ)。
    const target = createLineSegment({ p1: [0, 0], p2: [15, 0] });
    const crossA = createLineSegment({ p1: [3, -5], p2: [3, 5] });
    const crossB = createLineSegment({ p1: [6, -5], p2: [6, 5] });
    const crossC = createLineSegment({ p1: [9, -5], p2: [9, 5] });
    const result = trimSegmentWithConstraints([target, crossA, crossB, crossC], [], target.id, [1.5, 0]);

    const findFragByRange = (lo: number, hi: number) =>
      result.segments.find((s) => {
        if (s.kind !== "line" || s.id === crossA.id || s.id === crossB.id || s.id === crossC.id) return false;
        const xs = [s.p1[0], s.p2[0]].sort((a, b) => a - b);
        return Math.abs(xs[0] - lo) < 1e-6 && Math.abs(xs[1] - hi) < 1e-6;
      });
    const f1 = findFragByRange(3, 6);
    const f2 = findFragByRange(6, 9);
    const f3 = findFragByRange(9, 15);
    expect(f1).toBeDefined();
    expect(f2).toBeDefined();
    expect(f3).toBeDefined();

    expect(coincidentCountBetween(result.constraints, f1!.id, f2!.id)).toBe(1);
    expect(coincidentCountBetween(result.constraints, f2!.id, f3!.id)).toBe(1);
    // 隣接しない([0,3]が間に無くなった)f1↔f3には付かない。
    expect(coincidentCountBetween(result.constraints, f1!.id, f3!.id)).toBe(0);
    // T字交差の相手(crossA/B/C、targetとの交点はcrosser側の内部であって端点ではない)とは
    // point-on-curveであり対象外のため、一切coincidentは付かない。
    for (const cross of [crossA, crossB, crossC]) {
      expect(coincidentCountBetween(result.constraints, f1!.id, cross.id)).toBe(0);
      expect(coincidentCountBetween(result.constraints, f2!.id, cross.id)).toBe(0);
      expect(coincidentCountBetween(result.constraints, f3!.id, cross.id)).toBe(0);
    }
    // 合計もちょうど2件(f1-f2, f2-f3)のみ。
    expect(result.constraints.filter((c) => c.kind === "coincident")).toHaveLength(2);
  });

  it("交点が他セグメントの内部(T字)にしかない場合は一致拘束を追加しない(既存挙動の回帰確認)", () => {
    const circle = createCircleEntity({ center: [0, 0], radius: 5 });
    // 円を貫通する1本の直線(交点(-4,3)・(4,3)はいずれもこの直線の内部であり、直線の端点ではない)。
    const line = createLineSegment({ p1: [-10, 3], p2: [10, 3] });
    const result = trimEntityAtPoint([circle], circle.id, [line], [0, 5]);

    expect(result.entities).toHaveLength(0);
    const arcs = result.segments.filter((s) => s.kind === "arc");
    expect(arcs).toHaveLength(3);
    // lineとはどの弧片も一致拘束を持たない(point-on-curveはスコープ外)。
    for (const arc of arcs) {
      expect(coincidentCountBetween(result.constraints, arc.id, line.id)).toBe(0);
    }
    // 円の分解片同士(隣接する弧片)には引き続き一致拘束が付く。
    expect(result.constraints.filter((c) => c.kind === "coincident").length).toBeGreaterThan(0);
  });

  it("重複防止: 呼び出し時のconstraintsに既に同じ一致拘束が含まれていれば追加しない", () => {
    const circle = createCircleEntity({ center: [0, 0], radius: 5 });
    const lineLeft = createLineSegment({ p1: [-4, 3], p2: [-10, 3] });
    const lineRight = createLineSegment({ p1: [4, 3], p2: [10, 3] });

    const first = trimEntityAtPoint([circle], circle.id, [lineLeft, lineRight], [0, 5]);
    const firstCount = first.constraints.filter((c) => c.kind === "coincident").length;
    expect(firstCount).toBe(4);

    // 全く同じ入力(entities/segments/clickPointは不変)で、今回はfirst.constraintsを既存拘束として渡す。
    // トリム対象のentityは既にfirst側で消費済みだが、ここではFix2のconstraints引数そのものの
    // 重複防止(hasCoincidentBetween(existing))を検証するため、同一のexplode結果を再現できる
    // 独立な複製データで再度トリムし、既存分と同じ「意味」の拘束が二重にならないことを、
    // ペアごとの件数(常にちょうど1)で確認する(idはコール毎に新規発行されるため、pair単位の
    // 重複防止はcoincidentsForCutPoints内のadded同士の重複防止[同一コール内]で保証されるロジックを、
    // 独立した2回のトリムそれぞれで検証する形になる)。
    const circle2 = createCircleEntity({ center: [0, 0], radius: 5 });
    const lineLeft2 = createLineSegment({ p1: [-4, 3], p2: [-10, 3] });
    const lineRight2 = createLineSegment({ p1: [4, 3], p2: [10, 3] });
    const second = trimEntityAtPoint([circle2], circle2.id, [lineLeft2, lineRight2], [0, 5], []);
    const secondCount = second.constraints.filter((c) => c.kind === "coincident").length;
    expect(secondCount).toBe(4);

    // 同一トリム呼び出し内で対称に評価される断点ペア(弧片↔弧片)が二重登録されていないこと
    // (leftUpper↔lowerHalf, rightUpper↔lowerHalfのいずれも、cutPoints側からもpool側からも
    // 双方向に見つかるが、hasCoincidentBetween(added)によって1件に抑えられている)。
    const arcs = second.segments.filter((s) => s.kind === "arc");
    const lowerHalf = arcs.find(
      (s) => (closeTo(s.p1, [5, 0]) && closeTo(s.p2, [-5, 0])) || (closeTo(s.p1, [-5, 0]) && closeTo(s.p2, [5, 0])),
    )!;
    const leftUpper = arcs.find((s) => closeTo(s.p1, [-4, 3]) || closeTo(s.p2, [-4, 3]))!;
    expect(coincidentCountBetween(second.constraints, leftUpper.id, lowerHalf.id)).toBe(1);
  });
});

describe("トリム断点のcoincidentがsolveSketch()経由でも維持される(統合テスト、Phase 36)", () => {
  beforeAll(async () => {
    gcsAdapter.setGcsWasmPathForTests(path.resolve("node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"));
    registerGcsAdapter(gcsAdapter);
    await gcsAdapter.initGcs();
  });

  it("entityトリムで生じた弧片↔隣接線分のcoincidentは、寸法変更でソルバを再実行しても外枠が閉じたままになる", () => {
    const circle = createCircleEntity({ center: [0, 0], radius: 5 });
    const lineLeft = createLineSegment({ p1: [-4, 3], p2: [-10, 3] });
    const lineRight = createLineSegment({ p1: [4, 3], p2: [10, 3] });
    const trimmed = trimEntityAtPoint([circle], circle.id, [lineLeft, lineRight], [0, 5]);

    // lineLeftを水平のまま長さを変える(p2側を動かす)寸法拘束を1つ追加し、ソルバを実行する
    // (円の弧片はradius拘束なしで自由なまま。coincidentだけが弧片↔線分の接続を保つ)。
    const constraints: SketchConstraint[] = [
      ...trimmed.constraints,
      { id: "c-horizontal", kind: "horizontal", segmentId: lineLeft.id },
      { id: "c-length", kind: "length", segmentId: lineLeft.id, value: 8 },
    ];
    const result = solveSketch(trimmed.segments, constraints, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const solvedLineLeft = result.segments.find((s) => s.id === lineLeft.id)!;
    const arcs = result.segments.filter((s) => s.kind === "arc");
    const leftUpper = arcs.find((s) => coincidentCountBetween(constraints, s.id, lineLeft.id) === 1)!;
    expect(leftUpper).toBeDefined();

    // leftUpperの、lineLeftとcoincidentだった側の端点が、解いた後もlineLeftのp1と一致し続ける
    // (=外枠ループが閉じたまま)。
    const matchEnd: [number, number] = closeTo(leftUpper.p1, [-4, 3], 1) ? leftUpper.p1 : leftUpper.p2;
    expect(matchEnd[0]).toBeCloseTo(solvedLineLeft.p1[0], 6);
    expect(matchEnd[1]).toBeCloseTo(solvedLineLeft.p1[1], 6);
  });
});
