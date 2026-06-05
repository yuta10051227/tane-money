import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// 描画中のエラーを画面に表示（真っ白防止）。読み込み時エラーは index.html 側で捕捉。
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("App crashed:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", background: "#0F1115", color: "#E8EAED", padding: 20, fontFamily: "system-ui, sans-serif" }}>
          <h2 style={{ color: "#E2554B", fontSize: 16 }}>エラーが発生しました</h2>
          <p style={{ color: "#9AA1AC", fontSize: 13 }}>下の内容をコピーして共有してください。</p>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, background: "#171A21", padding: 12, borderRadius: 8 }}>
            {String(this.state.error?.stack || this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
