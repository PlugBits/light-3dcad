// src/sketch/solver.ts の単体テスト(純粋TS、WASM不要、Phase 20a)。
// ソルバの正しさが本フェーズの最重要事項のため、代表的な拘束の組み合わせ・矛盾検出・
// 正則化(劣拘束時に無関係な点が動かない)を厚めに検証する。
import { describe, expect, it } from "vitest";

import { arcGeometryFromBulge } from "../../src/sketch/bulge";
import { solveDocumentSketches, solveSketch } from "../../src/sketch/solver";
import type { CadDocument, SketchConstraint, SketchEntity, SketchFeature, SketchSegment } from "../../src/model/types";

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

describe("solveSketch", () => {
  it("① length単独: 線分の長さを変更すると方向を維持したまま長さが解ける", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const constraints: SketchConstraint[] = [{ id: "c1", kind: "length", segmentId: "s1", value: 20 }];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    const len = dist(out.p1, out.p2);
    expect(len).toBeCloseTo(20, 4);
    // 方向(単位ベクトル)が元のまま(+X方向)であること。
    const dir = [(out.p2[0] - out.p1[0]) / len, (out.p2[1] - out.p1[1]) / len];
    expect(dir[0]).toBeCloseTo(1, 4);
    expect(dir[1]).toBeCloseTo(0, 4);
  });

  it("② 水平+length: わずかに傾いた線分が水平かつ指定長さに解ける", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0.7] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "horizontal", segmentId: "s1" },
      { id: "c2", kind: "length", segmentId: "s1", value: 25 },
    ];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    expect(out.p1[1]).toBeCloseTo(out.p2[1], 6); // 水平
    expect(dist(out.p1, out.p2)).toBeCloseTo(25, 4);
  });

  it("③ 垂直+length: わずかに傾いた線分が垂直かつ指定長さに解ける", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [0.5, 10] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "vertical", segmentId: "s1" },
      { id: "c2", kind: "length", segmentId: "s1", value: 12 },
    ];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    expect(out.p1[0]).toBeCloseTo(out.p2[0], 6); // 垂直
    expect(dist(out.p1, out.p2)).toBeCloseTo(12, 4);
  });

  it("④ coincidentで連結した2線分: fix+lengthで片方を伸ばすと、もう片方が接続点に追従する", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [10, 0], p2: [10, 10] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "fix", point: { segmentId: "a", end: "p1" } },
      { id: "c2", kind: "length", segmentId: "a", value: 15 },
      { id: "c3", kind: "coincident", a: { segmentId: "a", end: "p2" }, b: { segmentId: "b", end: "p1" } },
    ];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.segments;
    expect(outA.p1[0]).toBeCloseTo(0, 5);
    expect(outA.p1[1]).toBeCloseTo(0, 5);
    expect(outA.p2[0]).toBeCloseTo(15, 3);
    expect(outA.p2[1]).toBeCloseTo(0, 3);
    // bのp1はaのp2に追従(coincident)している。
    expect(dist(outB.p1, outA.p2)).toBeLessThan(1e-5);
  });

  it("⑤ 矩形4線分+coincident4+horizontal2+vertical2+length2(幅・高さ)で寸法変更すると矩形が正確にリサイズされる", () => {
    const bottom: SketchSegment = { id: "bottom", kind: "line", p1: [0, 0], p2: [10, 0] };
    const right: SketchSegment = { id: "right", kind: "line", p1: [10, 0], p2: [10, 6] };
    const top: SketchSegment = { id: "top", kind: "line", p1: [10, 6], p2: [0, 6] };
    const left: SketchSegment = { id: "left", kind: "line", p1: [0, 6], p2: [0, 0] };

    const constraints: SketchConstraint[] = [
      { id: "co1", kind: "coincident", a: { segmentId: "bottom", end: "p2" }, b: { segmentId: "right", end: "p1" } },
      { id: "co2", kind: "coincident", a: { segmentId: "right", end: "p2" }, b: { segmentId: "top", end: "p1" } },
      { id: "co3", kind: "coincident", a: { segmentId: "top", end: "p2" }, b: { segmentId: "left", end: "p1" } },
      { id: "co4", kind: "coincident", a: { segmentId: "left", end: "p2" }, b: { segmentId: "bottom", end: "p1" } },
      { id: "h1", kind: "horizontal", segmentId: "bottom" },
      { id: "h2", kind: "horizontal", segmentId: "top" },
      { id: "v1", kind: "vertical", segmentId: "right" },
      { id: "v2", kind: "vertical", segmentId: "left" },
      { id: "len-w", kind: "length", segmentId: "bottom", value: 20 },
      { id: "len-h", kind: "length", segmentId: "right", value: 15 },
      { id: "fix1", kind: "fix", point: { segmentId: "bottom", end: "p1" } },
    ];

    const result = solveSketch([bottom, right, top, left], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.segments.map((s) => [s.id, s]));
    const outBottom = byId.get("bottom")!;
    const outRight = byId.get("right")!;
    const outTop = byId.get("top")!;
    const outLeft = byId.get("left")!;

    const TOL = 3; // toBeCloseTo桁数
    expect(outBottom.p1[0]).toBeCloseTo(0, TOL);
    expect(outBottom.p1[1]).toBeCloseTo(0, TOL);
    expect(outBottom.p2[0]).toBeCloseTo(20, TOL);
    expect(outBottom.p2[1]).toBeCloseTo(0, TOL);
    expect(outRight.p2[0]).toBeCloseTo(20, TOL);
    expect(outRight.p2[1]).toBeCloseTo(15, TOL);
    expect(outTop.p2[0]).toBeCloseTo(0, TOL);
    expect(outTop.p2[1]).toBeCloseTo(15, TOL);
    expect(outLeft.p2[0]).toBeCloseTo(0, TOL);
    expect(outLeft.p2[1]).toBeCloseTo(0, TOL);
    // 全ての接続点が一致している(coincident)こと。
    expect(dist(outBottom.p2, outRight.p1)).toBeLessThan(1e-4);
    expect(dist(outRight.p2, outTop.p1)).toBeLessThan(1e-4);
    expect(dist(outTop.p2, outLeft.p1)).toBeLessThan(1e-4);
    expect(dist(outLeft.p2, outBottom.p1)).toBeLessThan(1e-4);
  });

  it("⑥ 同じ線分に矛盾するlength拘束(10と20)を与えるとconflictingになる", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "length", segmentId: "s1", value: 10 },
      { id: "c2", kind: "length", segmentId: "s1", value: 20 },
    ];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicting).toBe(true);
  });

  it("⑥' 三角不等式を破るdistance拘束の組でconflictingになる", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [1, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [1, 5], p2: [2, 5] };
    const c: SketchSegment = { id: "c", kind: "line", p1: [5, 10], p2: [6, 10] };
    // A-B間, B-C間はそれぞれ短い距離(1)、A-C間は三角不等式的に不可能な100を要求する。
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distance", a: { segmentId: "a", end: "p1" }, b: { segmentId: "b", end: "p1" }, value: 1 },
      { id: "d2", kind: "distance", a: { segmentId: "b", end: "p1" }, b: { segmentId: "c", end: "p1" }, value: 1 },
      { id: "d3", kind: "distance", a: { segmentId: "a", end: "p1" }, b: { segmentId: "c", end: "p1" }, value: 100 },
    ];
    const result = solveSketch([a, b, c], constraints);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicting).toBe(true);
  });

  it("⑦ distance拘束: 無関係な2線分の端点間距離が指定値に解ける", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [1, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [5, 5], p2: [6, 5] };
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distance", a: { segmentId: "a", end: "p1" }, b: { segmentId: "b", end: "p2" }, value: 30 },
    ];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.segments.find((s) => s.id === "a")!;
    const outB = result.segments.find((s) => s.id === "b")!;
    expect(dist(outA.p1, outB.p2)).toBeCloseTo(30, 3);
  });

  it("⑧ radius拘束: 半円の半径を変更すると弦長(端点間距離)がbulge一定のまま調整される", () => {
    // p1=(-5,0) -> p2=(5,0)、bulge=1(挟角180度)の半円。半径=弦長/2=5。
    const seg: SketchSegment = { id: "arc1", kind: "arc", p1: [-5, 0], p2: [5, 0], bulge: 1 };
    const constraints: SketchConstraint[] = [{ id: "r1", kind: "radius", segmentId: "arc1", value: 8 }];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    expect(out.kind).toBe("arc");
    expect(out.bulge).toBeCloseTo(1, 6); // bulge(挟角)は維持される。
    const geom = arcGeometryFromBulge(out.p1, out.p2, out.bulge ?? 0);
    expect(geom).not.toBeNull();
    expect(geom!.radius).toBeCloseTo(8, 3);
  });

  it("⑨ 正則化の検証: 劣拘束時、拘束と無関係なセグメントの点は一切動かない", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const unrelated: SketchSegment = { id: "u", kind: "line", p1: [100, 100], p2: [123.456, 78.9] };
    const constraints: SketchConstraint[] = [{ id: "c1", kind: "length", segmentId: "a", value: 30 }];
    const result = solveSketch([a, unrelated], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outU = result.segments.find((s) => s.id === "u")!;
    expect(outU.p1[0]).toBeCloseTo(100, 8);
    expect(outU.p1[1]).toBeCloseTo(100, 8);
    expect(outU.p2[0]).toBeCloseTo(123.456, 8);
    expect(outU.p2[1]).toBeCloseTo(78.9, 8);
  });

  it("⑩ T字接合(3本が1点でcoincident)で1本の伸長が他の2本の接続点に伝播する", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [10, 0], p2: [10, 10] };
    const c: SketchSegment = { id: "c", kind: "line", p1: [10, 0], p2: [20, -5] };
    const constraints: SketchConstraint[] = [
      { id: "fix1", kind: "fix", point: { segmentId: "a", end: "p1" } },
      { id: "len1", kind: "length", segmentId: "a", value: 15 },
      { id: "co1", kind: "coincident", a: { segmentId: "a", end: "p2" }, b: { segmentId: "b", end: "p1" } },
      { id: "co2", kind: "coincident", a: { segmentId: "a", end: "p2" }, b: { segmentId: "c", end: "p1" } },
      { id: "h1", kind: "horizontal", segmentId: "a" },
    ];
    const result = solveSketch([a, b, c], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.segments.find((s) => s.id === "a")!;
    const outB = result.segments.find((s) => s.id === "b")!;
    const outC = result.segments.find((s) => s.id === "c")!;
    expect(outA.p2[0]).toBeCloseTo(15, 3);
    expect(outA.p2[1]).toBeCloseTo(0, 3);
    expect(dist(outB.p1, outA.p2)).toBeLessThan(1e-4);
    expect(dist(outC.p1, outA.p2)).toBeLessThan(1e-4);
  });

  it("⑪ 拘束が空配列の場合は入力segmentsをそのまま返す(恒等変換)", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [1, 2], p2: [3, 4] };
    const result = solveSketch([seg], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments).toEqual([seg]);
    expect(result.segments[0]).not.toBe(seg); // 新しいオブジェクトであること(非破壊)。
  });

  it("⑫ segmentsが空配列の場合は空配列を返す", () => {
    const result = solveSketch([], [{ id: "c1", kind: "horizontal", segmentId: "missing" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments).toEqual([]);
  });

  it("⑬ fix拘束された点は、他の拘束から張力がかかっても厳密にその場に留まる", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [1, 1] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [1, 1], p2: [50, 50] };
    const constraints: SketchConstraint[] = [
      { id: "fix1", kind: "fix", point: { segmentId: "a", end: "p1" } },
      { id: "co1", kind: "coincident", a: { segmentId: "a", end: "p2" }, b: { segmentId: "b", end: "p1" } },
      { id: "len1", kind: "length", segmentId: "b", value: 200 },
    ];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.segments.find((s) => s.id === "a")!;
    expect(outA.p1[0]).toBeCloseTo(0, 8);
    expect(outA.p1[1]).toBeCloseTo(0, 8);
  });

  it("⑭ 円弧セグメントのkind/id/bulgeは解いた後もそのまま保たれる(位置のみ更新)", () => {
    const seg: SketchSegment = { id: "arc-x", kind: "arc", p1: [0, 0], p2: [10, 0], bulge: 0.5 };
    const constraints: SketchConstraint[] = [{ id: "c1", kind: "length", segmentId: "arc-x", value: 20 }];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    expect(out.id).toBe("arc-x");
    expect(out.kind).toBe("arc");
    expect(out.bulge).toBe(0.5);
  });
});

describe("solveSketch circleエンティティの位置拘束(Phase 22)", () => {
  function circle(id: string, center: [number, number], radius = 5): Extract<SketchEntity, { kind: "circle" }> {
    return { kind: "circle", id, center, radius };
  }

  it("① distanceEntityOrigin: 円の中心↔原点の距離が指定値に解ける(方向は維持)", () => {
    const c = circle("c1", [10, 0]);
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distanceEntityOrigin", entity: { entityId: "c1" }, value: 25 },
    ];
    const result = solveSketch([], constraints, [c]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.entities[0];
    expect(out.kind).toBe("circle");
    if (out.kind !== "circle") return;
    expect(dist(out.center, [0, 0])).toBeCloseTo(25, 4);
    // 方向(+X)が維持されている。
    expect(out.center[1]).toBeCloseTo(0, 4);
  });

  it("② distanceEntityEntity: 2円の中心間距離が指定値に解ける", () => {
    const a = circle("a", [0, 0]);
    const b = circle("b", [5, 0]);
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distanceEntityEntity", a: { entityId: "a" }, b: { entityId: "b" }, value: 40 },
    ];
    const result = solveSketch([], constraints, [a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.entities.find((e) => e.id === "a")!;
    const outB = result.entities.find((e) => e.id === "b")!;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    expect(dist(outA.center, outB.center)).toBeCloseTo(40, 4);
  });

  it("②a distanceEntityEntity(axis:x): 2円のX距離のみが指定値に解け、Y座標は変わらない", () => {
    const a = circle("a", [0, 0]);
    const b = circle("b", [5, 8]);
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distanceEntityEntity", a: { entityId: "a" }, b: { entityId: "b" }, value: 30, axis: "x" },
    ];
    const result = solveSketch([], constraints, [a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.entities.find((e) => e.id === "a")!;
    const outB = result.entities.find((e) => e.id === "b")!;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    expect(Math.abs(outB.center[0] - outA.center[0])).toBeCloseTo(30, 3);
    // Y方向は拘束されていないため、入力の相対Y差(8)付近を維持する(正則化により入力形状に近い解を選ぶ)。
    expect(outB.center[1] - outA.center[1]).toBeCloseTo(8, 2);
  });

  it("②b distanceEntityEntity(axis:y): 2円のY距離のみが指定値に解け、X座標は変わらない", () => {
    const a = circle("a", [0, 0]);
    const b = circle("b", [8, 5]);
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distanceEntityEntity", a: { entityId: "a" }, b: { entityId: "b" }, value: 20, axis: "y" },
    ];
    const result = solveSketch([], constraints, [a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.entities.find((e) => e.id === "a")!;
    const outB = result.entities.find((e) => e.id === "b")!;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    expect(Math.abs(outB.center[1] - outA.center[1])).toBeCloseTo(20, 3);
    expect(outB.center[0] - outA.center[0]).toBeCloseTo(8, 2);
  });

  it("②c distanceEntityEntity(axis省略): 従来通り中心間の直線距離として解ける(後方互換)", () => {
    const a = circle("a", [0, 0]);
    const b = circle("b", [3, 4]);
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distanceEntityEntity", a: { entityId: "a" }, b: { entityId: "b" }, value: 25 },
    ];
    const result = solveSketch([], constraints, [a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.entities.find((e) => e.id === "a")!;
    const outB = result.entities.find((e) => e.id === "b")!;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    expect(dist(outA.center, outB.center)).toBeCloseTo(25, 4);
  });

  it("③ distanceEntityLine(entityEdge): rectangleを固定すれば円の中心↔rectangle辺の垂直距離が指定値に解ける(辺は動かない)", () => {
    const c = circle("c1", [5, 5]);
    const rect: SketchEntity = { kind: "rectangle", id: "r1", center: [0, 0], width: 20, height: 20 };
    // rectangleのedgeIndex0(下辺、y=-10の水平線)からの距離を30に指定 => 中心のy座標が20になる(現在+y側)。
    // rectangleにfixEntityを付けて固定するため、辺は動かず円だけが動く(矩形・多角形をソルバで
    // 動かせるようにする改善で、rectangleもデフォルトでは動きうるようになったため、旧来の
    // 「辺は動かない」挙動を再現するには明示的な固定が必要になった)。
    const constraints: SketchConstraint[] = [
      {
        id: "d1",
        kind: "distanceEntityLine",
        entity: { entityId: "c1" },
        line: { kind: "entityEdge", entityId: "r1", edgeIndex: 0 },
        value: 30,
      },
      { id: "fix1", kind: "fixEntity", entity: { entityId: "r1" } },
    ];
    const result = solveSketch([], constraints, [c, rect]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outC = result.entities.find((e) => e.id === "c1")!;
    const outR = result.entities.find((e) => e.id === "r1")!;
    if (outC.kind !== "circle" || outR.kind !== "rectangle") throw new Error("unexpected kind");
    expect(outC.center[1]).toBeCloseTo(20, 3);
    // rectangle自体は動いていない(fixEntity)。center[0]は-0になりうるためtoBeCloseToで比較する。
    expect(outR.center[0]).toBeCloseTo(rect.kind === "rectangle" ? rect.center[0] : 0, 6);
    expect(outR.center[1]).toBeCloseTo(rect.kind === "rectangle" ? rect.center[1] : 0, 6);
    expect(outR.width).toBe(20);
    expect(outR.height).toBe(20);
  });

  it("③a distanceEntityLine(entityEdge): 円を固定するとrectangle側(辺)が並進して距離を満たす", () => {
    const c = circle("c1", [5, 5]);
    const rect: SketchEntity = { kind: "rectangle", id: "r1", center: [0, 0], width: 20, height: 20 };
    // 円を固定して同じ拘束(edgeIndex0=下辺との距離30)を課すと、rectangleの中心が-y方向に並進して
    // (中心のyが-20になる)距離を満たす(円は動かない)。
    const constraints: SketchConstraint[] = [
      { id: "fixc", kind: "fixEntity", entity: { entityId: "c1" } },
      {
        id: "d1",
        kind: "distanceEntityLine",
        entity: { entityId: "c1" },
        line: { kind: "entityEdge", entityId: "r1", edgeIndex: 0 },
        value: 30,
      },
    ];
    const result = solveSketch([], constraints, [c, rect]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outC = result.entities.find((e) => e.id === "c1")!;
    const outR = result.entities.find((e) => e.id === "r1")!;
    if (outC.kind !== "circle" || outR.kind !== "rectangle") throw new Error("unexpected kind");
    // 円は動いていない(fixEntity)。
    expect(outC.center).toEqual(c.center);
    // rectangleの中心が並進して距離30を満たす(下辺は中心よりheight/2=10下、円のyは5なので
    // 中心y = 5 - 30 + 10 = -15)。
    expect(outR.center[1]).toBeCloseTo(-15, 3);
    expect(outR.center[0]).toBeCloseTo(0, 3);
    expect(outR.width).toBe(20);
    expect(outR.height).toBe(20);
  });

  it("③b distanceEntityLine(entityEdge、polygon): 円を固定するとpolygon側が剛体並進して距離を満たす(頂点の相対位置は維持)", () => {
    const c = circle("c1", [0, 30]);
    // 正方形polygon(辺0: [-10,-10]→[10,-10]、下辺)。
    const poly: SketchEntity = {
      kind: "polygon",
      id: "p1",
      points: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
    };
    const constraints: SketchConstraint[] = [
      { id: "fixc", kind: "fixEntity", entity: { entityId: "c1" } },
      {
        id: "d1",
        kind: "distanceEntityLine",
        entity: { entityId: "c1" },
        line: { kind: "entityEdge", entityId: "p1", edgeIndex: 0 },
        value: 50,
      },
    ];
    const result = solveSketch([], constraints, [c, poly]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outC = result.entities.find((e) => e.id === "c1")!;
    const outP = result.entities.find((e) => e.id === "p1")!;
    if (outC.kind !== "circle" || outP.kind !== "polygon") throw new Error("unexpected kind");
    expect(outC.center).toEqual(c.center);
    // 円中心y=30、下辺との距離50を満たすには下辺がy=-20になる必要がある(元は-10なので-10だけ並進)。
    expect(outP.points[0][1]).toBeCloseTo(-20, 3);
    expect(outP.points[1][1]).toBeCloseTo(-20, 3);
    // 剛体並進なので頂点間の相対位置(辺の長さ=20)は維持される。
    expect(outP.points[1][0] - outP.points[0][0]).toBeCloseTo(20, 3);
    // X方向は拘束されていないため、正則化により入力(0)に近いまま。
    expect(outP.points[0][0]).toBeCloseTo(-10, 2);
  });

  it("③c fixEntity: circleとrectangleを両方固定した状態でdistanceEntityLineが矛盾すれば検出する", () => {
    const c = circle("c1", [5, 5]);
    const rect: SketchEntity = { kind: "rectangle", id: "r1", center: [0, 0], width: 20, height: 20 };
    // 現在の距離(下辺との距離=15)と異なる値(30)を要求するが、両方固定されているためどちらも動けず矛盾する。
    const constraints: SketchConstraint[] = [
      { id: "fixc", kind: "fixEntity", entity: { entityId: "c1" } },
      { id: "fixr", kind: "fixEntity", entity: { entityId: "r1" } },
      {
        id: "d1",
        kind: "distanceEntityLine",
        entity: { entityId: "c1" },
        line: { kind: "entityEdge", entityId: "r1", edgeIndex: 0 },
        value: 30,
      },
    ];
    const result = solveSketch([], constraints, [c, rect]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicting).toBe(true);
  });

  it("③d distanceEntityLine(segmentEdge): 円を固定すると自由な線分(vertical拘束付き)が平行移動して距離を満たす(寸法ツールが実際に生成する形式の回帰テスト、ユーザー報告対応)", () => {
    // 前回コミット(19bd54d)のバグ再現条件: 矩形を線分ツールで描いた場合(4本の線分チェーン、
    // rectangle/polygonエンティティではない)、CadViewer.ts側は以前distanceEntityLineの
    // lineを常にrefEdge(ピック時点の座標を凍結)で作っていたため、円を固定して距離を変更すると
    // 辺・円のどちらも動けず必ず矛盾になっていた(ブラウザ再現・ユーザー報告に一致)。
    // segmentEdge(この改善で追加)はentityEdgeと同じく「今の値」から解決するため、線分自体が動く。
    // verticalは実際の線分ツール確定時にbuildAutoConstraintsForChain(src/sketch/autoConstraints.ts)
    // が軸ロックで付与する拘束を模したもの(無ければ線分が斜めに傾いて解かれてしまう、既知の制限)。
    const c = circle("c1", [0, 0]);
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [10, -10], p2: [10, 10] };
    const constraints: SketchConstraint[] = [
      { id: "fixc", kind: "fixEntity", entity: { entityId: "c1" } },
      { id: "vert", kind: "vertical", segmentId: "s1" },
      {
        id: "d1",
        kind: "distanceEntityLine",
        entity: { entityId: "c1" },
        line: { kind: "segmentEdge", segmentId: "s1" },
        value: 25,
      },
    ];
    const result = solveSketch([seg], constraints, [c]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outC = result.entities.find((e) => e.id === "c1")!;
    if (outC.kind !== "circle") throw new Error("not circle");
    // 円は動いていない(fixEntity)。center[0]/[1]は-0になりうるためtoBeCloseToで比較する。
    expect(outC.center[0]).toBeCloseTo(c.center[0], 6);
    expect(outC.center[1]).toBeCloseTo(c.center[1], 6);
    // 線分が平行移動してx=25(距離25)を満たし、vertical拘束によりp1/p2のxが揃ったまま解ける
    // (segmentEdgeでなくrefEdgeのままだったなら、線分は固定線扱いとなり残差が変化しないため
    // このケースは必ず矛盾[conflicting]になっていた)。
    const outSeg = result.segments.find((s) => s.id === "s1")!;
    expect(outSeg.p1[0]).toBeCloseTo(25, 3);
    expect(outSeg.p2[0]).toBeCloseTo(25, 3);
  });

  it("③e distanceEntityLine(segmentEdge): 円・線分の双方を固定すると矛盾を検出する(segmentEdgeもfixEntity/fix同様に凍結できることの確認)", () => {
    const c = circle("c1", [0, 0]);
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [10, -10], p2: [10, 10] };
    const constraints: SketchConstraint[] = [
      { id: "fixc", kind: "fixEntity", entity: { entityId: "c1" } },
      { id: "fixp1", kind: "fix", point: { segmentId: "s1", end: "p1" } },
      { id: "fixp2", kind: "fix", point: { segmentId: "s1", end: "p2" } },
      {
        id: "d1",
        kind: "distanceEntityLine",
        entity: { entityId: "c1" },
        line: { kind: "segmentEdge", segmentId: "s1" },
        value: 25,
      },
    ];
    const result = solveSketch([seg], constraints, [c]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicting).toBe(true);
  });

  it("④ distanceEntityLine(refEdge): ボディ端面参照エッジのスナップショット座標を固定線として解く", () => {
    const c = circle("c1", [0, 5]);
    const constraints: SketchConstraint[] = [
      {
        id: "d1",
        kind: "distanceEntityLine",
        entity: { entityId: "c1" },
        line: { kind: "refEdge", p1: [-10, 0], p2: [10, 0] },
        value: 15,
      },
    ];
    const result = solveSketch([], constraints, [c]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.entities[0];
    if (out.kind !== "circle") throw new Error("not circle");
    expect(out.center[1]).toBeCloseTo(15, 4);
  });

  it("⑤ fixEntity: 固定した円は他の円との距離拘束があっても動かず、もう一方が動く", () => {
    const fixed = circle("fixed", [0, 0]);
    const movable = circle("movable", [5, 0]);
    const constraints: SketchConstraint[] = [
      { id: "fix1", kind: "fixEntity", entity: { entityId: "fixed" } },
      { id: "d1", kind: "distanceEntityEntity", a: { entityId: "fixed" }, b: { entityId: "movable" }, value: 50 },
    ];
    const result = solveSketch([], constraints, [fixed, movable]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outFixed = result.entities.find((e) => e.id === "fixed")!;
    const outMovable = result.entities.find((e) => e.id === "movable")!;
    if (outFixed.kind !== "circle" || outMovable.kind !== "circle") throw new Error("not circle");
    expect(outFixed.center[0]).toBeCloseTo(0, 6);
    expect(outFixed.center[1]).toBeCloseTo(0, 6);
    expect(dist(outFixed.center, outMovable.center)).toBeCloseTo(50, 3);
  });

  it("⑥ fixEntityと矛盾するdistanceEntityOriginでconflictingになる(固定点は原点そのものだが距離30を要求)", () => {
    const c = circle("c1", [0, 0]);
    const constraints: SketchConstraint[] = [
      { id: "fix1", kind: "fixEntity", entity: { entityId: "c1" } },
      { id: "d1", kind: "distanceEntityOrigin", entity: { entityId: "c1" }, value: 30 },
    ];
    const result = solveSketch([], constraints, [c]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicting).toBe(true);
  });

  it("⑦ segmentsとcircleが混在していても、それぞれの拘束が独立に解ける", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const c = circle("c1", [3, 3]);
    const constraints: SketchConstraint[] = [
      { id: "len1", kind: "length", segmentId: "s1", value: 20 },
      { id: "d1", kind: "distanceEntityOrigin", entity: { entityId: "c1" }, value: 10 },
    ];
    const result = solveSketch([seg], constraints, [c]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(dist(result.segments[0].p1, result.segments[0].p2)).toBeCloseTo(20, 4);
    const outC = result.entities[0];
    if (outC.kind !== "circle") throw new Error("not circle");
    expect(dist(outC.center, [0, 0])).toBeCloseTo(10, 4);
  });
});

describe("solveSketch 原点系拘束(distancePointOrigin/coincidentOrigin、追加項目)", () => {
  function circle(id: string, center: [number, number], radius = 5): Extract<SketchEntity, { kind: "circle" }> {
    return { kind: "circle", id, center, radius };
  }

  it("① distancePointOrigin: 線分端点↔原点の距離が指定値に解ける(originLocal省略時はローカル原点[0,0]基準)", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [10, 0], p2: [20, 0] };
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distancePointOrigin", point: { segmentId: "s1", end: "p1" }, value: 25 },
    ];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    expect(dist(out.p1, [0, 0])).toBeCloseTo(25, 4);
    // p2は端点p1の拘束から独立(正則化により元の相対位置に近い解を選ぶ)。
  });

  it("② coincidentOrigin(線分端点): 端点が原点(ローカル[0,0])に一致するよう解ける", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [10, 5], p2: [20, 5] };
    const constraints: SketchConstraint[] = [
      { id: "o1", kind: "coincidentOrigin", point: { segmentId: "s1", end: "p1" } },
    ];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    expect(out.p1[0]).toBeCloseTo(0, 4);
    expect(out.p1[1]).toBeCloseTo(0, 4);
  });

  it("③ coincidentOrigin(circle)+originLocal: 面上スケッチのワールド原点投影位置(ローカル[0,0]以外)に円の中心が一致する", () => {
    // originLocal=[5,-3]は「面上スケッチでワールド原点をスケッチ平面へ投影した点」のスナップショット
    // (src/sketch/originSnapshot.tsが評価のたびにsketchPlanesから計算して書き込む値に相当)を模している。
    const c = circle("c1", [10, 10]);
    const constraints: SketchConstraint[] = [
      { id: "o1", kind: "coincidentOrigin", point: { entityId: "c1" }, originLocal: [5, -3] },
    ];
    const result = solveSketch([], constraints, [c]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.entities[0];
    if (out.kind !== "circle") throw new Error("not circle");
    expect(out.center[0]).toBeCloseTo(5, 4);
    expect(out.center[1]).toBeCloseTo(-3, 4);
  });

  it("④ distanceEntityOrigin+originLocal(仕様変更、既存拘束との併用): 面上スケッチでワールド原点の投影位置基準の距離に解ける", () => {
    // 例: 箱を(30,20)中心で作った上面スケッチのように、ワールド原点の投影位置がスケッチの
    // ローカル(0,0)と一致しないケース。originLocal=[5,5]を「原点」として距離20を指定する。
    const c = circle("c1", [5, 0]);
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distanceEntityOrigin", entity: { entityId: "c1" }, value: 20, originLocal: [5, 5] },
    ];
    const result = solveSketch([], constraints, [c]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.entities[0];
    if (out.kind !== "circle") throw new Error("not circle");
    expect(dist(out.center, [5, 5])).toBeCloseTo(20, 4);
    // ローカル(0,0)基準では無いことの確認(誤って[0,0]を使うと26.9程度になり20にならない)。
    expect(dist(out.center, [0, 0])).not.toBeCloseTo(20, 1);
  });

  it("⑤ coincidentOriginとfixEntityが矛盾するとconflictingになる(固定した円を原点一致させようとする)", () => {
    const c = circle("c1", [10, 10]);
    const constraints: SketchConstraint[] = [
      { id: "fix1", kind: "fixEntity", entity: { entityId: "c1" } },
      { id: "o1", kind: "coincidentOrigin", point: { entityId: "c1" } },
    ];
    const result = solveSketch([], constraints, [c]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicting).toBe(true);
  });
});

describe("solveSketch 幾何拘束(perpendicular/concentric/tangent、Phase 23)", () => {
  function circle(id: string, center: [number, number], radius = 5): Extract<SketchEntity, { kind: "circle" }> {
    return { kind: "circle", id, center, radius };
  }

  it("① perpendicular: わずかに傾いた2直線が垂直に解ける(内積が0に収束)", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0.3] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [5, -5], p2: [5.2, 5] };
    const constraints: SketchConstraint[] = [{ id: "c1", kind: "perpendicular", a: "a", b: "b" }];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.segments;
    const dax = outA.p2[0] - outA.p1[0];
    const day = outA.p2[1] - outA.p1[1];
    const dbx = outB.p2[0] - outB.p1[0];
    const dby = outB.p2[1] - outB.p1[1];
    const dot = dax * dbx + day * dby;
    expect(dot).toBeCloseTo(0, 3);
  });

  it("② perpendicular + length: 垂直を維持したまま片方の長さを指定値に解ける", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0.4] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [10, 0], p2: [10.3, 8] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "perpendicular", a: "a", b: "b" },
      { id: "c2", kind: "length", segmentId: "b", value: 12 },
    ];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.segments;
    const dax = outA.p2[0] - outA.p1[0];
    const day = outA.p2[1] - outA.p1[1];
    const dbx = outB.p2[0] - outB.p1[0];
    const dby = outB.p2[1] - outB.p1[1];
    expect(dax * dbx + day * dby).toBeCloseTo(0, 3);
    expect(dist(outB.p1, outB.p2)).toBeCloseTo(12, 3);
  });

  it("③ concentric: 2円の中心が一致するように解ける", () => {
    const c1 = circle("c1", [0, 0], 5);
    const c2 = circle("c2", [8, 3], 2);
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "concentric", a: { entityId: "c1" }, b: { entityId: "c2" } },
    ];
    const result = solveSketch([], constraints, [c1, c2]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.entities;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    expect(dist(outA.center, outB.center)).toBeLessThan(1e-4);
  });

  it("④ tangent(円↔直線): 中心↔直線の距離が半径に一致するように解ける", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [20, 0] };
    const c = circle("c1", [10, 3], 5);
    const constraints: SketchConstraint[] = [
      { id: "t1", kind: "tangent", entity: { entityId: "c1" }, target: { kind: "segment", segmentId: "s1" } },
    ];
    const result = solveSketch([seg], constraints, [c]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outSeg = result.segments[0];
    const outC = result.entities[0];
    if (outC.kind !== "circle") throw new Error("not circle");
    const dx = outSeg.p2[0] - outSeg.p1[0];
    const dy = outSeg.p2[1] - outSeg.p1[1];
    const len = Math.hypot(dx, dy);
    const cross = (outC.center[0] - outSeg.p1[0]) * dy - (outC.center[1] - outSeg.p1[1]) * dx;
    const distToLine = Math.abs(cross) / len;
    expect(distToLine).toBeCloseTo(5, 3);
  });

  it("⑤ tangent(円↔円、外接): 中心間距離がr1+r2に解ける", () => {
    const c1 = circle("c1", [0, 0], 5);
    const c2 = circle("c2", [8, 0], 3);
    const constraints: SketchConstraint[] = [
      {
        id: "t1",
        kind: "tangent",
        entity: { entityId: "c1" },
        target: { kind: "entity", entityId: "c2", mode: "external" },
      },
    ];
    const result = solveSketch([], constraints, [c1, c2]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.entities;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    expect(dist(outA.center, outB.center)).toBeCloseTo(8, 3);
  });

  it("⑥ tangent(円↔円、内接)+矛盾検出: 内接目標(|r1-r2|)に解け、さらに矛盾する外接指定はconflictingになる", () => {
    const c1 = circle("c1", [0, 0], 5);
    const c2 = circle("c2", [1.5, 0], 2);
    const constraints: SketchConstraint[] = [
      {
        id: "t1",
        kind: "tangent",
        entity: { entityId: "c1" },
        target: { kind: "entity", entityId: "c2", mode: "internal" },
      },
    ];
    const result = solveSketch([], constraints, [c1, c2]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.entities;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    expect(dist(outA.center, outB.center)).toBeCloseTo(3, 3); // |5-2|

    // 同じ2円に外接(r1+r2=7)も同時指定すると内接(3)と両立せず矛盾する。
    const conflicting: SketchConstraint[] = [
      ...constraints,
      {
        id: "t2",
        kind: "tangent",
        entity: { entityId: "c1" },
        target: { kind: "entity", entityId: "c2", mode: "external" },
      },
    ];
    const conflictResult = solveSketch([], conflicting, [c1, c2]);
    expect(conflictResult.ok).toBe(false);
    if (conflictResult.ok) return;
    expect(conflictResult.conflicting).toBe(true);
  });
});

describe("solveSketch 線分↔線分の寸法(distanceLineLine/angleLineLine、Phase 24)", () => {
  it("① distanceLineLine: ほぼ平行な2直線が、指定距離だけ離れた平行線に解ける", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0.1] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [0, 4], p2: [10, 4.2] };
    const constraints: SketchConstraint[] = [{ id: "c1", kind: "distanceLineLine", a: "a", b: "b", value: 8 }];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.segments;
    // 平行(方向ベクトルが揃う)であること。
    const dax = outA.p2[0] - outA.p1[0];
    const day = outA.p2[1] - outA.p1[1];
    const dbx = outB.p2[0] - outB.p1[0];
    const dby = outB.p2[1] - outB.p1[1];
    const cross = dax * dby - day * dbx;
    expect(cross).toBeCloseTo(0, 3);
    // aの両端点それぞれから直線bまでの距離が8mmに解けていること。
    const lenB = Math.hypot(dbx, dby);
    const distP1 = Math.abs((outA.p1[0] - outB.p1[0]) * dby - (outA.p1[1] - outB.p1[1]) * dbx) / lenB;
    const distP2 = Math.abs((outA.p2[0] - outB.p1[0]) * dby - (outA.p2[1] - outB.p1[1]) * dbx) / lenB;
    expect(distP1).toBeCloseTo(8, 3);
    expect(distP2).toBeCloseTo(8, 3);
  });

  it("② distanceLineLine + length: 平行距離を維持したまま片方の長さも指定値に解ける(併用)", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [0, 5], p2: [10, 5.3] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "distanceLineLine", a: "a", b: "b", value: 6 },
      { id: "c2", kind: "length", segmentId: "b", value: 15 },
    ];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.segments;
    expect(dist(outB.p1, outB.p2)).toBeCloseTo(15, 3);
    const dbx = outB.p2[0] - outB.p1[0];
    const dby = outB.p2[1] - outB.p1[1];
    const lenB = Math.hypot(dbx, dby);
    const distP1 = Math.abs((outA.p1[0] - outB.p1[0]) * dby - (outA.p1[1] - outB.p1[1]) * dbx) / lenB;
    const distP2 = Math.abs((outA.p2[0] - outB.p1[0]) * dby - (outA.p2[1] - outB.p1[1]) * dbx) / lenB;
    expect(distP1).toBeCloseTo(6, 2);
    expect(distP2).toBeCloseTo(6, 2);
  });

  it("③ angleLineLine: 角度90度を指定すると垂直相当に解ける(内積が0に収束)", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0.3] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [5, -5], p2: [5.2, 5] };
    const constraints: SketchConstraint[] = [{ id: "c1", kind: "angleLineLine", a: "a", b: "b", value: 90 }];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.segments;
    const dax = outA.p2[0] - outA.p1[0];
    const day = outA.p2[1] - outA.p1[1];
    const dbx = outB.p2[0] - outB.p1[0];
    const dby = outB.p2[1] - outB.p1[1];
    expect(dax * dbx + day * dby).toBeCloseTo(0, 3);
  });

  it("④ 矛盾: 同じ2直線にdistanceLineLine(平行距離8)とangleLineLine(60度)を同時指定すると矛盾する", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0.1] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [0, 4], p2: [10, 4.2] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "distanceLineLine", a: "a", b: "b", value: 8 },
      { id: "c2", kind: "angleLineLine", a: "a", b: "b", value: 60 },
    ];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicting).toBe(true);
  });
});

describe("solveDocumentSketches", () => {
  function makeDoc(features: SketchFeature[]): CadDocument {
    return { version: 1, features };
  }

  it("constraintsを持つsketchのsegmentsだけを解いて置き換え、持たないsketchは変更しない", () => {
    const constrained: SketchFeature = {
      type: "sketch",
      id: "sketch-a",
      name: "A",
      plane: { kind: "world", plane: "XY" },
      entities: [],
      segments: [{ id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] }],
      constraints: [{ id: "c1", kind: "length", segmentId: "s1", value: 40 }],
    };
    const untouched: SketchFeature = {
      type: "sketch",
      id: "sketch-b",
      name: "B",
      plane: { kind: "world", plane: "XY" },
      entities: [],
      segments: [{ id: "s2", kind: "line", p1: [0, 0], p2: [1, 1] }],
    };

    const result = solveDocumentSketches(makeDoc([constrained, untouched]));
    expect(result.conflict).toBeNull();
    const outA = result.doc.features.find((f) => f.id === "sketch-a") as SketchFeature;
    const outB = result.doc.features.find((f) => f.id === "sketch-b") as SketchFeature;
    expect(dist(outA.segments![0].p1, outA.segments![0].p2)).toBeCloseTo(40, 3);
    expect(outB.segments).toEqual(untouched.segments);
    // 拘束を持たないフィーチャーはオブジェクト参照ごと変更されない。
    expect(outB).toBe(untouched);
  });

  it("矛盾する拘束を含むsketchがあればドキュメント全体を変更せずconflictにfeatureIdを返す", () => {
    const conflicting: SketchFeature = {
      type: "sketch",
      id: "sketch-bad",
      name: "Bad",
      plane: { kind: "world", plane: "XY" },
      entities: [],
      segments: [{ id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] }],
      constraints: [
        { id: "c1", kind: "length", segmentId: "s1", value: 10 },
        { id: "c2", kind: "length", segmentId: "s1", value: 20 },
      ],
    };
    const doc = makeDoc([conflicting]);
    const result = solveDocumentSketches(doc);
    expect(result.conflict).not.toBeNull();
    expect(result.conflict?.featureId).toBe("sketch-bad");
    expect(result.doc).toBe(doc); // ドキュメントは変更せずそのまま返す。
  });
});

describe("solveSketch 累積ドリフト対策(ユーザー報告修正)", () => {
  function circle(id: string, center: [number, number], radius = 5): Extract<SketchEntity, { kind: "circle" }> {
    return { kind: "circle", id, center, radius };
  }

  it("① 既に拘束を満たしている円(中心-10,0)を再solveしても座標が完全に不変(ドリフトしない)", () => {
    const c = circle("c1", [-10, 0]);
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distanceEntityOrigin", entity: { entityId: "c1" }, value: 10 },
    ];
    const result = solveSketch([], constraints, [c]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.entities[0];
    if (out.kind !== "circle") throw new Error("not circle");
    // 数値解法を経由しても入力座標そのままであること(近似値ではなく厳密一致)。
    expect(out.center[0]).toBe(-10);
    expect(out.center[1]).toBe(0);
  });

  it("② 満たされた状態のまま100回連続solveしても座標が完全に不変", () => {
    let segs: SketchSegment[] = [{ id: "a", kind: "line", p1: [0, 0], p2: [10, 0] }];
    let entities: SketchEntity[] = [circle("c1", [-10, 0])];
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "horizontal", segmentId: "a" },
      { id: "c2", kind: "length", segmentId: "a", value: 10 },
      { id: "d1", kind: "distanceEntityOrigin", entity: { entityId: "c1" }, value: 10 },
    ];

    // 1回目でウォームアップ+LMを通して「きれいな値」に丸められた状態にする。
    const first = solveSketch(segs, constraints, entities);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    segs = first.segments;
    entities = first.entities;

    for (let i = 0; i < 100; i += 1) {
      const result = solveSketch(segs, constraints, entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // 前回の出力とビット単位で完全一致すること(=これ以上ドリフトしない)。
      expect(result.segments[0].p1).toEqual(segs[0].p1);
      expect(result.segments[0].p2).toEqual(segs[0].p2);
      const outCircle = result.entities[0];
      const prevCircle = entities[0];
      if (outCircle.kind !== "circle" || prevCircle.kind !== "circle") throw new Error("not circle");
      expect(outCircle.center).toEqual(prevCircle.center);
      segs = result.segments;
      entities = result.entities;
    }
    // 最終的に座標が理論値(-10,0)からずれていないこと。
    const finalCircle = entities[0];
    if (finalCircle.kind !== "circle") throw new Error("not circle");
    expect(finalCircle.center[0]).toBeCloseTo(-10, 6);
    expect(finalCircle.center[1]).toBeCloseTo(0, 6);
  });

  it("③ 拘束違反時(中心が目標値からずれている)は従来どおり解いて目標値に収束する", () => {
    const c = circle("c1", [-9, 0.3]); // わずかにdistanceEntityOrigin=10からずれている
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distanceEntityOrigin", entity: { entityId: "c1" }, value: 10 },
    ];
    const result = solveSketch([], constraints, [c]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.entities[0];
    if (out.kind !== "circle") throw new Error("not circle");
    expect(dist(out.center, [0, 0])).toBeCloseTo(10, 4);
    // 早期リターンではなく実際に解いた結果なので、入力座標そのままではない。
    expect(out.center).not.toEqual(c.center);
  });
});
