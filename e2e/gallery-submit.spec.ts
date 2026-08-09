// 「ギャラリーに投稿」ダイアログ(Phase 40d)のE2E。
// window.open()をpage.addInitScript()でスタブし、実際に新しいタブを開かず呼び出しURLだけを
// 記録する。ダイアログにタイトル・作者名・説明・タグを入力して送信すると、GitHub Issueフォームの
// URL(templateパラメータ+事前入力済みフィールド+共有リンクのペイロード)がwindow.open()に
// 渡されることを確認する。あわせて、ドキュメントが空の場合は投稿ボタンが無効になることも
// 同じテスト内で確認する(E2Eテスト数を抑えるため1テストにまとめている)。
import { expect, test } from "@playwright/test";

import { gotoApp, waitForReady } from "./helpers";

test("小さなモデルでギャラリーに投稿ダイアログを送信するとGitHubのissue作成URLが開かれる(空ドキュメントでは投稿不可)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });

  await gotoApp(page);
  await waitForReady(page);

  // 初期ボックス(Sketch1/Extrude1)が存在するため投稿ボタンは有効。
  const submitButton = page.getByTestId("btn-gallery-submit");
  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  await expect(page.getByTestId("gallery-submit-dialog")).toBeVisible();
  await page.getByTestId("gallery-submit-title-input").fill("テストブラケット");
  await page.getByTestId("gallery-submit-author-input").fill("e2eテスター");
  await page.getByTestId("gallery-submit-description-input").fill("E2Eテスト用の小さなモデルです。");
  await page.getByTestId("gallery-submit-tags-input").fill("テスト, E2E");

  const sendButton = page.getByTestId("btn-gallery-submit-send");
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  // 送信後、ダイアログは自動的に閉じる。
  await expect(page.getByTestId("gallery-submit-backdrop")).toHaveCount(0);

  const openedUrls = await page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls);
  expect(openedUrls).toHaveLength(1);

  const url = new URL(openedUrls[0]);
  expect(url.origin + url.pathname).toBe("https://github.com/PlugBits/light-3dcad/issues/new");
  expect(url.searchParams.get("template")).toBe("model-submission.yml");
  expect(url.searchParams.get("labels")).toBe("model-submission");
  expect(url.searchParams.get("model_title")).toBe("テストブラケット");
  expect(url.searchParams.get("author_name")).toBe("e2eテスター");
  expect(url.searchParams.get("description")).toBe("E2Eテスト用の小さなモデルです。");
  expect(url.searchParams.get("tags")).toBe("テスト, E2E");
  // 小さなモデルのためURLは長さ上限を超えず、共有リンクのペイロード(#m=を含む)がそのまま
  // model_dataとして事前入力される(=クリップボードへのフォールバックコピーは発生しない)。
  const modelData = url.searchParams.get("model_data");
  expect(modelData).toContain("#m=");

  // ドキュメントが空の場合は投稿ボタンが無効になる(ツールチップで案内)。「新規」はconfirm()で
  // 確認するため、ダイアログを自動的に承認する。
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByTestId("btn-new-project").click();
  await waitForReady(page);
  await expect(page.getByTestId("feature-item-Sketch1")).toHaveCount(0);
  await expect(submitButton).toBeDisabled();
  await expect(submitButton).toHaveAttribute("title", /モデルが空です/);
});
