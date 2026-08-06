// SolidWorks風の標準ビュー(正面/背面/左/右/上/下/等角)の視線方向・upベクトル定義(Phase 16)。
// Z-upのCAD慣習に合わせる: 正面=XZ面を-Y側から見る、上=+Z上から見下ろす。
// three.jsに依存しない純粋TSにしてVitestで単体テストできるようにする。

export type StandardView = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

export interface ViewOrientation {
  /** 注視点からカメラを置く方向(単位ベクトルである必要はない。呼び出し側で正規化する)。 */
  direction: [number, number, number];
  /** カメラのupベクトル。 */
  up: [number, number, number];
}

const ISO_COMPONENT = 1 / Math.sqrt(3);

/**
 * 各標準ビューの(カメラ方向, up)定義。
 * - front: 正面。-Y側からXZ面を見る。
 * - back: 背面。+Y側から見る。
 * - left: 左側面。-X側から見る。
 * - right: 右側面。+X側から見る。
 * - top: 上面。+Z上から見下ろす(up=+Yで軸退化を回避)。
 * - bottom: 下面。-Z下から見上げる(up=+Yはtopと同じにして一貫性を持たせる)。
 * - iso: 等角。前面右上(+X,-Y,+Z寄り)から見る、SolidWorks既定の等角に近い向き。
 */
export const STANDARD_VIEW_ORIENTATIONS: Record<StandardView, ViewOrientation> = {
  front: { direction: [0, -1, 0], up: [0, 0, 1] },
  back: { direction: [0, 1, 0], up: [0, 0, 1] },
  left: { direction: [-1, 0, 0], up: [0, 0, 1] },
  right: { direction: [1, 0, 0], up: [0, 0, 1] },
  top: { direction: [0, 0, 1], up: [0, 1, 0] },
  bottom: { direction: [0, 0, -1], up: [0, 1, 0] },
  iso: { direction: [ISO_COMPONENT, -ISO_COMPONENT, ISO_COMPONENT], up: [0, 0, 1] },
};

/** 指定ビューの(カメラ方向, up)を返す。 */
export function getStandardViewOrientation(view: StandardView): ViewOrientation {
  return STANDARD_VIEW_ORIENTATIONS[view];
}
