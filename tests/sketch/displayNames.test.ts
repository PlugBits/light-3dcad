// src/sketch/displayNames.ts の単体テスト(純粋TS、WASM不要)。
// Phase 48(全スケッチ要素の寸法対応)で追加したentityVertexDisplayName/entityEdgeDisplayName/
// movableLineRefDisplayName相当の挙動を、describeConstraint()経由で検証する
// (これらは内部ヘルパーでexportされていないため、describeConstraintの出力文字列から確認する)。
import { describe, expect, it } from "vitest";

import type { SketchConstraint, SketchEntity, SketchSegment } from "../../src/model/types";
import { describeConstraint } from "../../src/sketch/displayNames";

const rect: SketchEntity = { kind: "rectangle", id: "r1", center: [0, 0], width: 10, height: 10 };
const slot: SketchEntity = { kind: "slot", id: "sl1", start: [0, 0], end: [10, 0], width: 4 };
const point: SketchEntity = { kind: "point", id: "p1", position: [1, 1] };
const polygon: SketchEntity = {
  kind: "polygon",
  id: "pg1",
  points: [
    [0, 0],
    [10, 0],
    [5, 10],
  ],
};

describe("describeConstraint(Phase 48: entityの頂点・辺の表示名)", () => {
  it("矩形の角(vertexIndex0=左下)は「矩形1の左下」と表示される", () => {
    const c: SketchConstraint = { id: "c1", kind: "distancePointOrigin", point: { entityId: "r1", vertexIndex: 0 }, value: 10 };
    expect(describeConstraint([], [rect], c)).toContain("矩形1の左下");
  });

  it("矩形の他の角も左下/右下/右上/左上のラベルで区別される", () => {
    const labels = [0, 1, 2, 3].map((vertexIndex) => {
      const c: SketchConstraint = { id: `c${vertexIndex}`, kind: "distancePointOrigin", point: { entityId: "r1", vertexIndex }, value: 10 };
      return describeConstraint([], [rect], c);
    });
    expect(labels).toEqual([
      expect.stringContaining("矩形1の左下"),
      expect.stringContaining("矩形1の右下"),
      expect.stringContaining("矩形1の右上"),
      expect.stringContaining("矩形1の左上"),
    ]);
  });

  it("スロットの始点/終点は「スロット1の始点」「スロット1の終点」と表示される", () => {
    const start: SketchConstraint = { id: "c1", kind: "distancePointOrigin", point: { entityId: "sl1", vertexIndex: 0 }, value: 10 };
    const end: SketchConstraint = { id: "c2", kind: "distancePointOrigin", point: { entityId: "sl1", vertexIndex: 1 }, value: 10 };
    expect(describeConstraint([], [slot], start)).toContain("スロット1の始点");
    expect(describeConstraint([], [slot], end)).toContain("スロット1の終点");
  });

  it("pointエンティティの頂点は「点1」のみ(接尾辞なし)で表示される", () => {
    const c: SketchConstraint = { id: "c1", kind: "distancePointOrigin", point: { entityId: "p1", vertexIndex: 0 }, value: 10 };
    const text = describeConstraint([], [point], c);
    expect(text).toContain("点1 ↔ 原点");
  });

  it("多角形の頂点は「多角形1の頂点N」(1始まり)で表示される", () => {
    const c: SketchConstraint = { id: "c1", kind: "distancePointOrigin", point: { entityId: "pg1", vertexIndex: 1 }, value: 10 };
    expect(describeConstraint([], [polygon], c)).toContain("多角形1の頂点2");
  });

  it("矩形の辺(entityEdge、edgeIndex0=下辺)は「矩形1の下辺」と表示される(distanceEntityLine)", () => {
    const c: SketchConstraint = {
      id: "c1",
      kind: "distanceEntityLine",
      entity: { entityId: "r1" },
      line: { kind: "entityEdge", entityId: "r1", edgeIndex: 0 },
      value: 10,
    };
    expect(describeConstraint([], [rect], c)).toContain("矩形1の下辺");
  });

  it("矩形の辺同士のdistanceLineLine(MovableLineRef)は両辺の名前を表示する", () => {
    const other: SketchEntity = { kind: "rectangle", id: "r2", center: [100, 100], width: 5, height: 5 };
    const c: SketchConstraint = {
      id: "c1",
      kind: "distanceLineLine",
      a: { kind: "entityEdge", entityId: "r1", edgeIndex: 0 },
      b: { kind: "entityEdge", entityId: "r2", edgeIndex: 2 },
      value: 10,
    };
    const text = describeConstraint([], [rect, other], c);
    expect(text).toContain("矩形1の下辺");
    expect(text).toContain("矩形2の上辺");
  });

  it("distanceLineLine後方互換: 素の文字列(segmentId)は従来通り線分名で表示される", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const c: SketchConstraint = { id: "c1", kind: "distanceLineLine", a: "s1", b: "s1", value: 10 };
    expect(describeConstraint([seg], [], c)).toContain("線分1");
  });

  it("端点(頂点)同士のdistanceは矩形の角と自由な線分の端点を組み合わせて表示できる", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 0] };
    const c: SketchConstraint = {
      id: "c1",
      kind: "distance",
      a: { entityId: "r1", vertexIndex: 0 },
      b: { segmentId: "s1", end: "p1" },
      value: 10,
    };
    const text = describeConstraint([seg], [rect], c);
    expect(text).toContain("矩形1の左下");
    expect(text).toContain("線分1の始点");
  });
});
