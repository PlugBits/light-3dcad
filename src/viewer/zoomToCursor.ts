// カーソル位置中心のホイールズーム(Phase 49)の純粋な計算部分。
// three.js(PerspectiveCamera/Raycaster)に依存しない、テスト容易なベクトル計算のみをここに
// 切り出す。FreeOrbitControls.handleWheel()がカーソルのスクリーン座標から求めたレイ
// (origin, direction)と、クランプ済みの新しい距離をこの関数へ渡す。
//
// 導出の要点:
// カーソルを通るレイと、現在の注視点(target)を通り視線方向(camera→target)に垂直な平面との
// 交点をPとする。Pは常にその平面上にあるので、カメラから見たPの「視線方向に沿った深さ」は
// 常にカメラ〜target間の距離(oldDistance)と等しい。したがって、カメラ位置とtargetを同じ
// ベクトルLだけ平行移動(パン)しても、Pのカメラからの深さ・視線方向のずれ具合(=画面上の
// 見え方)は変わらない(offsetの各成分がLだけキャンセルされるため)。そこで、
//   L = (P - target) * (1 - newDistance/oldDistance)
// だけカメラ位置・targetをPに向けて(または遠ざけて)平行移動してから、通常のドリー
// (target〜カメラ距離をnewDistanceにする)を行うと、P は常に「新しいカメラ位置から見て
// 元と同じレイ方向」に残る。P はカーソルが指していた点そのものなので、結果としてカーソル位置が
// 画面上で不変になる(ズーム中心がカーソルになる)。
export type Vec3 = readonly [number, number, number];

export interface ZoomToCursorInput {
  /** ズーム前のカメラ位置(ワールド座標)。 */
  cameraPos: Vec3;
  /** ズーム前の注視点(ワールド座標)。 */
  target: Vec3;
  /** カーソルを通るレイの始点(通常はcameraPosと同じ)。 */
  rayOrigin: Vec3;
  /** カーソルを通るレイの方向(正規化不要)。 */
  rayDir: Vec3;
  /** ズーム後のカメラ〜注視点間の距離(呼び出し側でminDistance/maxDistanceにクランプ済み)。 */
  newDistance: number;
}

export interface ZoomToCursorResult {
  cameraPos: Vec3;
  target: Vec3;
}

const EPS = 1e-9;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len < EPS ? a : scale(a, 1 / len);
}

/** 注視点を中心にした通常のズーム(平行移動なし)。フォールバック・退化ケースで使う。 */
function centeredZoom(cameraPos: Vec3, target: Vec3, newDistance: number): ZoomToCursorResult {
  const offset = sub(cameraPos, target);
  const dir = length(offset) < EPS ? offset : normalize(offset);
  return { target, cameraPos: add(target, scale(dir, newDistance)) };
}

/**
 * カーソル位置中心のズーム後の新しいカメラ位置・注視点を求める。
 * カーソルのレイが視線垂直面とほぼ平行(交点なし)、または交点がレイの後方にある場合は
 * centeredZoom()(注視点中心の従来どおりのズーム)にフォールバックする。
 */
export function computeZoomToCursor(input: ZoomToCursorInput): ZoomToCursorResult {
  const { cameraPos, target, rayOrigin, rayDir, newDistance } = input;
  const oldDistance = length(sub(cameraPos, target));
  if (oldDistance < EPS) {
    return { cameraPos, target };
  }

  const forward = normalize(sub(target, cameraPos)); // カメラ→注視点
  const dir = normalize(rayDir);
  const denom = dot(forward, dir);
  if (Math.abs(denom) < EPS) {
    return centeredZoom(cameraPos, target, newDistance);
  }

  const t = dot(forward, sub(target, rayOrigin)) / denom;
  if (t < EPS) {
    return centeredZoom(cameraPos, target, newDistance);
  }

  const p = add(rayOrigin, scale(dir, t));
  const factor = 1 - newDistance / oldDistance;
  const shift = scale(sub(p, target), factor);

  const newTarget = add(target, shift);
  const shiftedCameraPos = add(cameraPos, shift);
  const newOffset = sub(shiftedCameraPos, newTarget);
  const newOffsetLen = length(newOffset);
  const finalOffset = newOffsetLen < EPS ? newOffset : scale(newOffset, newDistance / newOffsetLen);

  return { cameraPos: add(newTarget, finalOffset), target: newTarget };
}
