// 数値表示用の共通フォーマッタ(左パネルの数値入力・拘束一覧、ユーザー報告対応)。
// 内部値(state)は常にフル精度のまま保持し、表示のみここで丸める。数値入力欄はNumberField
// (src/components/SketchEditor.tsx)がフォーカス中は生の入力文字列を表示するため、ユーザーが
// 小数3桁を超える値を入力してもこの丸めで上書きされることはない。
const DISPLAY_DECIMALS = 3;

/**
 * mm値を表示用に小数3桁へ丸める。JSのNumber→String変換が末尾ゼロを自動的に落とすため、
 * 呼び出し側は`${formatMm(v)}mm`のようにテンプレートリテラルへそのまま埋め込めば
 * 「丸め+末尾ゼロ除去」になる(例: 10.5000001 -> 10.5、10 -> 10、-9.999999999 -> -10)。
 * NaN/非有限値はそのまま返す(空文字入力中など呼び出し側の一時的な状態を壊さないため)。
 */
export function formatMm(value: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** DISPLAY_DECIMALS;
  return Math.round(value * factor) / factor;
}
