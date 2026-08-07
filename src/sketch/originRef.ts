// 「原点」= ワールド原点(0,0,0)をスケッチ平面へ投影した点、という定義(仕様変更対応)を扱う
// 純粋関数群。ReactにもThree.jsにもReplicad(OCCT)にも依存しない(他のsrc/sketch/*.tsと同じ方針)。
// src/state/store.ts(originLocalスナップショットの追従更新)・src/app/App.tsx(拘束作成時点の
// originLocal計算)・src/viewer/CadViewer.ts(原点マーカーの表示・ピック位置)の3箇所から共通で使う。
//
// PlaneBasis(CadViewer.ts)・SketchPlaneInfo(protocol/messages.ts)はいずれもorigin/xDir/yDir/normalの
// 形が同一(いずれもワールド座標系の正規直交基底)なので、この最小限の構造型で共通に扱える。
export interface PlaneBasisLike {
  origin: [number, number, number];
  xDir: [number, number, number];
  yDir: [number, number, number];
}

/**
 * ワールド原点(0,0,0)をbasisのローカル2D座標に投影した点を返す。
 * world平面(XY等、basis.origin=[0,0,0])のスケッチでは常に[0,0]になり、従来の「スケッチのローカル
 * 原点=ワールド原点」という前提のまま動く。面上スケッチ(basis.originが面の基準点、ワールド原点とは
 * 一般に異なる)では、ワールド原点をbasisのxDir/yDir方向に射影した実際の点になる。
 * 計算式はplaneWorldToLocal(basis, [0,0,0])と同じ(rel = -basis.origin、u = rel・xDir、v = rel・yDir)。
 */
export function worldOriginLocal(basis: PlaneBasisLike): [number, number] {
  const rx = -basis.origin[0];
  const ry = -basis.origin[1];
  const rz = -basis.origin[2];
  return [
    rx * basis.xDir[0] + ry * basis.xDir[1] + rz * basis.xDir[2],
    rx * basis.yDir[0] + ry * basis.yDir[1] + rz * basis.yDir[2],
  ];
}
