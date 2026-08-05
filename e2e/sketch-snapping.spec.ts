// Phase 9: スナップ・軸ロックのE2E。新規スケッチ(Sketch2、初期ボディのExtrude1には手を加えない)
// 上で線描画モードを使い、window.__cadViewerDebug.projectPoint()でワールド座標→スクリーン座標に
// 変換してクリック/カーソル移動を行う。頂点編集パネルの数値でスナップ・軸ロックの結果を検証する。
import { expect, test } from "@playwright/test";

import { collectPageErrors, screenPointForWorld, waitForReady } from "./helpers";

test("線描画モードで原点付近をクリックすると原点(0,0)にスナップする", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  // 新規スケッチ(XY、Sketch2)を追加すると自動的に選択状態になる。
  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画キャンセル(Esc)");

  // 原点(0,0)から0.4mm程度ずれた位置をクリックする(点スナップ許容距離内)。
  // 1頂点目は原点スナップ(origin候補)で(0,0)になるはず。
  const nearOrigin = await screenPointForWorld(page, [0.4, -0.3, 0]);
  await page.mouse.click(nearOrigin.x, nearOrigin.y);

  // 続けて一辺20mmの矩形を描いて閉じる(3点以上必要なため)。
  const corners: [number, number, number][] = [
    [20, 0, 0],
    [20, 20, 0],
    [0, 20, 0],
  ];
  for (const corner of corners) {
    const pt = await screenPointForWorld(page, corner);
    await page.mouse.click(pt.x, pt.y);
  }
  const start = await screenPointForWorld(page, [0, 0, 0]);
  await page.mouse.click(start.x + 2, start.y + 2);
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画");

  // 1頂点目が原点スナップにより厳密に(0,0)になっていることを確認する。
  await expect(page.getByTestId("entity-polygon-0-vertex-0-x")).toHaveValue("0");
  await expect(page.getByTestId("entity-polygon-0-vertex-0-y")).toHaveValue("0");

  expect(pageErrors).toEqual([]);
});

test("水平から3度ずれたクリックは軸ロックにより正確に水平な辺になる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-polygon").click();
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画キャンセル(Esc)");

  // 1頂点目: クリックすると1mmグリッドスナップにより(-10,-10)に丸められる。
  const v0 = { x: -10.3, y: -9.7 };
  const p0 = await screenPointForWorld(page, [v0.x, v0.y, 0]);
  await page.mouse.click(p0.x, p0.y);

  // 2頂点目: v0から水平方向より3度傾いた位置(長さ20mm)。3度は軸ロックの許容角度(±5度)以内。
  // 軸ロックが無ければ、この位置の生のy成分(≈-8.65)はグリッドスナップにより-9に丸まり、
  // 1頂点目のy(-10)とは一致しない。軸ロックが働いて初めて2頂点目のyが1頂点目のyと厳密に一致する。
  const angleRad = (3 * Math.PI) / 180;
  const length = 20;
  const v1 = { x: v0.x + Math.cos(angleRad) * length, y: v0.y + Math.sin(angleRad) * length };
  const p1 = await screenPointForWorld(page, [v1.x, v1.y, 0]);
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.click(p1.x, p1.y);

  // 3頂点目: 軸ロックが働かない適当な位置(3点以上必要なため)。
  const p2 = await screenPointForWorld(page, [v0.x, v0.y + 20, 0]);
  await page.mouse.click(p2.x, p2.y);

  // 始点(v0)付近をクリックして閉じる。
  const start = await screenPointForWorld(page, [v0.x, v0.y, 0]);
  await page.mouse.click(start.x + 2, start.y + 2);
  await expect(page.getByTestId("btn-draw-polygon")).toHaveText("線描画");

  const y0 = await page.getByTestId("entity-polygon-0-vertex-0-y").inputValue();
  const y1 = await page.getByTestId("entity-polygon-0-vertex-1-y").inputValue();
  // 軸ロックにより、2頂点目のyは1頂点目のyと厳密に一致する(=辺が正確に水平)。
  expect(y1).toBe(y0);

  expect(pageErrors).toEqual([]);
});
