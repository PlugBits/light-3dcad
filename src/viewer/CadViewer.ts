import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { FeatureId, SketchEntity } from "../model/types";
import type { FaceGroup, FaceInfo, MeshData } from "../protocol/messages";
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

const BASE_COLOR = 0x5b8def;
/** 選択面のハイライト色(通常より明るい黄系)。 */
const HIGHLIGHT_COLOR = 0xffd54f;

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
  // polygon: 頂点列そのものが閉ループ(LineLoopが最後→最初を自動的に結ぶ)。
  return entity.points;
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
  private faceGroups: FaceGroup[] = [];
  private faceInfo: FaceInfo[] = [];
  private materials: THREE.MeshStandardMaterial[] = [];
  private selectedGroupIndex: number | null = null;
  private raycaster = new THREE.Raycaster();
  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private animationFrameId = 0;
  /** 面がクリックで選択/解除されたときに呼ばれる(解除時はnull)。 */
  private onFaceSelect?: (face: FaceInfo | null) => void;
  /** 現在のメッシュのバウンディングボックスから求めた半径目安(mm)。グリッド範囲の基準に使う。 */
  private meshHalfExtent = 50;

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
  private drawingBasis: PlaneBasis | null = null;
  /** 「スナップ」チェックボックスの状態(グリッド+点スナップ全体のON/OFF)。Shift押下中はこれとは別に一時無効化される。 */
  private drawingSnap = true;
  /** 描画対象スケッチに既にある図形(vertex/center/midpoint候補の収集元)。startPolygonDrawing()で設定する。 */
  private drawingEntities: SketchEntity[] = [];
  /** 確定済み頂点列(ローカル2D座標、スナップ適用済み)。 */
  private drawingPoints: [number, number][] = [];
  private drawingCallbacks: PolygonDrawingCallbacks | null = null;
  /** プレビュー線(確定済みセグメント+ラバーバンド+軸ロックガイド+スナップマーカー)を乗せるグループ。showSketchesトグルとは独立して常に表示する。 */
  private drawingGroup: THREE.Group;
  private drawingPreviewGeometries: THREE.BufferGeometry[] = [];
  private drawingPreviewMaterials: THREE.Material[] = [];
  /** 描画モード中、カーソル付近に現在のローカル座標・長さ・角度を表示するHTMLオーバーレイ。 */
  private coordOverlayEl: HTMLDivElement;

  constructor(container: HTMLElement, onFaceSelect?: (face: FaceInfo | null) => void) {
    this.container = container;
    this.onFaceSelect = onFaceSelect;

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

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(1, 1, 1);
    this.scene.add(ambient, directional);

    const grid = new THREE.GridHelper(200, 20);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    this.sketchOverlayGroup = new THREE.Group();
    this.scene.add(this.sketchOverlayGroup);

    this.drawingGroup = new THREE.Group();
    this.scene.add(this.drawingGroup);

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

    this.renderer.domElement.addEventListener("click", this.handleClick);
    this.renderer.domElement.addEventListener("mousemove", this.handleDrawingMouseMove);
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
  };

  private handleResize() {
    const { clientWidth, clientHeight } = this.container;
    if (clientWidth === 0 || clientHeight === 0) return;
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight);
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (this.drawingActive) {
      if (event.key === "Escape") {
        this.cancelPolygonDrawing();
      } else if (event.key === "Enter") {
        this.finishPolygonDrawing();
      }
      return;
    }
    if (event.key === "Escape") {
      this.clearSelection();
    }
  };

  private handleClick = (event: MouseEvent) => {
    if (this.drawingActive) {
      this.handlePolygonClick(event);
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

  /** materialIndex = groupIndex のマテリアル色をハイライト色に、前回選択分は基本色に戻す。 */
  private selectGroup(groupIndex: number) {
    if (this.selectedGroupIndex != null) {
      this.materials[this.selectedGroupIndex]?.color.setHex(BASE_COLOR);
    }
    this.selectedGroupIndex = groupIndex;
    this.materials[groupIndex]?.color.setHex(HIGHLIGHT_COLOR);
  }

  /** 面の選択を解除し、ハイライトを元の色に戻す。onFaceSelect(null)を呼ぶ。 */
  clearSelection() {
    if (this.selectedGroupIndex != null) {
      this.materials[this.selectedGroupIndex]?.color.setHex(BASE_COLOR);
      this.selectedGroupIndex = null;
      this.onFaceSelect?.(null);
    }
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
      materials.push(
        new THREE.MeshStandardMaterial({ color: BASE_COLOR, side: THREE.DoubleSide }),
      );
    });

    this.faceGroups = data.faceGroups;
    this.faceInfo = faceInfo;
    this.materials = materials;
    // メッシュが再生成されるとfaceGroupsのインデックス対応も変わりうるため選択状態はリセットする。
    // (ストア側の選択面はfaceInfoに残っているかどうかで呼び出し元が判断する)
    this.selectedGroupIndex = null;

    this.mesh = new THREE.Mesh(geometry, materials.length > 0 ? materials : new THREE.MeshStandardMaterial({ color: BASE_COLOR }));
    this.scene.add(this.mesh);

    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox;
    if (bbox) {
      const size = new THREE.Vector3();
      bbox.getSize(size);
      this.meshHalfExtent = Math.max(size.x, size.y, size.z, 20) / 2;
    }
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
   * 指定平面上での線描画モードを開始する。以後のクリックは面選択でなく頂点追加として扱われ、
   * カーソルはcrosshairになる。基底(basis)はWorkerが返したsketchPlanesの値をそのまま渡すこと
   * (UI側で独自に再計算しない)。existingEntitiesは対象スケッチに既にある図形で、
   * 点スナップ候補(頂点・中心・中点)の収集元として使う。
   */
  startPolygonDrawing(basis: PlaneBasis, snap: boolean, existingEntities: SketchEntity[], callbacks: PolygonDrawingCallbacks) {
    this.cancelPolygonDrawing();
    this.clearSelection();
    this.drawingActive = true;
    this.drawingBasis = basis;
    this.drawingSnap = snap;
    this.drawingEntities = existingEntities;
    this.drawingPoints = [];
    this.drawingCallbacks = callbacks;
    this.renderer.domElement.style.cursor = "crosshair";
  }

  /** 描画モード中のスナップ(グリッド+点スナップ)有効/無効をリアルタイムに切り替える。軸ロックはこれと独立。 */
  setPolygonDrawingSnap(enabled: boolean) {
    this.drawingSnap = enabled;
  }

  isPolygonDrawingActive(): boolean {
    return this.drawingActive;
  }

  /** 描画中の頂点列を破棄してモードを終了する(onCancelが呼ばれる)。非アクティブなら何もしない。 */
  cancelPolygonDrawing() {
    if (!this.drawingActive) return;
    const callbacks = this.drawingCallbacks;
    this.exitDrawingState();
    callbacks?.onCancel();
  }

  /** 頂点3点以上であれば閉じて確定する(onCompleteが呼ばれる)。非アクティブ・頂点不足時は何もしない。 */
  private finishPolygonDrawing() {
    if (!this.drawingActive || this.drawingPoints.length < 3) return;
    const points = [...this.drawingPoints];
    const callbacks = this.drawingCallbacks;
    this.exitDrawingState();
    callbacks?.onComplete(points);
  }

  /** 描画モードの内部状態・プレビュー・カーソルをリセットする(コールバックは呼ばない)。 */
  private exitDrawingState() {
    this.drawingActive = false;
    this.drawingBasis = null;
    this.drawingEntities = [];
    this.drawingPoints = [];
    this.drawingCallbacks = null;
    this.renderer.domElement.style.cursor = "";
    this.clearDrawingPreview();
    this.coordOverlayEl.style.display = "none";
  }

  /** 描画モード中のクリックをレイキャストしてスケッチ平面上のローカル2D座標に変換し、頂点を追加する。 */
  private handlePolygonClick(event: MouseEvent) {
    if (!this.drawingBasis) return;
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

  /** マウス移動時、描画モード中であればスナップ・軸ロックを適用したラバーバンド・ガイド・座標表示を更新する。 */
  private handleDrawingMouseMove = (event: MouseEvent) => {
    if (!this.drawingActive || !this.drawingBasis) return;
    const basis = this.drawingBasis;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    const hit = this.raycastDrawingPlane(basis, px, py, rect);
    if (!hit) {
      this.updateDrawingPreview();
      this.coordOverlayEl.style.display = "none";
      return;
    }
    const resolved = this.resolveDrawingCursor(basis, hit, event.shiftKey);
    this.updateDrawingPreview({ local: resolved.point, snapKind: resolved.snapKind, axis: resolved.axis });
    this.updateCoordOverlay(px, py, resolved.point);
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
    const axisLockEnabled = !shiftHeld;
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
    window.removeEventListener("keydown", this.handleKeyDown);
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
    this.clearSketchOverlay();
    this.clearDrawingPreview();
    if (import.meta.env.DEV && window.__cadViewerDebug) {
      delete window.__cadViewerDebug;
    }
    this.container.removeChild(this.coordOverlayEl);
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
