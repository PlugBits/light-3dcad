// 寸法値の符号仕様の明確化(Phase 33)のE2E。実機報告シナリオの再現検証。
// ①円↔円のX距離に負値を指定→2つ目の円が1つ目の円より左側(小さいX)へ配置される。
//   同じ寸法ラベルを編集し0を指定→2つ目の円が1つ目の円と同じX(垂直整列)になる。
//   編集ポップアップの初期値が直前に設定した符号付きの値(-15)を表示することも確認する。
// ②端点↔辺の距離に0を指定→端点が辺(線分)上に乗る(y座標が線と一致する)。
import { expect, type Page, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

async function newSketchAligned(page: Page) {
  await page.getByTestId("btn-add-sketch").click();
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();
  await waitForReady(page);
  await page.getByTestId("btn-align-to-plane").click();
}

/** 線分ツールで2点チェーン(1本)を描く(click→dblclick)。 */
async function drawSingleSegment(page: Page, p0: [number, number], p1: [number, number]) {
  const s0 = await screenPointForWorld(page, [p0[0], p0[1], 0]);
  await page.mouse.click(s0.x, s0.y);
  const s1 = await screenPointForWorld(page, [p1[0], p1[1], 0]);
  await page.mouse.dblclick(s1.x, s1.y);
}

type SegSnapshot = { id: string; p1: [number, number]; p2: [number, number] };

async function dimensionSegmentsSnapshot(page: Page): Promise<SegSnapshot[]> {
  return page.evaluate(() => window.__cadViewerDebug?.dimensionToolSegmentsSnapshot() ?? []);
}

test("①円↔円のX距離: 負値→左側へ配置、0→垂直整列(編集ポップアップの初期値は符号付き)", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // 円0(既定でcenter 0,0)・円1(center 20,0へ移動)を追加し、円0を固定する
  // (円0が動かない基準点になるようにする。位置寸法拘束の既存テストと同じパターン)。
  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await page.getByTestId("entity-circle-0-fixed").check();
  await waitForReady(page);
  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await page.getByTestId("entity-circle-1-center-x").fill("20");
  await waitForReady(page);

  // 寸法ツール: 円0→円1の順にクリックしてcircle-distance-circle(X距離)を作る。
  await page.getByTestId("btn-dimension").click();
  const c0 = await screenPointForWorld(page, [10, 0, 0]); // 円0(center 0,0 r10)の円周
  await page.mouse.click(c0.x, c0.y);
  await expect(page.getByTestId("dimension-pending-status")).toContainText("円");
  const c1 = await screenPointForWorld(page, [30, 0, 0]); // 円1(center 20,0 r10)の円周
  await page.mouse.click(c1.x, c1.y);
  const popup = page.getByTestId("dimension-tool-popup");
  await expect(popup).toBeVisible();
  await page.getByTestId("dimension-tool-popup-axis-x").check();
  // X/Y距離選択中は「符号は1点目→2点目の向き」ヒントが出る(発見性向上)。
  await expect(page.getByTestId("dimension-tool-popup-value-hint")).toContainText("1点目→2点目");
  await page.getByTestId("dimension-tool-popup-value").fill("-15");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-dimension").click(); // 寸法ツールを終了する。

  // 円0(固定、x=0)基準でX距離=-15 => 円1は円0より左側(x=-15)に配置される。
  await expect(page.getByTestId("entity-circle-1-center-x")).toHaveValue("-15");

  await page.screenshot({ path: "test-results/dim-sign-1-negative-x.png" });

  // ラベルをクリックして編集ポップアップを開く: 初期値が符号付きの-15であることを確認する。
  const xLabel = page.locator('[data-testid^="dim-label-c-"]').filter({ hasText: "X-15.0" });
  await expect(xLabel).toBeVisible();
  await xLabel.click();
  const editPopup = page.getByTestId("dimension-tool-popup");
  await expect(editPopup).toBeVisible();
  await expect(page.getByTestId("dimension-tool-popup-axis-x")).toBeChecked();
  await expect(page.getByTestId("dimension-tool-popup-value")).toHaveValue("-15.00");

  // 0に変更→垂直整列(円1のXが円0と同じ0になる)。
  await page.getByTestId("dimension-tool-popup-value").fill("0");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(editPopup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await expect(page.getByTestId("entity-circle-1-center-x")).toHaveValue("0");
  const alignedLabel = page.locator('[data-testid^="dim-label-c-"]').filter({ hasText: "X0.0" });
  await expect(alignedLabel).toBeVisible();

  await page.screenshot({ path: "test-results/dim-sign-2-zero-aligned.png" });
  expect(pageErrors).toEqual([]);
});

test("②端点↔辺(矩形の辺、固定)の距離に0を指定→端点が線上に乗る", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await gotoApp(page);
  await waitForReady(page);
  await newSketchAligned(page);

  // 20x20mmの矩形(既定、原点中心=下辺はy=-10)を基準線として追加し、動かないよう固定する。
  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);
  await page.getByTestId("entity-rectangle-0-fixed").check();
  await waitForReady(page);

  // 矩形から離れた(y=-2、下辺までの距離8)自由な線分を1本描く。近い方の端点(0,-2)を対象にする。
  await page.getByTestId("btn-draw-segment").click();
  await drawSingleSegment(page, [0, -2], [0, 5]);
  await expect(page.getByTestId("btn-draw-segment")).toHaveText("線分");

  // 寸法ツール: 矩形の下辺(edgeIndex0、y=-10)→自由な線分の近い方の端点、の順にクリックして
  // point-distance-lineを作る。
  await page.getByTestId("btn-dimension").click();
  const before = await dimensionSegmentsSnapshot(page);
  expect(before.some((s) => Math.hypot(s.p1[0], s.p1[1] + 2) < 0.5 || Math.hypot(s.p2[0], s.p2[1] + 2) < 0.5)).toBe(true);
  const edgeMid = await screenPointForWorld(page, [-5, -10, 0]);
  await page.mouse.click(edgeMid.x, edgeMid.y);
  await expect(page.getByTestId("dimension-pending-status")).toContainText("辺");
  const nearEnd = await screenPointForWorld(page, [0, -2, 0]);
  await page.mouse.click(nearEnd.x, nearEnd.y);
  const popup = page.getByTestId("dimension-tool-popup");
  await expect(popup).toBeVisible();
  // 現在の距離(8)が初期値として入る。
  await expect(page.getByTestId("dimension-tool-popup-value")).toHaveValue("8.00");
  // 直線距離(axisOptions無し)でも0を許容する旨のヒントが出る。
  await expect(page.getByTestId("dimension-tool-popup-value-hint")).toContainText("0以上");
  await page.getByTestId("dimension-tool-popup-value").fill("0");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.screenshot({ path: "test-results/dim-sign-3-point-line-zero.png" });

  // 端点(元は0,-2)が矩形の下辺(y=-10、固定)上に乗る=y座標がほぼ-10になる(寸法ツール終了
  // [dimensionToolSegmentsクリア]前にスナップショットを取る)。
  const after = await dimensionSegmentsSnapshot(page);
  await page.getByTestId("btn-dimension").click(); // 寸法ツールを終了する。
  const movedPoint = after
    .flatMap((s) => [s.p1, s.p2])
    .find((p) => Math.abs(p[0]) < 1.5 && Math.abs(p[1] + 10) < 1.5);
  expect(movedPoint, `端点が辺上(y≈-10)に見つかりません: ${JSON.stringify(after)}`).toBeTruthy();
  if (movedPoint) expect(Math.abs(movedPoint[1] + 10)).toBeLessThan(0.05);

  expect(pageErrors).toEqual([]);
});
