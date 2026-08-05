// page.evaluate() 内で参照するCadViewerのE2E用デバッグフックの型宣言。
// 実体は src/viewer/CadViewer.ts が import.meta.env.DEV 時のみ window に生やす。
export {};

declare global {
  interface Window {
    __cadViewerDebug?: {
      sketchLineCount: () => number;
      gridVisible: () => boolean;
    };
  }
}
