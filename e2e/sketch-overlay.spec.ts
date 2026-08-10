// スケッチ線可視化(Phase 7、Phase 43で自動表示化)のE2E。
// Phase 43からの新しい既定挙動: スケッチ編集モード中(スケッチフィーチャーを選択中)は自動的に
// 表示、それ以外は自動的に非表示。「スケッチ表示」チェックボックスは現在のモードに対する
// 手動オーバーライドとして働き、モードを抜ける(スケッチ選択解除)と自動判定にリセットされる
// (src/app/App.tsxのisInSketchMode/sketchVisibilityOverride参照)。
// CadViewerが開発ビルド時にのみ公開するwindow.__cadViewerDebugフックを使う。
import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, waitForReady } from "./helpers";

test("スケッチ表示は編集モード中のみ自動表示され、トグルで手動上書きできる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // スケッチ編集モード外(初期状態、何も選択していない)ではスケッチ線は自動的に非表示。
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.sketchLineCount() ?? -1))
    .toBe(0);
  await expect(page.getByTestId("toggle-sketch-visibility")).not.toBeChecked();

  // スケッチをツリーで選択する(=スケッチ編集モードに入る)と自動的に表示され、グリッドも出る。
  await page.getByTestId("feature-item-Sketch1").click();
  await expect(page.getByTestId("toggle-sketch-visibility")).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.sketchLineCount() ?? 0))
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.gridVisible() ?? false))
    .toBe(true);

  // トグルOFFで手動オーバーライド(線・グリッドが消える)。
  await page.getByTestId("toggle-sketch-visibility").uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.sketchLineCount() ?? -1))
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.gridVisible() ?? true))
    .toBe(false);

  // トグルONで手動オーバーライド(再び表示される)。
  await page.getByTestId("toggle-sketch-visibility").check();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.sketchLineCount() ?? 0))
    .toBeGreaterThan(0);

  // スケッチ編集モードを抜ける(Extrude1を選択)と、手動オーバーライド(ON)は引き継がれず、
  // 新しいモード(編集モード外)の自動既定値(非表示)にリセットされる。
  await page.getByTestId("feature-item-Extrude1").click();
  await expect(page.getByTestId("toggle-sketch-visibility")).not.toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.sketchLineCount() ?? -1))
    .toBe(0);

  expect(pageErrors).toEqual([]);
});
