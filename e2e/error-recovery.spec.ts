// エラーと復帰E2E: 不正な操作(2つ目のNew Body)でフィーチャーにエラーが表示され、
// 操作をCutに変更すると復帰することを確認する。
import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, waitForReady, waitForStatus } from "./helpers";

test("2つ目のNew Bodyはエラーになり、Cutへの変更で復帰する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 新しいXYスケッチを追加し、矩形を1つ入れる(初期ボディと重なる位置・20x20)。
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();

  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);

  // 押し出しを追加する。既に初期ボディ(Extrude1)が存在するためデフォルトのoperationは
  // "add"であり、直ちに評価が成功する(Phase 13)。
  await page.getByTestId("btn-add-extrude").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Extrude2")).toBeVisible();
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 明示的にoperationをNew Bodyへ変更すると「単一ボディのみ対応」エラーになる。
  await page.getByTestId("extrude-operation-select").selectOption("newBody");
  await waitForStatus(page, "error");
  await expect(page.getByTestId("eval-error")).toBeVisible();
  await expect(page.getByTestId("eval-error")).toContainText("単一ボディ");

  // 修正: 操作をCutに変更する。矩形は原点付近(20x20)で初期ボディと重なるため、
  // カットとして成立し評価が成功する。
  await page.getByTestId("extrude-operation-select").selectOption("cut");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("status-text")).toContainText("状態: ready");

  expect(pageErrors).toEqual([]);
});

test("面が無い状態でカットするとエラーになる(スケッチが空)", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 新しい空のXYスケッチに図形を入れずに押し出ししようとするとエラーになる。
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);

  await page.getByTestId("btn-add-extrude").click();
  // 既にボディがあるためデフォルトのoperationは"add"だが、スケッチが空なので
  // 「スケッチに図形がありません」エラーになる(Phase 13)。
  await waitForStatus(page, "error");
  await expect(page.getByTestId("eval-error")).toBeVisible();
  await expect(page.getByTestId("eval-error")).toContainText("図形がありません");

  await page.getByTestId("extrude-operation-select").selectOption("cut");
  await waitForStatus(page, "error");
  // Cutに変更しても空スケッチのため引き続き「スケッチに図形がありません」エラー。
  await expect(page.getByTestId("eval-error")).toContainText("図形がありません");

  // 修正: 矩形を追加すれば復帰する。
  const sketchFeature = page.getByTestId("feature-item-Sketch2");
  await sketchFeature.click();
  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
