// src/sketch/autoConstraints.ts の単体テスト(純粋TS、WASM不要、Phase 20a)。
import { describe, expect, it } from "vitest";

import { buildAutoConstraintsForChain } from "../../src/sketch/autoConstraints";
import type { SketchSegment } from "../../src/model/types";

describe("buildAutoConstraintsForChain", () => {
  it("連続する2セグメントの接続端点にcoincidentを1件生成する", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [10, 0], p2: [10, 10] };
    const result = buildAutoConstraintsForChain({ newSegments: [a, b] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "coincident",
      a: { segmentId: "a", end: "p2" },
      b: { segmentId: "b", end: "p1" },
    });
  });

  it("3セグメントのチェーンで隣接ペア2件のcoincidentを生成する(順序どおり)", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [10, 0], p2: [10, 10] };
    const c: SketchSegment = { id: "c", kind: "line", p1: [10, 10], p2: [0, 10] };
    const result = buildAutoConstraintsForChain({ newSegments: [a, b, c] });
    const coincidents = result.filter((c2) => c2.kind === "coincident");
    expect(coincidents).toHaveLength(2);
    expect(coincidents[0]).toMatchObject({ a: { segmentId: "a", end: "p2" }, b: { segmentId: "b", end: "p1" } });
    expect(coincidents[1]).toMatchObject({ a: { segmentId: "b", end: "p2" }, b: { segmentId: "c", end: "p1" } });
  });

  it("軸ロックで確定した辺にhorizontal/verticalを付ける(ロックなしの辺には付けない)", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [10, 0], p2: [10, 10] };
    const c: SketchSegment = { id: "c", kind: "line", p1: [10, 10], p2: [15, 13] }; // ロックなし
    const result = buildAutoConstraintsForChain({
      newSegments: [a, b, c],
      axisLocks: ["horizontal", "vertical", null],
    });
    const horizontal = result.filter((c2) => c2.kind === "horizontal");
    const vertical = result.filter((c2) => c2.kind === "vertical");
    expect(horizontal).toHaveLength(1);
    expect(horizontal[0]).toMatchObject({ segmentId: "a" });
    expect(vertical).toHaveLength(1);
    expect(vertical[0]).toMatchObject({ segmentId: "b" });
    // cはロックなしなので水平/垂直どちらも付かない。
    expect(result.some((c2) => "segmentId" in c2 && c2.segmentId === "c")).toBe(false);
  });

  it("円弧辺(bulgeあり)は軸ロックフラグが立っていてもhorizontal/verticalを付けない", () => {
    const arc: SketchSegment = { id: "arc1", kind: "arc", p1: [0, 0], p2: [10, 0], bulge: 0.5 };
    const result = buildAutoConstraintsForChain({ newSegments: [arc], axisLocks: ["horizontal"] });
    expect(result).toHaveLength(0);
  });

  it("始点付近クリックで閉じたチェーン(終端が始点と一致)は自己閉合のcoincidentを生成する", () => {
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const b: SketchSegment = { id: "b", kind: "line", p1: [10, 0], p2: [10, 10] };
    const c: SketchSegment = { id: "c", kind: "line", p1: [10, 10], p2: [0, 0] }; // 終端が始点(0,0)と一致
    const result = buildAutoConstraintsForChain({ newSegments: [a, b, c] });
    const coincidents = result.filter((c2) => c2.kind === "coincident");
    // 隣接2件 + 自己閉合1件 = 3件。
    expect(coincidents).toHaveLength(3);
    const closing = coincidents.find(
      (c2) =>
        (c2.a.segmentId === "c" && c2.a.end === "p2" && c2.b.segmentId === "a" && c2.b.end === "p1") ||
        (c2.b.segmentId === "c" && c2.b.end === "p2" && c2.a.segmentId === "a" && c2.a.end === "p1"),
    );
    expect(closing).toBeDefined();
  });

  it("既存セグメントの端点にスナップして接続した場合、既存側とのcoincidentを生成する", () => {
    const existing: SketchSegment = { id: "ex1", kind: "line", p1: [0, 0], p2: [0, 20] };
    const newSeg: SketchSegment = { id: "new1", kind: "line", p1: [0, 20], p2: [10, 20] }; // p1が既存のp2に一致
    const result = buildAutoConstraintsForChain({ newSegments: [newSeg], existingSegments: [existing] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "coincident",
      a: { segmentId: "new1", end: "p1" },
      b: { segmentId: "ex1", end: "p2" },
    });
  });

  it("既存セグメント同士の組み合わせではcoincidentを生成しない(新規チェーンと無関係な一致は無視)", () => {
    const existingA: SketchSegment = { id: "exA", kind: "line", p1: [0, 0], p2: [5, 5] };
    const existingB: SketchSegment = { id: "exB", kind: "line", p1: [5, 5], p2: [9, 9] }; // exAと端点一致だが両方既存
    const newSeg: SketchSegment = { id: "new1", kind: "line", p1: [50, 50], p2: [60, 60] }; // 完全に無関係
    const result = buildAutoConstraintsForChain({ newSegments: [newSeg], existingSegments: [existingA, existingB] });
    expect(result).toHaveLength(0);
  });

  it("同じ端点ペアを重複して生成しない(隣接ペアと自己閉合検出の重複排除)", () => {
    // 1本だけのチェーンでp1とp2がほぼ一致(縮退に近いが許容範囲外)しても、隣接ルールが無いため
    // 自己閉合ルールのみが1件生成することを確認する(隣接ペアが無い=重複の余地が無いケースの基本確認)。
    const a: SketchSegment = { id: "a", kind: "line", p1: [0, 0], p2: [10, 0] };
    const result = buildAutoConstraintsForChain({ newSegments: [a] });
    expect(result).toHaveLength(0); // 単独セグメントは接続端点も自己閉合も無い。
  });

  it("接続点・軸ロック・既存スナップを組み合わせた矩形チェーンで期待どおりの拘束一式を生成する", () => {
    const bottom: SketchSegment = { id: "bottom", kind: "line", p1: [0, 0], p2: [10, 0] };
    const right: SketchSegment = { id: "right", kind: "line", p1: [10, 0], p2: [10, 6] };
    const top: SketchSegment = { id: "top", kind: "line", p1: [10, 6], p2: [0, 6] };
    const left: SketchSegment = { id: "left", kind: "line", p1: [0, 6], p2: [0, 0] };
    const result = buildAutoConstraintsForChain({
      newSegments: [bottom, right, top, left],
      axisLocks: ["horizontal", "vertical", "horizontal", "vertical"],
    });
    const coincidents = result.filter((c) => c.kind === "coincident");
    const horizontals = result.filter((c) => c.kind === "horizontal");
    const verticals = result.filter((c) => c.kind === "vertical");
    // 隣接3件(bottom-right, right-top, top-left) + 自己閉合1件(left.p2 <-> bottom.p1) = 4件。
    expect(coincidents).toHaveLength(4);
    expect(horizontals).toHaveLength(2);
    expect(verticals).toHaveLength(2);
  });
});
