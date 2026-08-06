// page.evaluate() 内で参照するCadViewerのE2E用デバッグフックの型宣言。
// 実体は src/viewer/CadViewer.ts が import.meta.env.DEV 時のみ window に生やす。
export {};

declare global {
  interface Window {
    __cadViewerDebug?: {
      sketchLineCount: () => number;
      gridVisible: () => boolean;
      projectPoint: (world: [number, number, number]) => { x: number; y: number } | null;
      /** 寸法ツール中、直近のホバーでヒットしたentity対象の種別(ヒット無しはnull、Phase 21)。 */
      dimensionHoverEntityKind: () => "entity-radius" | "entity-width" | "entity-height" | null;
      /** 描画モード中の確定済み頂点列(ローカル2D)のスナップショット(Phase 21)。非アクティブ時は空配列。 */
      drawingPointsSnapshot: () => [number, number][];
    };
  }
}
