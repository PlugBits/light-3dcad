// モデル共有リンク(Phase 40a)のE2E。
// 小さなモデルを作り「共有リンクをコピー」でクリップボードへコピーされたURLを読み取り、
// そのURL(#m=...のフラグメント付き)へ改めてnavigateすると、共有されたモデルが復元されることを
// フィーチャーツリーの行の存在で確認する。
import { expect, test } from "@playwright/test";

import { collectPageErrors, gotoApp, waitForReady } from "./helpers";

test("共有リンクをコピーして開くとモデルが復元される", async ({ page, context }) => {
  const pageErrors = collectPageErrors(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await gotoApp(page);
  await waitForReady(page);

  // 初期ボックス(Sketch1/Extrude1)の押し出し距離を変えて、既定値ではない値が
  // 共有リンク経由でも保持されることを確認できるようにする。
  await page.getByTestId("feature-item-Extrude1").click();
  await page.getByTestId("extrude-distance-input").fill("37");
  await waitForReady(page);
  await expect(page.getByTestId("eval-error")).toHaveCount(0);

  const shareButton = page.getByTestId("btn-copy-share-link");
  await expect(shareButton).toBeEnabled();
  await shareButton.click();
  await expect(page.getByTestId("constraint-conflict-toast")).toContainText("共有リンクをコピーしました");

  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain("#m=");

  // 同一originかつパスも同じで#hashのみ異なるURLへのpage.goto()は「同一文書内ナビゲーション」
  // (ページの再読み込みを伴わない)としてブラウザに扱われ、起動時1回だけのReactマウント処理
  // (共有リンクの読み込みeffect)が再実行されない。新規タブとして開く(=ユーザーが共有リンクを
  // 新しいタブ/ウィンドウで開く典型的な使い方)ことで確実にフルロードさせる。
  const sharedPage = await context.newPage();
  const sharedPageErrors = collectPageErrors(sharedPage);
  await sharedPage.goto(url);
  await waitForReady(sharedPage);

  // ハッシュはロード後に取り除かれ、共有モデルの読み込みトーストが表示される。
  await expect(sharedPage.getByTestId("constraint-conflict-toast")).toContainText("共有モデルを読み込みました");
  await expect(async () => {
    expect(await sharedPage.evaluate(() => window.location.hash)).toBe("");
  }).toPass();

  await expect(sharedPage.getByTestId("feature-item-Sketch1")).toBeVisible();
  await expect(sharedPage.getByTestId("feature-item-Extrude1")).toBeVisible();
  await sharedPage.getByTestId("feature-item-Extrude1").click();
  await expect(sharedPage.getByTestId("extrude-distance-input")).toHaveValue("37");

  expect(pageErrors).toEqual([]);
  expect(sharedPageErrors).toEqual([]);
  await sharedPage.close();
});
