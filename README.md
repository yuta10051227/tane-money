# Tane Money（タネマネー）

「お金は、未来を育てるタネ。」— 家族向けおこづかい・ポイント管理 PWA

| 項目 | URL |
|------|-----|
| 本番 | https://tane-money.vercel.app |
| GitHub | https://github.com/yuta10051227/tane-money |
| テスト用ファミリーコード | `TANE-YUTA` |

## ファイル構成

| ファイル | 説明 |
|----------|------|
| `okozukai-v9.jsx` | ソース（編集はここ） |
| `index.html` | デプロイ用（Babel 変換済み JS 埋め込み） |
| `check.py` | デプロイ前チェック |
| `CLAUDE_CODE_HANDOVER.md` | Claude Code 用ハンドオーバー |
| `TANE_MONEY_RULES.md` | 開発ルール・バグ防止 |
| `PROJECT_LOG.md` | プロジェクト運営ログ |
| `manifest.json` / `vercel.json` | PWA・Vercel 設定 |

## ローカル開発

```bash
npm install
python3 check.py okozukai-v9.jsx   # 編集後は必ず実行
npm run build                      # okozukai-v9.jsx → index.html
npm run serve                      # http://localhost:3000
```

## デプロイ

`check.py` が exit 0 のあと、`index.html` と `okozukai-v9.jsx` を GitHub に push → Vercel 自動デプロイ。

詳細は `CLAUDE_CODE_HANDOVER.md` を参照。
