// ねじフィーチャー(Phase 25c)のISO並目ねじプリセットテーブル。
// このファイルは副作用のない純粋TypeScript(Replicad等の重い依存はimportしない)。
import type { ThreadPreset } from "./types";

/** ISO並目ねじの呼び径・ピッチ(mm)。JIS B 0205(ISOメートル並目ねじ)の代表的なサイズ抜粋。 */
export const THREAD_PRESET_TABLE: Record<ThreadPreset, { nominal: number; pitch: number }> = {
  M3: { nominal: 3, pitch: 0.5 },
  M4: { nominal: 4, pitch: 0.7 },
  M5: { nominal: 5, pitch: 0.8 },
  M6: { nominal: 6, pitch: 1.0 },
  M8: { nominal: 8, pitch: 1.25 },
  M10: { nominal: 10, pitch: 1.5 },
  M12: { nominal: 12, pitch: 1.75 },
};

/** UIのプリセット選択肢用の並び順(呼び径の昇順)。 */
export const THREAD_PRESET_LIST: ThreadPreset[] = ["M3", "M4", "M5", "M6", "M8", "M10", "M12"];

/** 雄ねじの長さ上限(mm)。スパイク検証(実測)により、これを超えるとヘリカルsweepの評価時間が
 * 実用的でなくなる(数十秒〜)ため、UI・evaluatorの両方でこの値を上限とする。 */
export const MALE_THREAD_MAX_LENGTH = 20;

/** 呼び径(mm)。 */
export function threadNominalDiameter(preset: ThreadPreset): number {
  return THREAD_PRESET_TABLE[preset].nominal;
}

/** ピッチ(mm)。 */
export function threadPitch(preset: ThreadPreset): number {
  return THREAD_PRESET_TABLE[preset].pitch;
}

/**
 * 雌ねじ(簡易表現)の下穴径(mm)。規格の目安式「下穴径 = 呼び径 − ピッチ」を使う
 * (実務でも広く使われるタップ下穴径の近似式)。
 */
export function threadDrillDiameter(preset: ThreadPreset): number {
  const { nominal, pitch } = THREAD_PRESET_TABLE[preset];
  return nominal - pitch;
}
