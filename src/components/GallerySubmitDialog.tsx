// 「ギャラリーに投稿」ダイアログ(Phase 40d)。
// src/app/App.tsx から React.lazy() 経由でのみ読み込まれる(メインバンドルには含めない、
// AiGeneratePanelと同じ方針)。
//
// 現在のドキュメントを共有リンク(Phase 40a、src/project/shareLink.ts)と同じ形式でエンコードし、
// GitHub Issueフォーム(.github/ISSUE_TEMPLATE/model-submission.yml)を事前入力したURLを
// window.open()で新しいタブに開く。事前入力込みURLが長すぎる場合は、共有リンクURLだけを
// クリップボードにコピーし、issueフォームの「モデルデータ」欄に手動で貼り付けるよう案内する
// (src/project/gallerySubmit.ts の buildGallerySubmissionUrl 参照)。
import { useState } from "react";

import { buildGallerySubmissionUrl, prefillGallerySubmitFields } from "../project/gallerySubmit";
import { buildShareLinkUrl, encodeShareLinkPayload } from "../project/shareLink";
import type { GallerySubmitMeta } from "../ai/pastePayload";
import type { CadDocument } from "../model/types";

export interface GallerySubmitDialogProps {
  doc: CadDocument;
  onClose: () => void;
  /** 送信後の案内・エラーをアプリ共通の一時トーストで表示する(App.tsx の showTransientMessage)。 */
  onNotice: (message: string) => void;
  /**
   * AI生成パネルの貼り付けモード(Phase 45)が読み込み時に提案したギャラリー投稿用メタ情報
   * (store.tsのpendingGalleryMeta)。あればタイトル/説明/タグ欄の初期値として使う
   * (作者名は含めない。常にユーザー自身の入力に委ねる)。未提案ならnull。
   */
  pendingMeta: GallerySubmitMeta | null;
}

export default function GallerySubmitDialog({ doc, onClose, onNotice, pendingMeta }: GallerySubmitDialogProps) {
  const [prefill] = useState(() => prefillGallerySubmitFields(pendingMeta));
  const [title, setTitle] = useState(prefill.title);
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState(prefill.description);
  const [tags, setTags] = useState(prefill.tags);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && author.trim().length > 0 && description.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const { data } = await encodeShareLinkPayload(doc);
      const shareLinkUrl = buildShareLinkUrl(location.origin, location.pathname, data);
      const { url, payloadIncluded } = buildGallerySubmissionUrl(
        { title: title.trim(), author: author.trim(), description: description.trim(), tags },
        shareLinkUrl,
      );

      if (!payloadIncluded) {
        try {
          await navigator.clipboard.writeText(shareLinkUrl);
          onNotice("モデルデータが長すぎるため自動入力できませんでした。共有リンクをクリップボードにコピーしたので、開いたGitHubの画面の「モデルデータ」欄に貼り付けてください");
        } catch {
          onNotice("モデルデータが長すぎるため自動入力できませんでした。クリップボードへのコピーにも失敗したため、アプリの「共有リンクをコピー」ボタンで得たURLを、開いたGitHubの画面の「モデルデータ」欄に貼り付けてください");
        }
      }

      window.open(url, "_blank", "noopener,noreferrer");
      onClose();
    } catch (err) {
      setErrorMessage(`投稿用データの作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="gallery-submit-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        zIndex: 1000,
        paddingTop: 40,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="gallery-submit-dialog"
        style={{
          background: "#242424",
          color: "#eee",
          border: "1px solid #555",
          borderRadius: 8,
          padding: 16,
          width: 440,
          maxWidth: "90vw",
          maxHeight: "85vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>ギャラリーに投稿</h2>
          <button type="button" data-testid="btn-gallery-submit-close" onClick={onClose}>
            閉じる
          </button>
        </div>

        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: "#bbb" }}>
          現在のモデルをコミュニティギャラリーに投稿します。<b>GitHubアカウントが必要です。</b>
          「送信」を押すとGitHubのIssue作成画面が新しいタブで開き、以下の内容が事前入力されます。
          ライセンス同意のチェックを入れてIssueを送信すると、自動的にPull Requestが作成され、
          マージされるとギャラリーに掲載されます。
        </p>

        {prefill.title && (
          <p
            data-testid="gallery-submit-prefill-notice"
            style={{ margin: 0, fontSize: 11, color: "#9cf" }}
          >
            AIが提案したタイトル/説明/タグを入力しました(自由に編集できます)
          </p>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          タイトル
          <input
            data-testid="gallery-submit-title-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例: L字ブラケット"
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          作者名
          <input
            data-testid="gallery-submit-author-input"
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="例: yourname"
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          説明
          <textarea
            data-testid="gallery-submit-description-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="モデルの簡単な説明"
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          タグ(カンマ区切り、任意)
          <input
            data-testid="gallery-submit-tags-input"
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="例: ブラケット, L字, 構造材"
          />
        </label>

        {errorMessage && (
          <p data-testid="gallery-submit-error" style={{ margin: 0, fontSize: 12, color: "#f88" }}>
            {errorMessage}
          </p>
        )}

        <button
          type="button"
          data-testid="btn-gallery-submit-send"
          onClick={handleSubmit}
          disabled={!canSubmit || submitting}
        >
          {submitting ? "準備中…" : "送信(GitHubのIssue作成画面を開く)"}
        </button>
      </div>
    </div>
  );
}
