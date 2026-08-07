// Phase 21 項目1(最優先バグ)の回帰E2E: ユーザー報告の再現手順そのまま
// 「スケッチ選択→矩形ツールで矩形→円ツールで内側に円→押し出し」を行い、
// 内側の円がholeとして扱われて評価が成功することを確認する
// (修正前は src/sketch/containment.ts の境界接触(タンジェント)判定と、
//  src/worker/evaluator.ts の2D Drawing#cut()のOCCT頑健性問題により、
//  条件によって円が無視され穴の無い直方体になってしまっていた。詳細はdocs/PLAN.md Phase 21参照)。
import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

test("矩形ツールで外枠→円ツールで内側に穴→押し出しで穴あき立体になる(Phase 21回帰)", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  await gotoApp(page);
  await waitForReady(page);

  // 初期ドキュメント(Sketch1+Extrude1、60x40x20の箱)を削除し、まっさらな状態から始める
  // (削除するとExtrude1が依存フィーチャーとして確認ダイアログが出るため、上のdialogハンドラで承諾する)。
  await page.getByTestId("feature-delete-Sketch1").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch1")).toHaveCount(0);

  // 新規スケッチ(XY平面)を追加すると自動的に選択状態になる。
  await page.getByTestId("btn-add-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();

  // 矩形ツールで外枠(40x30、中心原点)をクリック作図する。
  await page.getByTestId("btn-draw-rect").click();
  const rectCorner1 = await screenPointForWorld(page, [-20, -15, 0]);
  const rectCorner2 = await screenPointForWorld(page, [20, 15, 0]);
  await page.mouse.click(rectCorner1.x, rectCorner1.y);
  await page.mouse.click(rectCorner2.x, rectCorner2.y);
  await waitForReady(page);
  await expect(page.getByTestId("entity-rectangle-0-width")).toHaveValue("40");
  await expect(page.getByTestId("entity-rectangle-0-height")).toHaveValue("30");

  // 円ツールで、外枠の内側に円(半径8、中心原点)をクリック作図する。
  await page.getByTestId("btn-draw-circle").click();
  const circleCenter = await screenPointForWorld(page, [0, 0, 0]);
  const circleEdge = await screenPointForWorld(page, [8, 0, 0]);
  await page.mouse.click(circleCenter.x, circleCenter.y);
  await page.mouse.click(circleEdge.x, circleEdge.y);
  await waitForReady(page);
  await expect(page.getByTestId("entity-circle-1-radius")).toHaveValue("8");

  // 押し出し(New Body、既定10mm)を追加する。
  await page.getByTestId("btn-add-extrude").click();
  await waitForReady(page);
  await expect(page.getByTestId("extrude-operation-select")).toHaveValue("newBody");
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // STLダウンロードして、穴あき形状として正常にエクスポートできることを確認する
  // (修正前のバグでも一応エクスポート自体は成功してしまう=見た目上の穴の有無が本質のため、
  // ここでは「エラーなくエクスポートできる」ことに加え、evaluator統合テスト
  // [tests/worker/evaluator.test.ts]側でUIと同一構造のdocの体積を厳密に検証している)。
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("btn-download-stl").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("model.stl");
  await expect(page.getByTestId("export-error")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
