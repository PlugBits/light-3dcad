// 面(平面)の中心・法線から、決定的なxDirを持つワールド座標系の平面基底を求める純粋関数群。
// Worker(src/worker/evaluator.ts、OCCTのPlane構築)とビューア(src/viewer/CadViewer.ts、
// 面クリック点のローカル2D化。ねじフィーチャーの配置クリック、Phase 25c)の両方から参照するため、
// replicad等の重い依存を持たない(このファイル自体はTuple3の純粋な計算のみ)。
export type Tuple3 = [number, number, number];

export interface FacePlaneBasis {
  origin: Tuple3;
  xDir: Tuple3;
  yDir: Tuple3;
  normal: Tuple3;
}

function cross(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(v: Tuple3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}
function normalize(v: Tuple3): Tuple3 {
  const len = length(v);
  if (len < 1e-12) return v;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * 面の法線から、決定的なxDir(未正規化)を求める。
 * xDir は法線とグローバルZの外積(normal × Z)。ほぼ平行(Z軸自体を向く面)な場合はグローバルXに
 * フォールバックする。evaluator.tsのbuildFacePlane()・facePlaneBasis()の両方がこの関数を使うことで、
 * evaluatorが実際に押し出し等に使うPlaneの基底とsketchPlanes応答の基底を一致させる。
 */
export function facePlaneRawXDir(normal: Tuple3): Tuple3 {
  const GLOBAL_Z: Tuple3 = [0, 0, 1];
  const xDir = cross(normal, GLOBAL_Z);
  if (length(xDir) < 1e-8) {
    return [1, 0, 0];
  }
  return xDir;
}

/**
 * 面の中心・法線から、決定的なxDirを持つ平面基底(ワールド座標系、正規直交)を求める。
 * replicadのPlaneコンストラクタと同じ正規化手順(zDir=normalize(normal), xDir=normalize(rawXDir),
 * yDir=normalize(zDir×xDir))を踏襲する(evaluator.tsのbuildFacePlane()が構築する実際のOCCT Planeと
 * 同一の基底になる)。
 */
export function computeFacePlaneBasis(center: Tuple3, normal: Tuple3): FacePlaneBasis {
  const zDir = normalize(normal);
  const xDir = normalize(facePlaneRawXDir(normal));
  const yDir = normalize(cross(zDir, xDir));
  return { origin: center, xDir, yDir, normal: zDir };
}
