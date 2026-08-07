// 拘束の追加・更新に伴うupdateDocument呼び出しの共通ラッパー(Phase 20b)。
// store.tsのupdateDocument()はsolveDocumentSketches()経由で矛盾(過拘束)を検出すると、
// ドキュメントは更新済みのまま(未解決のsegmentsで)errorMessage/errorFeatureIdをセットする
// (src/state/store.ts参照)。寸法ツール・寸法ラベル編集・拘束一覧パネルのいずれも「矛盾したら
// 直前の変更を自動で取り消す」挙動が必要なため、ここに一本化する。
import type { CadDocument, FeatureId } from "../model/types";
import { useCadStore } from "./store";

/**
 * mutateを適用してupdateDocument()を呼び、結果が対象sketchIdの矛盾エラーであれば
 * 変更前のドキュメントへ即座に復元する(アンドゥ履歴は使わず、選択状態やツールの
 * アクティブ状態を変えないように「適用前ドキュメントを保持して復元」する方式を取る)。
 * 復元した場合はonConflict(message)を呼ぶ(呼び出し側は一時メッセージ表示に使う)。
 *
 * describeConflict(頂点ベースの寸法指定、Phase 30新設、省略可)は、矛盾が検出されたときに
 * 適用前ドキュメント(before)から典型的な解なしケース(例: distancePointOrigin/distance[direct]の
 * 値が既に固定されている軸成分より小さい)を検出し、より具体的な誘導メッセージを返す
 * (検出できなければnullを返し、既定の汎用メッセージにフォールバックする)。
 */
export function updateDocumentWithConflictRollback(
  sketchId: FeatureId,
  mutate: (doc: CadDocument) => CadDocument,
  onConflict: (message: string) => void,
  describeConflict?: (before: CadDocument) => string | null,
) {
  const before = useCadStore.getState().doc;
  useCadStore.getState().updateDocument(mutate);
  const after = useCadStore.getState();
  if (after.status === "error" && after.errorFeatureId === sketchId) {
    useCadStore.getState().updateDocument(() => before);
    const message = describeConflict?.(before) ?? "拘束が矛盾するため取り消しました";
    onConflict(message);
  }
}
