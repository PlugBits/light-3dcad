// モデルギャラリー(Phase 40c)の起動時ロード(URLクエリ "?g=<slug>")。
// リポジトリルートの models/<slug>/model.l3dcad を(ビルド後はdist/modelsへコピーされたものを)
// fetchし、deserializeProject()で検証する。vite.config.tsのカスタムプラグイン
// (light3dcad-models-assets)が devサーバーでの /models/ 配信、ビルド後の dist/models への
// コピーの両方を担う(models/ 自体がコントリビューションの起点=正本のまま)。
// このファイルは副作用のない純粋TypeScript(fetch呼び出し自体は関数内に閉じ込め、
// URL文字列操作はDOM非依存)。

import { deserializeProject } from "./serialization";
import type { BootLoadResult } from "./bootLoad";

/** location.search から起動時に読み込むギャラリーモデルのslug("g"パラメータ)を取り出す。無ければnull。 */
export function extractGallerySlug(search: string): string | null {
  const params = new URLSearchParams(search);
  const slug = params.get("g");
  return slug && slug.length > 0 ? slug : null;
}

/**
 * "g"パラメータだけを取り除いたクエリ文字列を返す(先頭"?"付き、他のパラメータが無ければ空文字列)。
 * 他のクエリパラメータがあれば保持する。
 */
export function stripGallerySlugFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("g");
  const rest = params.toString();
  return rest.length > 0 ? `?${rest}` : "";
}

/**
 * models/<slug>/model.l3dcad をfetchしてCadDocumentへ復元する。baseUrl は import.meta.env.BASE_URL
 * (末尾"/"付き)を呼び出し側から渡す。404・ネットワークエラー・不正なJSON/バリデーション失敗は
 * すべて{ ok:false, message }として返し、例外を投げない(decodeShareLinkPayload()と同じ方針)。
 */
export async function fetchGalleryModel(baseUrl: string, slug: string): Promise<BootLoadResult> {
  const url = `${baseUrl}models/${encodeURIComponent(slug)}/model.l3dcad`;
  let text: string;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { ok: false, message: `モデルが見つかりません(${slug}、HTTP ${res.status})` };
    }
    text = await res.text();
  } catch (err) {
    return {
      ok: false,
      message: `モデルの取得に失敗しました(${slug}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return deserializeProject(text);
}
