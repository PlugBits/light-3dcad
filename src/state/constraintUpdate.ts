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
 * メッセージの優先順位:
 * 1. describeConflict(頂点ベースの寸法指定、Phase 30新設、省略可)は、矛盾が検出されたときに
 *    適用前ドキュメント(before)から典型的な解なしケース(例: distancePointOrigin/distance[direct]の
 *    値が既に固定されている軸成分より小さい)を検出し、より具体的な誘導メッセージを返す
 *    (検出できなければnullを返し、次点にフォールバックする)。
 * 2. after.errorMessage(実機報告対応、Phase 32③): src/sketch/solver.tsのsolveSketch()が
 *    残差最大の拘束を人間可読な名前で特定して組み立てた具体的なメッセージ(store.tsの
 *    updateDocument()がsolveDocumentSketches()の結果をそのままerrorMessageにセットする)。
 * 3. 上記いずれも得られない場合の汎用フォールバック。
 *
 * Phase 35c: store.tsのupdateDocument()はPlaneGCS初期化待ちのため戻り値がPromiseになった
 * (アプリ起動直後のごく短い初期化ウィンドウのみ実際に待つ、以後は実質同期的に解決する)。
 * ここではそのPromiseをawaitしてからafterの状態を読むことで、以前の同期実装と同じ判定順序を保つ。
 * 呼び出し側(App.tsx/SketchEditor.tsx/DimensionOverlay.tsx)はいずれもfire-and-forgetで
 * 呼んでおり、この関数自体の戻り値(Promise<void>)を待つ必要はない。
 */
export async function updateDocumentWithConflictRollback(
  sketchId: FeatureId,
  mutate: (doc: CadDocument) => CadDocument,
  onConflict: (message: string) => void,
  describeConflict?: (before: CadDocument) => string | null,
): Promise<void> {
  const before = useCadStore.getState().doc;
  await useCadStore.getState().updateDocument(mutate);
  const after = useCadStore.getState();
  if (after.status === "error" && after.errorFeatureId === sketchId) {
    const message = describeConflict?.(before) ?? after.errorMessage ?? "拘束が矛盾するため取り消しました";
    await useCadStore.getState().updateDocument(() => before);
    onConflict(message);
  }
}
