// Phase 9: スナップ・軸ロックのE2E。新規スケッチ(Sketch2、初期ボディのExtrude1には手を加えない)
// 上で線分ツール(Phase 19b、Phase 21で旧「多角形」自由描画ツールの後継として自由描画を担う)を使い、
// window.__cadViewerDebug.projectPoint()でワールド座標→スクリーン座標に変換してクリック/カーソル
// 移動を行う。線分ツールはsegmentsを作るためポリゴンのような頂点編集パネルを持たない
// (SketchEditorの表示: 「個別の座標編集はまだ対応していません」)。そのため確定前の頂点列を
// window.__cadViewerDebug.drawingPointsSnapshot()(Phase 21で追加)で読み、スナップ・軸ロックの
// 結果を検証する(確定・押し出しまでは行わない。Escでキャンセルして後始末する)。
import { expect, test } from "@playwright/test";

import { collectPageErrors, screenPointForWorld, waitForReady } from "./helpers";

test("線分ツールで原点付近をクリックすると原点(0,0)にスナップする", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  // 新規スケッチ(XY、Sketch2)を追加すると自動的に選択状態になる。
  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);

  await page.getByTestId("btn-align-to-plane").click();
  await page.getByTestId("btn-draw-segment").click();
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分キャンセル(Esc)");

  // 原点(0,0)から0.4mm程度ずれた位置をクリックする(点スナップ許容距離内)。
  // 1頂点目は原点スナップ(origin候補)で(0,0)になるはず。
  const nearOrigin = await screenPointForWorld(page, [0.4, -0.3, 0]);
  await page.mouse.click(nearOrigin.x, nearOrigin.y);

  // 2頂点目(スナップ・軸ロックとは無関係な適当な位置)を追加してから確定前の状態を読む。
  const p1 = await screenPointForWorld(page, [20, 0, 0]);
  await page.mouse.click(p1.x, p1.y);

  const points = await page.evaluate(() => window.__cadViewerDebug?.drawingPointsSnapshot() ?? []);
  expect(points).toHaveLength(2);
  // 1頂点目が原点スナップにより厳密に(0,0)になっていることを確認する。
  expect(points[0][0]).toBe(0);
  expect(points[0][1]).toBe(0);

  // 後始末: Escでキャンセルし、entityを確定しない。
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

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
  await page.getByTestId("btn-draw-segment").click();
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分キャンセル(Esc)");

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

  const points = await page.evaluate(() => window.__cadViewerDebug?.drawingPointsSnapshot() ?? []);
  expect(points).toHaveLength(2);
  // 軸ロックにより、2頂点目のyは1頂点目のyと厳密に一致する(=辺が正確に水平)。
  expect(points[1][1]).toBe(points[0][1]);

  // 後始末: Escでキャンセルし、entityを確定しない。
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  expect(pageErrors).toEqual([]);
});
