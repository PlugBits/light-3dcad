import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { FeatureId, PointRef, SketchEntity, SketchSegment } from "../model/types";
import type { FaceGroup, FaceInfo, MeshData } from "../protocol/messages";
import { bulgeArcPoints, bulgeFromThreePoints, DEFAULT_BULGE_SEGMENTS } from "../sketch/bulge";
import { findEntityDimensionHit, type EntityDimensionHit } from "../sketch/entityDimensionPick";
import { polygonOutlinePoints } from "../sketch/polygonOutline";
import {
  circleRadiusFromPoints,
  rectangleCornerPoints,
  regularPolygonFromCenterVertex,
  regularPolygonVertices,
  slotOutlinePoints,
} from "../sketch/shapeFromPoints";
import {
  collectSegmentSnapCandidates,
  collectSketchSnapCandidates,
  ORIGIN_CANDIDATE,
  pointsToVertexCandidates,
  resolveDrawingPoint,
  type AxisLockKind,
  type ResolvedDrawingPoint,
  type SnapCandidate,
  type SnapKind,
} from "../sketch/snapping";
import { distPointToSegmentShape, findClosestSegmentPiece } from "../sketch/trim";
import { getStandardViewOrientation, type StandardView } from "./standardViews";

/** SolidWorks風の明るいグレー系ボディ色。 */
const BASE_COLOR = 0xc8ccd2;
/** 選択面のハイライト色(通常より明るい黄系)。 */
const HIGHLIGHT_COLOR = 0xffd54f;
/** ホバー中の面のハイライト色(選択色より控えめな薄い水色)。 */
const HOVER_COLOR = 0x9fd8ff;
/** エッジ線の色(濃いグレー〜黒)。 */
const EDGE_COLOR = 0x0a0a0a;

/** 基準平面(Phase 13)の一辺(mm)。ボディが存在しない空ドキュメント状態で表示する。 */
const REFERENCE_PLANE_SIZE = 60;
/** 基準平面の通常時/ホバー時の不透明度。 */
const REFERENCE_PLANE_OPACITY = 0.22;
const REFERENCE_PLANE_HOVER_OPACITY = 0.45;
/** 基準平面の色分け: XY=青系 / XZ=緑系 / YZ=赤系。 */
const REFERENCE_PLANE_COLORS: Record<"XY" | "XZ" | "YZ", number> = {
  XY: 0x4a90e2,
  XZ: 0x4caf50,
  YZ: 0xe57373,
};

/** 選択中スケッチの線色(オレンジ)。 */
const SKETCH_SELECTED_COLOR = 0xff9800;
/** 非選択スケッチの線色(控えめなグレー、半透明)。 */
const SKETCH_DEFAULT_COLOR = 0xaaaaaa;
/** Z-fighting防止のため、スケッチ線を面法線方向へオフセットする距離(mm)。 */
const SKETCH_NORMAL_OFFSET = 0.05;
/** 円エンティティのポリライン近似の分割数。 */
const CIRCLE_SEGMENTS = 64;
/** 選択中スケッチのグリッド間隔(mm)。 */
const GRID_SPACING = 10;
/** グリッドの色・不透明度。 */
const GRID_COLOR = 0xffcc80;
const GRID_OPACITY = 0.45;
/**
 * 選択中スケッチの線・グリッドに使うrenderOrder。ソリッドは既定(0)で描画されるため、
 * depthTest:falseと組み合わせて常にソリッドより手前に見せる(ベーススケッチがソリッド内部に
 * 埋まっていても選択時は視認できるようにするため)。
 */
const SELECTED_SKETCH_RENDER_ORDER = 999;
/**
 * 描画モードの動的フィードバック(確定済みプレビュー線・ラバーバンド・軸ロックガイド・スナップ
 * マーカー)のrenderOrder。原点マーカー・X/Y軸(SELECTED_SKETCH_RENDER_ORDER)と同じ値だと、
 * depthTest:false同士の描画順がThree.js内部のソート(renderOrder同点時はmaterial単位)に委ねられ
 * 不安定になり、赤いX軸等がユーザー操作中のフィードバックを隠してしまうことがあるため、
 * 常に手前になるようそれより大きい値を使う。
 */
const DRAWING_FEEDBACK_RENDER_ORDER = SELECTED_SKETCH_RENDER_ORDER + 1;
/** 描画モードのプレビュー線(確定済みセグメント+ラバーバンド)の色。選択中スケッチと同系色。 */
const DRAWING_PREVIEW_COLOR = 0xff9800;
/** 描画モードで「始点に戻ったとみなす」スクリーン距離(px)。 */
const CLOSE_TO_START_PX = 10;
/** 点スナップの許容距離(スクリーンpx)。描画モード中にローカルmmへ換算して使う。 */
const SNAP_TOLERANCE_PX = 12;
/** 描画モードのグリッドスナップ間隔(mm)。 */
const DRAWING_GRID_SPACING = 1;
/** X軸(赤系)/Y軸(緑系)の線色。原点マーカーの色。 */
const AXIS_X_COLOR = 0xff5252;
const AXIS_Y_COLOR = 0x66bb6a;
const ORIGIN_MARKER_COLOR = 0xffffff;
/** 原点マーカー(丸の半径・十字の腕の長さ、mm)。 */
const ORIGIN_MARKER_RADIUS = 3;
const ORIGIN_MARKER_CROSS_HALF = 5;
/** 描画中の軸ロックガイド線・スナップ確定マーカーの色。 */
const AXIS_GUIDE_COLOR = 0x29b6f6;
const SNAP_MARKER_COLOR = 0x40c4ff;
/** スナップ確定マーカーの半径・半辺長(mm)。 */
const SNAP_MARKER_SIZE = 1.2;

type Tuple3 = [number, number, number];

/** ビューア描画用に、平面基底(origin/xDir/yDir/normal)を紐づけた1スケッチ分のエンティティ群。 */
export interface SketchOverlayEntry {
  sketchId: FeatureId;
  entities: SketchEntity[];
  /** 自由な線分・円弧セグメント(Phase 19a)。省略可(既存のentitiesのみのスケッチとの後方互換)。 */
  segments?: SketchSegment[];
  origin: Tuple3;
  xDir: Tuple3;
  yDir: Tuple3;
  normal: Tuple3;
}

/**
 * ワールド座標系での平面基底(origin/xDir/yDir/normal)。Workerが返すsketchPlanesの正本を
 * そのまま渡すことを想定する(UI側で独自に再計算しない)。lookAtPlane()/線描画モードで使う。
 */
export interface PlaneBasis {
  origin: Tuple3;
  xDir: Tuple3;
  yDir: Tuple3;
  normal: Tuple3;
}

/** 線描画モードの完了/キャンセル時に呼ばれるコールバック。 */
export interface PolygonDrawingCallbacks {
  /**
   * 3点以上の頂点列で閉じて確定したときに呼ばれる(ローカル2D座標、スナップ適用済み)。
   * bulges(Phase 17)は辺i(points[i]→points[i+1]、最後は閉じる辺)のふくらみ。円弧セグメントを
   * 1つも使わなかった場合は省略される(undefined)。
   */
  onComplete: (points: [number, number][], bulges?: (number | null)[]) => void;
  /** Escapeキーまたはcancel呼び出しで中断したときに呼ばれる(頂点0でも呼ばれうる)。 */
  onCancel: () => void;
  /** 円弧モード(Phase 17)のON/OFFが切り替わるたびに呼ばれる(Aキー/ツールバートグル両方の経路)。省略可。 */
  onArcModeChange?: (active: boolean) => void;
}

/** 矩形ツール(2クリック)の完了/キャンセル時に呼ばれるコールバック(Phase 14)。 */
export interface RectDrawingCallbacks {
  /** 2クリック目で確定したときに呼ばれる(対角2点、ローカル2D座標、スナップ適用済み)。 */
  onComplete: (corner1: [number, number], corner2: [number, number]) => void;
  /** Escapeキーまたはcancel呼び出しで中断したときに呼ばれる(1クリック目前でも呼ばれうる)。 */
  onCancel: () => void;
}

/** 円ツール(2クリック)の完了/キャンセル時に呼ばれるコールバック(Phase 14)。 */
export interface CircleDrawingCallbacks {
  /** 2クリック目で確定したときに呼ばれる(中心・半径、ローカル2D座標/mm、スナップ適用済み)。 */
  onComplete: (center: [number, number], radius: number) => void;
  /** Escapeキーまたはcancel呼び出しで中断したときに呼ばれる(1クリック目前でも呼ばれうる)。 */
  onCancel: () => void;
}

/** スロットツール(2クリック)の完了/キャンセル時に呼ばれるコールバック(Phase 17)。 */
export interface SlotDrawingCallbacks {
  /** 2クリック目で確定したときに呼ばれる(中心線の始点・終点、ローカル2D座標、スナップ適用済み)。widthはツール開始時に固定済みのため呼び出し側が把握している。 */
  onComplete: (start: [number, number], end: [number, number]) => void;
  /** Escapeキーまたはcancel呼び出しで中断したときに呼ばれる(1クリック目前でも呼ばれうる)。 */
  onCancel: () => void;
}

/** 正多角形ツール(2クリック)の完了/キャンセル時に呼ばれるコールバック(Phase 17)。 */
export interface RegularPolygonDrawingCallbacks {
  /** 2クリック目で確定したときに呼ばれる(中心、外接円半径、回転(ラジアン)、ローカル2D座標/mm、スナップ適用済み)。 */
  onComplete: (center: [number, number], radius: number, rotation: number) => void;
  /** Escapeキーまたはcancel呼び出しで中断したときに呼ばれる(1クリック目前でも呼ばれうる)。 */
  onCancel: () => void;
}

/**
 * セグメント線分ツール(Phase 19b)の完了/キャンセル時に呼ばれるコールバック。
 * polygonツールと異なり閉じる必要がない(開いたチェーンのまま確定できる)。
 */
export interface SegmentDrawingCallbacks {
  /**
   * Enter・始点付近クリックでの自動close・ダブルクリックのいずれかでチェーンが確定したときに呼ばれる
   * (points.length >= 2 が保証される)。bulges[i]はpoints[i]→points[i+1]の辺のふくらみ(nullは直線、
   * 長さは常に points.length-1)。始点付近クリックで閉じた場合はpoints[0]と同じ座標が末尾に追加され、
   * 実質的な閉チェーンになる(polygonエンティティへの変換はしない)。
   * axisLocks[i](Phase 20a、長さはbulgesと同じpoints.length-1)は辺iの確定時に軸ロック
   * (水平/垂直吸着)が効いていたか。src/sketch/autoConstraints.tsの自動拘束付与に使う。
   */
  onComplete: (points: [number, number][], bulges: (number | null)[], axisLocks: AxisLockKind[]) => void;
  /** Escapeキーまたはcancel呼び出しで中断したときに呼ばれる(頂点0でも呼ばれうる)。 */
  onCancel: () => void;
  /** 円弧モード(Phase 17と同じ仕組み)のON/OFFが切り替わるたびに呼ばれる。省略可。 */
  onArcModeChange?: (active: boolean) => void;
}

/** トリムツール(Phase 19b)の開始/終了時に呼ばれるコールバック。 */
export interface TrimToolCallbacks {
  /**
   * ホバー中の削除候補区間の上でクリックされたときに呼ばれる(targetIdは対象セグメントの元のid、
   * clickPointはスケッチのローカル2D座標)。実際のtrimSegmentAtPoint()適用・ドキュメント更新は
   * App側の責務とする(CadViewerはヒット判定・プレビューのみを行い、正本は持たないため)。
   */
  onTrimClick: (targetId: string, clickPoint: [number, number]) => void;
  /** Escapeキーまたはcancel呼び出しで終了したときに呼ばれる。 */
  onCancel: () => void;
}

/**
 * 描画モードの対象図形種別。polygonは既存の複数頂点線描画、rectangle/circleは2クリック作図(Phase 14)、
 * slot/regularPolygonも2クリック作図(Phase 17。幅/辺数はツール開始時に固定するパラメータ)、
 * segmentは自由な線分・円弧チェーン作図(Phase 19b。閉じる必要が無い点がpolygonと異なる)。
 */
type DrawingShapeKind = "polygon" | "rectangle" | "circle" | "slot" | "regularPolygon" | "segment";

/** 線描画モード中の円弧セグメント(Phase 17)プレビューの弧分割数。 */
const ARC_PREVIEW_SEGMENTS = 24;

/** フィレット/面取りツール(Phase 18)の開始/終了時に呼ばれるコールバック。 */
export interface CornerToolCallbacks {
  /**
   * polygon頂点付近(スクリーン距離10px程度以内)がクリックされたときに呼ばれる。
   * 実際にcorners配列を更新する(トグルを含む)のはApp側の責務とする
   * (CadViewerはジオメトリのヒット判定のみを行い、ドキュメントの正本は持たないため)。
   */
  onVertexClick: (entityId: string, vertexIndex: number) => void;
  /** Escapeキーまたはcancel呼び出しで終了したときに呼ばれる。 */
  onCancel: () => void;
}

/** フィレット/面取りツールの頂点ヒット判定の許容スクリーン距離(px)。 */
const CORNER_HIT_TOLERANCE_PX = 10;

/** トリムツール(Phase 19b)の削除候補プレビュー色(赤系)。 */
const TRIM_PREVIEW_COLOR = 0xff1744;
/** トリムツールでホバー対象とみなす許容スクリーン距離(px)。 */
const TRIM_HOVER_TOLERANCE_PX = 16;

/**
 * 寸法ツール(Phase 20b)がヒットした対象。値の確定・拘束の作成/更新は行わず、
 * 「何をクリックしたか」の情報のみを持つ(実際の拘束データ生成・現在値の計算はApp側の責務。
 * src/sketch/constraintDimensions.tsのupsert系関数・segmentLength/segmentRadius/distanceBetweenRefs
 * を使う想定)。
 * "entity-radius"/"entity-width"/"entity-height"(Phase 21)はrectangle/circleエンティティ本体への
 * ヒットで、segments系と違い拘束を経由しない(entityIdの示すentityのradius/width/heightフィールドを
 * 直接更新する。src/sketch/entityDimensionPick.ts参照)。
 */
export type DimensionToolTarget =
  | { kind: "length"; segmentId: string }
  | { kind: "radius"; segmentId: string }
  | { kind: "distance"; a: PointRef; b: PointRef }
  | { kind: "entity-radius"; entityId: string }
  | { kind: "entity-width"; entityId: string }
  | { kind: "entity-height"; entityId: string };

/** 寸法ツール(Phase 20b)の開始/終了時に呼ばれるコールバック。 */
export interface DimensionToolCallbacks {
  /**
   * ヒット対象が確定したときに呼ばれる(screenX/screenYは値入力ポップアップの位置決めに使う
   * canvas内px座標)。実際の拘束の作成/更新・値のデフォルト計算はApp側の責務とする
   * (CadViewerはヒット判定のみを行い、ドキュメントの正本は持たないため)。
   */
  onTargetPicked: (target: DimensionToolTarget, screenX: number, screenY: number) => void;
  /** Escapeキーまたはcancel呼び出しで終了したときに呼ばれる。 */
  onCancel: () => void;
}

/** 寸法ツールの端点ヒット判定の許容スクリーン距離(px)。セグメント本体より優先してヒットさせる。 */
const DIMENSION_ENDPOINT_TOLERANCE_PX = 10;
/** 寸法ツールのセグメント本体ヒット判定の許容スクリーン距離(px、ローカルmmへ概算換算して使う)。 */
const DIMENSION_SEGMENT_TOLERANCE_PX = 14;

declare global {
  interface Window {
    __cadViewerDebug?: {
      sketchLineCount: () => number;
      gridVisible: () => boolean;
      /** 現在のカメラでワールド座標をcanvas内ピクセル座標に投影する(開発ビルド限定、E2E用)。 */
      projectPoint: (world: Tuple3) => { x: number; y: number } | null;
      /** 寸法ツール中、直近のホバーでヒットしたentity対象の種別(ヒット無しはnull、開発ビルド限定、E2E用、Phase 21)。 */
      dimensionHoverEntityKind: () => EntityDimensionHit["kind"] | null;
    };
  }
}

/** 平面基底(正規直交)上のローカル2D座標をワールド座標に変換する(オフセットなし)。 */
function planeLocalToWorld(basis: PlaneBasis, u: number, v: number): Tuple3 {
  const { origin, xDir, yDir } = basis;
  return [
    origin[0] + u * xDir[0] + v * yDir[0],
    origin[1] + u * xDir[1] + v * yDir[1],
    origin[2] + u * xDir[2] + v * yDir[2],
  ];
}

/** ワールド座標を平面基底(正規直交)上のローカル2D座標に変換する(内積による逆変換)。 */
function planeWorldToLocal(basis: PlaneBasis, world: Tuple3): [number, number] {
  const rel: Tuple3 = [world[0] - basis.origin[0], world[1] - basis.origin[1], world[2] - basis.origin[2]];
  const u = rel[0] * basis.xDir[0] + rel[1] * basis.xDir[1] + rel[2] * basis.xDir[2];
  const v = rel[0] * basis.yDir[0] + rel[1] * basis.yDir[1] + rel[2] * basis.yDir[2];
  return [u, v];
}

/** スケッチのローカル2D座標を平面基底でワールド座標に変換する(法線方向に微小オフセット済み)。 */
function toWorldPoint(entry: SketchOverlayEntry, u: number, v: number): Tuple3 {
  const { origin, xDir, yDir, normal } = entry;
  return [
    origin[0] + u * xDir[0] + v * yDir[0] + SKETCH_NORMAL_OFFSET * normal[0],
    origin[1] + u * xDir[1] + v * yDir[1] + SKETCH_NORMAL_OFFSET * normal[1],
    origin[2] + u * xDir[2] + v * yDir[2] + SKETCH_NORMAL_OFFSET * normal[2],
  ];
}

/** 中心center・半径radiusの円をsegments分割のポリラインで近似したローカル2D頂点列を返す。 */
function circleLocalPoints(center: [number, number], radius: number, segments: number): [number, number][] {
  const [cx, cy] = center;
  const points: [number, number][] = [];
  for (let i = 0; i < segments; i += 1) {
    const t = (i / segments) * Math.PI * 2;
    points.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
  }
  return points;
}

/** rectangle/circle/polygon/slot/regularPolygonエンティティのローカル2D頂点列(閉ループ)を返す。 */
function entityLocalPoints(entity: SketchEntity): [number, number][] {
  if (entity.kind === "rectangle") {
    const [cx, cy] = entity.center;
    const hw = entity.width / 2;
    const hh = entity.height / 2;
    return [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ];
  }
  if (entity.kind === "circle") {
    return circleLocalPoints(entity.center, entity.radius, CIRCLE_SEGMENTS);
  }
  if (entity.kind === "slot") {
    // Phase 17: 直線2本+半円2つの輪郭(evaluatorのbulgeArcTo(±1)と同じ弧定義)。
    return slotOutlinePoints(entity.start, entity.end, entity.width);
  }
  if (entity.kind === "regularPolygon") {
    // Phase 17: 外接円半径・辺数・回転から頂点を計算する(cornersなし)。
    return regularPolygonVertices(entity.center, entity.radius, entity.sides, entity.rotation ?? 0);
  }
  // polygon: フィレット/面取り(Phase 11)・円弧辺のふくらみ(Phase 17)を適用した輪郭をポリライン近似する。
  // corners/bulges未指定時は points がそのまま返る(既存の直線LineLoopと同じ結果)。
  // LineLoopが最後→最初を自動的に結ぶため、閉じる辺は明示しない。
  return polygonOutlinePoints(entity.points, entity.corners, entity.bulges);
}

/**
 * 1つのセグメント(直線/円弧、Phase 19a)のローカル2D頂点列(開いたポリライン、p1始点・p2終点)を返す。
 * entityLocalPoints()と異なりLineLoopではなくLine(開いた線)として描画する対象なので、
 * 閉じている保証は無い(自由なセグメント集合をそのまま線として見せるだけで、
 * 閉領域判定・トリムUIは19bで扱う)。
 */
function segmentLocalPoints(segment: SketchSegment): [number, number][] {
  if (segment.kind === "arc" && segment.bulge) {
    return bulgeArcPoints(segment.p1, segment.p2, segment.bulge, DEFAULT_BULGE_SEGMENTS);
  }
  return [segment.p1, segment.p2];
}

/** 平面基底に沿った方眼(LineSegments)を構築する。origin中心にhalfExtentの範囲、GRID_SPACING間隔。 */
function buildPlaneGrid(entry: SketchOverlayEntry, halfExtent: number): THREE.LineSegments {
  const divisions = Math.max(2, Math.ceil((halfExtent * 2) / GRID_SPACING));
  const actualHalf = (divisions * GRID_SPACING) / 2;
  const positions: number[] = [];

  for (let i = 0; i <= divisions; i += 1) {
    const t = -actualHalf + i * GRID_SPACING;
    const a1 = toWorldPoint(entry, t, -actualHalf);
    const a2 = toWorldPoint(entry, t, actualHalf);
    positions.push(...a1, ...a2);
    const b1 = toWorldPoint(entry, -actualHalf, t);
    const b2 = toWorldPoint(entry, actualHalf, t);
    positions.push(...b1, ...b2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  // グリッドは選択中スケッチにのみ表示するため、常にdepthTest:false+高renderOrderでよい
  // (ソリッド内部に埋もれても常に手前に見える)。
  const material = new THREE.LineBasicMaterial({
    color: GRID_COLOR,
    transparent: true,
    opacity: GRID_OPACITY,
    depthTest: false,
  });
  const grid = new THREE.LineSegments(geometry, material);
  grid.renderOrder = SELECTED_SKETCH_RENDER_ORDER;
  return grid;
}

/**
 * 選択中スケッチの原点マーカー(丸+十字)とX軸(赤系)/Y軸(緑系)の線分を構築する
 * (平面基底entry上、halfExtent範囲の長さ)。グリッドと同様、常にdepthTest:false+
 * 高renderOrderでソリッドより手前に見せる。
 */
function buildOriginAxisMarkers(entry: SketchOverlayEntry, halfExtent: number): (THREE.Line | THREE.LineLoop)[] {
  const objects: (THREE.Line | THREE.LineLoop)[] = [];

  const addLine = (localPoints: [number, number][], color: number, closed: boolean) => {
    const positions = new Float32Array(localPoints.length * 3);
    localPoints.forEach(([u, v], i) => positions.set(toWorldPoint(entry, u, v), i * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color, depthTest: false });
    const line = closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
    line.renderOrder = SELECTED_SKETCH_RENDER_ORDER;
    objects.push(line);
  };

  addLine(
    [
      [-halfExtent, 0],
      [halfExtent, 0],
    ],
    AXIS_X_COLOR,
    false,
  );
  addLine(
    [
      [0, -halfExtent],
      [0, halfExtent],
    ],
    AXIS_Y_COLOR,
    false,
  );
  addLine(circleLocalPoints([0, 0], ORIGIN_MARKER_RADIUS, 20), ORIGIN_MARKER_COLOR, true);
  addLine(
    [
      [-ORIGIN_MARKER_CROSS_HALF, 0],
      [ORIGIN_MARKER_CROSS_HALF, 0],
    ],
    ORIGIN_MARKER_COLOR,
    false,
  );
  addLine(
    [
      [0, -ORIGIN_MARKER_CROSS_HALF],
      [0, ORIGIN_MARKER_CROSS_HALF],
    ],
    ORIGIN_MARKER_COLOR,
    false,
  );

  return objects;
}

/**
 * 描画モード中、スナップが確定した点に表示するマーカーを構築する(basis上のlocal座標)。
 * 種別ごとに形を変える: vertex=四角、midpoint=三角、center=丸、origin=丸+十字。gridはマーカー無し(空配列)。
 */
function buildSnapMarkerObjects(basis: PlaneBasis, kind: SnapKind, local: [number, number]): (THREE.Line | THREE.LineLoop)[] {
  if (kind === "grid") return [];
  const objects: (THREE.Line | THREE.LineLoop)[] = [];
  const material = new THREE.LineBasicMaterial({ color: SNAP_MARKER_COLOR, depthTest: false });
  const s = SNAP_MARKER_SIZE;
  const [cx, cy] = local;

  const addLoop = (points: [number, number][]) => {
    const positions = new Float32Array(points.length * 3);
    points.forEach(([u, v], i) => positions.set(planeLocalToWorld(basis, u, v), i * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const loop = new THREE.LineLoop(geometry, material);
    // ガイド線・ラバーバンドより確実に手前に出す(スナップ確定は最も目立たせたいフィードバックのため)。
    loop.renderOrder = DRAWING_FEEDBACK_RENDER_ORDER + 2;
    objects.push(loop);
  };
  const addSegment = (a: [number, number], b: [number, number]) => {
    const wa = planeLocalToWorld(basis, a[0], a[1]);
    const wb = planeLocalToWorld(basis, b[0], b[1]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([...wa, ...wb], 3));
    const seg = new THREE.Line(geometry, material);
    seg.renderOrder = DRAWING_FEEDBACK_RENDER_ORDER + 2;
    objects.push(seg);
  };

  if (kind === "vertex") {
    addLoop([
      [cx - s, cy - s],
      [cx + s, cy - s],
      [cx + s, cy + s],
      [cx - s, cy + s],
    ]);
  } else if (kind === "midpoint") {
    addLoop([
      [cx, cy + s],
      [cx + s, cy - s],
      [cx - s, cy - s],
    ]);
  } else if (kind === "center") {
    addLoop(circleLocalPoints(local, s, 16));
  } else if (kind === "origin") {
    addLoop(circleLocalPoints(local, s, 16));
    addSegment([cx - s * 1.5, cy], [cx + s * 1.5, cy]);
    addSegment([cx, cy - s * 1.5], [cx, cy + s * 1.5]);
  }
  return objects;
}

/**
 * Three.jsシーンの命令的なラッパー。React stateにシーンを持たせず、
 * DOMコンテナに対して直接マウント/更新/破棄する。
 */
export class CadViewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  /** ソリッドのエッジ線(setMesh()でmesh.edgesから構築)。メッシュ更新時に破棄・再構築する。 */
  private edgesMesh: THREE.LineSegments | null = null;
  private faceGroups: FaceGroup[] = [];
  private faceInfo: FaceInfo[] = [];
  private materials: THREE.MeshStandardMaterial[] = [];
  private selectedGroupIndex: number | null = null;
  /** マウスオーバー中の面のmaterialIndex(選択面とは独立、選択時は選択色を優先)。 */
  private hoveredGroupIndex: number | null = null;
  private raycaster = new THREE.Raycaster();
  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private animationFrameId = 0;
  /** 面がクリックで選択/解除されたときに呼ばれる(解除時はnull)。 */
  private onFaceSelect?: (face: FaceInfo | null) => void;
  /** 基準平面(XY/XZ/YZ)がクリックで選択されたときに呼ばれる(Phase 13)。 */
  private onPlaneSelect?: (plane: "XY" | "XZ" | "YZ") => void;
  /** 基準平面(ボディなし時に表示する半透明の3枚)を乗せるグループ。visibleで表示/非表示を切り替える。 */
  private referencePlaneGroup: THREE.Group;
  private referencePlaneEntries: {
    plane: "XY" | "XZ" | "YZ";
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
  }[] = [];
  /** ホバー中の基準平面(未ホバーはnull)。 */
  private hoveredReferencePlane: "XY" | "XZ" | "YZ" | null = null;
  /** 現在のメッシュのバウンディングボックスから求めた半径目安(mm)。グリッド範囲の基準に使う。 */
  private meshHalfExtent = 50;
  /** 初回メッシュ受信時にfitToView()を自動実行するためのフラグ(2回目以降は視点を維持する)。 */
  private hasReceivedMesh = false;

  /** スケッチ線・グリッドを乗せるグループ。表示/非表示はこのgroup.visibleで切り替える。 */
  private sketchOverlayGroup: THREE.Group;
  private sketchOverlayGeometries: THREE.BufferGeometry[] = [];
  private sketchOverlayMaterials: THREE.Material[] = [];
  /** 直近のsetSketchOverlay()で描画した線(LineLoop)の本数。E2Eデバッグフックが参照する。 */
  private sketchLineCount = 0;
  /** 直近のsetSketchOverlay()でグリッドが描画されたかどうか。E2Eデバッグフックが参照する。 */
  private sketchGridBuilt = false;

  /** 線描画モード中かどうか。trueの間はクリックを面選択でなく頂点追加として扱う。 */
  private drawingActive = false;
  /** 現在の描画モードが対象とする図形種別(polygon/rectangle/circle、Phase 14)。 */
  private drawingShape: DrawingShapeKind = "polygon";
  private drawingBasis: PlaneBasis | null = null;
  /** 「スナップ」チェックボックスの状態(グリッド+点スナップ全体のON/OFF)。Shift押下中はこれとは別に一時無効化される。 */
  private drawingSnap = true;
  /** 描画対象スケッチに既にある図形(vertex/center/midpoint候補の収集元)。startXxxDrawing()で設定する。 */
  private drawingEntities: SketchEntity[] = [];
  /**
   * 確定済み頂点列(ローカル2D座標、スナップ適用済み)。polygonは複数点、rectangle/circleは
   * 1クリック目(コーナー1/中心)が入るまで空、入った後は要素数1のまま2クリック目で確定する。
   */
  private drawingPoints: [number, number][] = [];
  private polygonCallbacks: PolygonDrawingCallbacks | null = null;
  private rectCallbacks: RectDrawingCallbacks | null = null;
  private circleCallbacks: CircleDrawingCallbacks | null = null;
  private slotCallbacks: SlotDrawingCallbacks | null = null;
  private regularPolygonCallbacks: RegularPolygonDrawingCallbacks | null = null;
  private segmentCallbacks: SegmentDrawingCallbacks | null = null;
  /** 描画対象スケッチの既存segments(Phase 19b)。segmentツールのスナップ候補収集元として使う。 */
  private drawingSegments: SketchSegment[] = [];
  /** スロットツール開始時に固定した全幅(mm、Phase 17)。プレビュー描画にのみ使う(確定値はApp側が把握)。 */
  private drawingSlotWidth = 10;
  /** 正多角形ツール開始時に固定した辺数(Phase 17)。プレビュー描画にのみ使う。 */
  private drawingPolygonSides = 6;
  /**
   * polygon描画モード中の辺ごとのふくらみ(Phase 17)。drawingPoints[i]→drawingPoints[i+1]に対応
   * (drawingBulges.length === drawingPoints.length - 1 を維持する。頂点0にはまだ対応する辺が無いため)。
   */
  private drawingBulges: (number | null)[] = [];
  /**
   * セグメント描画モード中の辺ごとの軸ロック状態(Phase 20a)。drawingBulgesと同じ並び
   * (drawingPoints[i]→drawingPoints[i+1]に対応、長さはdrawingPoints.length-1)。
   * polygonツールでは使わない(常にnullのまま、finishPolygonDrawing()のコールバックに含めない)。
   */
  private drawingAxisLocks: AxisLockKind[] = [];
  /** 円弧セグメント(Phase 17)トグル中かどうか。trueの間、次のクリックは通過点/終点として扱われる。 */
  private drawingArcMode = false;
  /** 円弧セグメントの1クリック目(通過点)。null=まだ通過点未確定。 */
  private drawingArcPending: [number, number] | null = null;
  /** プレビュー線(確定済みセグメント+ラバーバンド+軸ロックガイド+スナップマーカー)を乗せるグループ。showSketchesトグルとは独立して常に表示する。 */
  private drawingGroup: THREE.Group;
  private drawingPreviewGeometries: THREE.BufferGeometry[] = [];
  private drawingPreviewMaterials: THREE.Material[] = [];
  /** 描画モード中、カーソル付近に現在のローカル座標・長さ・角度を表示するHTMLオーバーレイ。 */
  private coordOverlayEl: HTMLDivElement;
  /**
   * 描画モード中の数値長さ入力オーバーレイ(Phase 10)。数字キーを押すと表示され、入力中の
   * 文字列(lengthInputValue)を表示する。Enterで直前頂点から現在のカーソル方向(スナップ・
   * 軸ロック適用後)へその長さの頂点を確定する。
   */
  private lengthInputEl: HTMLDivElement;
  private lengthInputActive = false;
  private lengthInputValue = "";
  /** 直近のマウス移動で解決した(スナップ・軸ロック適用後の)カーソルのローカル2D座標。数値長さ入力の方向決定に使う。 */
  private lastHoverLocal: [number, number] | null = null;
  /** 直近のマウス位置(canvas内px)。数値長さ入力オーバーレイの位置決めに使う。 */
  private lastMousePx = 0;
  private lastMousePy = 0;
  /**
   * 毎フレーム(render後)呼ばれるコールバック群。寸法ラベル等、カメラ変更に追従して画面座標を
   * 再計算したいHTMLオーバーレイの位置更新に使う(Phase 10)。
   */
  private frameCallbacks = new Set<() => void>();

  /** フィレット/面取りツール(Phase 18)がアクティブかどうか。trueの間はクリックを頂点ヒット判定として扱う。 */
  private cornerToolActive = false;
  private cornerToolBasis: PlaneBasis | null = null;
  /** ヒット判定対象のエンティティ(対象スケッチのentities、polygon以外は無視する)。 */
  private cornerToolEntities: SketchEntity[] = [];
  private cornerToolCallbacks: CornerToolCallbacks | null = null;

  /** トリムツール(Phase 19b)がアクティブかどうか。trueの間はクリックを面選択でなくトリム対象クリックとして扱う。 */
  private trimActive = false;
  private trimBasis: PlaneBasis | null = null;
  /** ヒット判定対象のセグメント(対象スケッチのsegments)。 */
  private trimSegments: SketchSegment[] = [];
  private trimCallbacks: TrimToolCallbacks | null = null;
  /** 直近のホバーで求めた削除候補区間の元セグメントid(ヒット無しはnull)。クリック時にこれをonTrimClickへ渡す。 */
  private trimHoverTargetId: string | null = null;

  /** 寸法ツール(Phase 20b)がアクティブかどうか。trueの間はクリックを面選択でなく寸法対象クリックとして扱う。 */
  private dimensionToolActive = false;
  private dimensionToolBasis: PlaneBasis | null = null;
  /** ヒット判定対象のセグメント(対象スケッチのsegments)。 */
  private dimensionToolSegments: SketchSegment[] = [];
  /** ヒット判定対象のentities(rectangle/circleのみ対象、Phase 21)。 */
  private dimensionToolEntities: SketchEntity[] = [];
  private dimensionToolCallbacks: DimensionToolCallbacks | null = null;
  /** distance拘束の1点目としてクリック済みの端点(未選択はnull)。2点目のクリックでonTargetPickedを呼ぶ。 */
  private dimensionPendingPoint: PointRef | null = null;
  /** 直近のホバーでヒットしたentity対象(ハイライト再描画の要否判定・デバッグ用、Phase 21)。ヒット無しはnull。 */
  private dimensionHoverEntityHit: EntityDimensionHit | null = null;

  constructor(
    container: HTMLElement,
    onFaceSelect?: (face: FaceInfo | null) => void,
    onPlaneSelect?: (plane: "XY" | "XZ" | "YZ") => void,
  ) {
    this.container = container;
    this.onFaceSelect = onFaceSelect;
    this.onPlaneSelect = onPlaneSelect;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x222630);

    const { clientWidth, clientHeight } = container;
    this.camera = new THREE.PerspectiveCamera(
      45,
      Math.max(clientWidth, 1) / Math.max(clientHeight, 1),
      0.1,
      10000,
    );
    this.camera.position.set(150, 150, 150);
    this.camera.up.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(Math.max(clientWidth, 1), Math.max(clientHeight, 1));
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;

    // SolidWorks風の陰影: 控えめなHemisphere(空色/地色)+ カメラ斜め上からのキーライト
    // + 反対側からの弱いフィルライト(陰影が付く面でも真っ暗にならない程度の補助光)。
    const hemiLight = new THREE.HemisphereLight(0xcfe0ff, 0x4a4a42, 0.55);
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
    keyLight.position.set(120, 180, 220);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.25);
    fillLight.position.set(-150, -80, -100);
    this.scene.add(hemiLight, keyLight, fillLight);

    const grid = new THREE.GridHelper(200, 20);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    this.sketchOverlayGroup = new THREE.Group();
    this.scene.add(this.sketchOverlayGroup);

    this.drawingGroup = new THREE.Group();
    this.scene.add(this.drawingGroup);

    this.referencePlaneGroup = new THREE.Group();
    this.referencePlaneGroup.visible = false;
    this.referencePlaneEntries = this.buildReferencePlanes();
    this.referencePlaneEntries.forEach((entry) => this.referencePlaneGroup.add(entry.mesh));
    this.scene.add(this.referencePlaneGroup);

    // コンテナを絶対配置の基準にする(座標オーバーレイをcanvas上にpxで重ねるため)。
    // containerは既存レイアウト上は幅・高さ100%のプレーンなdivであり、position指定を持たない
    // 想定なのでrelativeにしても既存の見た目には影響しない。
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    this.coordOverlayEl = document.createElement("div");
    this.coordOverlayEl.setAttribute("data-testid", "drawing-coord-overlay");
    Object.assign(this.coordOverlayEl.style, {
      position: "absolute",
      pointerEvents: "none",
      background: "rgba(0, 0, 0, 0.75)",
      color: "#fff",
      padding: "2px 6px",
      borderRadius: "3px",
      fontSize: "11px",
      fontFamily: "monospace",
      whiteSpace: "nowrap",
      display: "none",
      zIndex: "10",
    });
    container.appendChild(this.coordOverlayEl);

    this.lengthInputEl = document.createElement("div");
    this.lengthInputEl.setAttribute("data-testid", "drawing-length-input");
    Object.assign(this.lengthInputEl.style, {
      position: "absolute",
      pointerEvents: "none",
      background: "rgba(41, 182, 246, 0.9)",
      color: "#00202b",
      padding: "2px 6px",
      borderRadius: "3px",
      fontSize: "11px",
      fontFamily: "monospace",
      fontWeight: "bold",
      whiteSpace: "nowrap",
      display: "none",
      zIndex: "11",
    });
    container.appendChild(this.lengthInputEl);

    this.renderer.domElement.addEventListener("click", this.handleClick);
    this.renderer.domElement.addEventListener("dblclick", this.handleSegmentDoubleClick);
    this.renderer.domElement.addEventListener("mousemove", this.handleDrawingMouseMove);
    this.renderer.domElement.addEventListener("mouseleave", this.handleMouseLeave);
    window.addEventListener("keydown", this.handleKeyDown);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.animate();

    // E2Eテストからスケッチオーバーレイ・描画モードの結果を検証するためのフック(開発ビルドのみ)。
    if (import.meta.env.DEV) {
      window.__cadViewerDebug = {
        sketchLineCount: () => this.sketchLineCount,
        gridVisible: () => this.sketchGridBuilt && this.sketchOverlayGroup.visible,
        projectPoint: (world) => this.projectPoint(world),
        dimensionHoverEntityKind: () => this.dimensionHoverEntityHit?.kind ?? null,
      };
    }
  }

  private animate = () => {
    this.animationFrameId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    // render()内でcamera.matrixWorldが最新化されるため、その後にフレームコールバックを呼ぶ
    // (寸法ラベルのprojectPoint()等が常に最新のカメラ状態を参照できるようにするため)。
    this.frameCallbacks.forEach((callback) => callback());
  };

  /**
   * 毎フレーム(render後)呼ばれるコールバックを登録する。寸法ラベル等、カメラ変更(orbit操作等)
   * に追従して画面座標を再計算したいHTMLオーバーレイの位置更新に使う想定。登録解除関数を返す。
   * コールバックは軽量に保つこと(このビューアのrAFループに同期して毎フレーム呼ばれるため)。
   */
  onFrame(callback: () => void): () => void {
    this.frameCallbacks.add(callback);
    return () => {
      this.frameCallbacks.delete(callback);
    };
  }

  /** 平面基底(basis)上のローカル2D座標(u, v)をワールド座標に変換する(オフセットなし)。 */
  localToWorld(basis: PlaneBasis, u: number, v: number): [number, number, number] {
    return planeLocalToWorld(basis, u, v);
  }

  private handleResize() {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight);
  }

  /**
   * 描画モード中のキー入力。数字/ピリオドキーで長さ数値入力を開始し(直前頂点が1つ以上必要)、
   * Enterで確定、Backspaceで1文字削除、Escapeで入力のみ取消す(既存のEscape=描画中断とは
   * 衝突しないよう、入力欄が開いている間はEscapeを入力キャンセルに限定する)。
   */
  private handleKeyDown = (event: KeyboardEvent) => {
    if (this.trimActive) {
      if (event.key === "Escape") {
        this.cancelTrimTool();
      }
      return;
    }
    if (this.cornerToolActive) {
      if (event.key === "Escape") {
        this.cancelCornerTool();
      }
      return;
    }
    if (this.dimensionToolActive) {
      if (event.key === "Escape") {
        this.cancelDimensionTool();
      }
      return;
    }
    if (this.drawingActive) {
      const isChainShape = this.drawingShape === "polygon" || this.drawingShape === "segment";
      if (event.key === "Escape") {
        if (this.lengthInputActive) {
          this.resetLengthInput();
          return;
        }
        this.cancelPolygonDrawing();
        return;
      }
      if (event.key === "Enter") {
        if (this.lengthInputActive) {
          this.commitLengthInput();
          return;
        }
        if (this.drawingShape === "polygon") this.finishPolygonDrawing();
        else if (this.drawingShape === "segment") this.finishSegmentDrawing();
        return;
      }
      if (event.key === "Backspace" && this.lengthInputActive) {
        this.lengthInputValue = this.lengthInputValue.slice(0, -1);
        if (this.lengthInputValue === "") {
          this.lengthInputActive = false;
        }
        this.updateLengthInputOverlay();
        return;
      }
      if (isChainShape && !this.lengthInputActive && this.drawingPoints.length > 0 && event.key.toLowerCase() === "a") {
        this.togglePolygonArcMode();
        return;
      }
      if (isChainShape && this.drawingPoints.length > 0 && /^[0-9.]$/.test(event.key)) {
        this.lengthInputActive = true;
        this.lengthInputValue += event.key;
        this.updateLengthInputOverlay();
      }
      return;
    }
    if (event.key === "Escape") {
      this.clearSelection();
    }
  };

  /**
   * 数値長さ入力を確定する。直前頂点から直近のカーソル方向(スナップ・軸ロック適用後、
   * lastHoverLocal)へ、入力された長さぶん進めた点を新しい頂点として追加する。
   * 入力値が不正、方向が定まらない(マウス未移動等)場合は何もしない(入力欄のみリセットする)。
   */
  private commitLengthInput() {
    const value = Number.parseFloat(this.lengthInputValue);
    this.resetLengthInput();
    if (!Number.isFinite(value) || value <= 0) return;
    if (!this.drawingBasis || this.drawingPoints.length === 0 || !this.lastHoverLocal) return;

    const from = this.drawingPoints[this.drawingPoints.length - 1];
    const dx = this.lastHoverLocal[0] - from[0];
    const dy = this.lastHoverLocal[1] - from[1];
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const next: [number, number] = [from[0] + (dx / dist) * value, from[1] + (dy / dist) * value];

    // 数値長さ入力で確定した辺は軸ロック状態を追跡していないため、常にaxis:null(自動水平/垂直拘束の対象外)。
    // 実用上はコインシデント拘束(接続端点)のみが自動で付き、水平/垂直はPhase 20bの手動拘束UIで付けられる。
    this.pushDrawingPoint(next, null);
    this.updateDrawingPreview();
    this.updateCoordOverlay(this.lastMousePx, this.lastMousePy, next);
  }

  /** 数値長さ入力の状態(入力中文字列)をリセットし、オーバーレイを隠す。 */
  private resetLengthInput() {
    this.lengthInputActive = false;
    this.lengthInputValue = "";
    this.updateLengthInputOverlay();
  }

  /** 数値長さ入力オーバーレイの表示/非表示・文言・位置(直近マウス位置基準)を更新する。 */
  private updateLengthInputOverlay() {
    if (!this.lengthInputActive) {
      this.lengthInputEl.style.display = "none";
      return;
    }
    this.lengthInputEl.textContent = `L入力: ${this.lengthInputValue}mm (Enterで確定/Escで取消)`;
    this.lengthInputEl.style.left = `${this.lastMousePx + 14}px`;
    this.lengthInputEl.style.top = `${this.lastMousePy + 32}px`;
    this.lengthInputEl.style.display = "block";
  }

  private handleClick = (event: MouseEvent) => {
    if (this.trimActive) {
      this.handleTrimClick(event);
      return;
    }
    if (this.cornerToolActive) {
      this.handleCornerToolClick(event);
      return;
    }
    if (this.dimensionToolActive) {
      this.handleDimensionToolClick(event);
      return;
    }
    if (this.drawingActive) {
      if (this.drawingShape === "polygon") {
        this.handlePolygonClick(event);
      } else if (this.drawingShape === "segment") {
        this.handleSegmentClick(event);
      } else {
        this.handleShapeClick(event);
      }
      return;
    }
    if (this.referencePlaneGroup.visible) {
      this.handleReferencePlaneClick(event);
      return;
    }
    if (!this.mesh) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );

    this.raycaster.setFromCamera(pointer, this.camera);
    const intersections = this.raycaster.intersectObject(this.mesh, false);
    if (intersections.length === 0) {
      // 空クリック(何もヒットしなかった)= 選択解除。
      this.clearSelection();
      return;
    }

    const triangleIndex = intersections[0].faceIndex;
    if (triangleIndex == null) {
      this.clearSelection();
      return;
    }

    // faceIndexは三角形番号。triangles配列上のオフセット(triangleIndex*3)が
    // どのfaceGroup範囲に含まれるかを線形探索してB-Rep面IDを逆引きする。
    const triangleOffset = triangleIndex * 3;
    const groupIndex = this.faceGroups.findIndex(
      (g) => triangleOffset >= g.start && triangleOffset < g.start + g.count,
    );

    if (groupIndex === -1) {
      this.clearSelection();
      return;
    }

    const faceId = this.faceGroups[groupIndex].faceId;
    const info = this.faceInfo.find((f) => f.faceId === faceId) ?? null;
    this.selectGroup(groupIndex);
    this.onFaceSelect?.(info);
  };

  /** materialIndex = groupIndex のマテリアル色をハイライト色に、前回選択分は基本色(またはホバー中ならホバー色)に戻す。 */
  private selectGroup(groupIndex: number) {
    if (this.selectedGroupIndex != null) {
      this.materials[this.selectedGroupIndex]?.color.setHex(
        this.selectedGroupIndex === this.hoveredGroupIndex ? HOVER_COLOR : BASE_COLOR,
      );
    }
    this.selectedGroupIndex = groupIndex;
    this.materials[groupIndex]?.color.setHex(HIGHLIGHT_COLOR);
  }

  /** 面の選択を解除し、ハイライトを元の色(またはホバー中ならホバー色)に戻す。onFaceSelect(null)を呼ぶ。 */
  clearSelection() {
    if (this.selectedGroupIndex != null) {
      this.materials[this.selectedGroupIndex]?.color.setHex(
        this.selectedGroupIndex === this.hoveredGroupIndex ? HOVER_COLOR : BASE_COLOR,
      );
      this.selectedGroupIndex = null;
      this.onFaceSelect?.(null);
    }
  }

  /**
   * 描画モード外でのマウス移動時、レイキャストでカーソル下の面を求めてホバーハイライトを更新する。
   * 選択中の面はホバー色より選択色を優先する(setHoverGroup内で判定)。
   */
  private handleHoverMouseMove(event: MouseEvent) {
    if (this.referencePlaneGroup.visible) {
      this.handleReferencePlaneHover(event);
      return;
    }
    if (!this.mesh) {
      this.setHoverGroup(null);
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const intersections = this.raycaster.intersectObject(this.mesh, false);
    if (intersections.length === 0) {
      this.setHoverGroup(null);
      return;
    }
    const triangleIndex = intersections[0].faceIndex;
    if (triangleIndex == null) {
      this.setHoverGroup(null);
      return;
    }
    const triangleOffset = triangleIndex * 3;
    const groupIndex = this.faceGroups.findIndex(
      (g) => triangleOffset >= g.start && triangleOffset < g.start + g.count,
    );
    this.setHoverGroup(groupIndex === -1 ? null : groupIndex);
  }

  /** キャンバスからマウスが離れたら、ホバーハイライトを解除する。 */
  private handleMouseLeave = () => {
    this.setHoverGroup(null);
    this.setHoveredReferencePlane(null);
    if (this.dimensionToolActive && !this.dimensionPendingPoint) {
      this.clearDrawingPreview();
      this.dimensionHoverEntityHit = null;
    }
  };

  /** 基準平面(XY/XZ/YZ)を60x60mmの半透明四角として構築する(Phase 13)。色分け: XY=青系/XZ=緑系/YZ=赤系。 */
  private buildReferencePlanes(): { plane: "XY" | "XZ" | "YZ"; mesh: THREE.Mesh; material: THREE.MeshBasicMaterial }[] {
    const planes: ("XY" | "XZ" | "YZ")[] = ["XY", "XZ", "YZ"];
    return planes.map((plane) => {
      const geometry = new THREE.PlaneGeometry(REFERENCE_PLANE_SIZE, REFERENCE_PLANE_SIZE);
      const material = new THREE.MeshBasicMaterial({
        color: REFERENCE_PLANE_COLORS[plane],
        transparent: true,
        opacity: REFERENCE_PLANE_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      // PlaneGeometryはデフォルトでXY平面(法線+Z)上にある。XZ/YZはそれぞれX軸/Y軸回りに90度回転させる。
      if (plane === "XZ") mesh.rotation.x = Math.PI / 2;
      if (plane === "YZ") mesh.rotation.y = Math.PI / 2;
      mesh.userData.planeName = plane;
      return { plane, mesh, material };
    });
  }

  /**
   * ボディが存在しない(空ドキュメント)状態で基準平面3枚の表示/非表示を切り替える。
   * ボディがある場合は呼び出し側(App)がfalseを渡すこと(従来どおり面選択のみになる)。
   */
  setReferencePlanesVisible(visible: boolean) {
    this.referencePlaneGroup.visible = visible;
    if (!visible) {
      this.setHoveredReferencePlane(null);
      this.renderer.domElement.style.cursor = "";
    }
  }

  /** canvas内のイベント位置から基準平面をレイキャストし、最も手前でヒットした平面名を返す(未ヒットはnull)。 */
  private raycastReferencePlane(event: MouseEvent): "XY" | "XZ" | "YZ" | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const meshes = this.referencePlaneEntries.map((e) => e.mesh);
    const intersections = this.raycaster.intersectObjects(meshes, false);
    if (intersections.length === 0) return null;
    const hit = intersections[0].object as THREE.Mesh;
    return (hit.userData.planeName as "XY" | "XZ" | "YZ" | undefined) ?? null;
  }

  /** 基準平面のホバー中強調を更新する(マウス移動のたびに呼ばれる)。 */
  private handleReferencePlaneHover(event: MouseEvent) {
    this.setHoveredReferencePlane(this.raycastReferencePlane(event));
  }

  private setHoveredReferencePlane(plane: "XY" | "XZ" | "YZ" | null) {
    if (this.hoveredReferencePlane === plane) return;
    if (this.hoveredReferencePlane) {
      const prev = this.referencePlaneEntries.find((e) => e.plane === this.hoveredReferencePlane);
      if (prev) prev.material.opacity = REFERENCE_PLANE_OPACITY;
    }
    this.hoveredReferencePlane = plane;
    if (plane) {
      const entry = this.referencePlaneEntries.find((e) => e.plane === plane);
      if (entry) entry.material.opacity = REFERENCE_PLANE_HOVER_OPACITY;
    }
    this.renderer.domElement.style.cursor = plane ? "pointer" : "";
  }

  /** 基準平面クリック: ヒットした平面をonPlaneSelectで通知する(未ヒットは何もしない)。 */
  private handleReferencePlaneClick(event: MouseEvent) {
    const plane = this.raycastReferencePlane(event);
    if (!plane) return;
    this.onPlaneSelect?.(plane);
  }

  /**
   * ホバー中の面(materialIndex)を更新する。選択中の面(selectedGroupIndex)はホバー色より
   * 選択色を優先するため、色の書き換えは行わない(選択が外れた時点でHOVER_COLORに切り替わる)。
   */
  private setHoverGroup(groupIndex: number | null) {
    if (this.hoveredGroupIndex === groupIndex) return;
    if (this.hoveredGroupIndex != null && this.hoveredGroupIndex !== this.selectedGroupIndex) {
      this.materials[this.hoveredGroupIndex]?.color.setHex(BASE_COLOR);
    }
    this.hoveredGroupIndex = groupIndex;
    if (groupIndex != null && groupIndex !== this.selectedGroupIndex) {
      this.materials[groupIndex]?.color.setHex(HOVER_COLOR);
    }
  }

  /** 面材質の共通見た目設定(SolidWorks風の明るいグレー、安っぽく見えない程度のroughness/metalness)。 */
  private createFaceMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: BASE_COLOR,
      side: THREE.DoubleSide,
      roughness: 0.55,
      metalness: 0.12,
      // エッジ線(this.edgesMesh)をZ-fighting無しで手前に見せるため、ソリッド側をわずかに
      // 奥へオフセットする(標準的な「ポリゴンオフセット+同一深度のエッジ線」の手法)。
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  }

  setMesh(data: MeshData, faceInfo: FaceInfo[] = []) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      const material = this.mesh.material;
      if (Array.isArray(material)) {
        material.forEach((m) => m.dispose());
      } else {
        material.dispose();
      }
      this.mesh = null;
    }
    if (this.edgesMesh) {
      this.scene.remove(this.edgesMesh);
      this.edgesMesh.geometry.dispose();
      (this.edgesMesh.material as THREE.Material).dispose();
      this.edgesMesh = null;
    }

    // ボディなし(Phase 13: positionsが空)の場合は、既存メッシュ・エッジを消去するのみで
    // 新しいジオメトリは作らない(clearSelection相当のリセットのみ行う)。
    if (data.positions.length === 0) {
      this.faceGroups = [];
      this.faceInfo = faceInfo;
      this.materials = [];
      this.selectedGroupIndex = null;
      this.hoveredGroupIndex = null;
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

    // faceGroupsをBufferGeometryのgroupとして登録する。materialIndexごとに
    // マテリアルを複製しておき、選択面のみ色を差し替えてハイライトする。
    geometry.clearGroups();
    const materials: THREE.MeshStandardMaterial[] = [];
    data.faceGroups.forEach((group, materialIndex) => {
      geometry.addGroup(group.start, group.count, materialIndex);
      materials.push(this.createFaceMaterial());
    });

    this.faceGroups = data.faceGroups;
    this.faceInfo = faceInfo;
    this.materials = materials;
    // メッシュが再生成されるとfaceGroupsのインデックス対応も変わりうるため選択・ホバー状態はリセットする。
    // (ストア側の選択面はfaceInfoに残っているかどうかで呼び出し元が判断する)
    this.selectedGroupIndex = null;
    this.hoveredGroupIndex = null;

    this.mesh = new THREE.Mesh(geometry, materials.length > 0 ? materials : this.createFaceMaterial());
    this.scene.add(this.mesh);

    if (data.edges && data.edges.length > 0) {
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute("position", new THREE.BufferAttribute(data.edges, 3));
      const edgeMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
      this.edgesMesh = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      this.scene.add(this.edgesMesh);
    }

    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox;
    if (bbox) {
      const size = new THREE.Vector3();
      bbox.getSize(size);
      this.meshHalfExtent = Math.max(size.x, size.y, size.z, 20) / 2;
    }

    // 初回メッシュ受信時のみ自動フィットする(2回目以降の再評価では現在の視点を維持する)。
    if (!this.hasReceivedMesh) {
      this.hasReceivedMesh = true;
      this.fitToView();
    }
  }

  /**
   * 現在のメッシュのバウンディングスフィアが画角に収まる距離までカメラを移動する
   * (「フィット」ボタン、初回メッシュ受信時に使用)。カメラの視線方向は維持し、距離のみ調整する。
   * メッシュが無ければ何もしない。
   */
  fitToView() {
    if (!this.mesh) return;
    this.mesh.geometry.computeBoundingSphere();
    const sphere = this.mesh.geometry.boundingSphere;
    if (!sphere || sphere.radius <= 0) return;

    const center = sphere.center.clone();
    const radius = Math.max(sphere.radius, 1);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const fitFov = Math.min(vFov, hFov);
    // 少し余白を持たせる(1.15倍)。
    const distance = (radius / Math.sin(fitFov / 2)) * 1.15;

    let direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-6) {
      direction = new THREE.Vector3(1, 1, 1);
    }
    direction.normalize();

    this.camera.position.copy(center.clone().addScaledVector(direction, distance));
    this.controls.target.copy(center);
    this.controls.update();
  }

  /**
   * SolidWorks風の標準ビュー(正面/背面/左/右/上/下/等角)へカメラを切り替える(Phase 16)。
   * 注視点は現在のメッシュがあればそのバウンディングスフィア中心、無ければ原点。距離は
   * fitToView()と同様にバウンディングスフィア半径(メッシュが無ければmeshHalfExtent)から
   * 画角に収まるよう計算する。upベクトルは向きごとに軸が退化しないものを使う
   * (src/viewer/standardViews.ts参照)。
   */
  setStandardView(view: StandardView) {
    const target = this.getStandardViewTarget();
    const { direction, up } = getStandardViewOrientation(view);
    const distance = this.computeStandardViewDistance();
    const dir = new THREE.Vector3(direction[0], direction[1], direction[2]).normalize();

    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.position.copy(target.clone().addScaledVector(dir, distance));
    this.controls.target.copy(target);
    this.controls.update();
  }

  /** 標準ビューの注視点(メッシュがあればバウンディングスフィア中心、無ければ原点)。 */
  private getStandardViewTarget(): THREE.Vector3 {
    if (this.mesh) {
      this.mesh.geometry.computeBoundingSphere();
      const sphere = this.mesh.geometry.boundingSphere;
      if (sphere && sphere.radius > 0) return sphere.center.clone();
    }
    return new THREE.Vector3(0, 0, 0);
  }

  /** 標準ビューのカメラ距離(fitToView()と同じ「画角に収まる+15%余白」の考え方)。 */
  private computeStandardViewDistance(): number {
    let radius = this.meshHalfExtent;
    if (this.mesh) {
      this.mesh.geometry.computeBoundingSphere();
      const sphere = this.mesh.geometry.boundingSphere;
      if (sphere && sphere.radius > 0) radius = sphere.radius;
    }
    radius = Math.max(radius, 1);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const fitFov = Math.min(vFov, hFov);
    return (radius / Math.sin(fitFov / 2)) * 1.15;
  }

  /** 直前のsetSketchOverlay()呼び出しで生成した線・グリッドをsceneから取り除き、リソースを解放する。 */
  private clearSketchOverlay() {
    while (this.sketchOverlayGroup.children.length > 0) {
      this.sketchOverlayGroup.remove(this.sketchOverlayGroup.children[0]);
    }
    this.sketchOverlayGeometries.forEach((g) => g.dispose());
    this.sketchOverlayMaterials.forEach((m) => m.dispose());
    this.sketchOverlayGeometries = [];
    this.sketchOverlayMaterials = [];
    this.sketchLineCount = 0;
    this.sketchGridBuilt = false;
  }

  /**
   * 各スケッチのエンティティ(矩形/円)を、Workerが返した平面基底で3D線として描画する。
   * 選択中スケッチ(selectedSketchId)は強調色+平面グリッドで、それ以外は控えめな色で表示する。
   * visible=false のときは何も描画せず(既存の描画があれば消す)、grid/lineCountも0になる。
   */
  setSketchOverlay(entries: SketchOverlayEntry[], selectedSketchId: FeatureId | null, visible: boolean) {
    this.clearSketchOverlay();
    this.sketchOverlayGroup.visible = visible;
    if (!visible) return;

    for (const entry of entries) {
      const isSelected = entry.sketchId === selectedSketchId;
      const color = isSelected ? SKETCH_SELECTED_COLOR : SKETCH_DEFAULT_COLOR;
      // 選択中スケッチはdepthTest:falseにしてソリッドを透過して常に見えるようにする
      // (ベーススケッチがソリッド内部に埋もれていても選択時は視認できることが狙い)。
      // 非選択スケッチは従来通り深度ありで描画する。
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: !isSelected,
        opacity: isSelected ? 1 : 0.5,
        linewidth: isSelected ? 2 : 1,
        depthTest: !isSelected,
      });
      this.sketchOverlayMaterials.push(material);

      for (const entity of entry.entities) {
        const localPoints = entityLocalPoints(entity);
        const positions = new Float32Array(localPoints.length * 3);
        localPoints.forEach(([u, v], i) => {
          const [x, y, z] = toWorldPoint(entry, u, v);
          positions[i * 3] = x;
          positions[i * 3 + 1] = y;
          positions[i * 3 + 2] = z;
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        this.sketchOverlayGeometries.push(geometry);

        const line = new THREE.LineLoop(geometry, material);
        if (isSelected) line.renderOrder = SELECTED_SKETCH_RENDER_ORDER;
        this.sketchOverlayGroup.add(line);
        this.sketchLineCount += 1;
      }

      // 自由な線分・円弧セグメント(Phase 19a)。entitiesと異なり閉じている保証が無いため
      // LineLoopではなく開いたLineとして描画する(トリムUIは19bで追加予定、ここでは可視化のみ)。
      for (const segment of entry.segments ?? []) {
        const localPoints = segmentLocalPoints(segment);
        const positions = new Float32Array(localPoints.length * 3);
        localPoints.forEach(([u, v], i) => {
          const [x, y, z] = toWorldPoint(entry, u, v);
          positions[i * 3] = x;
          positions[i * 3 + 1] = y;
          positions[i * 3 + 2] = z;
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        this.sketchOverlayGeometries.push(geometry);

        const line = new THREE.Line(geometry, material);
        if (isSelected) line.renderOrder = SELECTED_SKETCH_RENDER_ORDER;
        this.sketchOverlayGroup.add(line);
        this.sketchLineCount += 1;
      }

      if (isSelected) {
        const grid = buildPlaneGrid(entry, this.meshHalfExtent * 1.2);
        this.sketchOverlayGeometries.push(grid.geometry);
        this.sketchOverlayMaterials.push(grid.material as THREE.Material);
        this.sketchOverlayGroup.add(grid);
        this.sketchGridBuilt = true;

        const axisMarkers = buildOriginAxisMarkers(entry, this.meshHalfExtent * 1.2);
        axisMarkers.forEach((obj) => {
          this.sketchOverlayGeometries.push(obj.geometry as THREE.BufferGeometry);
          this.sketchOverlayMaterials.push(obj.material as THREE.Material);
          this.sketchOverlayGroup.add(obj);
        });
      }
    }
  }

  /**
   * カメラを指定平面の法線方向から見下ろす位置に移動し、注視点を平面原点にする(「平面に正対」)。
   * カメラの up ベクトルには平面のyDirを使う(normalとほぼ平行になる世界upの代わりに、
   * 常に法線と直交することが保証された基底ベクトルを使うことでジンバルロックを避ける)。
   * OrbitControls の target/カメラ位置の設定のみで実現する小規模な変更。
   */
  lookAtPlane(basis: PlaneBasis) {
    const origin = new THREE.Vector3(...basis.origin);
    const normal = new THREE.Vector3(...basis.normal).normalize();
    const distance = Math.max(this.meshHalfExtent * 3, 100);
    const eye = origin.clone().addScaledVector(normal, distance);

    this.camera.up.set(basis.yDir[0], basis.yDir[1], basis.yDir[2]);
    this.camera.position.copy(eye);
    this.controls.target.copy(origin);
    this.controls.update();
  }

  /**
   * 描画モードの共通の開始処理(進行中の描画があればキャンセルしてから新しいモードに入る)。
   * 個別のstartXxxDrawing()から呼ぶ内部ヘルパー。
   */
  private beginDrawing(
    shape: DrawingShapeKind,
    basis: PlaneBasis,
    snap: boolean,
    existingEntities: SketchEntity[],
    existingSegments: SketchSegment[] = [],
  ) {
    this.cancelPolygonDrawing();
    this.cancelTrimTool();
    this.cancelCornerTool();
    this.cancelDimensionTool();
    this.clearSelection();
    this.setHoverGroup(null);
    this.drawingActive = true;
    this.drawingShape = shape;
    this.drawingBasis = basis;
    this.drawingSnap = snap;
    this.drawingEntities = existingEntities;
    this.drawingSegments = existingSegments;
    this.drawingPoints = [];
    this.drawingBulges = [];
    this.drawingAxisLocks = [];
    this.drawingArcMode = false;
    this.drawingArcPending = null;
    this.renderer.domElement.style.cursor = "crosshair";
  }

  /**
   * 指定平面上での線描画モードを開始する。以後のクリックは面選択でなく頂点追加として扱われ、
   * カーソルはcrosshairになる。基底(basis)はWorkerが返したsketchPlanesの値をそのまま渡すこと
   * (UI側で独自に再計算しない)。existingEntitiesは対象スケッチに既にある図形で、
   * 点スナップ候補(頂点・中心・中点)の収集元として使う。
   */
  startPolygonDrawing(basis: PlaneBasis, snap: boolean, existingEntities: SketchEntity[], callbacks: PolygonDrawingCallbacks) {
    this.beginDrawing("polygon", basis, snap, existingEntities);
    this.polygonCallbacks = callbacks;
  }

  /**
   * 矩形ツール(2クリック)を開始する(Phase 14)。1クリック目でコーナー1を確定、マウス移動で
   * 矩形ラバーバンドプレビュー、2クリック目で対角コーナー2を確定してonCompleteが呼ばれる。
   */
  startRectDrawing(basis: PlaneBasis, snap: boolean, existingEntities: SketchEntity[], callbacks: RectDrawingCallbacks) {
    this.beginDrawing("rectangle", basis, snap, existingEntities);
    this.rectCallbacks = callbacks;
  }

  /**
   * 円ツール(2クリック)を開始する(Phase 14)。1クリック目で中心を確定、マウス移動で
   * 円プレビュー+半径ライブ表示、2クリック目で半径を確定してonCompleteが呼ばれる。
   */
  startCircleDrawing(basis: PlaneBasis, snap: boolean, existingEntities: SketchEntity[], callbacks: CircleDrawingCallbacks) {
    this.beginDrawing("circle", basis, snap, existingEntities);
    this.circleCallbacks = callbacks;
  }

  /**
   * スロットツール(2クリック)を開始する(Phase 17)。1クリック目で中心線の始点を確定、
   * マウス移動でスロット(直線+半円キャップ)のラバーバンドプレビュー、2クリック目で終点を確定して
   * onCompleteが呼ばれる。widthはツール開始時に固定する(プレビュー描画にのみ使う)。
   */
  startSlotDrawing(
    basis: PlaneBasis,
    snap: boolean,
    existingEntities: SketchEntity[],
    width: number,
    callbacks: SlotDrawingCallbacks,
  ) {
    this.beginDrawing("slot", basis, snap, existingEntities);
    this.drawingSlotWidth = width;
    this.slotCallbacks = callbacks;
  }

  /**
   * 正多角形ツール(2クリック)を開始する(Phase 17)。1クリック目で中心を確定、マウス移動で
   * 正多角形のラバーバンドプレビュー(半径+回転)、2クリック目で頂点位置を確定してonCompleteが呼ばれる。
   * sidesはツール開始時に固定する(プレビュー描画にのみ使う)。
   */
  startRegularPolygonDrawing(
    basis: PlaneBasis,
    snap: boolean,
    existingEntities: SketchEntity[],
    sides: number,
    callbacks: RegularPolygonDrawingCallbacks,
  ) {
    this.beginDrawing("regularPolygon", basis, snap, existingEntities);
    this.drawingPolygonSides = sides;
    this.regularPolygonCallbacks = callbacks;
  }

  /**
   * 自由な線分・円弧セグメントのチェーン作図ツール(Phase 19b)を開始する。polygonツールと異なり
   * 閉じる必要が無く、Enter・始点付近クリック・ダブルクリックのいずれでも確定できる(頂点2つ以上)。
   * existingSegmentsは対象スケッチに既にあるsegments(点スナップ候補の収集元、Phase 19a)。
   */
  startSegmentDrawing(
    basis: PlaneBasis,
    snap: boolean,
    existingEntities: SketchEntity[],
    existingSegments: SketchSegment[],
    callbacks: SegmentDrawingCallbacks,
  ) {
    this.beginDrawing("segment", basis, snap, existingEntities, existingSegments);
    this.segmentCallbacks = callbacks;
  }

  /**
   * 円弧セグメントモード(Phase 17、Phase 19bでsegmentツールにも対応)のON/OFFを切り替える。
   * 線描画モード(polygon/segment)がアクティブで、かつ確定済み頂点が1つ以上ある場合のみ有効
   * (それ以外は何もせず現在の状態を返す)。トグル時は保留中の通過点(drawingArcPending)をリセットする。
   */
  togglePolygonArcMode(): boolean {
    const isChainShape = this.drawingShape === "polygon" || this.drawingShape === "segment";
    if (!this.drawingActive || !isChainShape || this.drawingPoints.length === 0) {
      return this.drawingArcMode;
    }
    this.drawingArcMode = !this.drawingArcMode;
    this.drawingArcPending = null;
    this.updateDrawingPreview();
    if (this.drawingShape === "polygon") this.polygonCallbacks?.onArcModeChange?.(this.drawingArcMode);
    else this.segmentCallbacks?.onArcModeChange?.(this.drawingArcMode);
    return this.drawingArcMode;
  }

  isPolygonArcModeActive(): boolean {
    return this.drawingArcMode;
  }

  /**
   * フィレット/面取りツール(Phase 18)を開始する。既存の線描画モード・面選択は中断/解除する。
   * 以後のクリックは面選択ではなく、対象スケッチのpolygonエンティティの頂点付近ヒット判定として
   * 扱われ、ヒットすると`callbacks.onVertexClick`が呼ばれる(実際のcorners更新はApp側の責務)。
   */
  startCornerTool(basis: PlaneBasis, entities: SketchEntity[], callbacks: CornerToolCallbacks) {
    this.cancelCornerTool();
    this.cancelPolygonDrawing();
    this.cancelTrimTool();
    this.cancelDimensionTool();
    this.clearSelection();
    this.setHoverGroup(null);
    this.cornerToolActive = true;
    this.cornerToolBasis = basis;
    this.cornerToolEntities = entities;
    this.cornerToolCallbacks = callbacks;
    this.renderer.domElement.style.cursor = "crosshair";
  }

  /**
   * ヒット判定対象のエンティティ一覧を更新する(フィレット/面取り適用でcornersが変わった後、
   * 呼び出し側の最新entitiesを反映するために使う想定)。ツール非アクティブ時は何もしない。
   */
  updateCornerToolEntities(entities: SketchEntity[]) {
    if (!this.cornerToolActive) return;
    this.cornerToolEntities = entities;
  }

  isCornerToolActive(): boolean {
    return this.cornerToolActive;
  }

  /** フィレット/面取りツールを終了する(onCancelが呼ばれる)。非アクティブなら何もしない。 */
  cancelCornerTool() {
    if (!this.cornerToolActive) return;
    const callbacks = this.cornerToolCallbacks;
    this.cornerToolActive = false;
    this.cornerToolBasis = null;
    this.cornerToolEntities = [];
    this.cornerToolCallbacks = null;
    this.renderer.domElement.style.cursor = "";
    callbacks?.onCancel();
  }

  /**
   * フィレット/面取りツール中のクリック処理。対象スケッチのpolygonエンティティの全頂点を
   * スクリーン座標に投影し、クリック位置からCORNER_HIT_TOLERANCE_PX以内で最も近い頂点が
   * あれば`onVertexClick`を呼ぶ(複数候補がある場合は最も近いものを採用)。ヒットが無ければ何もしない
   * (連続クリックで複数頂点に適用できるよう、ツール自体は終了しない)。
   */
  private handleCornerToolClick(event: MouseEvent) {
    if (!this.cornerToolBasis) return;
    const basis = this.cornerToolBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    type Hit = { entityId: string; vertexIndex: number; distSq: number };
    let best: Hit | null = null;
    for (const entity of this.cornerToolEntities) {
      if (entity.kind !== "polygon") continue;
      for (let vertexIndex = 0; vertexIndex < entity.points.length; vertexIndex += 1) {
        const point = entity.points[vertexIndex];
        const world = planeLocalToWorld(basis, point[0], point[1]);
        const screen = this.projectPoint(world);
        if (!screen) continue;
        const dx = screen.x - px;
        const dy = screen.y - py;
        const distSq = dx * dx + dy * dy;
        if (distSq > CORNER_HIT_TOLERANCE_PX * CORNER_HIT_TOLERANCE_PX) continue;
        if (best === null || distSq < best.distSq) {
          best = { entityId: entity.id, vertexIndex, distSq };
        }
      }
    }
    if (best) {
      this.cornerToolCallbacks?.onVertexClick(best.entityId, best.vertexIndex);
    }
  }

  /**
   * トリムツール(Phase 19b)を開始する。既存の線描画モード・フィレット/面取りツール・面選択は
   * 中断/解除する。以後、マウス移動はホバー中の削除候補区間の赤色プレビュー、クリックは
   * `callbacks.onTrimClick`(実際のtrimSegmentAtPoint()適用・segments更新はApp側の責務)。
   */
  startTrimTool(basis: PlaneBasis, segments: SketchSegment[], callbacks: TrimToolCallbacks) {
    this.cancelTrimTool();
    this.cancelPolygonDrawing();
    this.cancelCornerTool();
    this.cancelDimensionTool();
    this.clearSelection();
    this.setHoverGroup(null);
    this.trimActive = true;
    this.trimBasis = basis;
    this.trimSegments = segments;
    this.trimCallbacks = callbacks;
    this.trimHoverTargetId = null;
    this.renderer.domElement.style.cursor = "crosshair";
  }

  /**
   * ヒット判定対象のsegments一覧を更新する(トリム適用でsegmentsが変わった後、呼び出し側の
   * 最新値を反映するために使う想定)。ツール非アクティブ時は何もしない。
   */
  updateTrimSegments(segments: SketchSegment[]) {
    if (!this.trimActive) return;
    this.trimSegments = segments;
    this.clearDrawingPreview();
    this.trimHoverTargetId = null;
  }

  isTrimToolActive(): boolean {
    return this.trimActive;
  }

  /** トリムツールを終了する(onCancelが呼ばれる)。非アクティブなら何もしない。 */
  cancelTrimTool() {
    if (!this.trimActive) return;
    const callbacks = this.trimCallbacks;
    this.trimActive = false;
    this.trimBasis = null;
    this.trimSegments = [];
    this.trimCallbacks = null;
    this.trimHoverTargetId = null;
    this.renderer.domElement.style.cursor = "";
    this.clearDrawingPreview();
    callbacks?.onCancel();
  }

  /**
   * トリムツール中のマウス移動処理。カーソル位置に最も近いセグメント(スクリーン距離
   * TRIM_HOVER_TOLERANCE_PX以内)を求め、そのセグメント上でカーソルに最も近い「区間」
   * (src/sketch/trim.ts の findClosestSegmentPiece())を赤色でプレビュー表示する。
   */
  private handleTrimMouseMove(event: MouseEvent) {
    if (!this.trimBasis) return;
    const basis = this.trimBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const hit = this.raycastDrawingPlane(basis, px, py, rect);
    if (!hit) {
      this.clearDrawingPreview();
      this.trimHoverTargetId = null;
      return;
    }
    const local = planeWorldToLocal(basis, hit);
    const toleranceMm = this.pxToMm(TRIM_HOVER_TOLERANCE_PX, hit);

    let nearestId: string | null = null;
    let nearestDist = Infinity;
    for (const segment of this.trimSegments) {
      const d = distPointToSegmentShape(local, segment);
      if (d < nearestDist) {
        nearestDist = d;
        nearestId = segment.id;
      }
    }

    this.clearDrawingPreview();
    if (nearestId === null || nearestDist > toleranceMm) {
      this.trimHoverTargetId = null;
      return;
    }
    const piece = findClosestSegmentPiece(this.trimSegments, nearestId, local);
    if (!piece) {
      this.trimHoverTargetId = null;
      return;
    }
    this.trimHoverTargetId = nearestId;
    this.drawTrimPreview(basis, piece);
  }

  /** トリムツール中のクリック処理。直近のホバーでヒットした対象セグメントがあれば`onTrimClick`を呼ぶ。 */
  private handleTrimClick(event: MouseEvent) {
    if (!this.trimBasis || this.trimHoverTargetId === null) return;
    const basis = this.trimBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const hit = this.raycastDrawingPlane(basis, px, py, rect);
    if (!hit) return;
    const local = planeWorldToLocal(basis, hit);
    this.trimCallbacks?.onTrimClick(this.trimHoverTargetId, local);
  }

  /** トリムの削除候補区間(piece)を赤色のプレビュー線として描画する(drawingGroupを流用)。 */
  private drawTrimPreview(basis: PlaneBasis, piece: SketchSegment) {
    const localPoints = segmentLocalPoints(piece);
    const worldPts = localPoints.map(([u, v]) => planeLocalToWorld(basis, u, v));
    const positions = new Float32Array(worldPts.length * 3);
    worldPts.forEach((p, i) => positions.set(p, i * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: TRIM_PREVIEW_COLOR, linewidth: 3, depthTest: false });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = DRAWING_FEEDBACK_RENDER_ORDER + 2;
    this.drawingGroup.add(line);
    this.drawingPreviewGeometries.push(geometry);
    this.drawingPreviewMaterials.push(material);
  }

  /**
   * 寸法ツール(Phase 20b、Phase 21でrectangle/circleエンティティにも対応)を開始する。
   * 既存の線描画モード・フィレット/面取りツール・トリムツール・面選択は中断/解除する。
   * 以後のクリックは、まず全segmentsの端点をスクリーン距離DIMENSION_ENDPOINT_TOLERANCE_PX以内で
   * 探し(優先)、無ければセグメント本体・entities(rectangle/circle)の境界を合わせて
   * DIMENSION_SEGMENT_TOLERANCE_PX以内で最も近いものを探す。端点を2つ順にクリックするとdistance、
   * セグメント本体(線分)をクリックするとlength、円弧をクリックするとradius、circleの円周を
   * クリックするとentity-radius、rectangleの辺をクリックするとentity-width/entity-heightの
   * ターゲットとして`callbacks.onTargetPicked`が呼ばれる(実際の拘束の作成/更新・entityの直接更新は
   * App側の責務)。マウス移動中はヒット候補をホバー色でハイライトする(handleDimensionToolMouseMove)。
   */
  startDimensionTool(basis: PlaneBasis, segments: SketchSegment[], entities: SketchEntity[], callbacks: DimensionToolCallbacks) {
    this.cancelDimensionTool();
    this.cancelPolygonDrawing();
    this.cancelCornerTool();
    this.cancelTrimTool();
    this.clearSelection();
    this.setHoverGroup(null);
    this.dimensionToolActive = true;
    this.dimensionToolBasis = basis;
    this.dimensionToolSegments = segments;
    this.dimensionToolEntities = entities;
    this.dimensionToolCallbacks = callbacks;
    this.dimensionPendingPoint = null;
    this.dimensionHoverEntityHit = null;
    this.renderer.domElement.style.cursor = "crosshair";
  }

  /**
   * ヒット判定対象のsegments/entities一覧を更新する(拘束追加・値変更で座標が変わった後、
   * 呼び出し側の最新値を反映するために使う想定)。1点目の保留状態・プレビューはリセットする
   * (更新前のsegmentIdを参照したままにしないため)。ツール非アクティブ時は何もしない。
   */
  updateDimensionToolTargets(segments: SketchSegment[], entities: SketchEntity[]) {
    if (!this.dimensionToolActive) return;
    this.dimensionToolSegments = segments;
    this.dimensionToolEntities = entities;
    this.clearDrawingPreview();
    this.dimensionPendingPoint = null;
    this.dimensionHoverEntityHit = null;
  }

  isDimensionToolActive(): boolean {
    return this.dimensionToolActive;
  }

  /** 寸法ツールを終了する(onCancelが呼ばれる)。非アクティブなら何もしない。 */
  cancelDimensionTool() {
    if (!this.dimensionToolActive) return;
    const callbacks = this.dimensionToolCallbacks;
    this.dimensionToolActive = false;
    this.dimensionToolBasis = null;
    this.dimensionToolSegments = [];
    this.dimensionToolEntities = [];
    this.dimensionToolCallbacks = null;
    this.dimensionPendingPoint = null;
    this.dimensionHoverEntityHit = null;
    this.renderer.domElement.style.cursor = "";
    this.clearDrawingPreview();
    callbacks?.onCancel();
  }

  /** 1点目として保留中の端点を示すマーカー(頂点スナップと同じ四角マーカー)を表示する。 */
  private drawDimensionPendingMarker(basis: PlaneBasis, local: [number, number]) {
    this.clearDrawingPreview();
    for (const obj of buildSnapMarkerObjects(basis, "vertex", local)) {
      this.drawingGroup.add(obj);
      this.drawingPreviewGeometries.push(obj.geometry);
      this.drawingPreviewMaterials.push(obj.material as THREE.Material);
    }
  }

  /**
   * 寸法ツール中のクリック処理。まず全segmentsの端点をスクリーン距離
   * DIMENSION_ENDPOINT_TOLERANCE_PX以内で探索し、最も近いものがあれば端点ヒットとして扱う
   * (セグメント本体・entitiesより優先)。1点目のクリックではdimensionPendingPointに保存して
   * マーカー表示のみ、2点目のクリック(異なる点)でdistanceターゲットとしてonTargetPickedを呼ぶ。
   * 端点ヒットが無ければセグメント本体・entities(rectangle/circle、Phase 21)の境界を合わせて
   * DIMENSION_SEGMENT_TOLERANCE_PX以内で最も近いものを探し、セグメントがヒットすればkindがarcなら
   * radius・それ以外はlength、entityがヒットすればentity-radius/entity-width/entity-heightの
   * ターゲットとしてonTargetPickedを呼ぶ(保留中の1点目は破棄する)。
   */
  private handleDimensionToolClick(event: MouseEvent) {
    if (!this.dimensionToolBasis) return;
    const basis = this.dimensionToolBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    type PointHit = { ref: PointRef; local: [number, number]; distSq: number };
    let bestPoint: PointHit | null = null;
    for (const seg of this.dimensionToolSegments) {
      for (const end of ["p1", "p2"] as const) {
        const local = end === "p1" ? seg.p1 : seg.p2;
        const world = planeLocalToWorld(basis, local[0], local[1]);
        const screen = this.projectPoint(world);
        if (!screen) continue;
        const dx = screen.x - px;
        const dy = screen.y - py;
        const distSq = dx * dx + dy * dy;
        if (distSq > DIMENSION_ENDPOINT_TOLERANCE_PX * DIMENSION_ENDPOINT_TOLERANCE_PX) continue;
        if (bestPoint === null || distSq < bestPoint.distSq) {
          bestPoint = { ref: { segmentId: seg.id, end }, local, distSq };
        }
      }
    }

    if (bestPoint) {
      const pending = this.dimensionPendingPoint;
      if (pending && !(pending.segmentId === bestPoint.ref.segmentId && pending.end === bestPoint.ref.end)) {
        this.dimensionPendingPoint = null;
        this.clearDrawingPreview();
        this.dimensionToolCallbacks?.onTargetPicked({ kind: "distance", a: pending, b: bestPoint.ref }, px, py);
        return;
      }
      this.dimensionPendingPoint = bestPoint.ref;
      this.drawDimensionPendingMarker(basis, bestPoint.local);
      return;
    }

    const hit = this.raycastDrawingPlane(basis, px, py, rect);
    if (!hit) return;
    const local = planeWorldToLocal(basis, hit);
    const toleranceMm = this.pxToMm(DIMENSION_SEGMENT_TOLERANCE_PX, hit);
    let nearestId: string | null = null;
    let nearestDist = Infinity;
    for (const seg of this.dimensionToolSegments) {
      const d = distPointToSegmentShape(local, seg);
      if (d < nearestDist) {
        nearestDist = d;
        nearestId = seg.id;
      }
    }
    const entityHit = findEntityDimensionHit(local, this.dimensionToolEntities);

    // セグメントとentityの両方が許容距離内にヒットしうる場合は、より近い方を優先する。
    if (entityHit && entityHit.dist <= toleranceMm && (nearestId === null || entityHit.dist < nearestDist)) {
      this.dimensionPendingPoint = null;
      this.clearDrawingPreview();
      this.dimensionToolCallbacks?.onTargetPicked({ kind: entityHit.kind, entityId: entityHit.entityId }, px, py);
      return;
    }

    if (nearestId === null || nearestDist > toleranceMm) return;

    this.dimensionPendingPoint = null;
    this.clearDrawingPreview();
    const seg = this.dimensionToolSegments.find((s) => s.id === nearestId);
    if (!seg) return;
    if (seg.kind === "arc" && seg.bulge) {
      this.dimensionToolCallbacks?.onTargetPicked({ kind: "radius", segmentId: nearestId }, px, py);
    } else {
      this.dimensionToolCallbacks?.onTargetPicked({ kind: "length", segmentId: nearestId }, px, py);
    }
  }

  /** 寸法ツールのヒット候補(セグメント・entity)をホバー色でプレビュー表示する(Phase 21)。 */
  private drawDimensionHoverPreview(basis: PlaneBasis, localPoints: [number, number][]) {
    const worldPts = localPoints.map(([u, v]) => planeLocalToWorld(basis, u, v));
    const positions = new Float32Array(worldPts.length * 3);
    worldPts.forEach((p, i) => positions.set(p, i * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: HOVER_COLOR, linewidth: 3, depthTest: false });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = DRAWING_FEEDBACK_RENDER_ORDER + 2;
    this.drawingGroup.add(line);
    this.drawingPreviewGeometries.push(geometry);
    this.drawingPreviewMaterials.push(material);
  }

  /**
   * 寸法ツール中のマウス移動処理(Phase 21)。カーソル位置に最も近いヒット候補
   * (セグメント本体・entitiesの境界。端点は対象外、クリック時のdistance用の特別扱いのため)を
   * DIMENSION_SEGMENT_TOLERANCE_PX以内で求め、ヒットがあればホバー色でハイライト表示する
   * (「選べるものが分かる」ようにするための視覚フィードバック)。distance入力の1点目待ち中
   * (dimensionPendingPoint)はそのマーカー表示を優先し、ホバープレビューは描かない。
   */
  private handleDimensionToolMouseMove(event: MouseEvent) {
    if (!this.dimensionToolBasis || this.dimensionPendingPoint) return;
    const basis = this.dimensionToolBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const hit = this.raycastDrawingPlane(basis, px, py, rect);
    if (!hit) {
      this.clearDrawingPreview();
      this.dimensionHoverEntityHit = null;
      return;
    }
    const local = planeWorldToLocal(basis, hit);
    const toleranceMm = this.pxToMm(DIMENSION_SEGMENT_TOLERANCE_PX, hit);

    let nearestSeg: SketchSegment | null = null;
    let nearestSegDist = Infinity;
    for (const seg of this.dimensionToolSegments) {
      const d = distPointToSegmentShape(local, seg);
      if (d < nearestSegDist) {
        nearestSegDist = d;
        nearestSeg = seg;
      }
    }
    const entityHit = findEntityDimensionHit(local, this.dimensionToolEntities);

    this.clearDrawingPreview();
    if (entityHit && entityHit.dist <= toleranceMm && (!nearestSeg || entityHit.dist < nearestSegDist)) {
      this.dimensionHoverEntityHit = entityHit;
      this.drawDimensionHoverPreview(basis, entityHit.highlightPoints);
      return;
    }
    this.dimensionHoverEntityHit = null;
    if (nearestSeg && nearestSegDist <= toleranceMm) {
      this.drawDimensionHoverPreview(basis, segmentLocalPoints(nearestSeg));
    }
  }

  /** 描画モード中のスナップ(グリッド+点スナップ)有効/無効をリアルタイムに切り替える。軸ロックはこれと独立。 */
  setPolygonDrawingSnap(enabled: boolean) {
    this.drawingSnap = enabled;
  }

  isPolygonDrawingActive(): boolean {
    return this.drawingActive;
  }

  /**
   * 描画中の内容を破棄してモードを終了する(現在の図形種別に応じたonCancelが呼ばれる)。
   * 非アクティブなら何もしない。polygon/rectangle/circleいずれのモードでも使える(名前は
   * polygon描画モード時代からの互換のため据え置き)。
   */
  cancelPolygonDrawing() {
    if (!this.drawingActive) return;
    const shape = this.drawingShape;
    const polygonCallbacks = this.polygonCallbacks;
    const rectCallbacks = this.rectCallbacks;
    const circleCallbacks = this.circleCallbacks;
    const slotCallbacks = this.slotCallbacks;
    const regularPolygonCallbacks = this.regularPolygonCallbacks;
    const segmentCallbacks = this.segmentCallbacks;
    this.exitDrawingState();
    if (shape === "polygon") polygonCallbacks?.onCancel();
    else if (shape === "rectangle") rectCallbacks?.onCancel();
    else if (shape === "circle") circleCallbacks?.onCancel();
    else if (shape === "slot") slotCallbacks?.onCancel();
    else if (shape === "regularPolygon") regularPolygonCallbacks?.onCancel();
    else segmentCallbacks?.onCancel();
  }

  /**
   * 頂点3点以上であれば閉じて確定する(onCompleteが呼ばれる)。非アクティブ・頂点不足時は何もしない。
   * 円弧セグメント(Phase 17)を1つも使わなかった場合はbulgesを渡さない(既存呼び出し側との互換)。
   */
  private finishPolygonDrawing() {
    if (!this.drawingActive || this.drawingShape !== "polygon" || this.drawingPoints.length < 3) return;
    const points = [...this.drawingPoints];
    const bulges = this.drawingBulges.some((b) => !!b) ? [...this.drawingBulges] : undefined;
    const callbacks = this.polygonCallbacks;
    this.exitDrawingState();
    callbacks?.onComplete(points, bulges);
  }

  /**
   * セグメントチェーン(Phase 19b)を確定する(onCompleteが呼ばれる)。polygonと異なり
   * 3点以上である必要は無く、頂点2つ(=セグメント1本)以上あれば確定できる。
   */
  private finishSegmentDrawing() {
    if (!this.drawingActive || this.drawingShape !== "segment" || this.drawingPoints.length < 2) return;
    const points = [...this.drawingPoints];
    const bulges = [...this.drawingBulges];
    const axisLocks = [...this.drawingAxisLocks];
    const callbacks = this.segmentCallbacks;
    this.exitDrawingState();
    callbacks?.onComplete(points, bulges, axisLocks);
  }

  /**
   * 矩形/円/スロット/正多角形ツールの2クリック目を確定する(onCompleteが呼ばれる)。始点と終点が
   * 実質同一点(縮退)の場合は無視して描画モードを継続する(誤クリックで幅・高さ0の図形ができるのを防ぐ)。
   */
  private finishShapeDrawing(first: [number, number], second: [number, number]) {
    if (Math.hypot(second[0] - first[0], second[1] - first[1]) < 1e-6) return;
    if (this.drawingShape === "rectangle") {
      const callbacks = this.rectCallbacks;
      this.exitDrawingState();
      callbacks?.onComplete(first, second);
    } else if (this.drawingShape === "circle") {
      const callbacks = this.circleCallbacks;
      const radius = circleRadiusFromPoints(first, second);
      this.exitDrawingState();
      callbacks?.onComplete(first, radius);
    } else if (this.drawingShape === "slot") {
      const callbacks = this.slotCallbacks;
      this.exitDrawingState();
      callbacks?.onComplete(first, second);
    } else if (this.drawingShape === "regularPolygon") {
      const callbacks = this.regularPolygonCallbacks;
      const { radius, rotation } = regularPolygonFromCenterVertex(first, second);
      this.exitDrawingState();
      callbacks?.onComplete(first, radius, rotation);
    }
  }

  /** 描画モードの内部状態・プレビュー・カーソルをリセットする(コールバックは呼ばない)。 */
  private exitDrawingState() {
    this.drawingActive = false;
    this.drawingBasis = null;
    this.drawingEntities = [];
    this.drawingSegments = [];
    this.drawingPoints = [];
    this.drawingBulges = [];
    this.drawingAxisLocks = [];
    this.drawingArcMode = false;
    this.drawingArcPending = null;
    this.polygonCallbacks = null;
    this.rectCallbacks = null;
    this.circleCallbacks = null;
    this.slotCallbacks = null;
    this.regularPolygonCallbacks = null;
    this.segmentCallbacks = null;
    this.lastHoverLocal = null;
    this.renderer.domElement.style.cursor = "";
    this.clearDrawingPreview();
    this.coordOverlayEl.style.display = "none";
    this.resetLengthInput();
  }

  /**
   * 矩形/円ツール(2クリック)のクリック処理(Phase 14)。1クリック目でコーナー1/中心を確定し、
   * 2クリック目でfinishShapeDrawing()を呼ぶ。
   */
  private handleShapeClick(event: MouseEvent) {
    if (!this.drawingBasis) return;
    const basis = this.drawingBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    const hit = this.raycastDrawingPlane(basis, px, py, rect);
    if (!hit) return;
    const resolved = this.resolveDrawingCursor(basis, hit, event.shiftKey);

    if (this.drawingPoints.length === 0) {
      this.drawingPoints.push(resolved.point);
      this.updateDrawingPreview();
      this.updateShapeCoordOverlay(px, py, null, resolved.point);
      return;
    }
    this.finishShapeDrawing(this.drawingPoints[0], resolved.point);
  }

  /**
   * 頂点(またはbulge=null)を確定済み頂点列に追加する共通ヘルパー。drawingBulges/drawingAxisLocksは
   * drawingPoints.length-1個を維持する(頂点0にはまだ対応する辺が無いため、2点目以降のみ追加)。
   * axis(Phase 20a)はセグメントツールでのみ意味を持つ(polygonツールの呼び出しは省略し、既定のnullになる)。
   */
  private pushDrawingPoint(point: [number, number], bulge: number | null, axis: AxisLockKind = null) {
    if (this.drawingPoints.length > 0) {
      this.drawingBulges.push(bulge);
      this.drawingAxisLocks.push(axis);
    }
    this.drawingPoints.push(point);
  }

  /**
   * 描画モード中のクリックをレイキャストしてスケッチ平面上のローカル2D座標に変換し、頂点を追加する。
   * 円弧セグメントモード(Phase 17、drawingArcMode)が有効な間は、1クリック目を通過点(仮点、
   * drawingPointsには追加しない)、2クリック目を終点として扱い、3点円弧のbulge値を計算して
   * 直前の確定頂点からの辺として追加する(確定後は自動的に直線モードへ戻る)。
   */
  private handlePolygonClick(event: MouseEvent) {
    if (!this.drawingBasis) return;
    // マウスクリックによる頂点確定は、入力中だった数値長さ(未確定)を破棄する。
    this.resetLengthInput();
    const basis = this.drawingBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    // 始点付近(スクリーン距離10px程度以内)のクリックは閉じて確定する扱いにする(スナップ判定より優先)。
    // 円弧セグメント入力中(通過点/終点クリック待ち)はこの近接クローズを行わない。
    if (!this.drawingArcMode && this.drawingPoints.length >= 3) {
      const startWorld = planeLocalToWorld(basis, this.drawingPoints[0][0], this.drawingPoints[0][1]);
      const startScreen = this.projectPoint(startWorld);
      if (startScreen) {
        const dx = startScreen.x - px;
        const dy = startScreen.y - py;
        if (Math.sqrt(dx * dx + dy * dy) <= CLOSE_TO_START_PX) {
          this.finishPolygonDrawing();
          return;
        }
      }
    }

    const hit = this.raycastDrawingPlane(basis, px, py, rect);
    if (!hit) return;
    const resolved = this.resolveDrawingCursor(basis, hit, event.shiftKey);

    if (this.drawingArcMode) {
      if (this.drawingArcPending === null) {
        // 1クリック目: 円弧の通過点(仮点)。確定頂点列には追加しない。
        this.drawingArcPending = resolved.point;
        this.updateDrawingPreview();
        this.updateCoordOverlay(px, py, resolved.point);
        return;
      }
      // 2クリック目: 円弧の終点。直前の確定頂点→通過点→終点の3点円弧としてbulgeを計算する。
      const start = this.drawingPoints[this.drawingPoints.length - 1];
      const via = this.drawingArcPending;
      const end = resolved.point;
      const bulge = bulgeFromThreePoints(start, via, end);
      this.pushDrawingPoint(end, bulge);
      this.drawingArcPending = null;
      this.drawingArcMode = false;
      this.polygonCallbacks?.onArcModeChange?.(false);
      this.updateDrawingPreview();
      this.updateCoordOverlay(px, py, end);
      return;
    }

    this.pushDrawingPoint(resolved.point, null);
    this.updateDrawingPreview();
    this.updateCoordOverlay(px, py, resolved.point);
  }

  /**
   * セグメントチェーンツール(Phase 19b)のクリック処理。基本はhandlePolygonClick()と同様
   * (スナップ・軸ロック・円弧セグメントモードを共有する)だが、閉じる必要が無い点が異なる:
   * 始点付近クリックはpolygonと同様に自動closeするが、閉じずにfinishSegmentDrawing()を呼ぶ経路
   * (Enter・ダブルクリック)もあるため3点未満でも成立する。
   */
  private handleSegmentClick(event: MouseEvent) {
    if (!this.drawingBasis) return;
    this.resetLengthInput();
    const basis = this.drawingBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    // 始点付近(スクリーン距離10px程度以内)のクリックは、始点へ戻る辺を追加してそのまま
    // 閉チェーンとして確定する(polygonへの変換はしない)。円弧セグメント入力中は近接closeしない。
    if (!this.drawingArcMode && this.drawingPoints.length >= 3) {
      const startWorld = planeLocalToWorld(basis, this.drawingPoints[0][0], this.drawingPoints[0][1]);
      const startScreen = this.projectPoint(startWorld);
      if (startScreen) {
        const dx = startScreen.x - px;
        const dy = startScreen.y - py;
        if (Math.sqrt(dx * dx + dy * dy) <= CLOSE_TO_START_PX) {
          this.pushDrawingPoint(this.drawingPoints[0], null);
          this.finishSegmentDrawing();
          return;
        }
      }
    }

    const hit = this.raycastDrawingPlane(basis, px, py, rect);
    if (!hit) return;
    const resolved = this.resolveDrawingCursor(basis, hit, event.shiftKey);

    if (this.drawingArcMode) {
      if (this.drawingArcPending === null) {
        this.drawingArcPending = resolved.point;
        this.updateDrawingPreview();
        this.updateCoordOverlay(px, py, resolved.point);
        return;
      }
      const start = this.drawingPoints[this.drawingPoints.length - 1];
      const via = this.drawingArcPending;
      const end = resolved.point;
      const bulge = bulgeFromThreePoints(start, via, end);
      this.pushDrawingPoint(end, bulge);
      this.drawingArcPending = null;
      this.drawingArcMode = false;
      this.segmentCallbacks?.onArcModeChange?.(false);
      this.updateDrawingPreview();
      this.updateCoordOverlay(px, py, end);
      return;
    }

    this.pushDrawingPoint(resolved.point, null, resolved.axis);
    this.updateDrawingPreview();
    this.updateCoordOverlay(px, py, resolved.point);
  }

  /**
   * セグメントチェーンツール(Phase 19b)のダブルクリック処理。ネイティブのdblclickは直前に
   * 通常のclickが2回発火し、ほぼ同一座標に頂点が2つ連続で追加された状態で届くため、
   * 最後の1点(2回目のクリック分、直前の点とほぼ同一座標)を取り除いてから確定する。
   */
  private handleSegmentDoubleClick = (event: MouseEvent) => {
    if (!this.drawingActive || this.drawingShape !== "segment" || this.lengthInputActive) return;
    event.preventDefault();
    if (this.drawingPoints.length >= 2) {
      const last = this.drawingPoints[this.drawingPoints.length - 1];
      const prev = this.drawingPoints[this.drawingPoints.length - 2];
      if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) < 1e-6) {
        this.drawingPoints.pop();
        this.drawingBulges.pop();
        this.drawingAxisLocks.pop();
      }
    }
    this.finishSegmentDrawing();
  };

  /**
   * マウス移動時、描画モード中であればスナップ・軸ロックを適用したラバーバンド・ガイド・座標表示を
   * 更新し、描画モード外であれば面ホバーハイライトを更新する。
   */
  private handleDrawingMouseMove = (event: MouseEvent) => {
    if (this.trimActive) {
      this.handleTrimMouseMove(event);
      return;
    }
    if (this.dimensionToolActive) {
      this.handleDimensionToolMouseMove(event);
      return;
    }
    // フィレット/面取りツール中は面ホバーハイライトも描画プレビューも不要(クリックのみで完結する)。
    if (this.cornerToolActive) return;
    if (!this.drawingActive || !this.drawingBasis) {
      this.handleHoverMouseMove(event);
      return;
    }
    const basis = this.drawingBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    this.lastMousePx = px;
    this.lastMousePy = py;

    const hit = this.raycastDrawingPlane(basis, px, py, rect);
    if (!hit) {
      this.updateDrawingPreview();
      this.coordOverlayEl.style.display = "none";
      return;
    }
    const resolved = this.resolveDrawingCursor(basis, hit, event.shiftKey);
    this.lastHoverLocal = resolved.point;
    this.updateDrawingPreview({ local: resolved.point, snapKind: resolved.snapKind, axis: resolved.axis });
    if (this.drawingShape === "polygon" || this.drawingShape === "segment") {
      this.updateCoordOverlay(px, py, resolved.point);
      // 数値長さ入力中はカーソル追従で位置を再計算する(内容は変わらない)。
      this.updateLengthInputOverlay();
    } else {
      const first = this.drawingPoints.length > 0 ? this.drawingPoints[0] : null;
      this.updateShapeCoordOverlay(px, py, first, resolved.point);
    }
  };

  /**
   * カーソルのワールド交点(hitWorld)を、スナップ・軸ロックを適用したスケッチ平面ローカル2D座標に解決する。
   * Shift押下中(shiftHeld)は点スナップ・グリッドスナップ・軸ロックのすべてを一時無効化する
   * (完全フリー入力)。「スナップ」チェックボックス(drawingSnap)は点+グリッドスナップのみを
   * 制御し、軸ロックはチェックボックスと独立してShift以外では常に有効。
   */
  private resolveDrawingCursor(basis: PlaneBasis, hitWorld: Tuple3, shiftHeld: boolean): ResolvedDrawingPoint {
    const cursor = planeWorldToLocal(basis, hitWorld);
    const snapEnabled = this.drawingSnap && !shiftHeld;
    // 軸ロックは連続する直線セグメントの水平/垂直吸着を狙ったもので、矩形/円の2クリック作図では
    // (特に矩形は)幅または高さが0に縮退しうるため適用しない(polygon/segmentのみ)。
    const axisLockEnabled = !shiftHeld && (this.drawingShape === "polygon" || this.drawingShape === "segment");
    const tolerance = this.pxToMm(SNAP_TOLERANCE_PX, hitWorld);
    const candidates: SnapCandidate[] = snapEnabled
      ? [
          ...collectSketchSnapCandidates(this.drawingEntities),
          ...collectSegmentSnapCandidates(this.drawingSegments),
          ORIGIN_CANDIDATE,
          ...pointsToVertexCandidates(this.drawingPoints),
        ]
      : [];
    const lastPoint = this.drawingPoints.length > 0 ? this.drawingPoints[this.drawingPoints.length - 1] : null;
    return resolveDrawingPoint({
      cursor,
      lastPoint,
      candidates,
      gridSpacing: snapEnabled ? DRAWING_GRID_SPACING : 0,
      tolerance,
      axisLockEnabled,
    });
  }

  /**
   * canvas内スクリーンpx距離を、指定ワールド点(hitWorld)におけるローカルmm距離に概算換算する。
   * パースペクティブカメラの垂直画角とカメラ〜hitWorld間の距離から、その距離での画面高さ(mm)を求め、
   * canvasの高さ(px)で割ってmm/px比を得る(視線とほぼ直交する平面上での近似。スナップ判定用途では
   * 厳密なピクセル一致は不要なため、この近似で十分)。
   */
  private pxToMm(px: number, hitWorld: Tuple3): number {
    const hit = new THREE.Vector3(hitWorld[0], hitWorld[1], hitWorld[2]);
    const dist = this.camera.position.distanceTo(hit);
    const vFovRad = (this.camera.fov * Math.PI) / 180;
    const worldHeightAtDist = 2 * Math.tan(vFovRad / 2) * dist;
    const heightPx = Math.max(this.container.clientHeight, 1);
    return px * (worldHeightAtDist / heightPx);
  }

  /** canvas内ピクセル座標(px, py)から描画平面(basis)へのレイキャスト交点(ワールド座標)を返す。 */
  private raycastDrawingPlane(basis: PlaneBasis, px: number, py: number, rect: DOMRect): Tuple3 | null {
    const pointer = new THREE.Vector2((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(pointer, this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3(basis.normal[0], basis.normal[1], basis.normal[2]),
      new THREE.Vector3(basis.origin[0], basis.origin[1], basis.origin[2]),
    );
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    return [hit.x, hit.y, hit.z];
  }

  /**
   * プレビュー(確定済みセグメント+ラバーバンド+軸ロックガイド+スナップマーカー)を作り直す。
   * hoverを渡すと、ラバーバンド・(軸ロック中なら)ガイド線・(スナップ中なら)確定候補マーカーも描く。
   */
  private updateDrawingPreview(hover?: { local: [number, number]; snapKind: SnapKind | null; axis: AxisLockKind }) {
    this.clearDrawingPreview();
    if (!this.drawingBasis) return;
    if (this.drawingShape !== "polygon" && this.drawingShape !== "segment") {
      this.updateShapePreview(hover);
      return;
    }
    const basis = this.drawingBasis;

    if (this.drawingPoints.length > 0) {
      // 確定済み頂点列を、円弧セグメント(Phase 17、drawingBulges)がある辺は弧近似で展開する。
      const localPts: [number, number][] = [this.drawingPoints[0]];
      for (let i = 1; i < this.drawingPoints.length; i += 1) {
        const bulge = this.drawingBulges[i - 1] ?? null;
        if (bulge) {
          const arcPts = bulgeArcPoints(this.drawingPoints[i - 1], this.drawingPoints[i], bulge, ARC_PREVIEW_SEGMENTS);
          localPts.push(...arcPts.slice(1));
        } else {
          localPts.push(this.drawingPoints[i]);
        }
      }
      const worldPts = localPts.map(([u, v]) => planeLocalToWorld(basis, u, v));
      const positions = new Float32Array(worldPts.length * 3);
      worldPts.forEach((p, i) => positions.set(p, i * 3));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({ color: DRAWING_PREVIEW_COLOR, depthTest: false });
      const line = new THREE.Line(geometry, material);
      line.renderOrder = DRAWING_FEEDBACK_RENDER_ORDER;
      this.drawingGroup.add(line);
      this.drawingPreviewGeometries.push(geometry);
      this.drawingPreviewMaterials.push(material);

      if (hover) {
        const lastLocal = this.drawingPoints[this.drawingPoints.length - 1];
        // 円弧セグメント入力中(通過点確定後、終点待ち)は、直前頂点→通過点→hover(仮終点)の
        // 3点円弧としてラバーバンドを弧形状で描く。それ以外は直線のラバーバンド。
        let rubberLocalPts: [number, number][];
        if (this.drawingArcMode && this.drawingArcPending) {
          const bulge = bulgeFromThreePoints(lastLocal, this.drawingArcPending, hover.local);
          rubberLocalPts = bulgeArcPoints(lastLocal, hover.local, bulge, ARC_PREVIEW_SEGMENTS);
        } else {
          rubberLocalPts = [lastLocal, hover.local];
        }
        const rubberWorldPts = rubberLocalPts.map(([u, v]) => planeLocalToWorld(basis, u, v));
        const rubberPositions = new Float32Array(rubberWorldPts.length * 3);
        rubberWorldPts.forEach((p, i) => rubberPositions.set(p, i * 3));
        const rubberGeometry = new THREE.BufferGeometry();
        rubberGeometry.setAttribute("position", new THREE.Float32BufferAttribute(rubberPositions, 3));
        const rubberMaterial = new THREE.LineDashedMaterial({
          color: DRAWING_PREVIEW_COLOR,
          dashSize: 2,
          gapSize: 1,
          depthTest: false,
        });
        const rubberLine = new THREE.Line(rubberGeometry, rubberMaterial);
        rubberLine.computeLineDistances();
        // 軸ロックガイド線(同じDRAWING_FEEDBACK_RENDER_ORDER)より確実に手前に出す。
        rubberLine.renderOrder = DRAWING_FEEDBACK_RENDER_ORDER + 1;
        this.drawingGroup.add(rubberLine);
        this.drawingPreviewGeometries.push(rubberGeometry);
        this.drawingPreviewMaterials.push(rubberMaterial);
      }
    }

    if (this.drawingArcMode && this.drawingArcPending) {
      // 円弧の通過点(確定待ち)の位置にマーカーを表示する。
      const markers = buildSnapMarkerObjects(basis, "vertex", this.drawingArcPending);
      markers.forEach((obj) => {
        this.drawingGroup.add(obj);
        this.drawingPreviewGeometries.push(obj.geometry as THREE.BufferGeometry);
        this.drawingPreviewMaterials.push(obj.material as THREE.Material);
      });
    }

    if (hover?.axis && this.drawingPoints.length > 0) {
      const from = this.drawingPoints[this.drawingPoints.length - 1];
      const extent = Math.max(this.meshHalfExtent * 1.5, 50);
      const a: [number, number] =
        hover.axis === "horizontal" ? [from[0] - extent, from[1]] : [from[0], from[1] - extent];
      const b: [number, number] =
        hover.axis === "horizontal" ? [from[0] + extent, from[1]] : [from[0], from[1] + extent];
      const wa = planeLocalToWorld(basis, a[0], a[1]);
      const wb = planeLocalToWorld(basis, b[0], b[1]);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute([...wa, ...wb], 3));
      // opaqueにする(transparent:trueにすると別の描画パスに回り、renderOrderで意図した
      // 重なり順(ラバーバンドを上に)を制御できなくなるため)。
      const material = new THREE.LineBasicMaterial({ color: AXIS_GUIDE_COLOR, depthTest: false });
      const guide = new THREE.Line(geometry, material);
      guide.renderOrder = DRAWING_FEEDBACK_RENDER_ORDER;
      this.drawingGroup.add(guide);
      this.drawingPreviewGeometries.push(geometry);
      this.drawingPreviewMaterials.push(material);
    }

    if (hover?.snapKind) {
      const markers = buildSnapMarkerObjects(basis, hover.snapKind, hover.local);
      markers.forEach((obj) => {
        this.drawingGroup.add(obj);
        this.drawingPreviewGeometries.push(obj.geometry as THREE.BufferGeometry);
        this.drawingPreviewMaterials.push(obj.material as THREE.Material);
      });
    }
  }

  /** カーソル付近に現在のローカル座標(2点目以降は直前点からの長さ・角度も)を表示する。 */
  private updateCoordOverlay(px: number, py: number, local: [number, number]) {
    const [u, v] = local;
    let text = `(${u.toFixed(1)}, ${v.toFixed(1)})`;
    if (this.drawingPoints.length > 0) {
      const [lu, lv] = this.drawingPoints[this.drawingPoints.length - 1];
      const len = Math.hypot(u - lu, v - lv);
      let angleDeg = (Math.atan2(v - lv, u - lu) * 180) / Math.PI;
      if (angleDeg < 0) angleDeg += 360;
      text += ` L=${len.toFixed(1)}mm ∠${angleDeg.toFixed(0)}°`;
    }
    this.coordOverlayEl.textContent = text;
    this.coordOverlayEl.style.left = `${px + 14}px`;
    this.coordOverlayEl.style.top = `${py + 14}px`;
    this.coordOverlayEl.style.display = "block";
  }

  /**
   * 矩形/円/スロット/正多角形ツール(2クリック)のプレビュー(Phase 14/17)。1クリック目
   * (drawingPoints[0])がまだ無ければスナップマーカーのみ、あればコーナー1/中心からhoverまでの
   * 破線ループ(スロットは非ループの輪郭だが同じヘルパーで閉じても実害無いため流用)を描く。
   */
  private updateShapePreview(hover?: { local: [number, number]; snapKind: SnapKind | null; axis: AxisLockKind }) {
    const basis = this.drawingBasis;
    if (!basis) return;

    if (this.drawingPoints.length > 0 && hover) {
      const first = this.drawingPoints[0];
      let localPoints: [number, number][];
      if (this.drawingShape === "rectangle") {
        localPoints = rectangleCornerPoints(first, hover.local);
      } else if (this.drawingShape === "circle") {
        localPoints = circleLocalPoints(first, circleRadiusFromPoints(first, hover.local), CIRCLE_SEGMENTS);
      } else if (this.drawingShape === "slot") {
        localPoints = slotOutlinePoints(first, hover.local, this.drawingSlotWidth);
      } else {
        const { radius, rotation } = regularPolygonFromCenterVertex(first, hover.local);
        localPoints = regularPolygonVertices(first, radius, this.drawingPolygonSides, rotation);
      }
      this.addDashedPreviewLoop(basis, localPoints);
    }

    if (hover?.snapKind) {
      const markers = buildSnapMarkerObjects(basis, hover.snapKind, hover.local);
      markers.forEach((obj) => {
        this.drawingGroup.add(obj);
        this.drawingPreviewGeometries.push(obj.geometry as THREE.BufferGeometry);
        this.drawingPreviewMaterials.push(obj.material as THREE.Material);
      });
    }
  }

  /** 破線のLineLoopをdrawingGroupに追加する(矩形/円プレビュー用)。 */
  private addDashedPreviewLoop(basis: PlaneBasis, localPoints: [number, number][]) {
    const worldPts = localPoints.map(([u, v]) => planeLocalToWorld(basis, u, v));
    const positions = new Float32Array(worldPts.length * 3);
    worldPts.forEach((p, i) => positions.set(p, i * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineDashedMaterial({
      color: DRAWING_PREVIEW_COLOR,
      dashSize: 2,
      gapSize: 1,
      depthTest: false,
    });
    const loop = new THREE.LineLoop(geometry, material);
    loop.computeLineDistances();
    loop.renderOrder = DRAWING_FEEDBACK_RENDER_ORDER;
    this.drawingGroup.add(loop);
    this.drawingPreviewGeometries.push(geometry);
    this.drawingPreviewMaterials.push(material);
  }

  /**
   * 矩形/円/スロット/正多角形ツール(2クリック)のカーソル付近ライブ表示(Phase 14/17)。
   * 1クリック目前はローカル座標のみ、1クリック目後は矩形なら「幅×高さ」、円なら「R半径」、
   * スロットなら「L長さ(幅固定)」、正多角形なら「R半径(辺数固定)」を表示する。
   */
  private updateShapeCoordOverlay(px: number, py: number, first: [number, number] | null, current: [number, number]) {
    let text: string;
    if (!first) {
      text = `(${current[0].toFixed(1)}, ${current[1].toFixed(1)})`;
    } else if (this.drawingShape === "rectangle") {
      const w = Math.abs(current[0] - first[0]);
      const h = Math.abs(current[1] - first[1]);
      text = `${w.toFixed(1)} × ${h.toFixed(1)} mm`;
    } else if (this.drawingShape === "circle") {
      text = `R${circleRadiusFromPoints(first, current).toFixed(1)} mm`;
    } else if (this.drawingShape === "slot") {
      const len = circleRadiusFromPoints(first, current);
      text = `L${len.toFixed(1)} × W${this.drawingSlotWidth.toFixed(1)} mm`;
    } else {
      const { radius } = regularPolygonFromCenterVertex(first, current);
      text = `${this.drawingPolygonSides}角形 R${radius.toFixed(1)} mm`;
    }
    this.coordOverlayEl.textContent = text;
    this.coordOverlayEl.style.left = `${px + 14}px`;
    this.coordOverlayEl.style.top = `${py + 14}px`;
    this.coordOverlayEl.style.display = "block";
  }

  /** プレビュー線をsceneから取り除き、リソースを解放する。 */
  private clearDrawingPreview() {
    while (this.drawingGroup.children.length > 0) {
      this.drawingGroup.remove(this.drawingGroup.children[0]);
    }
    this.drawingPreviewGeometries.forEach((g) => g.dispose());
    this.drawingPreviewMaterials.forEach((m) => m.dispose());
    this.drawingPreviewGeometries = [];
    this.drawingPreviewMaterials = [];
  }

  /**
   * 現在のカメラでワールド座標をcanvas内ピクセル座標(左上が原点)に投影する。
   * E2Eの`window.__cadViewerDebug.projectPoint`と、描画モードの始点近傍判定の両方から使う。
   */
  projectPoint(world: Tuple3): { x: number; y: number } | null {
    const vec = new THREE.Vector3(world[0], world[1], world[2]);
    vec.project(this.camera);
    if (!Number.isFinite(vec.x) || !Number.isFinite(vec.y)) return null;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    return {
      x: ((vec.x + 1) / 2) * width,
      y: ((1 - vec.y) / 2) * height,
    };
  }

  dispose() {
    cancelAnimationFrame(this.animationFrameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("click", this.handleClick);
    this.renderer.domElement.removeEventListener("dblclick", this.handleSegmentDoubleClick);
    this.renderer.domElement.removeEventListener("mousemove", this.handleDrawingMouseMove);
    this.renderer.domElement.removeEventListener("mouseleave", this.handleMouseLeave);
    window.removeEventListener("keydown", this.handleKeyDown);
    this.frameCallbacks.clear();
    this.controls.dispose();
    if (this.mesh) {
      this.mesh.geometry.dispose();
      const material = this.mesh.material;
      if (Array.isArray(material)) {
        material.forEach((m) => m.dispose());
      } else {
        material.dispose();
      }
    }
    if (this.edgesMesh) {
      this.edgesMesh.geometry.dispose();
      (this.edgesMesh.material as THREE.Material).dispose();
    }
    this.clearSketchOverlay();
    this.clearDrawingPreview();
    this.referencePlaneEntries.forEach((entry) => {
      entry.mesh.geometry.dispose();
      entry.material.dispose();
    });
    if (import.meta.env.DEV && window.__cadViewerDebug) {
      delete window.__cadViewerDebug;
    }
    this.container.removeChild(this.coordOverlayEl);
    this.container.removeChild(this.lengthInputEl);
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
