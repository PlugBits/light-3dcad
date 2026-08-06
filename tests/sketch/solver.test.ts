// src/sketch/solver.ts の単体テスト(純粋TS、WASM不要、Phase 20a)。
// ソルバの正しさが本フェーズの最重要事項のため、代表的な拘束の組み合わせ・矛盾検出・
// 正則化(劣拘束時に無関係な点が動かない)を厚めに検証する。
import { describe, expect, it } from "vitest";

import { arcGeometryFromBulge } from "../../src/sketch/bulge";
import { solveDocumentSketches, solveSketch } from "../../src/sketch/solver";
import type { CadDocument, SketchConstraint, SketchFeature, SketchSegment } from "../../src/model/types";

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
