// src/sketch/regions.ts の単体テスト(純粋TS、WASM不要、Phase 19a。Phase 36でギャップ許容の頂点結合を追加)。
import { describe, expect, it } from "vitest";

import { createArcSegment, createCircleEntity, createLineSegment } from "../../src/model";
import type { SketchSegment } from "../../src/model/types";
import { classifySketchEntities } from "../../src/sketch/containment";
import { findClosedRegions, loopPolyline, type Loop } from "../../src/sketch/regions";

/** ループ(セグメント列)の符号付き面積(シューレース。円弧は直線近似で概算)。テスト内の向き検証専用。 */
function loopShoelaceArea(loop: Loop): number {
  let sum = 0;
  for (const seg of loop) {
    sum += seg.p1[0] * seg.p2[1] - seg.p2[0] * seg.p1[1];
  }
  return sum / 2;
}

/** 頂点列(閉ループ、最後は最初に自動的に戻る)から直線セグメントの配列を作る。 */
function rectSegments(points: [number, number][]): SketchSegment[] {
  const segs: SketchSegment[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    segs.push(createLineSegment({ p1, p2 }));
  }
  return segs;
}

describe("findClosedRegions", () => {
  it("① 矩形4線分は1領域(外枠、穴なし)を返す", () => {
    const segments = rectSegments([
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ]);
    const regions = findClosedRegions(segments);
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(0);
    const area = loopShoelaceArea(regions[0].outer);
    expect(area).toBeCloseTo(200, 6);
    // outerは反時計回り(符号付き面積が正)。
    expect(area).toBeGreaterThan(0);
  });

  it("② 矩形+内側の矩形は外枠1件・穴1件のRegionになる(穴は時計回り)", () => {
    const outer = rectSegments([
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
    ]);
    const inner = rectSegments([
      [10, 10],
      [30, 10],
      [30, 20],
      [10, 20],
    ]);
    const regions = findClosedRegions([...outer, ...inner]);
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
    const outerArea = loopShoelaceArea(regions[0].outer);
    const holeArea = loopShoelaceArea(regions[0].holes[0]);
    expect(outerArea).toBeCloseTo(1200, 6);
    expect(outerArea).toBeGreaterThan(0);
    // holeは時計回り(符号付き面積が負)。
    expect(holeArea).toBeLessThan(0);
    expect(Math.abs(holeArea)).toBeCloseTo(200, 6);
  });

  it("③ 交差する2つの矩形(オーバーラップ)は3領域(A側のみ・重なり・B側のみ)に分割される", () => {
    // 正方形A: (0,0)-(10,0)-(10,10)-(0,10)。正方形B: (5,5)-(15,5)-(15,15)-(5,15)(Aと(5,5)-(10,10)で重なる)。
    const a = rectSegments([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    const b = rectSegments([
      [5, 5],
      [15, 5],
      [15, 15],
      [5, 15],
    ]);
    const regions = findClosedRegions([...a, ...b]);
    expect(regions).toHaveLength(3);
    regions.forEach((r) => expect(r.holes).toHaveLength(0));
    const areas = regions.map((r) => Math.abs(loopShoelaceArea(r.outer))).sort((x, y) => x - y);
    // 重なり(5x5=25) < Aのみ(100-25=75) ≈ Bのみ(100-25=75)。
    expect(areas[0]).toBeCloseTo(25, 6);
    expect(areas[1]).toBeCloseTo(75, 6);
    expect(areas[2]).toBeCloseTo(75, 6);
    const total = areas.reduce((s, a2) => s + a2, 0);
    expect(total).toBeCloseTo(175, 6); // 100+100-25(重複部分は1回だけ数える)
  });

  it("④ 開いた線分のみ(閉じていない)は0領域を返す", () => {
    const segments: SketchSegment[] = [
      createLineSegment({ p1: [0, 0], p2: [10, 0] }),
      createLineSegment({ p1: [10, 0], p2: [10, 10] }),
      createLineSegment({ p1: [10, 10], p2: [0, 20] }), // 閉じずに終わる
    ];
    expect(findClosedRegions(segments)).toHaveLength(0);
  });

  it("⑤ 半円+直線の閉ループ(D字形)は1領域になり、面積は半径付きの半円+何もなし(半円のみ)に一致する", () => {
    const r = 10;
    // 直線(-10,0)->(10,0)、円弧(10,0)->(-10,0)で半円を閉じる(上側に膨らむ半円、bulge=-1)。
    const line = createLineSegment({ p1: [-r, 0], p2: [r, 0] });
    const arc = createArcSegment({ p1: [r, 0], p2: [-r, 0], bulge: -1 });
    const regions = findClosedRegions([line, arc]);
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(0);
    expect(regions[0].outer).toHaveLength(2);
    // 半円の面積 = πr^2/2。regions.ts本体とは独立に、円弧の解析的な面積公式
    // (弦のシューレース項 + Green's theoremの扇形補正項)をテスト内で再実装して照合する。
    const expectedArea = (Math.PI * r * r) / 2;
    let analyticalArea = 0;
    for (const seg of regions[0].outer) {
      if (seg.kind === "arc" && seg.bulge) {
        const theta = 4 * Math.atan(seg.bulge);
        const dx = seg.p2[0] - seg.p1[0];
        const dy = seg.p2[1] - seg.p1[1];
        const chord = Math.hypot(dx, dy);
        const radius = Math.abs(chord / (2 * Math.sin(theta / 2)));
        analyticalArea += (seg.p1[0] * seg.p2[1] - seg.p2[0] * seg.p1[1]) / 2 + (radius * radius * (theta - Math.sin(theta))) / 2;
      } else {
        analyticalArea += (seg.p1[0] * seg.p2[1] - seg.p2[0] * seg.p1[1]) / 2;
      }
    }
    expect(analyticalArea).toBeCloseTo(expectedArea, 3);
  });

  it("⑥ ぶら下がり枝付きの矩形は依然として1領域(枝は無視される)、面積は矩形と一致する", () => {
    const rect = rectSegments([
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ]);
    // 頂点(0,0)から外側へ伸びるぶら下がり枝(閉じない)。
    const dangling = createLineSegment({ p1: [0, 0], p2: [-5, -5] });
    const regions = findClosedRegions([...rect, dangling]);
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(0);
    const area = loopShoelaceArea(regions[0].outer);
    expect(area).toBeCloseTo(200, 6);
  });

  it("ぶら下がり枝がセグメントの内部(T字)に接続していても矩形1領域を検出する", () => {
    const rect = rectSegments([
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ]);
    // 下辺(0,0)-(20,0)の中点(10,0)から外側(下)へ伸びる枝。
    const dangling = createLineSegment({ p1: [10, 0], p2: [10, -8] });
    const regions = findClosedRegions([...rect, dangling]);
    expect(regions).toHaveLength(1);
    const area = loopShoelaceArea(regions[0].outer);
    expect(Math.abs(area)).toBeCloseTo(200, 3);
  });

  it("セグメントが1本もない場合は0領域を返す", () => {
    expect(findClosedRegions([])).toHaveLength(0);
  });

  it("円弧のみで構成された閉ループ(半円2つでレンズ形)を検出する", () => {
    // 2つの半円弧(共通の弦(-5,0)-(5,0)を挟んで反対向きに膨らむ)でレンズ形を作る。
    const top = createArcSegment({ p1: [-5, 0], p2: [5, 0], bulge: -1 }); // 上側
    const bottom = createArcSegment({ p1: [5, 0], p2: [-5, 0], bulge: -1 }); // 下側
    const regions = findClosedRegions([top, bottom]);
    expect(regions).toHaveLength(1);
    expect(regions[0].outer).toHaveLength(2);
  });

  describe("REGION_JOIN_EPS(Phase 36: entityトリム由来の断片がソルバ再実行でµmずれても外枠が閉じる)", () => {
    /**
     * ほぼ矩形の4線分ループを作るが、1つの角(20,10)だけ隣接する2線分の端点をgapだけずらす
     * (実機報告の再現: トリムで生じた断片同士の一致拘束が無いままソルバが再実行され、
     * 端点が数µm〜数十µmドリフトするケースに相当)。
     */
    function nearRectSegments(gap: number): SketchSegment[] {
      const top = createLineSegment({ p1: [0, 10], p2: [20, 10 + gap] }); // 右上角がgapだけy方向にずれた端点
      const right = createLineSegment({ p1: [20, 10], p2: [20, 0] }); // 右上角はずれていない元の座標
      const bottom = createLineSegment({ p1: [20, 0], p2: [0, 0] });
      const left = createLineSegment({ p1: [0, 0], p2: [0, 10] });
      return [top, right, bottom, left];
    }

    it("6e-3mmのギャップ(REGION_JOIN_EPS=0.01mm以内)は結合され、外枠1領域として検出される", () => {
      const segments = nearRectSegments(6e-3);
      const regions = findClosedRegions(segments);
      expect(regions).toHaveLength(1);
      expect(regions[0].holes).toHaveLength(0);
      const area = loopShoelaceArea(regions[0].outer);
      expect(Math.abs(area - 200)).toBeLessThan(0.1); // ギャップ由来の微小な面積誤差(<0.01mm^2オーダー)を許容する。
    });

    it("0.05mmのギャップ(REGION_JOIN_EPS=0.01mmを超える)は結合されず、領域は検出されない", () => {
      const segments = nearRectSegments(0.05);
      const regions = findClosedRegions(segments);
      expect(regions).toHaveLength(0);
    });

    it("6e-3mmギャップの外枠+内側の円entityは、classifySketchEntitiesでouter+holeに分類される(evaluatorのbuildDrawingPartsと同じ経路)", () => {
      const segments = nearRectSegments(6e-3);
      const regions = findClosedRegions(segments);
      expect(regions).toHaveLength(1);

      const circle = createCircleEntity({ center: [10, 5], radius: 2 });
      const regionProxy = { kind: "polygon" as const, id: "__region_outer__0", points: loopPolyline(regions[0].outer) };
      const { outers, holes } = classifySketchEntities([circle, regionProxy]);

      expect(outers).toHaveLength(1);
      expect(outers[0].id).toBe(regionProxy.id);
      expect(holes).toHaveLength(1);
      expect(holes[0].id).toBe(circle.id);
    });

    it("結合されたクラスタ内の端点はすべて同一座標にスナップされ、ループが厳密に閉じる(p2===次のp1)", () => {
      const segments = nearRectSegments(6e-3);
      const regions = findClosedRegions(segments);
      expect(regions).toHaveLength(1);
      const loop = regions[0].outer;
      for (let i = 0; i < loop.length; i += 1) {
        const next = loop[(i + 1) % loop.length];
        expect(loop[i].p2[0]).toBeCloseTo(next.p1[0], 9);
        expect(loop[i].p2[1]).toBeCloseTo(next.p1[1], 9);
      }
    });
  });
});
