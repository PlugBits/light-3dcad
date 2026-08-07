// Phase 10: 寸法駆動編集のE2E(Phase 21で自由描画の「多角形」ツールが廃止されたため、
// テストシナリオを更新した)。
// ①多角形ツール(Phase 21で「正多角形」から改名、2クリックで頂点を計算したpolygonエンティティを
//   作る)で正方形を描く→寸法ラベルをクリック→長さを変更→頂点座標が再計算されることを検証。
// ②線分ツール(自由な線分・円弧チェーン作図)中に数字キー入力+Enterで、指定長の辺を引けることを
//   window.__cadViewerDebug.drawingPointsSnapshot()(Phase 21で追加。segmentsは頂点編集UIを
//   持たないため)で検証。
import { expect, type Locator, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

/**
 * 数値入力欄(input[type=number])の値を誤差許容付きで検証する。
 * 多角形ツールは中心・頂点クリックからatan2/cos/sinで頂点座標を逆算するため、"きれいな"整数を
 * クリックしても浮動小数点誤差(例: 10.000000000000002)で厳密な文字列一致が崩れうる
 * (toHaveValueは文字列完全一致のため使えない)。
 */
async function expectNumClose(locator: Locator, expected: number, precision = 6) {
  const raw = await locator.inputValue();
  expect(Number(raw)).toBeCloseTo(expected, precision);
}

test("寸法ラベルをクリックして長さを変更すると、始点を固定したまま終点が再計算される", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 新規スケッチ(XY、Sketch2)を追加すると自動的に選択状態になる。
  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  await page.getByTestId("btn-align-to-plane").click();
  // 辺数4(正方形)にしてから、中心(0,0)→頂点(10,10)の2クリックで描く。
  // regularPolygonVertices()の角度基準(atan2)により、この頂点は45°方向の頂点(10,10)になり、
  // 4頂点は軸に平行な正方形(10,10)/(-10,10)/(-10,-10)/(10,-10)になる(辺は45°刻みではなく
  // 軸平行になる、中心からの「頂点位置」基準で作図するツールの性質上こうなる)。
  await page.getByTestId("polygon-sides-select").selectOption("4");
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形キャンセル(Esc)");

  const center = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(center.x, center.y);
  const vertex = await screenPointForWorld(page, [10, 10, 0]);
  await page.mouse.click(vertex.x, vertex.y);
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形");

  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-0-x"), 10);
  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-0-y"), 10);
  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-1-x"), -10);
  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-1-y"), 10);

  // 辺0(頂点0→頂点1、水平・長さ20・-X方向=角度180°)の寸法ラベルをクリックして編集ポップアップを開く。
  const edgeLabel = page.locator('[data-testid^="dim-label-"][data-testid$="-0"]');
  await expect(edgeLabel).toBeVisible();
  await expect(edgeLabel).toHaveText("20.0");
  await edgeLabel.click();

  const popup = page.getByTestId("dim-edit-popup");
  await expect(popup).toBeVisible();
  await expect(page.getByTestId("dim-edit-angle")).toHaveValue("180.00");

  // 長さのみ50に変更する(角度欄は初期値180.00のまま=水平を維持)。
  await page.getByTestId("dim-edit-length").fill("50");
  await page.getByTestId("dim-edit-apply").click();
  await expect(popup).toHaveCount(0);

  await waitForReady(page);

  // 始点(頂点0)は固定のまま、終点(頂点1)のみが-X方向に50mm先(10-50=-40)へ移動している。
  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-0-x"), 10);
  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-0-y"), 10);
  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-1-x"), -40);
  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-1-y"), 10);
  // 後続の頂点(始点でも今回の終点でもない)は変更されない。
  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-2-x"), -10);
  await expectNumClose(page.getByTestId("entity-polygon-0-vertex-2-y"), -10);

  expect(pageErrors).toEqual([]);
});

test("線分ツール中に数字キー入力+Enterで指定長の辺を引ける", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-segment").click();
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分キャンセル(Esc)");

  // 1頂点目: 原点付近をクリックする(原点スナップにより厳密に(0,0)になる)。
  const p0 = await screenPointForWorld(page, [0.3, -0.2, 0]);
  await page.mouse.click(p0.x, p0.y);

  // マウスを水平方向(軸ロック許容角度内)へ移動して方向を確定させる。
  const p1 = await screenPointForWorld(page, [25, 0.3, 0]);
  await page.mouse.move(p1.x, p1.y);
  await expect(page.getByTestId("drawing-length-input")).toBeHidden();

  // 数字キーで「30」と入力する(長さ入力欄が現れる)。
  await page.keyboard.press("3");
  await page.keyboard.press("0");
  await expect(page.getByTestId("drawing-length-input")).toBeVisible();
  await expect(page.getByTestId("drawing-length-input")).toContainText("30");

  // Enterで確定: 直前頂点(0,0)から現在のカーソル方向(軸ロックにより水平)へ30mm先の頂点が追加される。
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("drawing-length-input")).toBeHidden();

  const points = await page.evaluate(() => window.__cadViewerDebug?.drawingPointsSnapshot() ?? []);
  expect(points).toHaveLength(2);
  expect(points[0][0]).toBe(0);
  expect(points[0][1]).toBe(0);
  // 数値入力で確定した頂点: 直前点(0,0)から水平方向へ厳密に30mm。
  expect(points[1][0]).toBe(30);
  expect(points[1][1]).toBe(0);

  // 後始末: Escでキャンセルし、segmentsを確定しない。
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  expect(pageErrors).toEqual([]);
});
