#!/usr/bin/env node
// 共有リンク(Phase 40a、src/project/shareLink.ts)と同じ base64url + gzip 形式のペイロードを
// ブラウザAPI(CompressionStream/DecompressionStream)を使わず node:zlib だけで伸長するための
// 独立モジュール。GitHub Actions(model-submission.yml)がTypeScriptビルドなしにモデル投稿の
// ペイロードを復元するために使う。プレーンJS(.mjs)のみで完結し、npm依存は追加しない。
//
// フォーマットの詳細はsrc/project/shareLink.tsを参照。往復すること(encodeShareLinkPayload()で
// 作ったデータをここでデコードできること)は tests/project/decodeShareLinkNode.test.ts で検証する。
import { gunzipSync } from "node:zlib";

/**
 * base64url(パディング無し、+/-, //_)文字列を通常のBufferに変換する。
 * 空白・改行は無視する(issueのtextareaに複数行で貼り付けられた場合の保険)。
 */
export function base64UrlToBuffer(data) {
  const cleaned = String(data).replace(/\s+/g, "");
  const base64 = cleaned.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * 共有リンクのbase64urlペイロード(location.hashの"#m="以降相当)をgzip伸長し、
 * .l3dcadと同じ形式のJSON文字列(ProjectFileのシリアライズ結果)を返す。
 * base64のデコードやgzip伸長に失敗した場合は例外を投げる(呼び出し側でtry/catchすること)。
 */
export function decodeShareLinkPayloadNode(payload) {
  const compressed = base64UrlToBuffer(payload);
  const jsonBytes = gunzipSync(compressed);
  return jsonBytes.toString("utf-8");
}
