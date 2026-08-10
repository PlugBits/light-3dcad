// 地面の無限グリッド表示トグル(Phase 44)のE2E。
// グリッド自体(シェーダ描画)は見た目の検証がしづらいため、window.__cadViewerDebug.groundGridVisible()
// で可視状態のみを検証する(CadViewerが開発ビルド時にのみ公開するフック)。
import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, waitForReady } from "./helpers";

test("グリッド表示チェックボックスで地面の無限グリッドを表示/非表示できる", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 既定値はON。
  await expect(page.getByTestId("toggle-grid-visibility")).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.groundGridVisible() ?? false))
    .toBe(true);

  // チェックを外すと非表示になる。
  await page.getByTestId("toggle-grid-visibility").uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.groundGridVisible() ?? true))
    .toBe(false);

  // 再度チェックすると表示に戻る。
  await page.getByTestId("toggle-grid-visibility").check();
  await expect
    .poll(() => page.evaluate(() => window.__cadViewerDebug?.groundGridVisible() ?? false))
    .toBe(true);

  expect(pageErrors).toEqual([]);
});
