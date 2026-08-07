// 合致ソルバ(src/assembly/mateSolver.ts)の純粋数学部分のユニットテスト(OCCT非依存)。
// evaluator経由の統合テスト(tests/worker/evaluator.test.ts)より高速に反復できるよう、
// 幾何抽出を介さずMateInputを直接組み立てて検証する。
import { describe, expect, it } from "vitest";
import { solveMates, type MateInput } from "../../src/assembly/mateSolver";

describe("solveMates", () => {
  it("coincident: 可動な平面を固定平面に一致させる(法線が逆平行・オフセット0)", () => {
    // 固定面: z=20の上向き平面(法線+Z)。可動部品のローカル底面(中心[0,0,0]・法線-Z)を
    // 初期位置[0,0,50]から動かして一致させる。
    const mate: MateInput = {
      id: "mate1",
      kind: "coincident",
      a: { kind: "fixed", geom: { surface: "plane", center: [0, 0, 20], normal: [0, 0, 1] } },
      b: { kind: "variable", partId: "part1", local: { surface: "plane", center: [0, 0, 0], normal: [0, 0, -1] } },
    };
    const result = solveMates([mate], new Map([["part1", { position: [5, 3, 50], rotation: [0, 0, 0] }]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const placement = result.placements.get("part1");
    expect(placement).toBeDefined();
    expect(placement!.position[2]).toBeCloseTo(20, 4);
    // 法線方向(Z)以外は正則化により初期値付近に留まる(未拘束のX/Y)。
    expect(placement!.position[0]).toBeCloseTo(5, 3);
    expect(placement!.position[1]).toBeCloseTo(3, 3);
  });

  it("distance: coincidentと同形+オフセットvalueぶんだけ離れる", () => {
    const mate: MateInput = {
      id: "mate2",
      kind: "distance",
      value: 5,
      a: { kind: "fixed", geom: { surface: "plane", center: [0, 0, 20], normal: [0, 0, 1] } },
      b: { kind: "variable", partId: "part1", local: { surface: "plane", center: [0, 0, 0], normal: [0, 0, -1] } },
    };
    const result = solveMates([mate], new Map([["part1", { position: [0, 0, 50], rotation: [0, 0, 0] }]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placements.get("part1")!.position[2]).toBeCloseTo(25, 4);
  });

  it("concentric: 円筒軸が一致する(軸まわりの並進は拘束されない)", () => {
    // 固定軸: 原点を通るZ軸方向。可動部品のローカル軸(原点通過・Z方向)を初期位置[8,-3,17]から動かす。
    const mate: MateInput = {
      id: "mate3",
      kind: "concentric",
      a: { kind: "fixed", geom: { surface: "cylinder", axisPoint: [0, 0, 0], axisDir: [0, 0, 1] } },
      b: { kind: "variable", partId: "part1", local: { surface: "cylinder", axisPoint: [0, 0, 0], axisDir: [0, 0, 1] } },
    };
    const result = solveMates([mate], new Map([["part1", { position: [8, -3, 17], rotation: [0, 0, 0] }]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const placement = result.placements.get("part1")!;
    expect(placement.position[0]).toBeCloseTo(0, 3);
    expect(placement.position[1]).toBeCloseTo(0, 3);
    // Z(軸方向)は拘束されないため、正則化により初期値付近(17)に留まる。
    expect(placement.position[2]).toBeCloseTo(17, 2);
  });

  it("矛盾する2つのcoincidentは収束せずok:falseを返す", () => {
    const mateA: MateInput = {
      id: "mateA",
      kind: "coincident",
      a: { kind: "fixed", geom: { surface: "plane", center: [0, 0, 0], normal: [0, 0, 1] } },
      b: { kind: "variable", partId: "part1", local: { surface: "plane", center: [0, 0, 0], normal: [0, 0, -1] } },
    };
    const mateB: MateInput = {
      id: "mateB",
      kind: "coincident",
      a: { kind: "fixed", geom: { surface: "plane", center: [0, 0, 100], normal: [0, 0, 1] } },
      b: { kind: "variable", partId: "part1", local: { surface: "plane", center: [0, 0, 0], normal: [0, 0, -1] } },
    };
    const result = solveMates([mateA, mateB], new Map([["part1", { position: [0, 0, 50], rotation: [0, 0, 0] }]]));
    expect(result.ok).toBe(false);
  });

  it("関与するpartInstanceが無ければ何もしない(空のplacements)", () => {
    const result = solveMates([], new Map());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.placements.size).toBe(0);
  });
});
