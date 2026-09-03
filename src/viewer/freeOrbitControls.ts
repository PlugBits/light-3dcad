// SolidWorks風の自由回転(トラックボール式)カメラコントロール(Phase 43)。
//
// 従来はthree.jsのOrbitControls(examples/jsm)を使っていたが、これは内部でconstructor時点の
// camera.upから求めた固定quaternionを基準に球面座標(theta/phi、phiは(0,π)にクランプ)を
// 管理する。本アプリはsetStandardView()/lookAtPlane()でcamera.upを標準ビューやスケッチ平面ごとに
// 動的に切り替えるため、その後に右ドラッグで回転させると「見た目上どこか」でphiクランプに
// 引っかかり、極付近で詰まる・反転するように見える不具合があった(Phase 43でユーザー報告)。
//
// 本実装はワールド固定の上方向を一切参照しない、アークボール/トラックボール方式に置き換える:
// 「注視点からカメラへのオフセットベクトル」と「カメラの現在のupベクトル」の組を状態として持ち、
// 水平ドラッグ=現在のup軸まわりの回転(yaw)、垂直ドラッグ=現在のright軸まわりの回転(pitch)を
// クォータニオンで適用する。yawはup自身を軸に回すためupは不変、pitchはoffsetとupを両方
// 同じクォータニオンで回すため、2つの直交関係は永久に保たれる(=特異点が生じない)。
// 結果として、真上/真下を何度またいでも詰まらず・反転せず、360度自由に連続回転できる。
//
// OrbitControlsのAPIのうち本アプリが実際に使っている部分(target/enabled/update()/dispose())
// のみを最小実装する(ダンピングやタッチ操作は元々未使用だったため実装しない)。
//
// マウス操作マッピング(Phase 49で中ボタン系を追加、既存の左/右ボタンの挙動はそのまま):
//   左ボタンドラッグ           = 回転(既存)
//   右ボタンドラッグ           = パン(既存、右クリックの既定コンテキストメニューは抑止)
//   中ボタンドラッグ           = 回転(SolidWorks標準、Phase 49で追加。ブラウザの中クリック
//                                 自動スクロールUIが出ないようmousedown時にpreventDefaultする)
//   Shift+中ボタンドラッグ     = パン(SolidWorks標準、Phase 49で追加)
//   ホイール                   = カーソル位置中心のズーム(Phase 49、handleWheel参照。
//                                 従来は常に注視点中心のズームだった)
import * as THREE from "three";

import { computeZoomToCursor } from "./zoomToCursor";

const EPS = 1e-6;
/** マウスドラッグでの回転感度(domElementの高さ全体の移動でおよそ半回転になる係数)。 */
const ROTATE_RADIANS_PER_HEIGHT = Math.PI;

export class FreeOrbitControls {
  /** 注視点(ワールド座標)。setStandardView()等が直接copy()で書き換える。 */
  readonly target = new THREE.Vector3();
  /** falseの間はマウス操作を一切受け付けない(他ツールのドラッグ中に外側から切り替える)。 */
  enabled = true;
  rotateSpeed = 1;
  panSpeed = 1;
  zoomSpeed = 1;
  minDistance = 0.01;
  maxDistance = Infinity;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private dragMode: "rotate" | "pan" | null = null;
  private lastX = 0;
  private lastY = 0;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    domElement.addEventListener("mousedown", this.handleMouseDown);
    domElement.addEventListener("wheel", this.handleWheel, { passive: false });
    domElement.addEventListener("contextmenu", this.handleContextMenu);
  }

  /**
   * 描画ループから毎フレーム呼ぶ(元のOrbitControls.update()と同じ役割)。ドラッグ操作自体は
   * イベントハンドラ側でcamera.position/upを直接更新済みなので、ここではcamera.lookAt(target)を
   * 呼んでカメラの向きを注視点・upベクトルに追従させるだけでよい(setStandardView()等が
   * camera.position/upを直接書き換えた直後に呼ぶ用途も兼ねる)。
   */
  update() {
    this.camera.lookAt(this.target);
  }

  dispose() {
    this.domElement.removeEventListener("mousedown", this.handleMouseDown);
    this.domElement.removeEventListener("wheel", this.handleWheel);
    this.domElement.removeEventListener("contextmenu", this.handleContextMenu);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);
  }

  private handleContextMenu = (event: MouseEvent) => {
    // 右ドラッグ=パンなので、右クリックの既定コンテキストメニューは抑止する(元のOrbitControls互換)。
    event.preventDefault();
  };

  private handleMouseDown = (event: MouseEvent) => {
    if (!this.enabled) return;
    if (event.button === 0) {
      this.dragMode = "rotate";
    } else if (event.button === 2) {
      this.dragMode = "pan";
    } else if (event.button === 1) {
      // 中ボタン(Phase 49): SolidWorks標準の回転、Shift併用でパン。ブラウザの中クリック
      // 自動スクロールUI(丸いアイコン)がポップアップしないよう既定動作を止める。
      event.preventDefault();
      this.dragMode = event.shiftKey ? "pan" : "rotate";
    } else {
      return;
    }
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("mouseup", this.handleMouseUp);
  };

  private handleMouseMove = (event: MouseEvent) => {
    if (!this.enabled || !this.dragMode) return;
    const deltaX = event.clientX - this.lastX;
    const deltaY = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (deltaX === 0 && deltaY === 0) return;
    if (this.dragMode === "rotate") this.rotate(deltaX, deltaY);
    else this.pan(deltaX, deltaY);
  };

  private handleMouseUp = () => {
    this.dragMode = null;
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);
  };

  private handleWheel = (event: WheelEvent) => {
    if (!this.enabled) return;
    event.preventDefault();
    const normalizedDelta = Math.abs(event.deltaY * 0.01);
    const scale = Math.pow(0.95, this.zoomSpeed * normalizedDelta);
    // deltaY > 0 (下スクロール) = ズームアウト、< 0 = ズームイン(標準的なホイール操作感)。
    this.dollyToCursor(event.deltaY > 0 ? 1 / scale : scale, event.clientX, event.clientY);
  };

  /**
   * カーソル位置中心のズーム(Phase 49)。カーソルを通るワールド空間のレイを求め、実際の平行移動+
   * 距離変更の計算はzoomToCursor.ts(three.js非依存の純粋関数、Vitestで単体テスト済み)に委ねる。
   * domElementの矩形が取得できない(非表示など)場合はdolly()(注視点中心)にフォールバックする。
   */
  private dollyToCursor(scale: number, clientX: number, clientY: number) {
    const offset = this.camera.position.clone().sub(this.target);
    const newDistance = THREE.MathUtils.clamp(offset.length() / scale, this.minDistance, this.maxDistance);

    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.dolly(scale);
      return;
    }

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    // NDC(x,y,0.5)をワールド座標へ逆投影すると、カメラ位置からそのスクリーン位置を通るレイ上の
    // 1点が得られる(three.jsのRaycaster.setFromCamera()と同じ手法)。
    const rayPoint = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(this.camera);
    const rayOrigin = this.camera.position.clone();
    const rayDir = rayPoint.clone().sub(rayOrigin);

    const result = computeZoomToCursor({
      cameraPos: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.target.x, this.target.y, this.target.z],
      rayOrigin: [rayOrigin.x, rayOrigin.y, rayOrigin.z],
      rayDir: [rayDir.x, rayDir.y, rayDir.z],
      newDistance,
    });
    this.camera.position.set(result.cameraPos[0], result.cameraPos[1], result.cameraPos[2]);
    this.target.set(result.target[0], result.target[1], result.target[2]);
    this.camera.lookAt(this.target);
  }

  /**
   * トラックボール式回転。offset(target→camera)とcamera.upを、水平方向はup軸まわり(yaw)、
   * 垂直方向はright軸まわり(pitch)にクォータニオンで回す。up自体もpitchと一緒に回すことで、
   * offsetとupの直交関係(≒視線方向とupが90°)が常に保たれ、極付近の特異点が生じない。
   */
  private rotate(deltaX: number, deltaY: number) {
    const height = Math.max(this.domElement.clientHeight, 1);
    const yawAngle = -(deltaX / height) * ROTATE_RADIANS_PER_HEIGHT * this.rotateSpeed;
    const pitchAngle = -(deltaY / height) * ROTATE_RADIANS_PER_HEIGHT * this.rotateSpeed;

    const offset = this.camera.position.clone().sub(this.target);
    const up = this.camera.up.clone().normalize();

    if (Math.abs(yawAngle) > EPS) {
      offset.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(up, yawAngle));
    }

    const forward = offset.clone().negate().normalize();
    const right = new THREE.Vector3().crossVectors(forward, up);
    if (right.lengthSq() < EPS) {
      // forwardとupがほぼ平行(理論上は起こらないはずだが、丸め誤差対策のフォールバック)。
      right.set(1, 0, 0);
    } else {
      right.normalize();
    }

    if (Math.abs(pitchAngle) > EPS) {
      const pitchQuat = new THREE.Quaternion().setFromAxisAngle(right, pitchAngle);
      offset.applyQuaternion(pitchQuat);
      up.applyQuaternion(pitchQuat);
    }

    this.camera.position.copy(this.target).add(offset);
    this.camera.up.copy(up);
    this.camera.lookAt(this.target);
  }

  /** 画面平面(right/up)方向へカメラと注視点を同時に平行移動する(OrbitControlsのscreenSpacePanningと同じ考え方)。 */
  private pan(deltaX: number, deltaY: number) {
    const height = Math.max(this.domElement.clientHeight, 1);
    const offset = this.camera.position.clone().sub(this.target);
    const targetDistance = offset.length() * Math.tan((this.camera.fov / 2) * (Math.PI / 180));

    const forward = offset.clone().negate().normalize();
    const up = this.camera.up.clone().normalize();
    const right = new THREE.Vector3().crossVectors(forward, up);
    if (right.lengthSq() < EPS) right.set(1, 0, 0);
    else right.normalize();
    const trueUp = new THREE.Vector3().crossVectors(right, forward).normalize();

    const panRight = ((-2 * deltaX * targetDistance) / height) * this.panSpeed;
    const panUp = ((2 * deltaY * targetDistance) / height) * this.panSpeed;

    const move = right.multiplyScalar(panRight).add(trueUp.multiplyScalar(panUp));
    this.camera.position.add(move);
    this.target.add(move);
    this.camera.lookAt(this.target);
  }

  /** 注視点からの距離をscale倍する(scale>1でズームイン=距離を縮める)。 */
  private dolly(scale: number) {
    const offset = this.camera.position.clone().sub(this.target);
    const distance = THREE.MathUtils.clamp(offset.length() / scale, this.minDistance, this.maxDistance);
    offset.setLength(distance);
    this.camera.position.copy(this.target).add(offset);
  }
}
