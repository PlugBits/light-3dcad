import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { FeatureId, SketchEntity } from "../model/types";
import type { FaceGroup, FaceInfo, MeshData } from "../protocol/messages";
import { polygonOutlinePoints } from "../sketch/polygonOutline";
import { circleRadiusFromPoints, rectangleCornerPoints } from "../sketch/shapeFromPoints";
import {
  collectSketchSnapCandidates,
  ORIGIN_CANDIDATE,
  pointsToVertexCandidates,
  resolveDrawingPoint,
  type AxisLockKind,
  type ResolvedDrawingPoint,
  type SnapCandidate,
  type SnapKind,
} from "../sketch/snapping";

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
  /** 3点以上の頂点列で閉じて確定したときに呼ばれる(ローカル2D座標、スナップ適用済み)。 */
  onComplete: (points: [number, number][]) => void;
  /** Escapeキーまたはcancel呼び出しで中断したときに呼ばれる(頂点0でも呼ばれうる)。 */
  onCancel: () => void;
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

/** 描画モードの対象図形種別。polygonは既存の複数頂点線描画、rectangle/circleは2クリック作図(Phase 14)。 */
type DrawingShapeKind = "polygon" | "rectangle" | "circle";

declare global {
  interface Window {
    __cadViewerDebug?: {
      sketchLineCount: () => number;
      gridVisible: () => boolean;
      /** 現在のカメラでワールド座標をcanvas内ピクセル座標に投影する(開発ビルド限定、E2E用)。 */
      projectPoint: (world: Tuple3) => { x: number; y: number } | null;
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

/** rectangle/circle/polygonエンティティのローカル2D頂点列(閉ループ)を返す。 */
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
  // polygon: フィレット/面取り(Phase 11)を適用した輪郭をポリライン近似する。
  // corners未指定時は points がそのまま返る(既存の直線LineLoopと同じ結果)。
  // LineLoopが最後→最初を自動的に結ぶため、閉じる辺は明示しない。
  return polygonOutlinePoints(entity.points, entity.corners);
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
    if (this.drawingActive) {
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
        this.finishPolygonDrawing();
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
      if (this.drawingShape === "polygon" && this.drawingPoints.length > 0 && /^[0-9.]$/.test(event.key)) {
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

    this.drawingPoints.push(next);
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
    if (this.drawingActive) {
      if (this.drawingShape === "polygon") {
        this.handlePolygonClick(event);
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
  private beginDrawing(shape: DrawingShapeKind, basis: PlaneBasis, snap: boolean, existingEntities: SketchEntity[]) {
    this.cancelPolygonDrawing();
    this.clearSelection();
    this.setHoverGroup(null);
    this.drawingActive = true;
    this.drawingShape = shape;
    this.drawingBasis = basis;
    this.drawingSnap = snap;
    this.drawingEntities = existingEntities;
    this.drawingPoints = [];
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
    this.exitDrawingState();
    if (shape === "polygon") polygonCallbacks?.onCancel();
    else if (shape === "rectangle") rectCallbacks?.onCancel();
    else circleCallbacks?.onCancel();
  }

  /** 頂点3点以上であれば閉じて確定する(onCompleteが呼ばれる)。非アクティブ・頂点不足時は何もしない。 */
  private finishPolygonDrawing() {
    if (!this.drawingActive || this.drawingShape !== "polygon" || this.drawingPoints.length < 3) return;
    const points = [...this.drawingPoints];
    const callbacks = this.polygonCallbacks;
    this.exitDrawingState();
    callbacks?.onComplete(points);
  }

  /**
   * 矩形/円ツールの2クリック目を確定する(onCompleteが呼ばれる)。始点と終点が実質同一点
   * (縮退)の場合は無視して描画モードを継続する(誤クリックで幅・高さ0の図形ができるのを防ぐ)。
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
    }
  }

  /** 描画モードの内部状態・プレビュー・カーソルをリセットする(コールバックは呼ばない)。 */
  private exitDrawingState() {
    this.drawingActive = false;
    this.drawingBasis = null;
    this.drawingEntities = [];
    this.drawingPoints = [];
    this.polygonCallbacks = null;
    this.rectCallbacks = null;
    this.circleCallbacks = null;
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

  /** 描画モード中のクリックをレイキャストしてスケッチ平面上のローカル2D座標に変換し、頂点を追加する。 */
  private handlePolygonClick(event: MouseEvent) {
    if (!this.drawingBasis) return;
    // マウスクリックによる頂点確定は、入力中だった数値長さ(未確定)を破棄する。
    this.resetLengthInput();
    const basis = this.drawingBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    // 始点付近(スクリーン距離10px程度以内)のクリックは閉じて確定する扱いにする(スナップ判定より優先)。
    if (this.drawingPoints.length >= 3) {
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
    this.drawingPoints.push(resolved.point);
    this.updateDrawingPreview();
    this.updateCoordOverlay(px, py, resolved.point);
  }

  /**
   * マウス移動時、描画モード中であればスナップ・軸ロックを適用したラバーバンド・ガイド・座標表示を
   * 更新し、描画モード外であれば面ホバーハイライトを更新する。
   */
  private handleDrawingMouseMove = (event: MouseEvent) => {
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
    if (this.drawingShape === "polygon") {
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
    // (特に矩形は)幅または高さが0に縮退しうるため適用しない(polygonのみ)。
    const axisLockEnabled = !shiftHeld && this.drawingShape === "polygon";
    const tolerance = this.pxToMm(SNAP_TOLERANCE_PX, hitWorld);
    const candidates: SnapCandidate[] = snapEnabled
      ? [
          ...collectSketchSnapCandidates(this.drawingEntities),
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
    if (this.drawingShape !== "polygon") {
      this.updateShapePreview(hover);
      return;
    }
    const basis = this.drawingBasis;

    if (this.drawingPoints.length > 0) {
      const worldPts = this.drawingPoints.map(([u, v]) => planeLocalToWorld(basis, u, v));
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
        const last = worldPts[worldPts.length - 1];
        const hoverWorld = planeLocalToWorld(basis, hover.local[0], hover.local[1]);
        const rubberGeometry = new THREE.BufferGeometry();
        rubberGeometry.setAttribute("position", new THREE.Float32BufferAttribute([...last, ...hoverWorld], 3));
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
   * 矩形/円ツール(2クリック)のプレビュー(Phase 14)。1クリック目(drawingPoints[0])がまだ無ければ
   * スナップマーカーのみ、あればコーナー1/中心からhoverまでの矩形/円の破線ループを描く。
   */
  private updateShapePreview(hover?: { local: [number, number]; snapKind: SnapKind | null; axis: AxisLockKind }) {
    const basis = this.drawingBasis;
    if (!basis) return;

    if (this.drawingPoints.length > 0 && hover) {
      const first = this.drawingPoints[0];
      const localPoints =
        this.drawingShape === "rectangle"
          ? rectangleCornerPoints(first, hover.local)
          : circleLocalPoints(first, circleRadiusFromPoints(first, hover.local), CIRCLE_SEGMENTS);
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
   * 矩形/円ツール(2クリック)のカーソル付近ライブ表示(Phase 14)。1クリック目前はローカル座標のみ、
   * 1クリック目後は矩形なら「幅×高さ」、円なら「R半径」を表示する。
   */
  private updateShapeCoordOverlay(px: number, py: number, first: [number, number] | null, current: [number, number]) {
    let text: string;
    if (!first) {
      text = `(${current[0].toFixed(1)}, ${current[1].toFixed(1)})`;
    } else if (this.drawingShape === "rectangle") {
      const w = Math.abs(current[0] - first[0]);
      const h = Math.abs(current[1] - first[1]);
      text = `${w.toFixed(1)} × ${h.toFixed(1)} mm`;
    } else {
      text = `R${circleRadiusFromPoints(first, current).toFixed(1)} mm`;
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
