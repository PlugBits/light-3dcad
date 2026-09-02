// 全スケッチ要素の寸法対応(Phase 48)のE2E。
// ユーザー報告: 「矩形の寸法が、他の線や円のようにスケッチ面の端面(基準エッジ)などから選べない」。
// ①面上スケッチの矩形の辺を、ボディ端面の参照エッジ(破線)から寸法指定できることを確認する
//   (基準エッジを1つ目→矩形の辺を2つ目の順にクリック。逆順は他のitで確認済みの実装と対称)。
// ②同じ面上スケッチの点(point、Phase 47)を、参照エッジから寸法指定できることを確認する。
import { expect, test } from "@playwright/test";

import { clickTopFace, collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

test("矩形の辺を基準エッジ(参照エッジ)から寸法指定でき、中心が解けて移動する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 初期ボックス(60x40x20)の上面にface参照スケッチを作る(上面はX:-30〜30, Y:-20〜20、Z=20)。
  await clickTopFace(page);
  await page.getByTestId("btn-add-face-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-FaceSketch1")).toBeVisible();

  // 既定の20x20矩形(中心[0,0])を追加する。右辺はローカルx=10(ワールドx=10,z=20)。
  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.getByTestId("btn-dimension").click();

  // 1つ目: ボディ端面の参照エッジ(上面右端、ワールドx=30の破線)をクリックする。
  const refEdgePoint = await screenPointForWorld(page, [30, 0, 20]);
  await page.mouse.click(refEdgePoint.x, refEdgePoint.y);
  await expect(page.getByTestId("dimension-pending-status")).toContainText("参照エッジ");

  // 2つ目: 矩形の右辺(entity-height、ローカルx=10)をクリックする。ユーザー報告対応の核心
  // (辺が1つ目の参照エッジ保留を受けてline-refedgeターゲットになることの確認、Phase 48)。
  const rectEdgePoint = await screenPointForWorld(page, [10, 0, 20]);
  await page.mouse.click(rectEdgePoint.x, rectEdgePoint.y);

  const popup = page.getByTestId("dimension-tool-popup");
  await expect(popup).toBeVisible();
  // 参照エッジ・矩形の右辺はいずれも垂直(平行)なので既定で「距離」が選ばれる。
  await page.getByTestId("dimension-tool-popup-value").fill("25");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-dimension").click(); // 寸法ツールを終了する。

  // 右辺(中心x+10)↔参照エッジ(x=30)の距離25を満たすには中心x=-5(初期の中心x=0に近い側の解)。
  // width/heightは寸法の対象にならず不変(20のまま)。
  await expect(page.getByTestId("entity-rectangle-0-center-x")).toHaveValue("-5");
  await expect(page.getByTestId("entity-rectangle-0-width")).toHaveValue("20");
  await expect(page.getByTestId("entity-rectangle-0-height")).toHaveValue("20");

  expect(pageErrors).toEqual([]);
});

test("点(point)エンティティを基準エッジ(参照エッジ)から寸法指定でき、位置が解けて移動する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  await clickTopFace(page);
  await page.getByTestId("btn-add-face-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-FaceSketch1")).toBeVisible();

  // 点ツールで1点配置し(1クリックで即確定)、数値欄で正確な座標(15,-15)に設定し直す
  // (クリックの投影誤差を避ける、thread-sketch-ref.spec.tsと同じ方針)。
  await page.getByTestId("btn-draw-point").click();
  const pointScreen = await screenPointForWorld(page, [15, -15, 20]);
  await page.mouse.click(pointScreen.x, pointScreen.y);
  await waitForReady(page);
  await expect(page.getByTestId("entity-point-0-position-x")).toBeVisible();
  await page.getByTestId("entity-point-0-position-x").fill("15");
  await page.getByTestId("entity-point-0-position-y").fill("-15");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.getByTestId("btn-dimension").click();

  // 1つ目: ボディ端面の参照エッジ(上面下端、ワールドy=-20の破線)をクリックする。
  const refEdgePoint = await screenPointForWorld(page, [15, -20, 20]);
  await page.mouse.click(refEdgePoint.x, refEdgePoint.y);
  await expect(page.getByTestId("dimension-pending-status")).toContainText("参照エッジ");

  // 2つ目: 点(point、Phase 47のエンティティ)自体をクリックする(Phase 48: 点entityが寸法ツールで
  // ピックできることの確認。以前はrectangle/circle/polygonの辺のみが対象で、pointは対象外だった)。
  await page.mouse.click(pointScreen.x, pointScreen.y);

  const popup = page.getByTestId("dimension-tool-popup");
  await expect(popup).toBeVisible();
  await page.getByTestId("dimension-tool-popup-value").fill("8");
  await page.getByTestId("dimension-tool-popup-apply").click();
  await expect(popup).toHaveCount(0);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await page.getByTestId("btn-dimension").click();

  // 点(y=-15)↔参照エッジ(y=-20)の距離8を満たすには y=-12(初期のy=-15に近い側の解)。
  await expect(page.getByTestId("entity-point-0-position-y")).toHaveValue("-12");
  await expect(page.getByTestId("entity-point-0-position-x")).toHaveValue("15");

  expect(pageErrors).toEqual([]);
});
