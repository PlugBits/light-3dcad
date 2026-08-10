// Phase 45: 貼り付けモード(AiGeneratePanelの「JSONを直接貼り付け」)のテキストを解析する純粋関数群。
// このファイルは副作用のない純粋TypeScript(DOM/Anthropic SDK等はimportしない)。
//
// 外部のAIチャット(ChatGPT等)の応答は、
// - Markdownのコードフェンス(```json ... ```)で囲まれていることが多い
// - Phase 45から、モデル本体だけでなくギャラリー投稿用メタ情報(タイトル/説明/タグ)も
//   併せて提案させる新形式({"model": {...}, "meta": {...}})になった
// - ただし、Phase 39以前の素の形式({"sketches": [...], "features": [...]})を貼り付けても
//   引き続き読み込めなければならない(後方互換)
// という3点を吸収する。

/** ギャラリー投稿(GallerySubmitDialog)のタイトル/説明/タグの事前提案。 */
export interface GallerySubmitMeta {
  title: string;
  description: string;
  tags: string[];
}

export type ParsePastePayloadResult =
  | { ok: true; model: unknown; meta: GallerySubmitMeta | null }
  | { ok: false; error: string };

/**
 * マークダウンのコードフェンス(```json ... ``` や ``` ... ```)を取り除く。
 * 外部AIチャットの応答は「説明文 + フェンス付きJSON」の形で返ってくることが多いため、
 * テキスト全体がフェンスで囲まれている場合はその中身を、フェンスが本文中に混在している場合は
 * 最初に見つかったフェンスブロックの中身を返す。フェンスが無ければ元のテキストをそのまま返す。
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const wholeMatch = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (wholeMatch) return wholeMatch[1].trim();
  const anyMatch = /```[^\n]*\n([\s\S]*?)```/.exec(trimmed);
  if (anyMatch) return anyMatch[1].trim();
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * meta(タイトル/説明/タグ)を読み取る。フィールドが欠けている/型が違う場合はそのフィールドだけ
 * 空文字列・空配列にフォールバックする(貼り付けモードはユーザーがどうせ編集できるため、
 * ここで厳密にエラーにはせず出来る範囲で拾う)。meta自体が存在しない/オブジェクトでない場合は
 * nullを返す(呼び出し側はpendingGalleryMetaを更新しない)。
 */
function readMeta(raw: unknown): GallerySubmitMeta | null {
  if (!isRecord(raw)) return null;
  const title = typeof raw.title === "string" ? raw.title : "";
  const description = typeof raw.description === "string" ? raw.description : "";
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [];
  return { title, description, tags };
}

/**
 * 貼り付けテキストを解析し、アウソリングモデル本体(compileAuthoringModel()にそのまま渡せる形)と
 * meta(あれば)を取り出す。
 * - コードフェンスは自動で剥がす。
 * - "model"キーを持つオブジェクトなら新形式({model, meta})とみなし、meta(あれば)も返す。
 * - "model"キーが無ければPhase 39以前の素の形式({sketches, features})とみなし、そのオブジェクト
 *   全体をmodelとして返す(meta: null)。
 * - JSON構文エラー、またはトップレベルがオブジェクトでない場合はエラーを返す。
 */
export function parsePastePayload(rawText: string): ParsePastePayloadResult {
  const stripped = stripCodeFence(rawText);
  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (err) {
    return { ok: false, error: `JSONの解析に失敗しました: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isRecord(json)) {
    return { ok: false, error: "JSONオブジェクトである必要があります" };
  }
  if ("model" in json) {
    return { ok: true, model: json.model, meta: readMeta(json.meta) };
  }
  // 後方互換: "model"キーが無ければ素の{sketches, features}形式とみなす。
  return { ok: true, model: json, meta: null };
}
