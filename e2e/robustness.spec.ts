// 堅牢性強化(Phase 29a)のE2E。
// ① Workerクラッシュ(開発ビルド限定のデバッグフック window.__cadDebugCrashWorker() で再現)→
//    「CADカーネルが応答しません」バナー表示→クラッシュ中もフィーチャー削除等のUI操作が
//    (Workerの応答を待たずに)即座に反映される→「カーネル再起動」で復帰する、を確認する。
// ② ねじの簡易表示(Phase 41でヘリカルloftを廃止し簡易表示化): 雄ねじ・雌ねじを配置すると、
//    ビューアに「二重円+ヘリックス」の線オーバーレイ(threadAnnotationLineCount、雄=3本/雌=2本)が
//    現れること、評価が実ブラウザ上で明らかに高速(数秒未満)であることを確認する。
// ③ 「開く」でプロジェクトを読み込むと、読み込んだドキュメントの初回評価完了時にビューアが
//    自動的にモデル全体をフィットすることを、カメラ距離の変化で確認する。
import fs from "node:fs";

import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, screenPointForWorld, waitForReady } from "./helpers";

test("① Workerクラッシュ→エラー表示→クラッシュ中もUI操作可能→カーネル再起動で復帰", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();

  // 開発ビルド限定のデバッグフックが公開されていること(本番ビルドでは存在しない想定)。
  const hasHook = await page.evaluate(() => typeof window.__cadDebugCrashWorker === "function");
  expect(hasHook).toBe(true);

  // Workerへ「故意にthrowする」メッセージを送り、実際のWorkerクラッシュ(Workerのerrorイベント)を再現する。
  await page.evaluate(() => window.__cadDebugCrashWorker?.());

  // クラッシュ検知のバナー(「CADカーネルが応答しません」+「カーネル再起動」ボタン)が表示される。
  await expect(page.getByTestId("kernel-crashed-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("kernel-crashed-banner")).toContainText("CADカーネルが応答しません");
  await expect(page.getByTestId("btn-restart-kernel")).toBeVisible();
  // 通常の評価エラー表示(eval-error)は、カーネルクラッシュ中は専用バナーに一本化され表示されない。
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // クラッシュ中でもUI操作(フィーチャー削除)は(Workerの応答を待たずに)即座に反映される
  // (store.ts側の doc/history 更新は Worker 往復とは独立した同期処理のため)。
  await page.getByTestId("feature-delete-Extrude1").click();
  await expect(page.getByTestId("feature-item-Extrude1")).toHaveCount(0);

  // 「カーネル再起動」: 旧Workerを破棄して新Workerを起動し、最新ドキュメントを再評価して復帰する。
  await page.getByTestId("btn-restart-kernel").click();
  await waitForReady(page);
  await expect(page.getByTestId("kernel-crashed-banner")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("status-text")).toContainText("状態: ready");

  // Workerのerrorイベントはメインスレッドの pageerror としては伝播しない(別グローバルスコープのため)。
  expect(pageErrors).toEqual([]);
});

test("② ねじの簡易表示: 雄ねじ配置で二重円+ヘリックス3本、雌ねじ配置で2本のオーバーレイが現れ、評価が高速", async ({ page }) => {
  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // ねじが1本も無い初期状態ではオーバーレイも0本のはず。
  const initialCount = await page.evaluate(() => window.__cadViewerDebug?.threadAnnotationLineCount() ?? -1);
  expect(initialCount).toBe(0);

  // 雄ねじツールを開始し、初期ボックス(60x40x20)の上面(z=20、x:-30..30, y:-20..20)に配置する。
  await page.getByTestId("btn-thread").click();
  await page.getByTestId("thread-tool-length").fill("12");
  const point1 = await screenPointForWorld(page, [-15, -10, 20]);
  const start1 = Date.now();
  await page.mouse.click(point1.x, point1.y);
  await waitForReady(page);
  const elapsed1 = Date.now() - start1;
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-M6ねじ1")).toBeVisible();

  // 雄ねじ1本ぶんのオーバーレイ(両端面の谷径円2本+ヘリックス1本=3本)が現れる。
  const countAfterMale = await page.evaluate(() => window.__cadViewerDebug?.threadAnnotationLineCount() ?? -1);
  expect(countAfterMale).toBe(3);

  // 雌ねじツールに切り替え、別の位置に配置する。
  await page.getByTestId("btn-thread").click();
  await page.getByTestId("thread-tool-hand-female").click();
  const point2 = await screenPointForWorld(page, [15, 10, 20]);
  const start2 = Date.now();
  await page.mouse.click(point2.x, point2.y);
  await waitForReady(page);
  const elapsed2 = Date.now() - start2;
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  // 雌ねじの名前は「M6ねじ穴2(簡易表現・下穴φ5.0)」になる(store.tsのaddThread()、雄と命名規則が異なる)。
  await expect(page.getByTestId("feature-item-M6ねじ穴2(簡易表現・下穴φ5.0)")).toBeVisible();

  // 雌ねじ1本ぶん(入口面の呼び径円1本+ヘリックス1本=2本)が追加され、合計5本になる。
  const countAfterFemale = await page.evaluate(() => window.__cadViewerDebug?.threadAnnotationLineCount() ?? -1);
  expect(countAfterFemale).toBe(5);

  // eslint-disable-next-line no-console
  console.log(`[thread simplified, browser] 雄ねじ配置: ${elapsed1}ms, 雌ねじ配置: ${elapsed2}ms`);
  // Phase 41でヘリカルloftを廃止したため(旧v1は数秒〜十数秒かかった)、実ブラウザでも明らかに高速なはず。
  expect(elapsed1).toBeLessThan(3000);
  expect(elapsed2).toBeLessThan(3000);

  expect(pageErrors).toEqual([]);
});

test("③ 「開く」でプロジェクトを読み込むと、初回評価完了時にビューアが自動的にモデル全体をフィットする", async ({
  page,
}, testInfo) => {
  const pageErrors = collectPageErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  await gotoApp(page);
  await waitForReady(page);

  const initialDistance = await page.evaluate(() => window.__cadViewerDebug?.cameraDistance() ?? 0);
  expect(initialDistance).toBeGreaterThan(0);

  // 初期ボックス(60x40x20)を大幅に大きくする(押し出し距離500mm)。この変更自体は
  // 「開く」ではないため、fitToView()は自動実行されずカメラ距離は変わらないままのはず。
  await page.getByTestId("feature-item-Extrude1").click();
  await page.getByTestId("extrude-distance-input").fill("500");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  const distanceAfterResize = await page.evaluate(() => window.__cadViewerDebug?.cameraDistance() ?? 0);
  expect(distanceAfterResize).toBeCloseTo(initialDistance, 3);

  // 保存→新規→開く、で読み込み直す。
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("btn-save-project").click();
  const download = await downloadPromise;
  const filePath = testInfo.outputPath("big-box.l3dcad");
  await download.saveAs(filePath);

  await page.getByTestId("btn-new-project").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch1")).toHaveCount(0);

  await page.getByTestId("input-open-project").setInputFiles({
    name: "big-box.l3dcad",
    mimeType: "application/json",
    buffer: fs.readFileSync(filePath),
  });
  await waitForReady(page);
  await expect(page.getByTestId("open-project-error")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-Extrude1")).toBeVisible();

  // 大きなボディ(60x40x500)を画面に収めるため、カメラ距離が自動的に大きく変わっているはず。
  const distanceAfterOpen = await page.evaluate(() => window.__cadViewerDebug?.cameraDistance() ?? 0);
  expect(distanceAfterOpen).toBeGreaterThan(initialDistance * 2);

  expect(pageErrors).toEqual([]);
});
