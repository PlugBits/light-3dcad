import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { FeatureId, SketchEntity } from "../model/types";
import type { FaceGroup, FaceInfo, MeshData } from "../protocol/messages";

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

declare global {
  interface Window {
    __cadViewerDebug?: {
      sketchLineCount: () => number;
      gridVisible: () => boolean;
    };
  }
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

/** rectangle/circleエンティティのローカル2D頂点列(閉ループ)を返す。 */
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
  const [cx, cy] = entity.center;
  const points: [number, number][] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i += 1) {
    const t = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    points.push([cx + entity.radius * Math.cos(t), cy + entity.radius * Math.sin(t)]);
  }
  return points;
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
  const material = new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: GRID_OPACITY });
  return new THREE.LineSegments(geometry, material);
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

    this.renderer.domElement.addEventListener("click", this.handleClick);
    window.addEventListener("keydown", this.handleKeyDown);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.animate();

    // E2Eテストからスケッチオーバーレイの描画結果を検証するためのフック(開発ビルドのみ)。
    if (import.meta.env.DEV) {
      window.__cadViewerDebug = {
        sketchLineCount: () => this.sketchLineCount,
        gridVisible: () => this.sketchGridBuilt && this.sketchOverlayGroup.visible,
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
    if (event.key === "Escape") {
      this.clearSelection();
    }
  };

  private handleClick = (event: MouseEvent) => {
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
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: !isSelected,
        opacity: isSelected ? 1 : 0.5,
        linewidth: isSelected ? 2 : 1,
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
        this.sketchOverlayGroup.add(line);
        this.sketchLineCount += 1;
      }

      if (isSelected) {
        const grid = buildPlaneGrid(entry, this.meshHalfExtent * 1.2);
        this.sketchOverlayGeometries.push(grid.geometry);
        this.sketchOverlayMaterials.push(grid.material as THREE.Material);
        this.sketchOverlayGroup.add(grid);
        this.sketchGridBuilt = true;
      }
    }
  }

  dispose() {
    cancelAnimationFrame(this.animationFrameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("click", this.handleClick);
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
    if (import.meta.env.DEV && window.__cadViewerDebug) {
      delete window.__cadViewerDebug;
    }
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
