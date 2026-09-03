// src/viewer/zoomToCursor.ts の単体テスト(純粋TS、three.js/WebGL不要、Phase 49)。
import { describe, expect, it } from "vitest";

import { computeZoomToCursor, type Vec3 } from "../../src/viewer/zoomToCursor";

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function length(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}
function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return [a[0] / len, a[1] / len, a[2] / len];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe("computeZoomToCursor", () => {
  const cameraPos: Vec3 = [0, -10, 0];
  const target: Vec3 = [0, 0, 0];

  it("カーソルが画面中心(target方向)を指している場合、targetは動かず通常のズームと同じになる", () => {
    const result = computeZoomToCursor({
      cameraPos,
      target,
      rayOrigin: cameraPos,
      rayDir: sub(target, cameraPos),
      newDistance: 5,
    });
    expect(result.target[0]).toBeCloseTo(0, 9);
    expect(result.target[1]).toBeCloseTo(0, 9);
    expect(result.target[2]).toBeCloseTo(0, 9);
    // カメラは target から距離5、同じ方向(-Y側)。
    expect(length(sub(result.cameraPos, result.target))).toBeCloseTo(5, 9);
    expect(result.cameraPos[1]).toBeCloseTo(-5, 9);
  });

  it("画面中心からズレたカーソル位置を指す場合、そのワールド点は新しいカメラ位置から見ても同じレイ方向上に残る(=画面上で不変)", () => {
    // targetの平面(y=0)上、中心から少しX/Zにずれた点を狙うレイ。
    const cursorPoint: Vec3 = [3, 0, 2];
    const rayDir = sub(cursorPoint, cameraPos);

    const result = computeZoomToCursor({
      cameraPos,
      target,
      rayOrigin: cameraPos,
      rayDir,
      newDistance: 4, // ズームイン(10→4)
    });

    // 不変条件: (cursorPoint - newCameraPos) は元のrayDirと平行(同じ方向)であるべき
    // (=新しいカメラ位置から見ても、cursorPointは同じスクリーン方向にある)。
    const newRayDir = sub(cursorPoint, result.cameraPos);
    const a = normalize(newRayDir);
    const b = normalize(rayDir);
    expect(dot(a, b)).toBeCloseTo(1, 6); // 平行かつ同じ向き

    // ズームアウト方向でも同様に成立する。
    const resultOut = computeZoomToCursor({
      cameraPos,
      target,
      rayOrigin: cameraPos,
      rayDir,
      newDistance: 20,
    });
    const newRayDirOut = sub(cursorPoint, resultOut.cameraPos);
    expect(dot(normalize(newRayDirOut), b)).toBeCloseTo(1, 6);
  });

  it("newDistance === oldDistance(ズーム無し)なら実質的に何も変わらない", () => {
    const cursorPoint: Vec3 = [3, 0, 2];
    const result = computeZoomToCursor({
      cameraPos,
      target,
      rayOrigin: cameraPos,
      rayDir: sub(cursorPoint, cameraPos),
      newDistance: 10,
    });
    expect(result.target).toEqual([0, 0, 0]);
    for (let i = 0; i < 3; i += 1) {
      expect(result.cameraPos[i]).toBeCloseTo(cameraPos[i], 9);
    }
  });

  it("カーソルのレイが視線垂直面とほぼ平行な退化ケースでは、注視点中心の通常ズームにフォールバックする(NaN/Infinityを出さない)", () => {
    const result = computeZoomToCursor({
      cameraPos,
      target,
      rayOrigin: cameraPos,
      // forward=(0,1,0)とほぼ直交するレイ方向(=視線垂直面とほぼ平行)。
      rayDir: [1, 0, 0],
      newDistance: 6,
    });
    for (const v of [...result.cameraPos, ...result.target]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(result.target).toEqual([0, 0, 0]);
    expect(length(sub(result.cameraPos, result.target))).toBeCloseTo(6, 9);
  });

  it("ズーム後の距離は常にnewDistanceに一致する(移動方向によらず)", () => {
    for (const cursor of [
      [3, 0, 2],
      [-5, 0, -1],
      [0.2, 0, 8],
    ] as Vec3[]) {
      for (const newDistance of [1, 4, 15]) {
        const result = computeZoomToCursor({
          cameraPos,
          target,
          rayOrigin: cameraPos,
          rayDir: sub(cursor, cameraPos),
          newDistance,
        });
        expect(length(sub(result.cameraPos, result.target))).toBeCloseTo(newDistance, 6);
      }
    }
  });
});
