// 簡易アセンブリ(部品配置、Phase 27b)のE2E。
// ①初期ボックス(60x40x20)をそのまま部品として保存 → ②新規プロジェクトで別の形状(円柱)を作る →
// ③「部品を配置」で①のファイルを配置(両方の形状が1つのcompoundとして表示される) →
// ④位置・回転を変更すると再評価が反映される → ⑤保存→新規→開くで部品配置ごと復元される、
// までを一気通貫で検証する。
//
// setInputFiles()は、この実行環境ではpath文字列を渡す方式(ダウンロード直後のファイルをそのまま
// 指す)だと稀に(サンドボックス化されたブラウザプロセスからのローカルファイル読み取りの何らかの
// 制約により)ファイルが実際には入力要素にセットされない事象を確認したため、
// {name, mimeType, buffer} 形式(内容を直接読み込んでバッファとして渡す)を使う。
//
// 多くの手順(WASM初期化+複数回の新規プロジェクト+保存/読み込み)を含む一気通貫シナリオのため、
// デフォルトのテストタイムアウト(150秒)を延長する。
import fs from "node:fs";

import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, waitForReady } from "./helpers";

test("部品配置: 保存→新規→部品として配置→位置/回転編集→保存→開くで復元", async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  const pageErrors = collectPageErrors(page);
  // 「新規」ボタンはwindow.confirm()で確認する(2回押すため、テスト全体で常に承諾する)。
  page.on("dialog", (dialog) => dialog.accept());

  await gotoApp(page);
  await waitForReady(page);

  // ① 初期ドキュメント(Sketch1: XY矩形60x40 -> Extrude1: 押し出し20mmの箱)をそのまま
  // 部品プロジェクトとして保存する。
  const partDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("btn-save-project").click();
  const partDownload = await partDownloadPromise;
  const partFilePath = testInfo.outputPath("part-box.l3dcad");
  await partDownload.saveAs(partFilePath);

  // ② 新規プロジェクトを開始し(自動保存も消去)、別の形状(円柱、半径10・押し出し高さ10)を作る。
  await page.getByTestId("btn-new-project").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch1")).toHaveCount(0);

  await page.getByTestId("btn-add-sketch").click();
  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await page.getByTestId("btn-add-extrude").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();

  // ③ 「部品を配置」で①のファイル(part-box.l3dcad)を原点に配置する。両方の形状(円柱+箱)が
  // 1つのcompoundとして評価エラーなく表示されるはず。
  await page.getByTestId("input-add-part").setInputFiles({
    name: "part-box.l3dcad",
    mimeType: "application/json",
    buffer: fs.readFileSync(partFilePath),
  });
  await waitForReady(page);
  await expect(page.getByTestId("open-part-error")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-part-box")).toBeVisible();
  await expect(page.getByTestId("feature-item-part-box")).toContainText("部品: part-box");

  // ④ 部品配置フィーチャーを選択し、位置・回転を変更する。変更のたびに再評価が成功することを確認する。
  await page.getByTestId("feature-item-part-box").click();
  await expect(page.getByTestId("part-instance-position-x")).toBeVisible();

  await page.getByTestId("part-instance-position-x").fill("100");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.getByTestId("part-instance-rotation-x").fill("90");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 両方の形状(円柱+移動・回転させた箱)が表示されている状態のスクリーンショット(視覚確認用)。
  // フィットして両ボディがフレーム内に収まるようにしてから撮る。
  await page.getByTestId("btn-fit-view").click();
  await page.screenshot({ path: testInfo.outputPath("assembly-both-bodies.png") });

  // ⑤ 保存→新規→開くで、部品配置(位置・回転を含む)が完全に復元されることを確認する。
  const assemblyDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("btn-save-project").click();
  const assemblyDownload = await assemblyDownloadPromise;
  const assemblyFilePath = testInfo.outputPath("assembly.l3dcad");
  await assemblyDownload.saveAs(assemblyFilePath);

  await page.getByTestId("btn-new-project").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch1")).toHaveCount(0);

  await page.getByTestId("input-open-project").setInputFiles({
    name: "assembly.l3dcad",
    mimeType: "application/json",
    buffer: fs.readFileSync(assemblyFilePath),
  });
  await waitForReady(page);
  await expect(page.getByTestId("open-project-error")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();
  await expect(page.getByTestId("feature-item-part-box")).toBeVisible();

  await page.getByTestId("feature-item-part-box").click();
  await expect(page.getByTestId("part-instance-position-x")).toHaveValue("100");
  await expect(page.getByTestId("part-instance-rotation-x")).toHaveValue("90");

  // pageerrorが発生していないこと。
  expect(pageErrors).toEqual([]);
});
