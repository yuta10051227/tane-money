import React from "react";
import ReactDOM from "react-dom/client";

const root = ReactDOM.createRoot(document.getElementById("root"));

// エラーを画面に表示（真っ白防止）
function ErrorView({ error }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0F1115", color: "#E8EAED", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ color: "#E2554B", fontSize: 16 }}>エラーが発生しました</h2>
      <p style={{ color: "#9AA1AC", fontSize: 13 }}>下の内容をそのままコピーして共有してください。</p>
      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, background: "#171A21", padding: 12, borderRadius: 8 }}>
        {String(error?.stack || error)}
      </pre>
    </div>
  );
}

// 描画中のエラーを捕捉
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
    return this.state.error ? <ErrorView error={this.state.error} /> : this.props.children;
  }
}

// App（および firebase.js 等）の読み込み時エラーも捕捉する
import("./App.jsx")
  .then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  })
  .catch((error) => {
    console.error("Module load failed:", error);
    root.render(<ErrorView error={error} />);
  });
