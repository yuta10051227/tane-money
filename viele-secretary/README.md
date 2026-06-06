# VIELE secretary

一人社長（施術家／コンテンツ発信者）のための秘書ダッシュボード。
React + Vite + Firebase（Auth / Firestore）。PC・スマホで同期し、本人だけが閲覧。PWAでデスクトップ／ホーム画面に設置可能。

## 機能

- **出張・遠征の逆算チェーン** — 型テンプレ（遠方登壇 / 日帰り / 海外実習）。本番日から逆算して手配項目の締切と信号（🟢済 / 🟠もうすぐ / 🔴遅れ）を自動表示
- **締切からの逆算（二段ローンチ）** — LINE先行登録 → セミナー本申込 を時系列で並べ、残日数を信号表示
- **今週の時間配分メーター** — 施術 / 制作 / 集客 / 経営 ＋「労働 ⟷ 仕組み」の2軸で可視化
- **今日の予定 / コンテンツ制作サイクル / 請求・お金 / 追加タスク**
- **固定費・サブスク管理（タブ）** — 月払い/四半期/半年/年払いを登録すると、次回請求日・月合計・年換算を「今日」基準で毎回自動算出（月替わりで自動繰越）。請求前リマインド（信号＋任意のブラウザ通知）・カテゴリ内訳付き
- **売上（タブ）** — 定期収入（顧問料・月額講座など）を登録すれば毎月自動計上。単発売上の記録、12ヶ月推移、そして固定費と連動した **今月の手残り＝売上 − 固定費** を表示
- **Firestore同期** — ログイン本人のデータのみ、全端末で即同期

## デスクトップ＆スマホで使う

両端末で同じデータを同期するには Firebase ＋ Vercel の設定が必要です。
👉 **クリック順の手順は [`SETUP.md`](./SETUP.md) を参照**（15〜20分）。

## ローカル開発

```bash
npm install
npm run dev            # http://localhost:5173 （.env無しでもローカルモードで動く）
```

Firebaseの値を `.env`（`cp .env.example .env`）に入れると、ログイン＋クラウド同期モードに自動で切り替わります。

## Firebaseセットアップ（手作業）

1. <https://console.firebase.google.com> で新規プロジェクト作成（無料Sparkで可）
2. Authentication → Sign-in method → **Google** を有効化
3. Firestore Database → 本番モードで作成
4. プロジェクト設定 ⚙ → マイアプリ → ウェブアプリ（</>）追加 → `firebaseConfig` を控える
5. `.env.example` を `.env` にコピーし、`VITE_FB_*` に値を貼る
6. `firestore.rules` の内容を Firestore → ルール に貼って公開（自分のUIDだけにロックしたい場合は ALLOWLIST にUIDを追記）

## Vercelデプロイ

1. このフォルダをGitHubへ push
2. Vercelで Import（Vite自動検出）
3. **Environment Variables に `.env` と同じ7項目を登録**（忘れると本番で動かない）
4. Deploy → 固定URL取得
5. Firebase → Authentication → Settings → 承認済みドメインに Vercel ドメインを追加

## 構成

```
viele-secretary/
├─ package.json / vite.config.js / index.html
├─ .env.example            # Firebase設定の雛形
├─ firestore.rules         # 本人だけ読み書き可
├─ public/icon-512.png     # PWAアイコン
└─ src/
   ├─ main.jsx
   ├─ firebase.js          # Firebase初期化（envから読む）
   ├─ useCloud.js          # Firestore同期フック
   └─ App.jsx              # ダッシュボード本体＋ログインゲート
```

## データ

初回ログイン時、`src/App.jsx` の `makeSeed()`（trips / deadlines / content / money / tasks）が自動でFirestoreへ書き込まれる。中身はアプリ上で編集・追加・削除でき、すべて同期される。
`LOG`（今週の予定・時間配分の元データ）は現状コード内の定数で、Phase2でGoogleカレンダー連携に差し替える前提。

## 次のフェーズ（未実装・設計のみ）

- **Googleカレンダー連携** — 役割ごとに4カレンダー（施術/制作/集客/経営）→ 由来で `cat` を判定して `LOG` に流し込む（`calendar.readonly`）
- **Gmailトリアージ** — 「決済・請求・入金」「セミナー・イベント申込」の2種だけ前に出す（取りこぼし防止）
- どちらも OAuth が必要なため Vercel に `/api`（または Firebase Functions）を追加する
