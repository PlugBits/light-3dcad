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

test("既存の面上スケッチの円が、ねじ配置後でも配置基準の候補に見つかる(Phase 47 item1のバグ修正確認)", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 報告された不具合の手順どおり: 箱(既定) → 上面に面参照スケッチ → 円 → 同じ上面にねじ配置。
  await clickTopFace(page);
  await page.getByTestId("btn-add-face-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-FaceSketch1")).toBeVisible();

  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.getByTestId("btn-exit-sketch-panel").click();

  await page.getByTestId("btn-thread").click();
  const threadPoint = await screenPointForWorld(page, [10, 5, 20]);
  await page.mouse.click(threadPoint.x, threadPoint.y);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-M6ねじ1")).toBeVisible();

  // 配置基準ドロップダウンに、既存のFaceSketch1の円が候補として表示される(空にならない)。
  await page.getByTestId("thread-position-mode-sketch").check();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("thread-position-ref-select")).toBeVisible();
  await expect(page.getByTestId("thread-position-ref-select").locator("option:checked")).toHaveText(/FaceSketch1/);

  expect(pageErrors).toEqual([]);
});

test("配置スケッチを編集(ガイド付きフロー、Phase 47): 点を置いてスケッチを終了すると配置基準が自動設定される", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 上面に雄ねじを手動配置する(positionRef未設定のまま)。
  await clickTopFace(page);
  await page.getByTestId("btn-thread").click();
  const threadPoint = await screenPointForWorld(page, [-15, -10, 20]);
  await page.mouse.click(threadPoint.x, threadPoint.y);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-M6ねじ1")).toBeVisible();
  await expect(page.getByTestId("thread-position-mode-manual")).toBeChecked();

  // 「配置スケッチを編集」: positionRef未設定なので、配置面と同じ面に新規スケッチ(ThreadSketch1)を
  // 作成し、点ツールを事前アクティブ化した状態でスケッチモードへ入る。
  await page.getByTestId("btn-edit-thread-placement-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-ThreadSketch1")).toBeVisible();
  await expect(page.getByTestId("btn-exit-sketch-panel")).toBeVisible();
  await expect(page.locator('[data-testid="btn-draw-point"].is-active')).toBeVisible();

  // 点ツールで1点配置する(点ツールは1クリックで即確定してツールを終了する)。
  const pointScreen = await screenPointForWorld(page, [6, -8, 20]);
  await page.mouse.click(pointScreen.x, pointScreen.y);
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("entity-point-0-position-x")).toBeVisible();

  // クリックの投影誤差を避けるため、数値欄で正確な座標に設定し直す(タスク方針: 安価な寸法追加の
  // 代わりに座標を直接設定してよい)。
  await page.getByTestId("entity-point-0-position-x").fill("6");
  await page.getByTestId("entity-point-0-position-y").fill("-8");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // スケッチ終了 → 保留リンクが消費され、positionRefが自動設定され、成功トーストが出る。
  await page.getByTestId("btn-exit-sketch-panel").click();
  await waitForReady(page);
  await expect(page.getByTestId("constraint-conflict-toast")).toHaveText("ねじの配置基準に 点1 を設定しました");

  await page.getByTestId("feature-item-M6ねじ1").click();
  await expect(page.getByTestId("thread-position-mode-sketch")).toBeChecked();
  await expect(page.getByTestId("thread-position-ref-select").locator("option:checked")).toHaveText(/ThreadSketch1 の 点1/);
  await expect(page.getByTestId("thread-position-x-input")).toHaveValue("6");
  await expect(page.getByTestId("thread-position-y-input")).toHaveValue("-8");

  const snapshot = await page.evaluate(() => window.__cadViewerDebug?.threadAnnotationsSnapshot() ?? []);
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0].position[0]).toBeCloseTo(6, 3);
  expect(snapshot[0].position[1]).toBeCloseTo(-8, 3);
  expect(snapshot[0].position[2]).toBeCloseTo(20, 3);

  expect(pageErrors).toEqual([]);
});
