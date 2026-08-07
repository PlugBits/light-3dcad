// エラーと復帰E2E(Phase 27a複数ボディ対応で更新): 単一ボディ制限は撤廃されたため、2つ目の
// New Body自体はもうエラーにならない(むしろ新しい独立ボディが正しく作られることを確認する)。
// 代わりに、targetBodyIdが参照するボディを削除して参照切れにするとフィーチャーにエラーが表示され、
// 対象ボディを「(最新のボディ)」に戻すと復帰することを確認する。
import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, waitForReady, waitForStatus } from "./helpers";

test("2つ目のNew Bodyは成功し、targetBodyIdの参照先削除はエラーになり、対象ボディのリセットで復帰する", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 離れた位置(x=150)に2つ目のスケッチ+矩形を追加し、New Bodyで押し出す。
  // 単一ボディ制限は撤廃されているため、New Bodyのままでもエラーにならず成功する(Phase 27a)。
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch2")).toBeVisible();

  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);
  await page.getByTestId("entity-rectangle-0-center-x").fill("150");
  await waitForReady(page);

  await page.getByTestId("btn-add-extrude").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Extrude2")).toBeVisible();
  await page.getByTestId("extrude-operation-select").selectOption("newBody");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 3つ目のスケッチ(原点付近、初期ボディ=Extrude1と重なる)を、対象ボディをExtrude1に明示して
  // Addする。ボディが2つあるため「対象ボディ」セレクトが表示される。
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch3")).toBeVisible();

  await page.getByTestId("btn-add-rectangle").click();
  await waitForReady(page);

  await page.getByTestId("btn-add-extrude").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Extrude3")).toBeVisible();
  await expect(page.getByTestId("extrude-operation-select")).toHaveValue("add");
  await expect(page.getByTestId("extrude-target-body-select")).toBeVisible();
  await page.getByTestId("extrude-target-body-select").selectOption({ label: "Extrude1" });
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // Extrude1(Extrude3のtargetBodyIdが指すボディ)を削除すると、参照切れでエラーになる。
  await page.getByTestId("feature-delete-Extrude1").click();
  await waitForStatus(page, "error");
  await expect(page.getByTestId("eval-error")).toBeVisible();
  await expect(page.getByTestId("eval-error")).toContainText("対象ボディ");

  // 修正: 対象ボディを「(最新のボディ)」に戻す(targetBodyIdをクリア)と復帰する。
  await page.getByTestId("extrude-target-body-select").selectOption("");
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
