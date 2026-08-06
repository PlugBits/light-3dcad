// Phase 10: 寸法駆動編集のE2E。
// ①線描画モードで多角形を描く→寸法ラベルをクリック→長さを変更→頂点座標が再計算されることを検証。
// ②線描画モード中に数字キー入力+Enterで、指定長の辺を引けることを検証(頂点編集パネルの値で確認)。
import { expect, test } from "@playwright/test";

import { collectPageErrors, screenPointForWorld, waitForReady } from "./helpers";

test("寸法ラベルをクリックして長さを変更すると、始点を固定したまま終点が再計算される", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  // 新規スケッチ(XY、Sketch2)を追加すると自動的に選択状態になる。
  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形キャンセル(Esc)");

  // 一辺20mmの正方形を描く(辺0は頂点0(-10,-10)→頂点1(10,-10)の水平な下辺)。
  const corners: [number, number, number][] = [
    [-10, -10, 0],
    [10, -10, 0],
    [10, 10, 0],
    [-10, 10, 0],
  ];
  for (const corner of corners) {
    const pt = await screenPointForWorld(page, corner);
    await page.mouse.click(pt.x, pt.y);
  }
  const start = await screenPointForWorld(page, corners[0]);
  await page.mouse.click(start.x + 2, start.y + 2);
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形");

  await expect(page.getByTestId("entity-polygon-0-vertex-0-x")).toHaveValue("-10");
  await expect(page.getByTestId("entity-polygon-0-vertex-1-x")).toHaveValue("10");

  // 辺0(下辺、水平)の寸法ラベルをクリックして編集ポップアップを開く。
  const edgeLabel = page.locator('[data-testid^="dim-label-"][data-testid$="-0"]');
  await expect(edgeLabel).toBeVisible();
  await expect(edgeLabel).toHaveText("20.0");
  await edgeLabel.click();

  const popup = page.getByTestId("dim-edit-popup");
  await expect(popup).toBeVisible();
  await expect(page.getByTestId("dim-edit-angle")).toHaveValue("0.00");

  // 長さのみ50に変更する(角度欄は初期値0.00のまま=水平を維持)。
  await page.getByTestId("dim-edit-length").fill("50");
  await page.getByTestId("dim-edit-apply").click();
  await expect(popup).toHaveCount(0);

  await waitForReady(page);

  // 始点(頂点0)は固定のまま、終点(頂点1)のみが水平方向に50mm先へ移動している。
  await expect(page.getByTestId("entity-polygon-0-vertex-0-x")).toHaveValue("-10");
  await expect(page.getByTestId("entity-polygon-0-vertex-0-y")).toHaveValue("-10");
  await expect(page.getByTestId("entity-polygon-0-vertex-1-x")).toHaveValue("40");
  await expect(page.getByTestId("entity-polygon-0-vertex-1-y")).toHaveValue("-10");
  // 後続の頂点(始点でも今回の終点でもない)は変更されない。
  await expect(page.getByTestId("entity-polygon-0-vertex-2-x")).toHaveValue("10");
  await expect(page.getByTestId("entity-polygon-0-vertex-2-y")).toHaveValue("10");

  expect(pageErrors).toEqual([]);
});

test("線描画モード中に数字キー入力+Enterで指定長の辺を引ける", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形キャンセル(Esc)");

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

  // 3・4頂点目を追加して閉じる(3点以上必要なため)。
  const p2 = await screenPointForWorld(page, [30, 30, 0]);
  await page.mouse.click(p2.x, p2.y);
  const p3 = await screenPointForWorld(page, [0, 30, 0]);
  await page.mouse.click(p3.x, p3.y);
  const start = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(start.x + 2, start.y + 2);
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("多角形");

  await expect(page.getByTestId("entity-polygon-0-vertex-0-x")).toHaveValue("0");
  await expect(page.getByTestId("entity-polygon-0-vertex-0-y")).toHaveValue("0");
  // 数値入力で確定した頂点: 直前点(0,0)から水平方向へ厳密に30mm。
  await expect(page.getByTestId("entity-polygon-0-vertex-1-x")).toHaveValue("30");
  await expect(page.getByTestId("entity-polygon-0-vertex-1-y")).toHaveValue("0");

  expect(pageErrors).toEqual([]);
});
