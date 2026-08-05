// Phase 9: スナップ・軸ロックエンジン(src/sketch/snapping.ts)の単体テスト。
// 純粋関数のみを対象とするため environment: "node" のまま(vitest.config.ts参照)テスト可能。
import { describe, expect, it } from "vitest";

import {
  applyAxisLock,
  collectSketchSnapCandidates,
  findSnap,
  ORIGIN_CANDIDATE,
  pointsToVertexCandidates,
  resolveDrawingPoint,
  type SnapCandidate,
} from "../../src/sketch/snapping";

describe("findSnap", () => {
  it("許容距離内に候補が無ければnullを返す(グリッド無効時)", () => {
    const result = findSnap([5, 5], [], 0, 1);
    expect(result).toBeNull();
  });

  it("許容距離ちょうど外側の候補は無視する", () => {
    const candidates: SnapCandidate[] = [{ point: [0, 1.01], kind: "vertex" }];
    expect(findSnap([0, 0], candidates, 0, 1)).toBeNull();
  });

  it("許容距離ちょうど境界の候補は採用する", () => {
    const candidates: SnapCandidate[] = [{ point: [0, 1], kind: "vertex" }];
    expect(findSnap([0, 0], candidates, 0, 1)).toEqual({ point: [0, 1], kind: "vertex" });
  });

  it("優先順位: vertexがcenterより近くても遠くても優先される(距離が同等の場合)", () => {
    const candidates: SnapCandidate[] = [
      { point: [0.5, 0], kind: "center" },
      { point: [0.6, 0], kind: "vertex" },
    ];
    // centerの方がわずかに近いが、優先順位はvertexが上のためvertexが選ばれる。
    const result = findSnap([0, 0], candidates, 0, 2);
    expect(result).toEqual({ point: [0.6, 0], kind: "vertex" });
  });

  it("優先順位: center > midpoint > origin > grid の順で優先される", () => {
    const candidates: SnapCandidate[] = [
      { point: [0.1, 0], kind: "grid" }, // gridは自動生成分と衝突しないよう別候補として明示テスト
      { point: [0.1, 0], kind: "origin" },
      { point: [0.1, 0], kind: "midpoint" },
      { point: [0.1, 0], kind: "center" },
    ];
    expect(findSnap([0, 0], candidates, 0, 1)).toEqual({ point: [0.1, 0], kind: "center" });
  });

  it("同一種別内では最近傍の候補を選ぶ", () => {
    const candidates: SnapCandidate[] = [
      { point: [0.9, 0], kind: "vertex" },
      { point: [0.3, 0], kind: "vertex" },
    ];
    expect(findSnap([0, 0], candidates, 0, 2)).toEqual({ point: [0.3, 0], kind: "vertex" });
  });

  it("gridSpacing>0のとき、カーソル位置から最近傍のグリッド交点を候補として生成する", () => {
    const result = findSnap([4.6, -2.3], [], 1, 1);
    expect(result).toEqual({ point: [5, -2], kind: "grid" });
  });

  it("点スナップとグリッドスナップが両方許容距離内なら点スナップが優先される", () => {
    const candidates: SnapCandidate[] = [{ point: [4.6, -2.3], kind: "vertex" }];
    const result = findSnap([4.6, -2.3], candidates, 1, 1);
    expect(result).toEqual({ point: [4.6, -2.3], kind: "vertex" });
  });

  it("ORIGIN_CANDIDATEは(0,0)のorigin種別である", () => {
    expect(ORIGIN_CANDIDATE).toEqual({ point: [0, 0], kind: "origin" });
  });
});

describe("applyAxisLock", () => {
  it("水平(0度)方向はhorizontalにロックしfromのyに揃える", () => {
    const result = applyAxisLock([0, 0], [10, 0.5], 5);
    expect(result.axis).toBe("horizontal");
    expect(result.point).toEqual([10, 0]);
  });

  it("垂直(90度)方向はverticalにロックしfromのxに揃える", () => {
    const result = applyAxisLock([0, 0], [0.5, 10], 5);
    expect(result.axis).toBe("vertical");
    expect(result.point).toEqual([0, 10]);
  });

  it("負方向の水平(180度)もhorizontalにロックする", () => {
    const result = applyAxisLock([5, 5], [-5, 5.3], 5);
    expect(result.axis).toBe("horizontal");
    expect(result.point).toEqual([-5, 5]);
  });

  it("負方向の垂直(-90度/270度)もverticalにロックする", () => {
    const result = applyAxisLock([5, 5], [5.3, -5], 5);
    expect(result.axis).toBe("vertical");
    expect(result.point).toEqual([5, -5]);
  });

  it("±5度ちょうど境界はロックする(inclusive)", () => {
    const from: [number, number] = [0, 0];
    const angleRad = (5 * Math.PI) / 180;
    const cursor: [number, number] = [Math.cos(angleRad) * 10, Math.sin(angleRad) * 10];
    const result = applyAxisLock(from, cursor, 5);
    expect(result.axis).toBe("horizontal");
    expect(result.point[1]).toBeCloseTo(0, 10);
  });

  it("5度を超えるとロックしない", () => {
    const from: [number, number] = [0, 0];
    const angleRad = (5.5 * Math.PI) / 180;
    const cursor: [number, number] = [Math.cos(angleRad) * 10, Math.sin(angleRad) * 10];
    const result = applyAxisLock(from, cursor, 5);
    expect(result.axis).toBeNull();
    expect(result.point).toEqual(cursor);
  });

  it("fromとcursorが一致する場合はaxis:nullを返す(方向不定)", () => {
    const result = applyAxisLock([3, 4], [3, 4], 5);
    expect(result.axis).toBeNull();
    expect(result.point).toEqual([3, 4]);
  });
});

describe("collectSketchSnapCandidates", () => {
  it("rectangleは4頂点+4中点を候補にする(centerは含まない)", () => {
    const candidates = collectSketchSnapCandidates([
      { kind: "rectangle", id: "r1", center: [0, 0], width: 10, height: 4 },
    ]);
    const vertices = candidates.filter((c) => c.kind === "vertex");
    const midpoints = candidates.filter((c) => c.kind === "midpoint");
    expect(vertices).toHaveLength(4);
    expect(midpoints).toHaveLength(4);
    expect(candidates.some((c) => c.kind === "center")).toBe(false);
    expect(vertices).toContainEqual({ point: [-5, -2], kind: "vertex" });
    expect(midpoints).toContainEqual({ point: [0, -2], kind: "midpoint" });
  });

  it("circleは中心のみを候補にする(vertex/midpointなし)", () => {
    const candidates = collectSketchSnapCandidates([{ kind: "circle", id: "c1", center: [3, 4], radius: 10 }]);
    expect(candidates).toEqual([{ point: [3, 4], kind: "center" }]);
  });

  it("polygonは全頂点+各辺の中点を候補にする", () => {
    const candidates = collectSketchSnapCandidates([
      {
        kind: "polygon",
        id: "p1",
        points: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
      },
    ]);
    expect(candidates.filter((c) => c.kind === "vertex")).toHaveLength(3);
    expect(candidates.filter((c) => c.kind === "midpoint")).toHaveLength(3);
    expect(candidates).toContainEqual({ point: [5, 0], kind: "midpoint" });
  });
});

describe("pointsToVertexCandidates", () => {
  it("頂点列をすべてvertex種別に変換する", () => {
    expect(
      pointsToVertexCandidates([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([
      { point: [1, 2], kind: "vertex" },
      { point: [3, 4], kind: "vertex" },
    ]);
  });
});

describe("resolveDrawingPoint", () => {
  it("lastPointが無ければ軸ロックせず点スナップのみ適用する", () => {
    const result = resolveDrawingPoint({
      cursor: [0.2, -0.1],
      lastPoint: null,
      candidates: [ORIGIN_CANDIDATE],
      gridSpacing: 0,
      tolerance: 1,
      axisLockEnabled: true,
    });
    expect(result).toEqual({ point: [0, 0], snapKind: "origin", axis: null });
  });

  it("axisLockEnabled:falseはShift相当で軸ロックを無効化する(生カーソルへの点スナップのみ)", () => {
    const result = resolveDrawingPoint({
      cursor: [10, 3],
      lastPoint: [0, 0],
      candidates: [],
      gridSpacing: 0,
      tolerance: 1,
      axisLockEnabled: false,
    });
    expect(result).toEqual({ point: [10, 3], snapKind: null, axis: null });
  });

  it("軸から3度ずれた移動は水平ロックし、固定座標をfromに一致させる", () => {
    const from: [number, number] = [0, 0];
    const angleRad = (3 * Math.PI) / 180;
    const cursor: [number, number] = [Math.cos(angleRad) * 20, Math.sin(angleRad) * 20];
    const result = resolveDrawingPoint({
      cursor,
      lastPoint: from,
      candidates: [],
      gridSpacing: 0,
      tolerance: 1,
      axisLockEnabled: true,
    });
    expect(result.axis).toBe("horizontal");
    expect(result.point[1]).toBe(0);
  });

  it("軸ロック中、軸から外れる点候補は無視され、軸上の候補のみスナップ対象になる", () => {
    const from: [number, number] = [0, 0];
    const cursor: [number, number] = [10, 0.2]; // ほぼ水平 → horizontalロック
    const candidates: SnapCandidate[] = [
      { point: [9.9, 5], kind: "vertex" }, // 軸(y=0)から大きく外れる → 無視される
      { point: [10.1, 0], kind: "vertex" }, // 軸上 → 採用されうる
    ];
    const result = resolveDrawingPoint({
      cursor,
      lastPoint: from,
      candidates,
      gridSpacing: 0,
      tolerance: 1,
      axisLockEnabled: true,
    });
    expect(result.axis).toBe("horizontal");
    expect(result.point).toEqual([10.1, 0]);
    expect(result.snapKind).toBe("vertex");
  });

  it("軸ロック中のグリッドスナップは自由座標のみ丸め、固定座標はfromの値を保つ", () => {
    const from: [number, number] = [0.3, 0.3]; // グリッド非整合点から開始
    const cursor: [number, number] = [4.6, 0.32]; // ほぼ水平
    const result = resolveDrawingPoint({
      cursor,
      lastPoint: from,
      candidates: [],
      gridSpacing: 1,
      tolerance: 1,
      axisLockEnabled: true,
    });
    expect(result.axis).toBe("horizontal");
    expect(result.point).toEqual([5, 0.3]);
  });
});
