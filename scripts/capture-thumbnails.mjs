#!/usr/bin/env node
// モデルギャラリー(Phase 40c)のサムネイル生成。
// ビルド済みdist/(npm run build。GITHUB_PAGES環境変数を揃えることでvite.config.tsのbaseが
// 一致する)を`vite preview`でローカルに立ち上げ、各モデルを"?g=<slug>"で開いて
// レンダリング+fitToViewの完了を待ってからビューアのcanvas領域をスクリーンショットし、
// dist/gallery/thumbs/<slug>.pngへ保存する。
//
// playwright.config.tsと同じ方針で、プリインストール済みChromium
// (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers)があればそれを使う(無ければ標準解決に委ねる)。
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModelEntries } from "./build-gallery.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const PORT = 4173;
// vite.config.tsのbase計算と同じロジック(dist/はこのbase設定でビルドされている前提)。
const BASE = process.env.BASE_PATH ?? (process.env.GITHUB_PAGES === "true" ? "/light-3dcad/" : "/");

const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath = existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

const THUMB_WIDTH = 480;
const THUMB_HEIGHT = 360;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `vite preview` を起動し、`http://localhost:${PORT}` が応答するようになるまで待つ。
 * `npx vite`(シェル経由)ではなく`node_modules/vite/bin/vite.js`をNodeで直接実行する。
 * npxはローカル環境によっては`sh -c "vite preview ..."`を挟んでプロセスを起動することがあり、
 * その場合`child.kill()`が中間シェルにしか届かず実際のviteプロセス(孫プロセス)が残り続ける
 * (実機で確認: `npm run gallery:build`がサムネイル生成完了後も終了しない不具合の原因だった)。
 * Nodeで直接起動すれば中間プロセスが無く、killが確実にvite本体へ届く。
 */
async function startPreviewServer() {
  const viteBin = join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(
    process.execPath,
    [viteBin, "preview", "--outDir", "dist", "--port", String(PORT), "--strictPort"],
    { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`vite previewの起動に失敗しました:\n${stderr}`);
    }
    try {
      const res = await fetch(`http://localhost:${PORT}${BASE}`);
      if (res.ok || res.status === 304) break;
    } catch {
      // まだ起動していない。リトライする。
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("vite previewの起動待ちがタイムアウトしました");
    }
    await sleep(300);
  }
  return child;
}

/** 「状態: ready」表示になり、初期化オーバーレイが消えるまで待つ(e2e/helpers.tsのwaitForReadyと同じ考え方)。 */
async function waitForAppReady(page, timeout = 120_000) {
  await page.waitForSelector('[data-testid="init-overlay"]', { state: "detached", timeout }).catch(() => {});
  await page.waitForFunction(
    () => document.querySelector('[data-testid="status-text"]')?.textContent?.includes("状態: ready"),
    { timeout },
  );
}

async function captureOne(browser, slug, outDir) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto(`http://localhost:${PORT}${BASE}?g=${encodeURIComponent(slug)}`);
  await waitForAppReady(page);
  // fitToView()はメッシュ受信時に自動実行される(CadViewer)。ギャラリー読み込みの一時トースト
  // (「ギャラリーモデルを読み込みました」、3秒で自動的に消える、App.tsxのshowTransientMessage)が
  // サムネイルに写り込まないよう、それが消えるまで待つ。表示自体が無い場合(検出タイミングによる)は
  // 何もしない。
  await page
    .waitForSelector('[data-testid="constraint-conflict-toast"]', { state: "detached", timeout: 5_000 })
    .catch(() => {});
  // レンダリング1フレームが確実に反映されるよう短い猶予を置く(WebGLの描画完了を確実に待つための
  // 実用的なマージン)。
  await page.waitForTimeout(300);

  const canvas = page.locator('[data-testid="viewer-container"] canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error(`canvasが見つかりません(slug=${slug})`);

  // fitToView()はcanvas全体の中央にモデルを収める。canvasはビューポートより大きいことが多いため、
  // 左上を起点にクリップすると中央のモデルが写らない。canvas中央を基準にTHUMB_WIDTH×THUMB_HEIGHTを
  // 切り出す。
  const clipWidth = Math.min(THUMB_WIDTH, box.width);
  const clipHeight = Math.min(THUMB_HEIGHT, box.height);
  const clip = {
    x: box.x + (box.width - clipWidth) / 2,
    y: box.y + (box.height - clipHeight) / 2,
    width: clipWidth,
    height: clipHeight,
  };
  const outPath = join(outDir, `${slug}.png`);
  await page.screenshot({ path: outPath, clip });
  await page.close();

  if (pageErrors.length > 0) {
    throw new Error(`slug=${slug} の読み込み中にpageerrorが発生しました: ${pageErrors[0].message}`);
  }
  console.log(`  - ${slug}: thumbs/${slug}.png`);
}

async function main() {
  const modelsDir = join(REPO_ROOT, "models");
  const entries = loadModelEntries(modelsDir);
  if (entries.length === 0) {
    console.log("models/ にモデルが無いため、サムネイル生成をスキップします。");
    return;
  }

  const outDir = join(REPO_ROOT, "dist", "gallery", "thumbs");
  mkdirSync(outDir, { recursive: true });

  console.log(`vite previewを起動しています(port=${PORT}, base=${BASE})...`);
  const server = await startPreviewServer();
  let browser;
  try {
    browser = await chromium.launch(executablePath ? { executablePath } : {});
    console.log(`サムネイルを生成しています(${entries.length}件)...`);
    for (const entry of entries) {
      await captureOne(browser, entry.slug, outDir);
    }
  } finally {
    await browser?.close();
    // SIGTERM(既定)だと`vite preview`がkeep-aliveなソケットの終了待ちで終了しないことがある
    // (実機で確認: プレビューサーバーがSIGTERM後も生き残り、呼び出し元のnpmスクリプトが
    // 終了しない不具合)。サムネイル取得は完了しているため、即座に強制終了してよい。
    server.kill("SIGKILL");
  }

  console.log("✓ サムネイル生成が完了しました。");
}

main()
  .then(() => {
    // 上と同じ理由(vite preview/Playwrightのハンドルが残り得る)で、明示的にプロセスを終了する。
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
