// フィーチャーIDおよびスケッチエンティティID生成。
// ブラウザ/Worker/Node(Vitest)いずれの環境でも動くようにフォールバックを用意する。

let fallbackCounter = 0;

function randomToken(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    return g.crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `${Date.now().toString(36)}-${fallbackCounter}-${Math.random().toString(36).slice(2)}`;
}

/** 接頭辞付きの一意なIDを生成する(例: "sketch-<uuid>")。 */
export function generateId(prefix: string): string {
  return `${prefix}-${randomToken()}`;
}
