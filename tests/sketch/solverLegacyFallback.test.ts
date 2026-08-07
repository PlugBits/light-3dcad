// PlaneGCS移行(Phase 35b-1)後も、GCSアダプタ未登録/未初期化のあいだはsolveSketch()が
// 自前実装の旧ソルバ(solveSketchLegacy、src/sketch/solver.ts)へフォールバックすることを確認する。
// このファイルは意図的に registerGcsAdapter() を一切呼ばない(tests/sketch/solver.test.tsとは
// 別ファイルにして、vitestのモジュール分離[各テストファイルは独立したモジュールグラフを持つ]により
// src/sketch/solver.ts内のgcsAdapter変数がnullのまま[未登録]の状態を保証する)。
import { describe, expect, it } from "vitest";

import { solveSketch } from "../../src/sketch/solver";
import type { SketchConstraint, SketchSegment } from "../../src/model/types";

describe("solveSketch GCSアダプタ未登録時のフォールバック(旧ソルバ、Phase 35b-1)", () => {
  it("length拘束: 旧ソルバでも長さを指定値に解ける", () => {
    const seg: SketchSegment = { id: "s1", kind: "line", p1: [0, 0], p2: [10, 2] };
    const constraints: SketchConstraint[] = [{ id: "c1", kind: "length", segmentId: "s1", value: 20 }];
    const result = solveSketch([seg], constraints);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dx = result.segments[0].p2[0] - result.segments[0].p1[0];
    const dy = result.segments[0].p2[1] - result.segments[0].p1[1];
    expect(Math.hypot(dx, dy)).toBeCloseTo(20, 6);
  });

  it("矛盾する拘束は旧ソルバでもconflicting:trueを返す", () => {
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
});
