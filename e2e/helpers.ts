// E2Eテスト共通ヘルパー。
// WASM初期化待ち、viewer上の面クリック(スクリーン座標計算)、pageerror収集を提供する。
import { expect, type Page } from "@playwright/test";

/** status-text が指定の状態文字列を含むまで待つ。 */
export async function waitForStatus(page: Page, status: string, timeout = 120_000) {
  await expect(page.getByTestId("status-text")).toContainText(`状態: ${status}`, { timeout });
}

/** WASM初期化+初回評価が完了し、ビューアに初期ボックスが表示されるまで待つ。 */
export async function waitForReady(page: Page, timeout = 120_000) {
  // 初回ロード中はオーバーレイが表示される。消えるまで待つ(WASM読み込みはこの間に行われる)。
  await expect(page.getByTestId("init-overlay")).toHaveCount(0, { timeout });
  await waitForStatus(page, "ready", timeout);
}

/**
 * ビューアのcanvas上で、ワールド座標 (0,0,z) の点がおおよそ投影される画面の垂直位置(0=上端,1=下端)を返す。
 *
 * 導出: CadViewerの既定カメラは position (150,150,150) / target (0,0,0) / up (0,0,1) / fov 45度。
 * カメラ位置・注視点・upが対称的なため、点 (0,0,z) は常にNDC上で x=0(水平中央)に投影される
 * (view space の x 成分が常に0になる)。垂直方向はビュー空間への射影から計算する。
 * これにより、初期ボックス(60x40x20、原点中心・Z=0〜20)の上面中心 (0,0,20) を
 * 「canvas中央やや上」の安定した位置としてクリックできる(dead centerだとy=20の辺と重なり不安定)。
 */
export function verticalFractionForZ(z: number): number {
  const eye = { x: 150, y: 150, z: 150 };
  const fovRad = (45 * Math.PI) / 180;
  const tanHalfFov = Math.tan(fovRad / 2);

  const zLen = Math.sqrt(eye.x ** 2 + eye.y ** 2 + eye.z ** 2);
  const zaxis = { x: eye.x / zLen, y: eye.y / zLen, z: eye.z / zLen };
  // xaxis = normalize(cross(up, zaxis)), up = (0,0,1)
  const cx = 0 * zaxis.z - 1 * zaxis.y;
  const cy = 1 * zaxis.x - 0 * zaxis.z;
  const cz = 0 * zaxis.y - 0 * zaxis.x;
  const cLen = Math.sqrt(cx ** 2 + cy ** 2 + cz ** 2);
  const xaxis = { x: cx / cLen, y: cy / cLen, z: cz / cLen };
  // yaxis = cross(zaxis, xaxis)
  const yaxis = {
    x: zaxis.y * xaxis.z - zaxis.z * xaxis.y,
    y: zaxis.z * xaxis.x - zaxis.x * xaxis.z,
    z: zaxis.x * xaxis.y - zaxis.y * xaxis.x,
  };

  const v = { x: 0 - eye.x, y: 0 - eye.y, z: z - eye.z };
  const vy = v.x * yaxis.x + v.y * yaxis.y + v.z * yaxis.z;
  const vz = v.x * zaxis.x + v.y * zaxis.y + v.z * zaxis.z;
  const depth = -vz;
  const ndcY = vy / (depth * tanHalfFov);
  return (1 - ndcY) / 2;
}

/** 初期ボックスの上面(z=20、中心 (0,0,20))をクリックする。 */
export async function clickTopFace(page: Page) {
  const canvas = page.locator('[data-testid="viewer-container"] canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error("viewer canvas が見つかりません");
  const x = box.x + box.width / 2;
  const y = box.y + box.height * verticalFractionForZ(20);
  await page.mouse.click(x, y);
}

/** テスト全体を通じてpageerrorイベントを収集する。呼び出し側でassertする。 */
export function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on("pageerror", (err) => errors.push(err));
  return errors;
}

/**
 * 指定ワールド座標(スケッチ平面上の点等)を、現在のカメラでのページ内クリック座標に変換する。
 * `window.__cadViewerDebug.projectPoint`(開発ビルド限定)が返すcanvas内ピクセル座標に
 * canvasの画面上オフセットを足し合わせる。線描画モードのE2Eから使う。
 */
export async function screenPointForWorld(
  page: Page,
  world: [number, number, number],
): Promise<{ x: number; y: number }> {
  const canvas = page.locator('[data-testid="viewer-container"] canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error("viewer canvas が見つかりません");
  const projected = await page.evaluate((w) => window.__cadViewerDebug?.projectPoint(w) ?? null, world);
  if (!projected) throw new Error("projectPoint()がnullを返しました(カメラ範囲外の可能性)");
  return { x: box.x + projected.x, y: box.y + projected.y };
}

/**
 * 「初期ボックスの上面を選択 → 選択面にスケッチ → 円(r=10)追加 →
 *  押し出し追加(Cut・深さ10・方向反転)」までを行い、評価成功(ready)まで待つ。
 * 要求8ステップのうち4〜7に相当する共通フロー。呼び出し前に waitForReady 済みであること。
 */
export async function buildFaceCutFlow(page: Page) {
  await clickTopFace(page);
  await expect(page.getByTestId("selected-face-panel")).toBeVisible();
  await expect(page.getByTestId("selected-face-normal")).toContainText("0.00, 0.00, 1.00");

  await page.getByTestId("btn-add-face-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-FaceSketch1")).toBeVisible();

  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await expect(page.getByTestId("entity-circle-0-radius")).toHaveValue("10");

  await page.getByTestId("btn-add-extrude").click();
  // デフォルトのoperationは"newBody"であり、既にボディが存在するため一旦エラーになる。
  await waitForStatus(page, "error");
  await expect(page.getByTestId("eval-error")).toBeVisible();

  await page.getByTestId("extrude-operation-select").selectOption("cut");
  await page.getByTestId("extrude-distance-input").fill("10");
  await page.getByTestId("extrude-direction-select").selectOption("-1");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
}
