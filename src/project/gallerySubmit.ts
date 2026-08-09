// 「ギャラリーに投稿」ダイアログ(Phase 40d)用の純粋ロジック。
// 現在のドキュメントを共有リンク(Phase 40a、src/project/shareLink.ts)と同じ形式で
// エンコードした上で、GitHub Issueフォーム(.github/ISSUE_TEMPLATE/model-submission.yml)を
// クエリパラメータで事前入力したURLを組み立てる。フィールドidはissueフォーム側のidと一致させる
// 必要がある(GitHubの仕様: `?<field-id>=<value>` でその項目を事前入力できる)。
//
// URLが長すぎる(一部ブラウザ・プロキシで途中で切れる恐れがある)場合は、モデルデータ
// (`model_data`)フィールドだけを除外したURLを返す(payloadIncluded: false)。呼び出し側は
// この場合、共有リンクをクリップボードにコピーした上で「モデルデータ欄に貼り付けてください」と
// 案内する。

/** 投稿先リポジトリのissue作成URL(既定値、テストでは差し替え可能)。 */
export const GALLERY_SUBMISSION_ISSUES_NEW_URL = "https://github.com/PlugBits/light-3dcad/issues/new";

/** issueフォームのテンプレートファイル名。 */
export const GALLERY_SUBMISSION_TEMPLATE = "model-submission.yml";

/**
 * 事前入力込みURLがこの文字数を超える場合、モデルデータ(model_data)を除外したURLに切り替える
 * (一部のブラウザ・プロキシ・チャットアプリ等でURLが途中で切れる恐れがあるため)。
 */
export const GALLERY_SUBMISSION_URL_LENGTH_LIMIT = 7000;

/** ダイアログで入力するフィールド(モデルデータ・ライセンス同意を除く)。 */
export interface GallerySubmitFields {
  title: string;
  author: string;
  description: string;
  /** カンマ区切りのタグ文字列(未加工、issueフォームのtagsフィールドと同じ表現)。 */
  tags: string;
}

export interface GallerySubmitUrlOptions {
  /** issue作成URLの基点(既定: GALLERY_SUBMISSION_ISSUES_NEW_URL)。テストでの差し替え用。 */
  baseUrl?: string;
  template?: string;
  lengthLimit?: number;
}

export interface GallerySubmitUrlResult {
  /** 開くべきURL(GitHubのissue作成画面)。 */
  url: string;
  /** モデルデータ(共有リンクURL)を事前入力できたかどうか。falseの場合は手動貼り付けが必要。 */
  payloadIncluded: boolean;
}

function buildParams(fields: GallerySubmitFields, shareLinkUrl: string, template: string, includePayload: boolean): URLSearchParams {
  const params = new URLSearchParams();
  params.set("template", template);
  params.set("labels", "model-submission");
  // GitHubのissueフォームは、テンプレート本文のフィールドとは別に「issueのタイトル」欄を持つ
  // (?title=で事前入力できる)。フィールドidの"model_title"と紛らわしいが別物。
  params.set("title", `[モデル投稿] ${fields.title}`);
  params.set("model_title", fields.title);
  params.set("author_name", fields.author);
  params.set("description", fields.description);
  if (fields.tags.trim().length > 0) {
    params.set("tags", fields.tags);
  }
  if (includePayload) {
    params.set("model_data", shareLinkUrl);
  }
  return params;
}

/**
 * ダイアログの入力フィールド+共有リンクURLから、GitHub Issue作成画面のURLを組み立てる。
 * 全体が長すぎる場合はmodel_dataを除外したフォールバックURLを返す(payloadIncluded: false)。
 */
export function buildGallerySubmissionUrl(
  fields: GallerySubmitFields,
  shareLinkUrl: string,
  options: GallerySubmitUrlOptions = {},
): GallerySubmitUrlResult {
  const baseUrl = options.baseUrl ?? GALLERY_SUBMISSION_ISSUES_NEW_URL;
  const template = options.template ?? GALLERY_SUBMISSION_TEMPLATE;
  const lengthLimit = options.lengthLimit ?? GALLERY_SUBMISSION_URL_LENGTH_LIMIT;

  const fullUrl = `${baseUrl}?${buildParams(fields, shareLinkUrl, template, true).toString()}`;
  if (fullUrl.length <= lengthLimit) {
    return { url: fullUrl, payloadIncluded: true };
  }

  const fallbackUrl = `${baseUrl}?${buildParams(fields, shareLinkUrl, template, false).toString()}`;
  return { url: fallbackUrl, payloadIncluded: false };
}
