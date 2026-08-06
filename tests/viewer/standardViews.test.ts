// src/viewer/standardViews.ts の単体テスト(純粋TS、three.js/WebGL不要、Phase 16)。
import { describe, expect, it } from "vitest";

import { getStandardViewOrientation, type StandardView } from "../../src/viewer/standardViews";

function length([x, y, z]: [number, number, number]): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe("getStandardViewOrientation", () => {
  const views: StandardView[] = ["front", "back", "left", "right", "top", "bottom", "iso"];

  it("すべてのビューでdirection・upが有限かつ非ゼロベクトルである", () => {
    for (const view of views) {
      const { direction, up } = getStandardViewOrientation(view);
      expect(length(direction)).toBeGreaterThan(0);
      expect(length(up)).toBeGreaterThan(0);
      for (const v of [...direction, ...up]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("direction と up が平行にならない(カメラ姿勢が破綻しない)", () => {
    for (const view of views) {
      const { direction, up } = getStandardViewOrientation(view);
      const dLen = length(direction);
      const uLen = length(up);
      const cos = dot(direction, up) / (dLen * uLen);
      // 平行(cos ±1)に近すぎるとlookAt/OrbitControlsが破綻するため、明確に離れていることを確認する。
      expect(Math.abs(cos)).toBeLessThan(0.99);
    }
  });

  it("front/back, left/right, top/bottom は互いに正反対の方向を向く", () => {
    const pairs: [StandardView, StandardView][] = [
      ["front", "back"],
      ["left", "right"],
      ["top", "bottom"],
    ];
    for (const [a, b] of pairs) {
      const da = getStandardViewOrientation(a).direction;
      const db = getStandardViewOrientation(b).direction;
      expect(da[0]).toBeCloseTo(-db[0]);
      expect(da[1]).toBeCloseTo(-db[1]);
      expect(da[2]).toBeCloseTo(-db[2]);
    }
  });

  it("top は+Z、front は-Yから見る(Z-up CAD慣習)", () => {
    expect(getStandardViewOrientation("top").direction).toEqual([0, 0, 1]);
    expect(getStandardViewOrientation("front").direction).toEqual([0, -1, 0]);
  });
});
