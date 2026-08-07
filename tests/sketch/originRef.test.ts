// src/sketch/originRef.ts の単体テスト(純粋TS、WASM不要)。
import { describe, expect, it } from "vitest";

import { worldOriginLocal } from "../../src/sketch/originRef";

describe("worldOriginLocal", () => {
  it("① world平面相当(origin=[0,0,0])のスケッチでは常にローカル[0,0]になる", () => {
    const basis = { origin: [0, 0, 0] as [number, number, number], xDir: [1, 0, 0] as [number, number, number], yDir: [0, 1, 0] as [number, number, number] };
    const [u, v] = worldOriginLocal(basis);
    expect(u).toBeCloseTo(0, 6);
    expect(v).toBeCloseTo(0, 6);
  });

  it("② 面上スケッチ(originが原点でない)では、ワールド原点の投影位置がローカル[0,0]以外になる(箱を(30,20)中心で作った上面スケッチ相当)", () => {
    // 面中心(30,20,10)、法線+Z、xDir=+X、yDir=+Yの面上スケッチ。ワールド原点[0,0,0]を
    // このローカル座標系に投影すると、面中心から見て(-30,-20)の位置になる。
    const basis = { origin: [30, 20, 10] as [number, number, number], xDir: [1, 0, 0] as [number, number, number], yDir: [0, 1, 0] as [number, number, number] };
    const [u, v] = worldOriginLocal(basis);
    expect(u).toBeCloseTo(-30, 6);
    expect(v).toBeCloseTo(-20, 6);
  });

  it("③ 回転した基底(XZ平面相当)でも正しく投影される", () => {
    // 面中心(5,10,3)、xDir=+X、yDir=+Z(XZ平面的な基底)。
    const basis = { origin: [5, 10, 3] as [number, number, number], xDir: [1, 0, 0] as [number, number, number], yDir: [0, 0, 1] as [number, number, number] };
    const [u, v] = worldOriginLocal(basis);
    expect(u).toBeCloseTo(-5, 6);
    expect(v).toBeCloseTo(-3, 6);
  });
});
