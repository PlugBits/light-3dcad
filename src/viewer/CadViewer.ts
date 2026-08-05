import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { FaceGroup, MeshData } from "../protocol/messages";

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
  private raycaster = new THREE.Raycaster();
  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private animationFrameId = 0;

  constructor(container: HTMLElement) {
    this.container = container;

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

    this.renderer.domElement.addEventListener("click", this.handleClick);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.animate();
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

  private handleClick = (event: MouseEvent) => {
    if (!this.mesh) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );

    this.raycaster.setFromCamera(pointer, this.camera);
    const intersections = this.raycaster.intersectObject(this.mesh, false);
    if (intersections.length === 0) return;

    const triangleIndex = intersections[0].faceIndex;
    if (triangleIndex == null) return;

    // faceIndexは三角形番号。triangles配列上のオフセット(triangleIndex*3)が
    // どのfaceGroup範囲に含まれるかを線形探索してB-Rep面IDを逆引きする。
    const triangleOffset = triangleIndex * 3;
    const group = this.faceGroups.find(
      (g) => triangleOffset >= g.start && triangleOffset < g.start + g.count,
    );

    if (group) {
      // eslint-disable-next-line no-console
      console.log("[CadViewer] face clicked, faceId =", group.faceId);
    } else {
      // eslint-disable-next-line no-console
      console.log("[CadViewer] face clicked, but no matching faceGroup for triangle", triangleIndex);
    }
  };

  setMesh(data: MeshData) {
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
    geometry.setAttribute("position", new THREE.BufferAttribute(data.vertices, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.triangles, 1));

    // faceGroupsをBufferGeometryのgroupとして登録する(ハイライトは行わないが
    // materialIndexを差し替えられるように単一マテリアルを複製しておく)。
    geometry.clearGroups();
    const baseColor = 0x5b8def;
    const materials: THREE.Material[] = [];
    data.faceGroups.forEach((group, materialIndex) => {
      geometry.addGroup(group.start, group.count, materialIndex);
      materials.push(
        new THREE.MeshStandardMaterial({ color: baseColor, side: THREE.DoubleSide }),
      );
    });

    this.faceGroups = data.faceGroups;

    this.mesh = new THREE.Mesh(geometry, materials.length > 0 ? materials : new THREE.MeshStandardMaterial({ color: baseColor }));
    this.scene.add(this.mesh);
  }

  dispose() {
    cancelAnimationFrame(this.animationFrameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("click", this.handleClick);
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
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
