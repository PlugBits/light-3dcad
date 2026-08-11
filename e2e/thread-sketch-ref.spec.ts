// ねじのスケッチ参照配置(positionRef、Phase 46)のE2E。
// 面上スケッチに円(押し出さない、位置決め専用)を置き、それをねじの配置基準に選ぶと
// 円の中心がねじの配置位置として使われること、円の中心(=寸法)を変更するとねじの位置が
// 自動的に追従することを、window.__cadViewerDebug.threadAnnotationsSnapshot()
// (ワールド座標)経由で確認する。
import { expect, test } from "@playwright/test";

import { clickTopFace, collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

test("面上スケッチの円をねじの配置基準に選ぶと、円の中心変更にねじの位置が追従する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 上面にface参照スケッチ+円(押し出さない、位置決め専用)を作る。
  await clickTopFace(page);
  await page.getByTestId("btn-add-face-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-FaceSketch1")).toBeVisible();

  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await page.getByTestId("entity-circle-0-center-x").fill("6");
  await page.getByTestId("entity-circle-0-center-y").fill("-8");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // スケッチを抜ける(このスケッチは何にも使われていないため、円はボディに何の影響も与えない)。
  await page.getByTestId("btn-exit-sketch-panel").click();

  // 同じ上面に雄ねじを配置する(クリック位置は暫定。後でpositionRefへ切り替えて上書きする)。
  await page.getByTestId("btn-thread").click();
  const point = await screenPointForWorld(page, [-15, -10, 20]);
  await page.mouse.click(point.x, point.y);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-M6ねじ1")).toBeVisible();

  // 配置基準を「スケッチの円を参照」へ切り替える(候補が1件のみのため自動的に選ばれる)。
  await page.getByTestId("thread-position-mode-sketch").check();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("thread-position-ref-select").locator("option:checked")).toHaveText(/FaceSketch1/);
  await expect(page.getByTestId("thread-position-x-input")).toHaveValue("6");
  await expect(page.getByTestId("thread-position-y-input")).toHaveValue("-8");

  const snapshot1 = await page.evaluate(() => window.__cadViewerDebug?.threadAnnotationsSnapshot() ?? []);
  expect(snapshot1).toHaveLength(1);
  expect(snapshot1[0].position[0]).toBeCloseTo(6, 3);
  expect(snapshot1[0].position[1]).toBeCloseTo(-8, 3);
  expect(snapshot1[0].position[2]).toBeCloseTo(20, 3);

  // 円の中心(=寸法に相当する位置決め)を変更すると、ねじの位置も自動的に追従する。
  await page.getByTestId("feature-item-FaceSketch1").click();
  await page.getByTestId("entity-circle-0-center-x").fill("5");
  await page.getByTestId("entity-circle-0-center-y").fill("-3");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  const snapshot2 = await page.evaluate(() => window.__cadViewerDebug?.threadAnnotationsSnapshot() ?? []);
  expect(snapshot2).toHaveLength(1);
  expect(snapshot2[0].position[0]).toBeCloseTo(5, 3);
  expect(snapshot2[0].position[1]).toBeCloseTo(-3, 3);

  // 手動配置へ戻すと、直近の解決済み位置がそのまま数値入力欄の起点として残る。
  await page.getByTestId("feature-item-M6ねじ1").click();
  await page.getByTestId("thread-position-mode-manual").check();
  await waitForReady(page);
  await expect(page.getByTestId("thread-position-x-input")).toHaveValue("5");
  await expect(page.getByTestId("thread-position-y-input")).toHaveValue("-3");

  expect(pageErrors).toEqual([]);
});
