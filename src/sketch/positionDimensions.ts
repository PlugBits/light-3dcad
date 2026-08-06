// 円の位置寸法(第1弾、Phase 21b)の純ロジック。ソルバ(src/sketch/solver.ts)は使わず、
// 「距離を計算する」「距離を満たすように中心を移動する」だけの決定的な関数群。
// React/Three.js/Replicadに依存しない純粋TypeScript(src/sketch/entityDimensionPick.tsと同じ方針)。
//
// 対応する3ケース(すべて「動くのは円の中心のみ、相手は動かない」):
//   1. 円 ↔ スケッチ原点(ローカル座標系の原点、常に[0,0])の距離
//   2. 円 ↔ 円の中心間距離(後にクリックした方=移動対象の中心)
//   3. 円の中心 ↔ 辺(直線)の垂直距離(辺は動かない)

export type Point2 = [number, number];

/** 2点間のユークリッド距離。 */
export function distanceBetweenPoints(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * anchorを固定したまま、center を「anchor→centerの方向を保った」状態で距離distanceの位置へ
 * 移動した新しい座標を返す(円→原点、円→円で共通に使う)。
 * center と anchor が一致している(方向が定まらない)場合は +X方向([anchor+distance, anchor])を採用する。
 */
export function moveCenterAlongDirection(center: Point2, anchor: Point2, distance: number): Point2 {
  const dx = center[0] - anchor[0];
  const dy = center[1] - anchor[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) {
    return [anchor[0] + distance, anchor[1]];
  }
  const ux = dx / d;
  const uy = dy / d;
  return [anchor[0] + ux * distance, anchor[1] + uy * distance];
}

/** 点pointから、a・bを通る無限直線(辺の延長線)への垂直距離。 */
export function distancePointToLine(point: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lineLen = Math.hypot(dx, dy);
  if (lineLen < 1e-9) return distanceBetweenPoints(point, a);
  const cross = (point[0] - a[0]) * dy - (point[1] - a[1]) * dx;
  return Math.abs(cross) / lineLen;
}

/**
 * center を、直線(a, bを通る無限直線)からの垂直距離が distance になるよう、
 * 現在centerがある側の法線方向へ移動した新しい座標を返す(辺自体は動かさない)。
 * centerが直線上にある(距離0、どちら側か定まらない)場合は、a→b方向を左に90度回した向き
 * ([-dy, dx]を正規化したもの)をデフォルトの法線として採用する。
 */
export function moveCenterToLineDistance(center: Point2, a: Point2, b: Point2, distance: number): Point2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) return moveCenterAlongDirection(center, a, distance);

  const t = ((center[0] - a[0]) * dx + (center[1] - a[1]) * dy) / lenSq;
  const foot: Point2 = [a[0] + t * dx, a[1] + t * dy];
  const vx = center[0] - foot[0];
  const vy = center[1] - foot[1];
  const s = Math.hypot(vx, vy);

  let nx: number;
  let ny: number;
  if (s < 1e-9) {
    const lineLen = Math.sqrt(lenSq);
    nx = -dy / lineLen;
    ny = dx / lineLen;
  } else {
    nx = vx / s;
    ny = vy / s;
  }
  return [foot[0] + nx * distance, foot[1] + ny * distance];
}
