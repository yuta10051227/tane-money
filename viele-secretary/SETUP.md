# デスクトップ＆スマホで使う — セットアップ手順

両方の端末で同じデータを見るには **① Firebase（同期）** と **② Vercel（固定URL）** の設定が要ります。
所要 15〜20分。上から順にやればOK。詰まったらClaudeに「ここで止まった」と言えば続きを案内します。

チェックを埋めながら進めてください。

---

## ① Firebase（データ同期の土台）

- [ ] 1. <https://console.firebase.google.com> を開き **プロジェクトを追加**（名前は `viele-secretary` など。無料Sparkプランでよい / Googleアナリティクスはオフでよい）
- [ ] 2. 左メニュー **Authentication → 始める → Sign-in method → Google → 有効にする → 保存**
- [ ] 3. 左メニュー **Firestore Database → データベースの作成 → 本番モード → ロケはasia-northeast1（東京）→ 有効**
- [ ] 4. 歯車 ⚙ **プロジェクトの設定 → マイアプリ → ウェブ（`</>`）を追加**。アプリ名を入れて登録すると `firebaseConfig = { apiKey: ... }` が表示される。**この7つの値を控える**
- [ ] 5. **Firestore → ルール** タブを開き、このリポジトリの `firestore.rules` の中身を全部貼り付けて **公開**

> ※ 自分のアカウントだけに完全ロックしたい場合は、1回ログインした後に Authentication 画面で自分のUIDを確認し、`firestore.rules` の `allowlist = []` にそのUIDを入れて再公開。

---

## ② Vercelにデプロイ（固定URLを作る）

このリポジトリ（tane-money）の中の `viele-secretary/` フォルダだけを別プロジェクトとして公開する。
**Firebase設定はコードに組み込み済みなので、環境変数の入力は不要。**

- [ ] 1. <https://vercel.com> にGitHubでログイン → **Add New… → Project** → `yuta10051227/tane-money` を Import
- [ ] 2. **Root Directory** を `viele-secretary` に変更（Edit→フォルダ選択）。Framework は **Vite** が自動検出される
- [ ] 3. **Deploy** をそのまま押す → 数分でURL（例 `viele-secretary.vercel.app`）が出る
- [ ] 4. **Firebaseに戻り** Authentication → **Settings → 承認済みドメイン → ドメインを追加** → ③で出たVercelのドメイン（`viele-secretary.vercel.app`）を追加
      （これをやらないと本番URLでGoogleログインがブロックされる）

---

## ③ 各端末に設置（PWA）

- [ ] **デスクトップ（Chrome）**：URLを開く → アドレスバー右の **インストール** アイコン → デスクトップにアプリ追加
- [ ] **スマホ（Safari/Chrome）**：URLを開く → 共有 → **ホーム画面に追加**
- [ ] 両端末で **同じGoogleアカウント** でログイン → 同じデータが出れば成功 🎉

---

## よくある詰まり

| 症状 | 原因 / 対処 |
|------|------|
| 本番でログイン画面が出ずローカルモードのまま | Vercelの環境変数が未設定 or 名前ミス。①-4の7項目を再確認 → 再デプロイ |
| ログインで `auth/unauthorized-domain` | ②-5の承認済みドメイン追加を忘れている |
| ログインできるがデータが保存されない | `firestore.rules` を公開していない（①-5） |
| ローカルモードで入れたデータが本番に無い | localStorageは端末内のみ。同期モードのデータは別管理（初回にサンプルが入る） |

> ローカルで先に試したいときは `cp .env.example .env` して7項目を貼り、`npm run dev`。
