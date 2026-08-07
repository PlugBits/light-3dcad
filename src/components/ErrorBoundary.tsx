// アプリ全体を囲むReactエラーバウンダリ(Phase 29a、堅牢性強化)。レンダリング中に予期しない
// 例外が起きても白画面にならないようにする(src/state/store.tsのWorkerクラッシュ対策とは独立した、
// UIツリー側の防御。Workerはメインスレッドの外で動くためWorker内の例外はここでは捕捉できず、
// 逆にReactのレンダー例外はWorker側の対策では防げないため、両方が必要)。
// 復旧手段はページリロードのみ(内部状態の部分的な巻き戻しは複雑になるため単純さを優先する)。
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] 予期しないエラーを捕捉しました", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        data-testid="app-error-boundary"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          gap: 16,
          fontFamily: "sans-serif",
          padding: 24,
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>予期しないエラーが発生しました</h1>
        <pre
          style={{
            maxWidth: 640,
            whiteSpace: "pre-wrap",
            fontSize: 12,
            opacity: 0.8,
            background: "rgba(255,0,0,0.08)",
            padding: 12,
            borderRadius: 6,
          }}
        >
          {error.message}
        </pre>
        <button type="button" data-testid="btn-error-boundary-reload" onClick={() => window.location.reload()}>
          リロード
        </button>
      </div>
    );
  }
}
