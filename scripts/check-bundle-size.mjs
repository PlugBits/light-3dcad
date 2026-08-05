#!/usr/bin/env node
// dist/assets 配下の各JSファイルのgzipサイズを一覧表示し、UIバンドル(index-*.js。
// cad.worker-*.jsは対象外)のgzipサイズが閾値を超えたら非ゼロ終了するCIゲート。
// npm run build の後に `npm run size` として実行する想定(.github/workflows/deploy.yml参照)。
// Node標準モジュールのみを使用する(新規npm依存の追加禁止のため)。
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/** UIバンドル(index-*.js)のgzipサイズ上限(バイト)。超えたらCI失敗にする。 */
const UI_BUNDLE_GZIP_LIMIT_BYTES = 350 * 1024;

const distAssetsDir = join(process.cwd(), "dist", "assets");

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function main() {
  let entries;
  try {
    entries = readdirSync(distAssetsDir);
  } catch {
    console.error(`dist/assets が見つかりません(${distAssetsDir})。先に \`npm run build\` を実行してください。`);
    process.exit(1);
  }

  const files = entries
    .map((name) => join(distAssetsDir, name))
    .filter((path) => statSync(path).isFile());

  if (files.length === 0) {
    console.error("dist/assets にファイルがありません。ビルドに失敗している可能性があります。");
    process.exit(1);
  }

  console.log("バンドルサイズ一覧(dist/assets):");
  let uiBundleGzipBytes = null;
  let uiBundleName = null;
  let exceeded = false;

  for (const path of files.sort()) {
    const ext = extname(path);
    const name = path.split("/").pop();
    const raw = readFileSync(path);
    const rawBytes = raw.byteLength;

    if (ext === ".wasm") {
      // WASMは表示のみ(閾値なし)。gzip転送されるかは配信環境依存のため生サイズのみ表示する。
      console.log(`  ${name}: raw ${formatKb(rawBytes)} (閾値なし)`);
      continue;
    }

    if (ext !== ".js") {
      continue;
    }

    const gzipBytes = gzipSync(raw).byteLength;
    // UIバンドル: Worker(cad.worker-*.js)を除いたindex-*.js等。cad.worker側はWASM同様、
    // Workerスレッド専用でUI初回ロードのブロッキング要因にならないため閾値対象外にする。
    const isUiBundle = !name.startsWith("cad.worker");
    console.log(`  ${name}: raw ${formatKb(rawBytes)} / gzip ${formatKb(gzipBytes)}${isUiBundle ? "" : " (Workerバンドル、閾値対象外)"}`);

    if (isUiBundle) {
      if (uiBundleGzipBytes === null || gzipBytes > uiBundleGzipBytes) {
        uiBundleGzipBytes = gzipBytes;
        uiBundleName = name;
      }
    }
  }

  if (uiBundleGzipBytes === null) {
    console.error("UIバンドル(index-*.js)が見つかりませんでした。ビルド出力を確認してください。");
    process.exit(1);
  }

  console.log("");
  console.log(
    `UIバンドル(${uiBundleName})gzip: ${formatKb(uiBundleGzipBytes)} / 上限 ${formatKb(UI_BUNDLE_GZIP_LIMIT_BYTES)}`,
  );

  if (uiBundleGzipBytes > UI_BUNDLE_GZIP_LIMIT_BYTES) {
    exceeded = true;
  }

  if (exceeded) {
    console.error(
      `✗ UIバンドルのgzipサイズが上限(${formatKb(UI_BUNDLE_GZIP_LIMIT_BYTES)})を超えました。依存追加やコード量の増加を見直してください。`,
    );
    process.exit(1);
  }

  console.log("✓ UIバンドルのgzipサイズは上限内です。");
}

main();
