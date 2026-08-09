#!/usr/bin/env node
// GitHub Issueフォーム経由のモデルギャラリー投稿(Phase 40d、model-submission.yml)を処理する
// GitHub Action(.github/workflows/model-submission.yml)向けの純粋ロジック。
// issueフォームのbody(markdown)のパース・共有リンクペイロードの抽出・slug生成・meta.json生成を
// 行う。node:zlib等の副作用を伴う処理はここに置かず(decode-share-link.mjs側)、このファイルは
// 文字列/オブジェクトの変換だけを行う純粋関数のみで構成する(vitestで直接テストしやすくするため)。

/** .github/ISSUE_TEMPLATE/model-submission.yml のフィールドlabel(見出しとして本文に現れる文字列)。 */
export const FIELD_LABELS = {
  title: "タイトル",
  author: "作者名",
  description: "説明",
  tags: "タグ",
  modelData: "モデルデータ",
  license: "ライセンス同意",
};

/**
 * issueフォームのbody(markdown、"### <label>\n\n<value>\n\n### <次のlabel>..."の並び)を
 * { label: value } のオブジェクトにパースする。GitHubのissueフォームは値が空の場合
 * "_No response_" を挿入するため、その判定はsectionValue()側で行う(ここでは生の値を返す)。
 */
export function parseIssueBody(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const sections = {};
  const headingRegex = /^### (.+?)\s*$/gm;
  const matches = [...text.matchAll(headingRegex)];
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections[heading] = text.slice(start, end).trim();
  }
  return sections;
}

/** parseIssueBody()の結果から指定labelの値を取り出す。"_No response_"・未定義は空文字列とする。 */
export function sectionValue(sections, label) {
  const raw = sections[label];
  if (raw === undefined) return "";
  if (raw === "_No response_") return "";
  return raw;
}

/** checkboxesフィールドの本文("- [x] ..."または"- [ ] ...")がチェック済みかどうかを判定する。 */
export function isChecked(raw) {
  if (!raw) return false;
  return /-\s*\[[xX]\]/.test(raw);
}

/** issueのbody(markdown)から投稿フィールドを抽出する。 */
export function extractSubmissionFields(body) {
  const sections = parseIssueBody(body);
  return {
    title: sectionValue(sections, FIELD_LABELS.title).trim(),
    author: sectionValue(sections, FIELD_LABELS.author).trim(),
    description: sectionValue(sections, FIELD_LABELS.description).trim(),
    tags: sectionValue(sections, FIELD_LABELS.tags).trim(),
    modelData: sectionValue(sections, FIELD_LABELS.modelData).trim(),
    licenseAgreed: isChecked(sections[FIELD_LABELS.license]),
  };
}

/** 必須フィールドが揃っているかを検証し、不足があれば日本語のエラーメッセージ配列を返す(空配列=OK)。 */
export function validateSubmissionFields(fields) {
  const errors = [];
  if (!fields.title) errors.push("「タイトル」が空です");
  if (!fields.author) errors.push("「作者名」が空です");
  if (!fields.description) errors.push("「説明」が空です");
  if (!fields.modelData) errors.push("「モデルデータ」が空です");
  if (!fields.licenseAgreed) {
    errors.push("「ライセンス同意」のチェックがありません(投稿モデルをMITライセンスで公開することへの同意が必要です)");
  }
  return errors;
}

/**
 * 「モデルデータ」欄の生の値から、共有リンクのbase64urlペイロード部分を取り出す。
 * 受け付ける入力:
 * - "#m="を含む完全な共有リンクURL(前後に説明文や改行が付いていても可)
 * - "#m="プレフィックスを含まない、base64urlペイロードそのもの
 * コードフェンス(```)で囲まれている場合は取り除く。空白・改行はペイロード内から除去する
 * (textareaでの折り返しや貼り付け時の改行に対応するため)。
 */
export function extractSharePayload(modelDataValue) {
  const trimmed = String(modelDataValue ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "モデルデータが空です" };
  }

  const unfenced = trimmed
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```\s*$/, "")
    .trim();

  const hashIndex = unfenced.indexOf("#m=");
  const afterHash = hashIndex >= 0 ? unfenced.slice(hashIndex + "#m=".length) : unfenced;
  const payload = afterHash.replace(/\s+/g, "");

  if (payload.length === 0) {
    return { ok: false, message: "モデルデータから共有リンクのペイロードを取り出せませんでした" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
    return {
      ok: false,
      message: "モデルデータの形式が不正です(base64url(英数字・-・_)以外の文字が含まれています)。共有リンクのコピー結果をそのまま貼り付けてください",
    };
  }
  return { ok: true, payload };
}

/** カンマ区切りのタグ文字列を、trim済み・空文字除去済みの配列に変換する。 */
export function parseTags(tagsValue) {
  if (!tagsValue) return [];
  return String(tagsValue)
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * タイトルをASCIIセーフなslugに変換する(小文字英数字とハイフンのみ、先頭は英数字)。
 * 日本語のみのタイトル等、変換結果が空になる場合は空文字列を返す(呼び出し側でfallbackする)。
 */
function stripCombiningMarks(str) {
  // 結合文字(アクセント記号等、Unicode "Combining Diacritical Marks"ブロック U+0300-U+036F)を
  // 数値レンジ比較で除去する(正規表現の文字クラスに結合文字そのものを書くと編集時に文字化けし
  // やすいため、意図的にcodePoint比較で実装している)。
  const COMBINING_MARK_START = 0x0300;
  const COMBINING_MARK_END = 0x036f;
  let out = "";
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= COMBINING_MARK_START && code <= COMBINING_MARK_END) continue;
    out += ch;
  }
  return out;
}

export function slugifyTitle(title) {
  if (typeof title !== "string") return "";
  const normalized = stripCombiningMarks(title.normalize("NFKD")).toLowerCase();
  const ascii = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return ascii;
}

/**
 * モデルの投稿先ディレクトリ名(slug)を決定する。タイトルからslug化できない場合は
 * `model-<issueNumber>` にfallbackする。既存slugと衝突する場合は末尾に連番を付与する。
 */
export function buildModelSlug(title, issueNumber, existingSlugs = []) {
  const base = slugifyTitle(title) || `model-${issueNumber}`;
  const existing = new Set(existingSlugs);
  if (!existing.has(base)) return base;
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (existing.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

/** meta.json(tests/project/models.test.tsのvalidateMetaShapeが要求する4フィールド)を組み立てる。 */
export function buildMetaJson(fields) {
  return {
    title: fields.title.trim(),
    author: fields.author.trim(),
    description: fields.description.trim(),
    tags: parseTags(fields.tags),
  };
}
