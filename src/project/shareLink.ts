// モデル共有リンク(Phase 40a)のエンコード/デコード。バックエンドを持たないため、
// プロジェクト(.l3dcadと同じJSON、src/project/serialization.ts参照)をgzip圧縮してURLの
// フラグメント(#m=...)に埋め込む方式で共有する。フラグメントはサーバーへ送信されない
// (どのGitHub Pagesでも動く)ため、静的ホスティングのみで完結する。
//
// このファイルは副作用のない純粋モジュール(重い依存importなし)。圧縮/伸長の実体は
// ByteTransform型として注入可能にしており、ブラウザではネイティブのCompressionStream/
// DecompressionStream(gzip)を使う一方、テスト環境でNode(node:zlib)実装を注入して
// 個別に検証できるようにする(vitestが動くNode自体もCompressionStream/DecompressionStreamを
// 持つため通常は不要だが、環境非依存の純粋な往復ロジックとして分離しておく)。

import type { CadDocument } from "../model/types";
import { deserializeProject, serializeProject } from "./serialization";

/** location.hash側のプレフィックス(このあとにbase64urlデータが続く)。 */
export const SHARE_LINK_HASH_PREFIX = "#m=";

/**
 * この文字数(base64urlデータ部分、プレフィックス除く)を超えると、一部のブラウザ/プロキシ/
 * チャットアプリ等でURLが途中で切れる恐れがある。コピー自体は行うが警告文言を添える閾値。
 */
export const SHARE_LINK_WARN_CHARS = 8000;

/**
 * 圧縮/伸長を行う関数の型。バイト列を受け取りバイト列を返す非同期関数。
 * Uint8Array<ArrayBuffer>で固定するのは、DOM の CompressionStream/DecompressionStream の
 * write() がSharedArrayBuffer裏付けのUint8Arrayを受け付けない(TypeScript 5.7+の
 * ArrayBufferView<ArrayBuffer>型付け)ため。
 */
export type ByteTransform = (input: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>;

/** 実行環境がネイティブのCompressionStream/DecompressionStream(gzip)を持つかどうか。 */
export function isShareLinkSupported(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

/** ReadableStreamの中身をすべて読み切って1つのUint8Arrayに連結する。 */
async function readAllChunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** ブラウザ標準のCompressionStreamでgzip圧縮する(既定の圧縮実装)。 */
export const gzipWithCompressionStream: ByteTransform = async (input) => {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  // write()/close()の失敗はreadable側の読み取り(readAllChunks)でも例外として観測されるため、
  // ここでは「未処理のPromise拒否」を防ぐためだけに個別に握りつぶす(呼び出し側は
  // readAllChunks側の例外だけを見ればよい)。
  const writeDone = writer.write(input).catch(() => {});
  const closeDone = writer.close().catch(() => {});
  const out = await readAllChunks(cs.readable);
  await Promise.all([writeDone, closeDone]);
  return out;
};

/** ブラウザ標準のDecompressionStreamでgzip伸長する(既定の伸長実装)。 */
export const gunzipWithDecompressionStream: ByteTransform = async (input) => {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const writeDone = writer.write(input).catch(() => {});
  const closeDone = writer.close().catch(() => {});
  const out = await readAllChunks(ds.readable);
  await Promise.all([writeDone, closeDone]);
  return out;
};

/** バイト列をbase64url(パディング無し、+/-, //_)文字列に変換する。 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url文字列をバイト列に変換する。不正な文字列の場合は例外を投げる。 */
function base64UrlToBytes(str: string): Uint8Array<ArrayBuffer> {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** encodeShareLinkPayload()の結果。 */
export interface ShareLinkPayload {
  /** location.hashの"#m="の後に続けるbase64urlデータ。 */
  data: string;
  /** 圧縮後のバイト数(トースト表示の「Nkb」用)。 */
  byteLength: number;
}

/**
 * CadDocumentをJSON化(.l3dcadと同じ封筒形式)→gzip圧縮→base64url化する。
 * compressは既定でgzipWithCompressionStream(ブラウザ標準)だが、テストではnode:zlib等の
 * 実装を注入できる。
 */
export async function encodeShareLinkPayload(
  doc: CadDocument,
  compress: ByteTransform = gzipWithCompressionStream,
): Promise<ShareLinkPayload> {
  const json = serializeProject(doc);
  const jsonBytes = new TextEncoder().encode(json);
  const compressed = await compress(jsonBytes);
  return { data: bytesToBase64Url(compressed), byteLength: compressed.byteLength };
}

/** location.origin + location.pathname + "#m=" + data の形の共有URLを組み立てる。 */
export function buildShareLinkUrl(origin: string, pathname: string, data: string): string {
  return `${origin}${pathname}${SHARE_LINK_HASH_PREFIX}${data}`;
}

export type DecodeShareLinkResult = { ok: true; doc: CadDocument } | { ok: false; message: string };

/**
 * base64urlデータ(location.hashの"#m="以降)をbase64urlデコード→gzip伸長→JSON解析→
 * deserializeProject()で検証、の順で復元する。各段階の失敗はすべて{ ok: false, message }として
 * 返し、例外を投げない(呼び出し側でtry/catchせずに済むようにする)。
 */
export async function decodeShareLinkPayload(
  data: string,
  decompress: ByteTransform = gunzipWithDecompressionStream,
): Promise<DecodeShareLinkResult> {
  let compressedBytes: Uint8Array<ArrayBuffer>;
  try {
    compressedBytes = base64UrlToBytes(data);
  } catch (err) {
    return { ok: false, message: `共有リンクのデータが不正です(base64のデコードに失敗しました): ${err instanceof Error ? err.message : String(err)}` };
  }

  let jsonBytes: Uint8Array;
  try {
    jsonBytes = await decompress(compressedBytes);
  } catch (err) {
    return { ok: false, message: `共有リンクのデータの展開(gzip伸長)に失敗しました: ${err instanceof Error ? err.message : String(err)}` };
  }

  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  } catch (err) {
    return { ok: false, message: `共有リンクのデータの文字コード変換に失敗しました: ${err instanceof Error ? err.message : String(err)}` };
  }

  const result = deserializeProject(json);
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  return { ok: true, doc: result.doc };
}

/**
 * location.hash(例: "#m=xxxx")から共有リンクのbase64urlデータ部分を取り出す。
 * "#m="で始まらない、またはデータ部分が空の場合はnull(共有リンクではない=通常起動)。
 */
export function extractShareLinkData(hash: string): string | null {
  if (!hash.startsWith(SHARE_LINK_HASH_PREFIX)) return null;
  const data = hash.slice(SHARE_LINK_HASH_PREFIX.length);
  return data.length > 0 ? data : null;
}
