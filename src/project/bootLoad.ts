// 起動時ロード(共有リンク[Phase 40a]・モデルギャラリー[Phase 40c]共通)のオーケストレーション。
// このファイルは副作用のない純粋TypeScript(React/DOMに依存しない)。
// App.tsx側は resolve()/confirm()/onSuccess()等のコールバックを渡すだけで、
// 「自動保存と内容が異なる場合のみ確認ダイアログを出す→読み込む→トースト表示」の流れは
// この1本の runBootLoad() に共通化されている。

import type { CadDocument } from "../model/types";
import { serializeProject } from "./serialization";

/** 起動時ロードの解決結果(共有リンクのdecodeShareLinkPayload()と同じ形)。 */
export type BootLoadResult = { ok: true; doc: CadDocument } | { ok: false; message: string };

/**
 * 自動保存(存在する場合)と読み込もうとしているドキュメントの内容が異なるかどうか。
 * 異なる場合のみ、無言で上書きせず確認ダイアログを出す必要がある。
 */
export function shouldConfirmBootLoad(autosaved: CadDocument | null, incoming: CadDocument): boolean {
  return autosaved !== null && serializeProject(autosaved) !== serializeProject(incoming);
}

/**
 * 起動時ロードを実行する。
 * 1. resolve() でロード対象のCadDocumentを解決する(失敗時はonError()を呼んで終了)。
 * 2. isCancelled() が真を返した場合はここで打ち切る(Reactのeffectクリーンアップ対応)。
 * 3. 自動保存が存在し、かつ内容が異なる場合のみ confirm() で確認する(拒否時はonCancelled()を呼ぶ)。
 * 4. onSuccess(doc) を呼ぶ。
 */
export async function runBootLoad(params: {
  resolve: () => Promise<BootLoadResult>;
  isCancelled?: () => boolean;
  getAutosaved: () => CadDocument | null;
  confirm: (message: string) => boolean;
  confirmMessage: string;
  onSuccess: (doc: CadDocument) => void;
  onError: (message: string) => void;
  onCancelled?: () => void;
}): Promise<void> {
  const result = await params.resolve();
  if (params.isCancelled?.()) return;

  if (!result.ok) {
    params.onError(result.message);
    return;
  }

  const autosaved = params.getAutosaved();
  if (shouldConfirmBootLoad(autosaved, result.doc)) {
    const ok = params.confirm(params.confirmMessage);
    if (!ok) {
      params.onCancelled?.();
      return;
    }
  }

  params.onSuccess(result.doc);
}
