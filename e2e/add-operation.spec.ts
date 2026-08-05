// 押し出しAdd操作(材料追加)のE2E: 上面に円スケッチ→Add(方向+1、距離10)で
// エラーなく再評価が完了し(ready復帰)、エラーバナーが出ないことを確認する。
// e2e/helpers.ts の面上スケッチフロー(clickTopFace等)を流用する。
import { expect, test } from "@playwright/test";

import { clickTopFace, collectPageErrors, waitForReady, waitForStatus } from "./helpers";

test("上面に円スケッチ→Add操作でエラーなく再評価が完了する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  // 初期ボックスの上面を選択し、選択面にスケッチを作成する。
  await clickTopFace(page);
  await expect(page.getByTestId("selected-face-panel")).toBeVisible();
  await expect(page.getByTestId("selected-face-normal")).toContainText("0.00, 0.00, 1.00");

  await page.getByTestId("btn-add-face-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-FaceSketch1")).toBeVisible();

  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await expect(page.getByTestId("entity-circle-0-radius")).toHaveValue("10");

  await page.getByTestId("btn-add-extrude").click();
  // デフォルトのoperationは"newBody"であり、既にボディが存在するため一旦エラーになる。
  await waitForStatus(page, "error");
  await expect(page.getByTestId("eval-error")).toBeVisible();

  // 修正: 操作をAddに変更する。distance(10)・direction(+1、上面法線=外向き)はデフォルトのままでよい。
  await page.getByTestId("extrude-operation-select").selectOption("add");
  await expect(page.getByTestId("extrude-distance-input")).toHaveValue("10");
  await expect(page.getByTestId("extrude-direction-select")).toHaveValue("1");
  await waitForReady(page);

  // エラーなくready状態に復帰していること。
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("status-text")).toContainText("状態: ready");

  expect(pageErrors).toEqual([]);
});
