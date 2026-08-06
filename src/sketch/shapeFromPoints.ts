// クリック作図ツール(矩形・円・スロット・正多角形、Phase 14/17)用の2点→ジオメトリ変換。
// React/Three非依存の純粋関数のみ(テスト容易性優先)。CadViewerのプレビュー描画・確定コールバックの
// 両方から使う。
import { bulgeArcPoints } from "./bulge";

/** スロットのキャップ半円のbulge値(replicadのbulgeArcTo規約で半円=tan(±π/4)=±1。src/sketch/bulge.ts参照)。 */
export const SLOT_CAP_BULGE = -1;

/** 対角2点(コーナー1・コーナー2、ローカル2D座標mm)から矩形の中心・幅・高さを計算する。 */
export function rectangleFromCorners(
  p1: [number, number],
  p2: [number, number],
): { center: [number, number]; width: number; height: number } {
  return {
    center: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2],
    width: Math.abs(p2[0] - p1[0]),
    height: Math.abs(p2[1] - p1[1]),
  };
}

/** 対角2点から矩形の4頂点(閉ループ、始点から時計回り/反時計回りいずれか)を返す(プレビュー描画用)。 */
export function rectangleCornerPoints(p1: [number, number], p2: [number, number]): [number, number][] {
  return [
    [p1[0], p1[1]],
    [p2[0], p1[1]],
    [p2[0], p2[1]],
    [p1[0], p2[1]],
  ];
}

/** 中心と円周上の1点から半径を計算する。 */
export function circleRadiusFromPoints(center: [number, number], edge: [number, number]): number {
  return Math.hypot(edge[0] - center[0], edge[1] - center[1]);
}

/** 中心と頂点1つから正多角形の外接円半径・回転角(ラジアン、+X軸からのCCW)を計算する(Phase 17)。 */
export function regularPolygonFromCenterVertex(
  center: [number, number],
  vertex: [number, number],
): { radius: number; rotation: number } {
  const dx = vertex[0] - center[0];
  const dy = vertex[1] - center[1];
  return { radius: Math.hypot(dx, dy), rotation: Math.atan2(dy, dx) };
}

/** 正多角形(外接円半径radius、辺数sides、回転rotation)の頂点列を返す(Phase 17)。sides>=3が前提。 */
export function regularPolygonVertices(
  center: [number, number],
  radius: number,
  sides: number,
  rotation = 0,
): [number, number][] {
  const [cx, cy] = center;
  const n = Math.max(3, Math.round(sides));
  const points: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    const angle = rotation + (i / n) * Math.PI * 2;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return points;
}

/** start→end方向の直線に対して左向き(CCW90度)の単位法線ベクトル。start===endの場合は[0,1]にフォールバックする。 */
export function slotAxisNormal(start: [number, number], end: [number, number]): [number, number] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [0, 1];
  return [-dy / len, dx / len];
}

/**
 * 直線スロット(中心線start→end、全幅width)の輪郭(閉ループ、両端は半円キャップ)を
 * ポリライン近似で返す(Phase 17)。evaluatorが実際のB-Rep形状を作る際に使うbulgeArcTo(±1)と
 * 同じ弧の定義(src/sketch/bulge.ts)を使うため、オーバーレイと実形状が一致する。
 */
export function slotOutlinePoints(
  start: [number, number],
  end: [number, number],
  width: number,
  segmentsPerCap = 16,
): [number, number][] {
  const r = width / 2;
  const n = slotAxisNormal(start, end);
  const a: [number, number] = [start[0] + n[0] * r, start[1] + n[1] * r];
  const b: [number, number] = [end[0] + n[0] * r, end[1] + n[1] * r];
  const c: [number, number] = [end[0] - n[0] * r, end[1] - n[1] * r];
  const d: [number, number] = [start[0] - n[0] * r, start[1] - n[1] * r];
  const capBC = bulgeArcPoints(b, c, SLOT_CAP_BULGE, segmentsPerCap); // [b, ..., c]
  const capDA = bulgeArcPoints(d, a, SLOT_CAP_BULGE, segmentsPerCap); // [d, ..., a]
  return [a, b, ...capBC.slice(1), d, ...capDA.slice(1, -1)];
}
