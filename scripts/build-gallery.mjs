#!/usr/bin/env node
// モデルギャラリー(Phase 40c)の静的ページ生成。
// リポジトリルートの models/*/meta.json を走査し、dist/gallery/index.html にカードグリッドを
// 出力する(サムネイルはscripts/capture-thumbnails.mjsが別途 dist/gallery/thumbs/<slug>.png を
// 生成する。このスクリプトはHTML生成のみで、無ければ壊れたimgとして残る)。
// Node標準モジュールのみを使用する(新規npm依存の追加禁止)。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** models/<slug>/meta.json を読み、{ slug, title, author, description, tags } の配列(slug昇順)を返す。 */
export function loadModelEntries(modelsDir) {
  if (!existsSync(modelsDir)) return [];
  const slugs = readdirSync(modelsDir)
    .filter((name) => statSync(join(modelsDir, name)).isDirectory())
    .sort();
  const entries = [];
  for (const slug of slugs) {
    const metaPath = join(modelsDir, slug, "meta.json");
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    entries.push({
      slug,
      title: meta.title,
      author: meta.author,
      description: meta.description,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
    });
  }
  return entries;
}

function renderCard(entry) {
  const tagsHtml = entry.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  return `
      <article class="card">
        <a class="card-thumb-link" href="../?g=${encodeURIComponent(entry.slug)}">
          <img class="card-thumb" src="thumbs/${encodeURIComponent(entry.slug)}.png" alt="${escapeHtml(entry.title)}のサムネイル" loading="lazy" />
        </a>
        <div class="card-body">
          <h2 class="card-title">${escapeHtml(entry.title)}</h2>
          <p class="card-author">by ${escapeHtml(entry.author)}</p>
          <p class="card-description">${escapeHtml(entry.description)}</p>
          <div class="card-tags">${tagsHtml}</div>
          <a class="card-open-link" href="../?g=${encodeURIComponent(entry.slug)}">開く &rarr;</a>
        </div>
      </article>`;
}

export function renderGalleryHtml(entries) {
  const cardsHtml = entries.map(renderCard).join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>モデルギャラリー | light-3dcad</title>
<meta name="description" content="light-3dcadのコミュニティモデルギャラリー。ユーザーが投稿したパラメトリックCADモデルを閲覧・オープンできます。" />
<style>
  :root {
    --cad-bg: #f4f5f7;
    --cad-panel: #ffffff;
    --cad-panel-alt: #fafbfc;
    --cad-border: #d8dbe0;
    --cad-border-strong: #c2c6cd;
    --cad-text: #1f2328;
    --cad-text-muted: #5b6270;
    --cad-text-faint: #8a909c;
    --cad-hover: #eef1f5;
    --cad-accent: #2563eb;
    --cad-accent-hover: #1d4ed8;
    --cad-accent-soft: #dbe6fd;
    --cad-radius-sm: 4px;
    --cad-radius-md: 6px;
    --cad-radius-lg: 10px;
    --cad-shadow-sm: 0 1px 2px rgba(20, 24, 32, 0.06);
    --cad-shadow-md: 0 2px 8px rgba(20, 24, 32, 0.08);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", system-ui, Roboto, "Hiragino Sans", "Yu Gothic", sans-serif;
    background: var(--cad-bg);
    color: var(--cad-text);
  }
  header.page-header {
    background: var(--cad-panel);
    border-bottom: 1px solid var(--cad-border);
    box-shadow: var(--cad-shadow-sm);
    padding: 20px 24px;
  }
  .page-header-inner {
    max-width: 1080px;
    margin: 0 auto;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  h1.page-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
  }
  .page-subtitle {
    margin: 4px 0 0;
    color: var(--cad-text-muted);
    font-size: 13px;
  }
  a.back-link {
    color: var(--cad-accent);
    text-decoration: none;
    font-size: 13px;
    white-space: nowrap;
  }
  a.back-link:hover {
    color: var(--cad-accent-hover);
    text-decoration: underline;
  }
  main {
    max-width: 1080px;
    margin: 0 auto;
    padding: 24px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 20px;
  }
  .card {
    background: var(--cad-panel);
    border: 1px solid var(--cad-border);
    border-radius: var(--cad-radius-lg);
    box-shadow: var(--cad-shadow-sm);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: box-shadow 0.15s ease, border-color 0.15s ease;
  }
  .card:hover {
    box-shadow: var(--cad-shadow-md);
    border-color: var(--cad-border-strong);
  }
  .card-thumb-link {
    display: block;
    background: var(--cad-panel-alt);
    border-bottom: 1px solid var(--cad-border);
  }
  .card-thumb {
    display: block;
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: contain;
    background: var(--cad-panel-alt);
  }
  .card-body {
    padding: 14px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
  }
  .card-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
  }
  .card-author {
    margin: 0;
    font-size: 12px;
    color: var(--cad-text-faint);
  }
  .card-description {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--cad-text-muted);
    line-height: 1.5;
    flex: 1;
  }
  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }
  .tag {
    font-size: 10.5px;
    color: var(--cad-text-muted);
    background: var(--cad-panel-alt);
    border: 1px solid var(--cad-border);
    border-radius: 999px;
    padding: 2px 8px;
  }
  .card-open-link {
    display: inline-block;
    margin-top: 8px;
    align-self: flex-start;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--cad-accent);
    text-decoration: none;
    padding: 5px 10px;
    border-radius: var(--cad-radius-sm);
    background: var(--cad-accent-soft);
  }
  .card-open-link:hover {
    color: #ffffff;
    background: var(--cad-accent-hover);
  }
  .empty-state {
    color: var(--cad-text-muted);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --cad-bg: #1b1d21;
      --cad-panel: #24262b;
      --cad-panel-alt: #2c2f35;
      --cad-border: #3a3d44;
      --cad-border-strong: #4a4e57;
      --cad-text: #e7e9ec;
      --cad-text-muted: #a7acb6;
      --cad-text-faint: #7c828d;
      --cad-hover: #2c2f35;
      --cad-accent: #5b8dfa;
      --cad-accent-hover: #7ba3fb;
      --cad-accent-soft: #26314f;
    }
  }
</style>
</head>
<body>
<header class="page-header">
  <div class="page-header-inner">
    <div>
      <h1 class="page-title">モデルギャラリー</h1>
      <p class="page-subtitle">light-3dcadのコミュニティモデル一覧(${entries.length}件)</p>
    </div>
    <a class="back-link" href="../">&larr; light-3dcad アプリに戻る</a>
  </div>
</header>
<main>
${
  entries.length > 0
    ? `  <div class="grid">${cardsHtml}
  </div>`
    : `  <p class="empty-state">まだモデルが投稿されていません。</p>`
}
</main>
</body>
</html>
`;
}

function main() {
  const modelsDir = join(REPO_ROOT, "models");
  const outDir = join(REPO_ROOT, "dist", "gallery");
  const entries = loadModelEntries(modelsDir);

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "thumbs"), { recursive: true });
  writeFileSync(join(outDir, "index.html"), renderGalleryHtml(entries), "utf-8");

  console.log(`✓ モデルギャラリーを生成しました: dist/gallery/index.html (${entries.length}件)`);
  for (const entry of entries) {
    console.log(`  - ${entry.slug}: ${entry.title}`);
  }
}

// このファイルが直接実行された場合のみmain()を呼ぶ(capture-thumbnails.mjs等からのimportを許容)。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
