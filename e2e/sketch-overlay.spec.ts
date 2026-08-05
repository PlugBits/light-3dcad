// スケッチ線可視化(Phase 7)のE2E: 初期ドキュメント表示でスケッチ線が描画されること、
// スケッチをツリーで選択するとグリッドが表示されること、表示トグルOFFで線が消えることを確認する。
// CadViewerが開発ビルド時にのみ公開するwindow.__cadViewerDebugフックを使う。
import { expect, test } from "@playwright/test";

import { collectPageErrors, waitForReady } from "./helpers";

test("スケッチ線が描画され、選択でグリッドが表示され、トグルで非表示になる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  // 初期ドキュメント(XYスケッチ+矩形)のスケッチ線が1本以上描画されている。
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.sketchLineCount() ?? 0))
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.gridVisible() ?? false))
    .toBe(false);

  // スケッチをツリーで選択するとグリッドが表示される。
  await page.getByTestId("feature-item-Sketch1").click();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.gridVisible() ?? false))
    .toBe(true);

  // トグルOFFで線(グリッド含む)が消える。
  await page.getByTestId("toggle-sketch-visibility").uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.sketchLineCount() ?? -1))
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.gridVisible() ?? true))
    .toBe(false);

  // トグルONで再び表示される。
  await page.getByTestId("toggle-sketch-visibility").check();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.sketchLineCount() ?? 0))
    .toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});
