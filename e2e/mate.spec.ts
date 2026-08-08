// 合致(メイト、Phase 28c)のE2E。
// ①初期ボックス(60x40x20)を本体に、別途組み立てた小さな部品(20x20x10)を本体から離れた位置
// (60,0,40。XY footprintが本体と重ならない)へ配置 → ②「合致」ツールで部品底面(下面ビュー)→
// 本体上面(上面ビュー)の順にクリック → ③「一致」を適用すると即座にソルブされ、部品zが20に
// スナップする(パネルの数値も更新される) → ④部品移動ツールでZ方向にドラッグ(Shift+ドラッグ)して
// 位置をずらしても、再評価のたびにソルバが元の合致位置(z=20)へ引き戻す →
// ⑤合致フィーチャーを削除すると自由に動かせるようになる、までを一気通貫で検証する。
//
// 部品ファイルはUIで作らず(new project往復を避けるため)、l3dcadのJSON構造を直接組み立てて
// setInputFiles()へbufferとして渡す(e2e/part-assembly.spec.tsのコメント参照: このE2E実行環境では
// path文字列よりbuffer方式の方が確実にファイルがセットされる)。
//
// 面クリックの視点について: 既定の等角(iso)ビューでは「上向き(+Z寄り)」の3面しか見えない
// (凸形状の自己遮蔽により、反対側の3面はどの平行移動でも常に隠れる)。合致で向き合わせる2面
// (本体の上面=+Z・部品の底面=-Z)は互いに逆向きなので、同一カメラ角度からは絶対に両方クリック
// できない。そのため部品底面は「下」標準ビュー、本体上面は「上」標準ビューに切り替えてそれぞれ
// クリックする(screenPointForWorld()は現在のカメラ状態から都度正しく投影するため、
// ビュー切り替え自体は問題にならない)。
//
// また、本体と部品のXY footprintは完全に離す(本体x:[-30,30]、部品x:[50,70])。
// 一部重ねる配置も試したが、標準ビューは透視投影(fov 30度)のため、真下/真上から見ても
// 高さの異なる2物体の間でパララックス(視差)が生じ、片方の面の中心をクリックしたつもりでも
// レイが途中でもう片方のボディの領域に入り込んで誤って手前の面に当たることがあった
// (実測で確認済み)。footprintを完全に分離しておけば、視差があってもレイが他方のボディへ
// 入り込む余地が無く、安定してクリックできる。
//
// 数値アサーションについて: 合致ソルバは数値LM法(src/assembly/mateSolver.ts)のため、拘束されない
// 自由度(このシナリオではX位置)はサブミリ単位の残差を残したまま収束することがある
// (正則化により初期値付近には留まるが、厳密に同一値にはならない)。そのため位置の検証は
// 文字列の完全一致ではなく数値許容誤差(0.05mm)で行う。
import { expect, test, type Page } from "@playwright/test";

import { collectPageErrors, gotoApp, openRibbonTab, screenPointForWorld, waitForReady } from "./helpers";

const MATE_PART_FILE = JSON.stringify({
  format: "l3dcad",
  schemaVersion: 1,
  document: {
    version: 1,
    features: [
      {
        type: "sketch",
        id: "matepart-sketch1",
        name: "Sketch1",
        plane: { kind: "world", plane: "XY" },
        entities: [{ kind: "rectangle", id: "matepart-rect1", center: [0, 0], width: 20, height: 20 }],
      },
      {
        type: "extrude",
        id: "matepart-extrude1",
        name: "Extrude1",
        sketchId: "matepart-sketch1",
        distance: 10,
        direction: 1,
        operation: "newBody",
      },
    ],
  },
});

/** 数値inputの現在値を読み、期待値との差がtoleranceMm以内であることを確認する。 */
async function expectCloseValue(page: Page, testId: string, expected: number, toleranceMm = 0.05) {
  const raw = await page.getByTestId(testId).inputValue();
  const value = Number(raw);
  expect(Number.isFinite(value), `${testId} の値が数値ではありません: ${raw}`).toBe(true);
  expect(Math.abs(value - expected), `${testId}=${raw} が期待値${expected}から離れすぎています`).toBeLessThan(toleranceMm);
}

test("合致: 部品配置→面を2つ選んで一致→スナップ→ドラッグしても引き戻す→削除で自由になる", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const pageErrors = collectPageErrors(page);

  await gotoApp(page);
  await waitForReady(page);

  // ① 部品(20x20x10、footprint x:[-10,10] y:[-10,10]、底面z=0・上面z=10)を(60,0,40)へ配置する。
  // 本体(初期ドキュメント、60x40x20、footprint x:[-30,30] y:[-20,20]、上面z=20)とXY footprintが
  // 完全に離れる配置(ファイル冒頭のコメント参照)。
  await page.getByTestId("input-add-part").setInputFiles({
    name: "MatePart.l3dcad",
    mimeType: "application/json",
    buffer: Buffer.from(MATE_PART_FILE),
  });
  await waitForReady(page);
  await expect(page.getByTestId("open-part-error")).toHaveCount(0);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-MatePart")).toBeVisible();

  await page.getByTestId("feature-item-MatePart").click();
  await page.getByTestId("part-instance-position-x").fill("60");
  await page.getByTestId("part-instance-position-z").fill("40");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  // ② 合致ツールを開始する(Phase 38a: 合致・部品移動はCommandManagerリボンの「アセンブリ」タブ)。
  await openRibbonTab(page, "アセンブリ");
  await page.getByTestId("btn-mate").click();
  await expect(page.getByTestId("mate-tool-hint")).toBeVisible();

  // 部品の底面(下向き、-Z)をクリックする。既定のiso視点では自己遮蔽で見えないため「下」ビューに切り替える。
  await page.getByTestId("btn-view-bottom").click();
  await page.waitForTimeout(300);
  const partBottomScreen = await screenPointForWorld(page, [60, 0, 40]);
  await page.mouse.click(partBottomScreen.x, partBottomScreen.y);
  await expect(page.getByTestId("mate-pending-status")).toContainText("1つ目: 平面");

  // 本体の上面(+Z)をクリックする。「上」ビューに切り替える。
  await page.getByTestId("btn-view-top").click();
  await page.waitForTimeout(300);
  const baseTopScreen = await screenPointForWorld(page, [0, 0, 20]);
  await page.mouse.click(baseTopScreen.x, baseTopScreen.y);

  // ③ ポップアップから「一致」を選ぶ。即座にソルブされ、部品zが20にスナップするはず。
  await expect(page.getByTestId("mate-tool-popup")).toBeVisible();
  await expect(page.getByTestId("mate-tool-popup-coincident")).toBeVisible();
  await page.getByTestId("mate-tool-popup-coincident").click();
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expect(page.getByTestId("feature-item-合致1")).toBeVisible();
  await expect(page.getByTestId("feature-item-合致1")).toContainText("一致");

  // パネルの数値(position-z)が20に更新されていることを確認する(store側の書き戻し)。
  await page.getByTestId("feature-item-MatePart").click();
  await expectCloseValue(page, "part-instance-position-z", 20);
  // X(法線方向以外の未拘束の自由度)は正則化により初期値付近(60)のまま。
  await expectCloseValue(page, "part-instance-position-x", 60);

  await page.getByTestId("btn-mate").click(); // 合致キャンセル(トグル)。
  await page.getByTestId("btn-view-iso").click();
  await page.getByTestId("btn-fit-view").click();
  await page.screenshot({ path: testInfo.outputPath("mate-snapped.png") });

  // ④ 部品移動ツールでZ方向(Shift+ドラッグ)にずらしても、再評価のたびにソルバが引き戻すことを確認する。
  await page.getByTestId("btn-part-drag").click();
  const partTopScreen = await screenPointForWorld(page, [60, 0, 30]);
  await page.mouse.move(partTopScreen.x, partTopScreen.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  // 画面上で上方向へ動かす=+Z方向(computePartDragDelta参照)。スナップ格子に収まる量動かす。
  await page.mouse.move(partTopScreen.x, partTopScreen.y - 60, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  await page.getByTestId("feature-item-MatePart").click();
  // ドラッグでZは変化したはずだが、合致が効いているため再評価後は20へ引き戻される。
  await expectCloseValue(page, "part-instance-position-z", 20);
  await page.screenshot({ path: testInfo.outputPath("mate-after-drag-pulled-back.png") });

  await page.getByTestId("btn-part-drag").click(); // 部品移動キャンセル(トグル)。

  // ⑤ 合致フィーチャーを削除すると、以後は自由に動かせる(値を書き換えてもソルバに引き戻されない)。
  await page.getByTestId("feature-item-合致1").click();
  await expect(page.getByTestId("mate-kind-label")).toBeVisible();
  await page.getByTestId("btn-delete-mate").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-合致1")).toHaveCount(0);

  await page.getByTestId("feature-item-MatePart").click();
  await page.getByTestId("part-instance-position-z").fill("40");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);
  await expectCloseValue(page, "part-instance-position-z", 40, 1e-6);

  expect(pageErrors).toEqual([]);
});
