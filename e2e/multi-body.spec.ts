// 複数ボディ対応(Phase 27a)のE2E: 初期ボックス(body1)とは離れた位置に2つ目のNew Body押し出し
// (body2)を作り、両方が表示されること、body2の面に開けたスケッチ→カット(対象ボディ自動)で
// 正しい方(body2)にだけ穴が開くこと、STLダウンロードが成功することを確認する。
// スクリーンショットはscratchpadへ保存し(コミット対象外)、目視確認にも使う。
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

test("離れた位置に2つ目のNew Bodyを作り、その面をカットしてSTL出力する", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // 初期ボディ(Sketch1 -> Extrude1、60x40x20、原点)が表示されている。
  await expect(page.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // ① 離れた位置(x=150)に2つ目のスケッチ+矩形(20x20)を作り、New Bodyで10mm押し出す。
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
  await page.getByTestId("extrude-distance-input").fill("10");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // 両ボディが画面に収まるようにカメラをフィットさせてからスクリーンショットで確認する。
  await page.getByTestId("btn-fit-view").click();
  await page.screenshot({
    path: "/tmp/claude-0/-home-user-light-3dcad/9cb15686-4da1-5bf8-9d5b-b08b9faa43f1/scratchpad/multi-body-1-two-bodies.png",
  });

  // ② body2の上面(中心 (150,0,10))をクリックして選択し、その面にスケッチ→円(既定r=10)→
  // カット(対象ボディは指定せず自動で最後に作られたボディ=body2が対象になる)。
  const top2 = await screenPointForWorld(page, [150, 0, 10]);
  await page.mouse.click(top2.x, top2.y);
  await expect(page.getByTestId("selected-face-panel")).toBeVisible();
  await expect(page.getByTestId("selected-face-normal")).toContainText("0.00, 0.00, 1.00");

  await page.getByTestId("btn-add-face-sketch").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-FaceSketch1")).toBeVisible();

  await page.getByTestId("btn-add-circle").click();
  await waitForReady(page);
  await expect(page.getByTestId("entity-circle-0-radius")).toHaveValue("10");

  await page.getByTestId("btn-add-extrude").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Extrude3")).toBeVisible();
  // 対象ボディセレクトが表示されていても既定値(空="最新のボディ")のままにしておく(自動選択の確認)。
  await expect(page.getByTestId("extrude-target-body-select")).toHaveValue("");
  await page.getByTestId("extrude-operation-select").selectOption("cut");
  await page.getByTestId("extrude-distance-input").fill("10");
  await page.getByTestId("extrude-direction-select").selectOption("-1");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // body2にのみ穴が開いた状態をスクリーンショットで確認する(body1は無変化のはず)。
  await page.screenshot({
    path: "/tmp/claude-0/-home-user-light-3dcad/9cb15686-4da1-5bf8-9d5b-b08b9faa43f1/scratchpad/multi-body-2-body2-cut.png",
  });

  // ③ STLダウンロード(両ボディ分の形状が含まれる)。
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("btn-download-stl").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("model.stl");

  // ファイル内容がバイナリSTL形式であることを検証する(Phase 29a、full-flow.spec.tsと同じ判定方法)。
  const stlPath = await download.path();
  expect(stlPath).toBeTruthy();
  const content = readFileSync(stlPath as string);
  expect(content.byteLength).toBeGreaterThan(84);
  const triangleCount = content.readUInt32LE(80);
  expect(triangleCount).toBeGreaterThan(0);
  expect(content.byteLength).toBe(84 + triangleCount * 50);

  await expect(page.getByTestId("export-error")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
