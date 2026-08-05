// エラーと復帰E2E: 不正な操作(2つ目のNew Body)でフィーチャーにエラーが表示され、
// 操作をCutに変更すると復帰することを確認する。
import { expect, test } from "@playwright/test";

import { collectPageErrors, waitForReady, waitForStatus } from "./helpers";

test("2つ目のNew Bodyはエラーになり、Cutへの変更で復帰する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await page.goto("/");
  await waitForReady(page);

  // 新しいXYスケッチを追加し、矩形を1つ入れる(初期ボディと重なる位置・20x20)。
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();

  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);

  // 押し出しを追加する。デフォルトのoperationは"newBody"であり、
  // 既に初期ボディ(Extrude1)が存在するため「単一ボディのみ対応」エラーになる。
  await page.getByTestId("btn-add-extrude").click();
  await waitForStatus(page, "error");
  await expect(page.getByTestId("eval-error")).toBeVisible();
  await expect(page.getByTestId("eval-error")).toContainText("単一ボディ");
  await expect(page.getByTestId("feature-item-Extrude2")).toBeVisible();

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

  await page.goto("/");
  await waitForReady(page);

  // 新しい空のXYスケッチに図形を入れずに押し出し(Cut)しようとするとエラーになる。
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);

  await page.getByTestId("btn-add-extrude").click();
  // 空スケッチ+newBody(既にボディがある)なので、いずれにせよエラーになる。
  await waitForStatus(page, "error");
  await expect(page.getByTestId("eval-error")).toBeVisible();

  await page.getByTestId("extrude-operation-select").selectOption("cut");
  await waitForStatus(page, "error");
  // 空スケッチのため「スケッチに図形がありません」エラーに変わる。
  await expect(page.getByTestId("eval-error")).toContainText("図形がありません");

  // 修正: 矩形を追加すれば復帰する。
  const sketchFeature = page.getByTestId("feature-item-Sketch2");
  await sketchFeature.click();
  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
