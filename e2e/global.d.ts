// page.evaluate() 内で参照するCadViewer/storeのE2E用デバッグフックの型宣言。
// 実体は src/viewer/CadViewer.ts / src/state/store.ts が import.meta.env.DEV 時のみ window に生やす。
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
      /** カメラ〜注視点の距離(mm、Phase 29a、自動フィット検証用)。 */
      cameraDistance: () => number;
      /**
       * 寸法ツール中のヒット判定対象セグメントの現在の座標スナップショット(Phase 30、頂点ベースの
       * 寸法指定検証用)。kind/bulge(Phase 42b)は円弧セグメントの識別・接線検証のE2Eで使う。
       */
      dimensionToolSegmentsSnapshot: () => { id: string; p1: [number, number]; p2: [number, number]; kind: "line" | "arc"; bulge?: number }[];
      /** ねじの簡易表示(Phase 41)オーバーレイの現在の線本数(円+ヘリックス)。 */
      threadAnnotationLineCount: () => number;
      /** 地面の無限グリッド(Phase 44)の現在の可視状態。 */
      groundGridVisible: () => boolean;
    };
    /**
     * Workerへ「故意にthrowする」メッセージを送り、実際のWorkerクラッシュ(Workerのerrorイベント)を
     * 再現する(開発ビルド限定、Phase 29a)。src/state/store.ts参照。
     */
    __cadDebugCrashWorker?: () => void;
  }
}
