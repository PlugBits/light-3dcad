// src/sketch/explode.ts の単体テスト(純粋TS、WASM不要、Phase 19b)。
import { describe, expect, it } from "vitest";

import { bulgeArcPoints } from "../../src/sketch/bulge";
import { explodeEntity } from "../../src/sketch/explode";
import { polygonOutlinePoints } from "../../src/sketch/polygonOutline";
import type { SketchEntity, SketchSegment } from "../../src/model/types";

/** セグメント列(閉ループ想定)をポリライン(2D点列)に展開する。円弧はbulgeArcPointsで16分割近似。 */
function segmentsToPolyline(segments: SketchSegment[]): [number, number][] {
  const points: [number, number][] = [];
  for (const seg of segments) {
    const pts = seg.kind === "arc" && seg.bulge ? bulgeArcPoints(seg.p1, seg.p2, seg.bulge, 16) : [seg.p1, seg.p2];
    pts.forEach((p, i) => {
      if (points.length > 0 && i === 0) return; // 直前セグメントの終点と重複するため飛ばす。
      points.push(p);
    });
  }
  return points;
}

/** 閉ポリラインの符号付き面積(shoelace、絶対値)。 */
function polygonArea(points: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

describe("explodeEntity", () => {
  it("rectangleを4本の直線セグメント(閉ループ・連続)に展開する", () => {
    const entity: SketchEntity = { kind: "rectangle", id: "r1", center: [0, 0], width: 20, height: 40 };
    const segments = explodeEntity(entity);
    expect(segments).toHaveLength(4);
    expect(segments.every((s) => s.kind === "line")).toBe(true);
    // 連続性: 各セグメントのp2が次のセグメントのp1と一致する(閉ループ)。
    for (let i = 0; i < segments.length; i += 1) {
      const next = segments[(i + 1) % segments.length];
      expect(segments[i].p2[0]).toBeCloseTo(next.p1[0], 9);
      expect(segments[i].p2[1]).toBeCloseTo(next.p1[1], 9);
    }
    const perimeter = segments.reduce((sum, s) => sum + Math.hypot(s.p2[0] - s.p1[0], s.p2[1] - s.p1[1]), 0);
    expect(perimeter).toBeCloseTo(2 * (20 + 40), 6);
    expect(polygonArea(segmentsToPolyline(segments))).toBeCloseTo(20 * 40, 6);
  });

  it("circleを半円弧2本(閉ループ)に展開し、面積が円の面積に一致する", () => {
    const entity: SketchEntity = { kind: "circle", id: "c1", center: [5, -2], radius: 10 };
    const segments = explodeEntity(entity);
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.kind === "arc" && s.bulge === -1)).toBe(true);
    // 連続性: 左端(5-10,-2)→右端(5+10,-2)→左端…と閉じる。
    expect(segments[0].p1[0]).toBeCloseTo(-5, 9);
    expect(segments[0].p2[0]).toBeCloseTo(15, 9);
    expect(segments[1].p1[0]).toBeCloseTo(15, 9);
    expect(segments[1].p2[0]).toBeCloseTo(-5, 9);
    const area = polygonArea(segmentsToPolyline(segments));
    const expectedArea = Math.PI * 10 * 10;
    expect(Math.abs(area - expectedArea) / expectedArea).toBeLessThan(0.01); // ポリライン近似(16分割)ぶんの誤差を許容。
  });

  it("フィレット付きpolygonを展開した輪郭は、polygonOutlinePoints()の輪郭と同じ面積になる", () => {
    const points: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const corners = [null, { kind: "fillet" as const, size: 2 }, null, null];
    const entity: SketchEntity = { kind: "polygon", id: "p1", points, corners };
    const segments = explodeEntity(entity);
    // 4辺 + フィレット1個分の円弧 = 5セグメント。
    expect(segments).toHaveLength(5);
    // 連続性(閉ループ)。
    for (let i = 0; i < segments.length; i += 1) {
      const next = segments[(i + 1) % segments.length];
      expect(segments[i].p2[0]).toBeCloseTo(next.p1[0], 9);
      expect(segments[i].p2[1]).toBeCloseTo(next.p1[1], 9);
    }
    const explodedArea = polygonArea(segmentsToPolyline(segments));
    const referenceArea = polygonArea(polygonOutlinePoints(points, corners, undefined, 16));
    expect(explodedArea).toBeCloseTo(referenceArea, 6);
  });
});
