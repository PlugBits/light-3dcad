// クリック作図ツール(矩形・円、Phase 14)用の2点→ジオメトリ変換。React/Three非依存の純粋関数のみ
// (テスト容易性優先)。CadViewerのプレビュー描画・確定コールバックの両方から使う。

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
