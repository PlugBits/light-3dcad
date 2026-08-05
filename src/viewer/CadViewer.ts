import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { MeshData } from "../protocol/messages";

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

    const material = new THREE.MeshStandardMaterial({ color: 0x5b8def, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);
  }

  dispose() {
    cancelAnimationFrame(this.animationFrameId);
    this.resizeObserver.disconnect();
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
