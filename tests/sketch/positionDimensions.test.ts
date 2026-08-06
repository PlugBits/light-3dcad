// src/sketch/positionDimensions.ts の単体テスト(純粋TS、WASM不要)。
import { describe, expect, it } from "vitest";

import {
  distanceBetweenPoints,
  distancePointToLine,
  moveCenterAlongDirection,
  moveCenterToLineDistance,
} from "../../src/sketch/positionDimensions";

describe("distanceBetweenPoints", () => {
  it("2点間のユークリッド距離を返す", () => {
    expect(distanceBetweenPoints([0, 0], [3, 4])).toBeCloseTo(5, 6);
  });
});

describe("moveCenterAlongDirection", () => {
  it("anchor→centerの方向を保ったまま指定距離の位置へ移動する", () => {
    const moved = moveCenterAlongDirection([10, 0], [0, 0], 25);
    expect(moved[0]).toBeCloseTo(25, 6);
    expect(moved[1]).toBeCloseTo(0, 6);
  });

  it("斜め方向でも単位ベクトルを保ったまま距離だけ変える", () => {
    const moved = moveCenterAlongDirection([3, 4], [0, 0], 10); // 元の距離は5
    expect(moved[0]).toBeCloseTo(6, 6);
    expect(moved[1]).toBeCloseTo(8, 6);
  });

  it("centerとanchorが一致する(距離0)場合は+X方向を採用する", () => {
    const moved = moveCenterAlongDirection([5, 5], [5, 5], 12);
    expect(moved[0]).toBeCloseTo(17, 6);
    expect(moved[1]).toBeCloseTo(5, 6);
  });
});

describe("distancePointToLine", () => {
  it("水平線(y=0)への垂直距離を返す", () => {
    expect(distancePointToLine([3, 7], [0, 0], [10, 0])).toBeCloseTo(7, 6);
  });
});

describe("moveCenterToLineDistance", () => {
  it("水平線から現在の側を保ったまま指定距離の位置へ中心を移動する", () => {
    const moved = moveCenterToLineDistance([3, 7], [0, 0], [10, 0], 20);
    expect(moved[0]).toBeCloseTo(3, 6); // 直線に平行な足元のx座標は変わらない
    expect(moved[1]).toBeCloseTo(20, 6); // 同じ側(+y)に距離20
  });

  it("中心が直線上にある(距離0)場合はデフォルトの法線方向へ移動する", () => {
    const moved = moveCenterToLineDistance([5, 0], [0, 0], [10, 0], 8);
    // a→b方向([1,0])を左に90度回した法線は[0,1]
    expect(moved[0]).toBeCloseTo(5, 6);
    expect(moved[1]).toBeCloseTo(8, 6);
  });
});
