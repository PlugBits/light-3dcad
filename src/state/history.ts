// 簡易アンドゥ/リドゥ用の履歴スタック(Phase 14)。React/Zustandに依存しない純粋関数のみで構成する
// (テスト容易性優先)。ジェネリックTはCadDocumentを想定するが、このモジュール自体はCADに依存しない。
// スナップショットのディープコピー(structuredClone等)は呼び出し側の責務とする(このモジュールは
// 渡された値をそのまま保持・返すのみ)。

/** 履歴の上限件数(pastがこれを超えたら古いものから捨てる)。 */
export const HISTORY_LIMIT = 50;

/** アンドゥ(past)/リドゥ(future)スタック。past末尾が直近の変更前スナップショット。 */
export interface HistoryState<T> {
  past: T[];
  future: T[];
}

/** 空の履歴状態を作る。 */
export function createHistoryState<T>(): HistoryState<T> {
  return { past: [], future: [] };
}

/**
 * ドキュメント変更時に呼ぶ。変更前のスナップショット(previous)をpastへ積み、futureはクリアする
 * (新しい変更をしたらリドゥ履歴は無効になるため)。pastがHISTORY_LIMITを超えたら先頭(最古)を捨てる。
 */
export function pushHistory<T>(state: HistoryState<T>, previous: T): HistoryState<T> {
  const past = [...state.past, previous];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, future: [] };
}

/**
 * 1つ前のスナップショットに戻る。current(戻る直前の現在値)はfutureの先頭に積まれ、
 * redo()で戻れるようにする。pastが空なら何もせずnullを返す。
 */
export function undoHistory<T>(state: HistoryState<T>, current: T): { state: HistoryState<T>; doc: T } | null {
  if (state.past.length === 0) return null;
  const doc = state.past[state.past.length - 1];
  const past = state.past.slice(0, -1);
  const future = [current, ...state.future];
  return { state: { past, future }, doc };
}

/**
 * undo()で戻した変更をやり直す。current(やり直す直前の現在値)はpastの末尾に積まれ、
 * 再度undo()できるようにする。futureが空なら何もせずnullを返す。
 */
export function redoHistory<T>(state: HistoryState<T>, current: T): { state: HistoryState<T>; doc: T } | null {
  if (state.future.length === 0) return null;
  const doc = state.future[0];
  const future = state.future.slice(1);
  const past = [...state.past, current];
  return { state: { past, future }, doc };
}
