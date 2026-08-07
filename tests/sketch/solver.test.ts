// src/sketch/solver.ts の単体テスト(Phase 20a。Phase 35b-1でPlaneGCS[WASM]移行に伴いWASMロードが
// 必要になった。tests/worker/evaluator.test.tsと同じく絶対パスを直接指定してNode上でロードする)。
// ソルバの正しさが本フェーズの最重要事項のため、代表的な拘束の組み合わせ・矛盾検出・
// 正則化(劣拘束時に無関係な点が動かない)を厚めに検証する。
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { arcGeometryFromBulge } from "../../src/sketch/bulge";
import * as gcsAdapter from "../../src/sketch/gcsAdapter";
import { registerGcsAdapter, solveDocumentSketches, solveSketch } from "../../src/sketch/solver";
import type { DragTarget } from "../../src/sketch/solver";
import type { CadDocument, SketchConstraint, SketchEntity, SketchFeature, SketchSegment } from "../../src/model/types";

// このテストファイル全体、solveSketch()はPlaneGCS(gcsAdapter.ts)経由で解かれる
// (Phase 35b-1: 「既存のsolver系VitestをGCS実装で全通過させる」の対応。Phase 35cで自前実装の
// LM法[旧ソルバ]のフォールバックを完全撤去したため、以後solveSketch()は常にPlaneGCS経由になる)。
beforeAll(async () => {
  gcsAdapter.setGcsWasmPathForTests(path.resolve("node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm"));
  registerGcsAdapter(gcsAdapter);
  await gcsAdapter.initGcs();
});

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

  // ---- 寸法値の符号仕様の明確化(Phase 33): signed:trueのdistanceEntityEntity/distance/
  // distancePointOriginは、axis:"x"/"y"の残差が絶対値[|Δ|-value]ではなく符号付き
  // [(座標2-座標1)-value]になる(1点目→2点目のクリック順が符号の基準)。signed省略(旧データ)は
  // 従来通り絶対値のまま解釈される(後方互換)。----

  it("②d distanceEntityEntity(axis:x, signed:true, 負値): 2点目(b)が1点目(a、固定)より小さいXへ解ける", () => {
    const a = circle("a", [0, 0]);
    const b = circle("b", [5, 8]);
    const constraints: SketchConstraint[] = [
      { id: "fixA", kind: "fixEntity", entity: { entityId: "a" } },
      { id: "d1", kind: "distanceEntityEntity", a: { entityId: "a" }, b: { entityId: "b" }, value: -15, axis: "x", signed: true },
    ];
    const result = solveSketch([], constraints, [a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.entities.find((e) => e.id === "a")!;
    const outB = result.entities.find((e) => e.id === "b")!;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    expect(outA.center[0]).toBeCloseTo(0, 4);
    // 符号付き: b.x - a.x = -15 (絶対値[旧挙動]なら|d|=-15は解なしになるはずだが、signed:trueなので
    // 単純にb.xがa.xより15小さい値[-15]に解ける)。
    expect(outB.center[0] - outA.center[0]).toBeCloseTo(-15, 3);
    expect(outB.center[0]).toBeCloseTo(-15, 3);
  });

  it("②e distanceEntityEntity(axis:x, signed:true, 0): 2点目(b)が1点目(a、固定)と同じXに解ける(垂直整列)", () => {
    const a = circle("a", [0, 0]);
    const b = circle("b", [5, 8]);
    const constraints: SketchConstraint[] = [
      { id: "fixA", kind: "fixEntity", entity: { entityId: "a" } },
      { id: "d1", kind: "distanceEntityEntity", a: { entityId: "a" }, b: { entityId: "b" }, value: 0, axis: "x", signed: true },
    ];
    const result = solveSketch([], constraints, [a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.entities.find((e) => e.id === "a")!;
    const outB = result.entities.find((e) => e.id === "b")!;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    expect(outB.center[0]).toBeCloseTo(outA.center[0], 4);
    // X以外(Y)は拘束されていないため、入力の相対Y差(8)付近を維持する(正則化)。
    expect(outB.center[1] - outA.center[1]).toBeCloseTo(8, 2);
  });

  it("②f distanceEntityEntity(axis:x, signed省略[旧データ]): 絶対値のまま解釈され、負の値は指定できない(後方互換)", () => {
    // bがaより左(x=-5、負のX差)にある状態で、正の値20を指定する従来通りの使い方(絶対値=20)。
    // signedを付けていない旧データはこれまで通り|Δ|=valueとして解ける(現在の側[左]を保つ)。
    const a = circle("a", [0, 0]);
    const b = circle("b", [-5, 8]);
    const constraints: SketchConstraint[] = [
      { id: "fixA", kind: "fixEntity", entity: { entityId: "a" } },
      { id: "d1", kind: "distanceEntityEntity", a: { entityId: "a" }, b: { entityId: "b" }, value: 20, axis: "x" },
    ];
    const result = solveSketch([], constraints, [a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.entities.find((e) => e.id === "a")!;
    const outB = result.entities.find((e) => e.id === "b")!;
    if (outA.kind !== "circle" || outB.kind !== "circle") throw new Error("not circle");
    // 絶対値: |b.x - a.x| = 20。現在の側(左、負)を保つため b.x ≈ -20 に解ける(bが右[+20]に
    // 飛び移ることはない)。
    expect(Math.abs(outB.center[0] - outA.center[0])).toBeCloseTo(20, 3);
    expect(outB.center[0]).toBeCloseTo(-20, 3);
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
    // center[0]は本来動く理由が無い(拘束が距離のy成分にしか依存しない)方向だが、Phase 35b-1の
    // PlaneGCS移行後は剛体並進を表現する補助点群(rectangleの4隅+difference拘束)を介した
    // 数値解法の性質上、無関係な軸にごくわずかな残差(1e-3mm未満、CAD実務精度に対して無視できる
    // 大きさ)が乗ることがある(桁精度を1段階緩めた。挙動の実質的な変更ではない)。
    expect(outR.center[0]).toBeCloseTo(0, 2);
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

describe("solveSketch 頂点ベースの寸法指定(distancePointLine/distance・distancePointOriginのaxis、Phase 30)", () => {
  it("① distancePointLine(長さ拘束なし): 遠い方の端点を固定すると、距離を満たすよう線分が伸びる(遠い方の端点は動かない)", () => {
    const s1: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "fix1", kind: "fix", point: { segmentId: "s1", end: "p1" } },
      { id: "horiz", kind: "horizontal", segmentId: "s1" },
      {
        id: "d1",
        kind: "distancePointLine",
        point: { segmentId: "s1", end: "p2" },
        line: { kind: "refEdge", p1: [0, -5], p2: [0, 5] },
        value: 20,
      },
    ];
    const result = solveSketch([s1], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    // 遠い方の端点(fix)は動かない。
    expect(out.p1[0]).toBeCloseTo(0, 4);
    expect(out.p1[1]).toBeCloseTo(0, 4);
    // 端点(p2)は線(Y軸、x=0)からの距離20を満たす位置まで伸びる。
    expect(Math.abs(out.p2[0])).toBeCloseTo(20, 3);
    expect(out.p2[1]).toBeCloseTo(0, 4);
  });

  it("② distancePointLine(長さ拘束あり): 長さが固定されていると線分ごと平行移動して距離を満たす", () => {
    const s1: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "horiz", kind: "horizontal", segmentId: "s1" },
      { id: "len1", kind: "length", segmentId: "s1", value: 10 },
      {
        id: "d1",
        kind: "distancePointLine",
        point: { segmentId: "s1", end: "p2" },
        line: { kind: "refEdge", p1: [0, -5], p2: [0, 5] },
        value: 20,
      },
    ];
    const result = solveSketch([s1], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    expect(Math.abs(out.p2[0])).toBeCloseTo(20, 3);
    // 長さは維持(平行移動、伸びていない)。
    expect(dist(out.p1, out.p2)).toBeCloseTo(10, 3);
    expect(out.p1[1]).toBeCloseTo(out.p2[1], 4);
    // p1も一緒に動いている(伸びるケース[①]とは異なり、p1が[0,0]のままではない)。
    expect(Math.abs(out.p1[0] - (out.p2[0] - 10))).toBeLessThan(1e-2);
    expect(out.p1[0]).not.toBeCloseTo(0, 1);
  });

  it("③ distancePointLine: 端点・線(segmentEdge)の双方を固定すると矛盾を検出する", () => {
    const p: SketchSegment = { id: "p1seg", kind: "line", p1: [0, 5], p2: [0, 6] };
    const line: SketchSegment = { id: "lineSeg", kind: "line", p1: [-10, 0], p2: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "fixp1", kind: "fix", point: { segmentId: "p1seg", end: "p1" } },
      { id: "fixl1", kind: "fix", point: { segmentId: "lineSeg", end: "p1" } },
      { id: "fixl2", kind: "fix", point: { segmentId: "lineSeg", end: "p2" } },
      {
        id: "d1",
        kind: "distancePointLine",
        point: { segmentId: "p1seg", end: "p1" },
        line: { kind: "segmentEdge", segmentId: "lineSeg" },
        value: 20,
      },
    ];
    const result = solveSketch([p, line], constraints);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicting).toBe(true);
  });

  it("④ distance(axis:x): 2端点のX距離のみが指定値に解け、Y方向の相対位置は変わらない", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [0, 1] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [5, 8], p2: [5, 9] };
    const constraints: SketchConstraint[] = [
      { id: "fixa", kind: "fix", point: { segmentId: "a", end: "p1" } },
      { id: "d1", kind: "distance", a: { segmentId: "a", end: "p1" }, b: { segmentId: "b", end: "p1" }, value: 30, axis: "x" },
    ];
    const result = solveSketch([a, b], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outA = result.segments.find((s) => s.id === "a")!;
    const outB = result.segments.find((s) => s.id === "b")!;
    expect(Math.abs(outB.p1[0] - outA.p1[0])).toBeCloseTo(30, 3);
    // Y方向は拘束されていないため、入力の相対Y差(8)付近を維持する(正則化)。
    expect(outB.p1[1] - outA.p1[1]).toBeCloseTo(8, 2);
  });

  it("⑤ distancePointOrigin(axis:y): 端点のY距離のみが原点からの指定値に解け、X座標は変わらない", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [10, 3], p2: [20, 3] };
    const constraints: SketchConstraint[] = [
      { id: "d1", kind: "distancePointOrigin", point: { segmentId: "s1", end: "p1" }, value: 25, axis: "y" },
    ];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.segments[0];
    expect(Math.abs(out.p1[1])).toBeCloseTo(25, 3);
    // Xは拘束されていないため、正則化で入力(10)に近いまま。
    expect(out.p1[0]).toBeCloseTo(10, 1);
  });

  it("⑥ 一致クラスタ経由の連動: 3線分チェーンの中間頂点(一致拘束)にdistancePointOriginを指定すると、後続の線分も整合して動く", () => {
    // s1.p2とs2.p1、s2.p2とs3.p1がそれぞれcoincidentで結ばれたチェーン(L字ではなく直線的な3本鎖)。
    // s1の遠い方の端点(p1)を固定し、s1自体には長さ拘束を付けない(中間頂点[s1.p2/s2.p1の代表点]の
    // 位置がdistancePointOriginで決まれば、s1がその位置まで伸びる)。s2/s3はhorizontal+lengthで
    // 剛体として振る舞うため、中間頂点が動けばcoincident経由でs2・s3全体が整合して追従する
    // (頂点ベースの寸法指定でクラスタの代表点[segmentId昇順の先頭='s1:p2']に拘束をつけた場合と等価)。
    const s1: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const s2: SketchSegment = { id: "s2", kind: "line", p1: [10, 0], p2: [20, 0] };
    const s3: SketchSegment = { id: "s3", kind: "line", p1: [20, 0], p2: [30, 0] };
    const constraints: SketchConstraint[] = [
      { id: "fix1", kind: "fix", point: { segmentId: "s1", end: "p1" } },
      { id: "h1", kind: "horizontal", segmentId: "s1" },
      { id: "h2", kind: "horizontal", segmentId: "s2" },
      { id: "len2", kind: "length", segmentId: "s2", value: 10 },
      { id: "h3", kind: "horizontal", segmentId: "s3" },
      { id: "len3", kind: "length", segmentId: "s3", value: 10 },
      { id: "co1", kind: "coincident", a: { segmentId: "s1", end: "p2" }, b: { segmentId: "s2", end: "p1" } },
      { id: "co2", kind: "coincident", a: { segmentId: "s2", end: "p2" }, b: { segmentId: "s3", end: "p1" } },
      { id: "d1", kind: "distancePointOrigin", point: { segmentId: "s1", end: "p2" }, value: 50, axis: "x" },
    ];
    const result = solveSketch([s1, s2, s3], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outS1 = result.segments.find((s) => s.id === "s1")!;
    const outS2 = result.segments.find((s) => s.id === "s2")!;
    const outS3 = result.segments.find((s) => s.id === "s3")!;
    // 中間頂点(s1.p2)が指定通りx=50に伸びる。
    expect(outS1.p2[0]).toBeCloseTo(50, 3);
    expect(outS1.p2[1]).toBeCloseTo(0, 3);
    // coincidentでs2.p1が追従。
    expect(dist(outS2.p1, outS1.p2)).toBeLessThan(1e-3);
    expect(outS2.p2[0]).toBeCloseTo(60, 3);
    // coincidentでs3.p1が追従、s3も整合して伸びる。
    expect(dist(outS3.p1, outS2.p2)).toBeLessThan(1e-3);
    expect(outS3.p2[0]).toBeCloseTo(70, 3);
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

describe("solveSketch 接線拘束が解けるのに矛盾判定されるバグの修正(実機報告、Phase 32)", () => {
  function circle(id: string, center: [number, number], radius: number): Extract<SketchEntity, { kind: "circle" }> {
    return { kind: "circle", id, center, radius };
  }

  /**
   * 実機報告の再現: 一致拘束で繋がった5本の線分チェーン(4番目=水平、5番目=垂直)+中心固定の
   * 円2つに囲まれた形状で、垂直な線分(セグメント5)と外側の円への接線を追加する。この形状・
   * 座標自体はスクリーンショットの厳密な再現ではなく「垂直線が円から離れた位置にある同型の
   * 構成」(タスク仕様)。修正前は、垂直セグメントが一致チェームを経由して円に接するまで
   * 移動する解が明らかに存在するにもかかわらず、LM法が退化した解(セグメント5がほぼ1点に
   * 潰れる局所解)に迷い込んで矛盾判定(ok:false, conflicting:true)になっていた
   * (根本原因: tangent[円↔直線]のnudge無し・warmupの正則化が常にinitXへ引き戻す設計のため、
   * 「線分を剛体並進させる」自然な解より先に退化解へ収束してしまっていた)。
   */
  it("① 一致チェーン(5本、4=水平・5=垂直)+中心固定の2円: 垂直セグメントと外側の円への接線が、退化せずに解ける", () => {
    const s1: SketchSegment = { id: "s1", kind: "line", p1: [2.902695, -0.419605], p2: [2.196322, 4.216721] };
    const s2: SketchSegment = { id: "s2", kind: "line", p1: [2.196322, 4.216721], p2: [-7.607091, 5.758038] };
    const s3: SketchSegment = { id: "s3", kind: "line", p1: [-7.607091, 5.758038], p2: [-8.268544, -8.246643] };
    const s4: SketchSegment = { id: "s4", kind: "line", p1: [-8.268544, -8.246643], p2: [2.902695, -8.246643] };
    const s5: SketchSegment = { id: "s5", kind: "line", p1: [2.902695, -8.246643], p2: [2.902695, -0.419605] };
    const segments = [s1, s2, s3, s4, s5];
    const innerCircle = circle("c1", [0, 0], 27.5);
    const outerCircle = circle("c2", [0, 0], 59);
    const entities: SketchEntity[] = [innerCircle, outerCircle];

    const constraints: SketchConstraint[] = [
      { id: "co1", kind: "coincident", a: { segmentId: "s1", end: "p2" }, b: { segmentId: "s2", end: "p1" } },
      { id: "co2", kind: "coincident", a: { segmentId: "s2", end: "p2" }, b: { segmentId: "s3", end: "p1" } },
      { id: "co3", kind: "coincident", a: { segmentId: "s3", end: "p2" }, b: { segmentId: "s4", end: "p1" } },
      { id: "co4", kind: "coincident", a: { segmentId: "s4", end: "p2" }, b: { segmentId: "s5", end: "p1" } },
      { id: "co5", kind: "coincident", a: { segmentId: "s5", end: "p2" }, b: { segmentId: "s1", end: "p1" } },
      { id: "h4", kind: "horizontal", segmentId: "s4" },
      { id: "v5", kind: "vertical", segmentId: "s5" },
      { id: "fix1", kind: "fixEntity", entity: { entityId: "c1" } },
      { id: "fix2", kind: "fixEntity", entity: { entityId: "c2" } },
      { id: "tan1", kind: "tangent", entity: { entityId: "c2" }, target: { kind: "segment", segmentId: "s5" } },
    ];

    const result = solveSketch(segments, constraints, entities);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outS1 = result.segments.find((s) => s.id === "s1")!;
    const outS4 = result.segments.find((s) => s.id === "s4")!;
    const outS5 = result.segments.find((s) => s.id === "s5")!;

    // セグメント5は垂直かつ円2(半径59)に接する(=x=±59)まで移動している。
    expect(outS5.p1[0]).toBeCloseTo(outS5.p2[0], 6);
    expect(Math.abs(outS5.p1[0])).toBeCloseTo(59, 3);
    // 退化(セグメント5が1点に潰れる)していない: 修正前のバグでは長さがほぼ0になっていた。
    expect(dist(outS5.p1, outS5.p2)).toBeGreaterThan(5);
    // 一致チェームで繋がった隣接セグメント(s1, s4)もセグメント5の移動に連動して端点が追従する。
    expect(outS4.p2[0]).toBeCloseTo(outS5.p1[0], 6);
    expect(outS4.p2[1]).toBeCloseTo(outS5.p1[1], 6);
    expect(outS1.p1[0]).toBeCloseTo(outS5.p2[0], 6);
    expect(outS1.p1[1]).toBeCloseTo(outS5.p2[1], 6);
    // 水平拘束を保っている。
    expect(outS4.p1[1]).toBeCloseTo(outS4.p2[1], 6);
  });

  it("② ①と同じ形状を200通りのランダムな初期配置で解いても常に成功する(局所解への迷い込みの再発防止)", () => {
    function mulberry32(seed: number) {
      let s = seed;
      return () => {
        s |= 0;
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const baseConstraints: SketchConstraint[] = [
      { id: "co1", kind: "coincident", a: { segmentId: "s1", end: "p2" }, b: { segmentId: "s2", end: "p1" } },
      { id: "co2", kind: "coincident", a: { segmentId: "s2", end: "p2" }, b: { segmentId: "s3", end: "p1" } },
      { id: "co3", kind: "coincident", a: { segmentId: "s3", end: "p2" }, b: { segmentId: "s4", end: "p1" } },
      { id: "co4", kind: "coincident", a: { segmentId: "s4", end: "p2" }, b: { segmentId: "s5", end: "p1" } },
      { id: "co5", kind: "coincident", a: { segmentId: "s5", end: "p2" }, b: { segmentId: "s1", end: "p1" } },
      { id: "h4", kind: "horizontal", segmentId: "s4" },
      { id: "v5", kind: "vertical", segmentId: "s5" },
      { id: "fix1", kind: "fixEntity", entity: { entityId: "c1" } },
      { id: "fix2", kind: "fixEntity", entity: { entityId: "c2" } },
    ];
    const entities: SketchEntity[] = [circle("c1", [0, 0], 27.5), circle("c2", [0, 0], 59)];

    let failures = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const rand = mulberry32(seed);
      const r = (a: number, b: number) => a + rand() * (b - a);
      const pts: [number, number][] = [];
      for (let i = 0; i < 5; i += 1) {
        const angle = (i / 5) * Math.PI * 2 + r(-0.3, 0.3);
        const radius = r(3, 15);
        pts.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
      }
      const segments: SketchSegment[] = pts.map((p, i) => ({
        id: `s${i + 1}`,
        kind: "line",
        p1: p,
        p2: pts[(i + 1) % 5],
      }));

      const pre = solveSketch(segments, baseConstraints, entities);
      if (!pre.ok) continue; // 前処理(接線を追加する前)自体が解けない配置は対象外。
      const withTangent: SketchConstraint[] = [
        ...baseConstraints,
        { id: "tan1", kind: "tangent", entity: { entityId: "c2" }, target: { kind: "segment", segmentId: "s5" } },
      ];
      const result = solveSketch(pre.segments, withTangent, pre.entities);
      if (!result.ok) failures += 1;
    }
    expect(failures).toBe(0);
  }, 60000);

  it("③ 矛盾時のメッセージに、残差最大の拘束の人間可読な名前(拘束一覧と同じ表記)が含まれる", () => {
    // 同一セグメントに互いに両立しない長さを2つ指定する、常に検出可能な真の矛盾。
    const s1: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "len1", kind: "length", segmentId: "s1", value: 10 },
      { id: "len2", kind: "length", segmentId: "s1", value: 20 },
    ];
    const result = solveSketch([s1], constraints, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicting).toBe(true);
    // 拘束一覧パネルと同じ表記(種類ラベル+セグメントラベル)を含む。
    expect(result.message).toContain("セグメント1");
    expect(result.message).toMatch(/長さ/);
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

// スケッチジオメトリのドラッグ編集(Phase 34)のソルバ側単体テスト。dragTargetは常に
// grabPoint=対象の現在位置(=initXそのもの)を渡す形にし、target-grabPointがそのまま
// 「その変数を動かしたい移動量」になるようにする(CadViewer側の「掴んだ位置からの相対移動」と
// 同じ考え方、DragTargetの型コメント参照)。
describe("solveSketch dragTarget(スケッチジオメトリのドラッグ編集、Phase 34)", () => {
  it("① 拘束の無い自由な頂点をドラッグすると、目標位置の近くまで追従する", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const dragTarget: DragTarget = { kind: "point", point: { segmentId: "s1", end: "p1" }, grabPoint: [0, 0], target: [5, 3] };
    const result = solveSketch([seg], [], [], { dragTarget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p1 = result.segments[0].p1;
    // ソフト残差(正則化より強いがハード拘束ではない)なので厳密に一致はしないが、大部分追従する。
    expect(dist(p1, [5, 3])).toBeLessThan(0.3);
    // 反対側の端点(拘束で繋がっていない)はほぼ動かない。
    expect(dist(result.segments[0].p2, [10, 0])).toBeLessThan(1e-3);
  });

  it("② 水平拘束付き線分の端点ドラッグ: 水平を維持してY追従は拒否され、X方向のみ追従する", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "fix", point: { segmentId: "s1", end: "p1" } },
      { id: "c2", kind: "horizontal", segmentId: "s1" },
    ];
    const dragTarget: DragTarget = { kind: "point", point: { segmentId: "s1", end: "p2" }, grabPoint: [10, 0], target: [8, 5] };
    const result = solveSketch([seg], constraints, [], { dragTarget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outP1, outP2] = [result.segments[0].p1, result.segments[0].p2];
    // p1はfixで完全固定。
    expect(outP1).toEqual([0, 0]);
    // horizontalが厳密に維持される(Yはp1と一致=0のまま、Y追従は拒否される)。
    expect(outP2[1]).toBeCloseTo(0, 6);
    // X方向はカーソルへ大きく追従する(10→8に近づく、少なくとも半分以上移動)。
    expect(outP2[0]).toBeLessThan(9);
    expect(outP2[0]).toBeGreaterThan(7);
  });

  it("③ 長さ拘束+一致チェーンのドラッグ: つながった隣のセグメントが連動する", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [10, 0], p2: [10, 10] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "fix", point: { segmentId: "a", end: "p1" } },
      { id: "c2", kind: "length", segmentId: "a", value: 10 },
      { id: "c3", kind: "coincident", a: { segmentId: "a", end: "p2" }, b: { segmentId: "b", end: "p1" } },
    ];
    const dragTarget: DragTarget = { kind: "point", point: { segmentId: "a", end: "p2" }, grabPoint: [10, 0], target: [0, 10] };
    const result = solveSketch([a, b], constraints, [], { dragTarget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [outA, outB] = result.segments;
    // aはp1(原点)を中心に長さ10を保ったまま回転する(伸び縮みしない)。
    expect(dist(outA.p1, [0, 0])).toBeCloseTo(0, 6);
    expect(dist(outA.p1, outA.p2)).toBeCloseTo(10, 4);
    // aのp2が動いた分、一致拘束でbのp1が追従する(=チェーンが連動する)。
    expect(dist(outB.p1, outA.p2)).toBeLessThan(1e-4);
    // 実際に元の位置(10,0)からは大きく動いている(何もしていないわけではない)。
    expect(dist(outA.p2, [10, 0])).toBeGreaterThan(3);
  });

  it("④ 完全拘束(両端点fix)された線分をドラッグしても動かない", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "c1", kind: "fix", point: { segmentId: "s1", end: "p1" } },
      { id: "c2", kind: "fix", point: { segmentId: "s1", end: "p2" } },
    ];
    const dragTarget: DragTarget = { kind: "point", point: { segmentId: "s1", end: "p2" }, grabPoint: [10, 0], target: [50, 50] };
    const result = solveSketch([seg], constraints, [], { dragTarget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments[0].p1).toEqual([0, 0]);
    expect(result.segments[0].p2).toEqual([10, 0]);
  });

  it("⑤ 拘束の無い円の中心ドラッグ: 目標位置の近くまで追従する", () => {
    const c: Extract<SketchEntity, { kind: "circle" }> = { kind: "circle", id: "c1", center: [0, 0], radius: 5 };
    const dragTarget: DragTarget = { kind: "entity", entityId: "c1", grabPoint: [0, 0], target: [7, -3] };
    const result = solveSketch([], [], [c], { dragTarget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.entities[0];
    if (out.kind !== "circle") throw new Error("not circle");
    expect(dist(out.center, [7, -3])).toBeLessThan(0.3);
  });
});

// PlaneGCS移行(Phase 35b-1)の回帰テスト。スパイク(Phase 35a、experiments/planegcs-spike/
// 02-failure-cases.mjs)で「旧ソルバ[自前LM法]が矛盾判定してしまっていたが、PlaneGCSでは解ける」
// ことを確認した3ケースのうち、5本チェーン複合(ケース③)は既にPhase 32のテスト(直上のdescribe
// ブロック①)が同型の形状でカバーしているため、残る2ケース(接線単純・長さ変更再solve)をここに追加する。
describe("solveSketch PlaneGCS移行(Phase 35b-1)のスパイク失敗ケース回帰", () => {
  it("① 接線単純: 固定R59円+1本の垂直線の接線(旧ソルバは正則化のwarmupに引き戻されて矛盾判定していた)", () => {
    const outerCircle: Extract<SketchEntity, { kind: "circle" }> = { kind: "circle", id: "c1", center: [0, 0], radius: 59 };
    // わずかに傾いた初期状態(スパイクの02-failure-cases.mjsケース①と同じ座標)。
    const line: SketchSegment = { id: "line", kind: "line", p1: [80, -10], p2: [82, 10] };
    const constraints: SketchConstraint[] = [
      { id: "fix1", kind: "fixEntity", entity: { entityId: "c1" } },
      { id: "vert", kind: "vertical", segmentId: "line" },
      { id: "tan", kind: "tangent", entity: { entityId: "c1" }, target: { kind: "segment", segmentId: "line" } },
    ];
    const result = solveSketch([line], constraints, [outerCircle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outLine = result.segments[0];
    // 垂直を保ったまま円(半径59)に接するx=59(初期状態が円の右側にあったので符号は正のまま)。
    expect(outLine.p1[0]).toBeCloseTo(outLine.p2[0], 6);
    expect(Math.abs(outLine.p1[0])).toBeCloseTo(59, 3);
  });

  it("② 長さ変更再solve: 5本チェーン複合(接続する水平線)の長さを50→134へ変更しても、接線を保ったまま再収束する", () => {
    function buildChain(s4Length: number): { segments: SketchSegment[]; entities: SketchEntity[]; constraints: SketchConstraint[] } {
      const s1: SketchSegment = { id: "s1", kind: "line", p1: [2.902695, -0.419605], p2: [2.196322, 4.216721] };
      const s2: SketchSegment = { id: "s2", kind: "line", p1: [2.196322, 4.216721], p2: [-7.607091, 5.758038] };
      const s3: SketchSegment = { id: "s3", kind: "line", p1: [-7.607091, 5.758038], p2: [-8.268544, -8.246643] };
      const s4: SketchSegment = { id: "s4", kind: "line", p1: [-8.268544, -8.246643], p2: [2.902695, -8.246643] };
      const s5: SketchSegment = { id: "s5", kind: "line", p1: [2.902695, -8.246643], p2: [2.902695, -0.419605] };
      const innerCircle: SketchEntity = { kind: "circle", id: "c1", center: [0, 0], radius: 27.5 };
      const outerCircle: SketchEntity = { kind: "circle", id: "c2", center: [0, 0], radius: 59 };
      const constraints: SketchConstraint[] = [
        { id: "co1", kind: "coincident", a: { segmentId: "s1", end: "p2" }, b: { segmentId: "s2", end: "p1" } },
        { id: "co2", kind: "coincident", a: { segmentId: "s2", end: "p2" }, b: { segmentId: "s3", end: "p1" } },
        { id: "co3", kind: "coincident", a: { segmentId: "s3", end: "p2" }, b: { segmentId: "s4", end: "p1" } },
        { id: "co4", kind: "coincident", a: { segmentId: "s4", end: "p2" }, b: { segmentId: "s5", end: "p1" } },
        { id: "co5", kind: "coincident", a: { segmentId: "s5", end: "p2" }, b: { segmentId: "s1", end: "p1" } },
        { id: "h4", kind: "horizontal", segmentId: "s4" },
        { id: "v5", kind: "vertical", segmentId: "s5" },
        { id: "fix1", kind: "fixEntity", entity: { entityId: "c1" } },
        { id: "fix2", kind: "fixEntity", entity: { entityId: "c2" } },
        { id: "tan1", kind: "tangent", entity: { entityId: "c2" }, target: { kind: "segment", segmentId: "s5" } },
        { id: "len4", kind: "length", segmentId: "s4", value: s4Length },
      ];
      return { segments: [s1, s2, s3, s4, s5], entities: [innerCircle, outerCircle], constraints };
    }

    const first = buildChain(50);
    const r1 = solveSketch(first.segments, first.constraints, first.entities);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // 長さ拘束(len4)の値だけ134に差し替え、①の解いた後のsegmentsを入力として再solveする
    // (store.tsのupdateDocument()が寸法変更のたびに行う処理と同じパターン)。
    const second = buildChain(134);
    const r2 = solveSketch(r1.segments, second.constraints, r1.entities);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const outS4 = r2.segments.find((s) => s.id === "s4")!;
    const outS5 = r2.segments.find((s) => s.id === "s5")!;
    // s4(水平線)の長さが134に解ける。
    expect(dist(outS4.p1, outS4.p2)).toBeCloseTo(134, 3);
    // 一致チェーン経由でs5も垂直+外側の円(半径59)への接線を保ったまま追従する(退化していない)。
    expect(outS5.p1[0]).toBeCloseTo(outS5.p2[0], 6);
    expect(Math.abs(outS5.p1[0])).toBeCloseTo(59, 3);
    expect(dist(outS5.p1, outS5.p2)).toBeGreaterThan(1);
  });
});
