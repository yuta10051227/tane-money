# Tane Money — Claude Code 行動ルール

このファイルはClaude Codeが読み込む設定です。
プロジェクトの全作業でこのルールを最優先に従ってください。

---

## プロジェクト概要

| 項目 | 内容 |
|------|------|
| アプリ名 | Tane Money（タネマネー） |
| 本番URL | https://tane-money.vercel.app |
| GitHub | https://github.com/yuta10051227/tane-money |
| ソースファイル | `okozukai-v9.jsx`（編集はここだけ） |
| デプロイ対象 | `index.html`（ビルド成果物） |

---

## 鉄則：作業の流れ

```
編集（okozukai-v9.jsx）
  ↓
npm run check      ← 必ず実行。exit 0 以外はデプロイ禁止
  ↓
npm run build      ← index.html を再生成
  ↓
動作確認（http://localhost:3000）
  ↓
npm run deploy "fix: 変更内容を一行で"
```

## 禁止事項

- `check.py` が失敗した状態でのデプロイ
- `index.html` を直接編集すること（ビルドで上書きされる）
- 未確認の状態でのpush

---

## コード編集ルール

### 1. タブ変更は3点セット（守らないと動かない）

```
① MAIN_TABS 配列
② tabAlias マッピング
③ render側の effectiveTab==="X" 条件式
```

### 2. サブタブはstateで分岐

```jsx
// NG: 同じeffectiveTabで複数ブロック（全部同時表示される）
{effectiveTab==="money" && <家計簿/>}
{effectiveTab==="money" && <目標/>}

// OK: stateで1つだけ
{effectiveTab==="money" && monTab==="kakeibo" && <家計簿/>}
{effectiveTab==="money" && monTab==="goals" && <目標/>}
```

### 3. カラー定数（変更禁止）

```javascript
GP="#187A4E"  G="#34C77B"   GS="#DDF3E7"
GOLD="#E8B83E" GOLDS="#FFF1CB"
R="#D95C55"   RS="#FCE6E4"
B="#3478D4"   BS="#E5F0FF"
P="#7B61C9"   PS="#EFEAFE"
BG="#F7F5EF"  CARD="#FFFFFF" CARDS="#F2EFE7"
TEXT="#18231D" TEXTS="#59645E" MUTED="#929B95" BORDER="#E8E3D8"
Y=GOLD（後方互換alias）  SHADOW="0 4px 16px rgba(24,35,29,0.05)"（後方互換alias）
```

### 4. 使用禁止

- `lucide-react` のアイコン（未インポート）→ 絵文字か自前SVGで代替
- `O`（旧orange変数）→ `P` を使う

### 5. 新コンポーネント追加時チェック

```
□ スコープ内で全変数が定義されているか
□ props は親から受け取るか
□ lucide-react を使っていないか
□ グローバル関数（uid, bal, addLogToFirestore等）は存在するか
```

### 6. str_replace 前に必ずview確認

- 置換対象が1箇所のみであることを確認してから実行

---

## モード・画面の構造

### displayMode による分岐

| displayMode | 対象 | タブ構成 |
|-------------|------|---------|
| `teen` | 中高生 | daily / activity / money / learn / more |
| `junior` | 小学生 | daily / tasks / goals / more |
| `adult` | 保護者 | daily / activity / money / learn / more |

### isJunior チェック

```javascript
const isJunior = child.displayMode === "junior";
// Junior専用UI: moneyタブはkakeiboなし、learnタブなし
```

### 画面遷移（screen state）

```
home
  ├── pin-child   → child（ChildScreen）
  ├── pin-parent  → parent（ChildScreen）
  ├── family_public（FamilyPublicScreen）← 子のランキングから遷移
  ├── family_guardian（FamilyGuardianScreen）← 親のランキングから遷移
  └── pin-reset
```

---

## ログtype（変更禁止）

```
good / bad / daily / grant / reward / gacha
interest / invest_buy / invest_sell / forex_buy / forex_sell
badge / tips
```

---

## デプロイコマンド早見表

```bash
npm run check          # ソースチェックのみ
npm run build          # ビルドのみ
npm run serve          # ローカル確認（http://localhost:3000）
npm run deploy "メッセージ"  # check→build→commit→push 一括
```

---

## キャッシュ更新ルール（古い版が端末に残る問題の恒久対策）

**もう手作業でキャッシュ対応をしない。`npm run build` が自動でやる。** 仕組み：

1. `build` が `index.html` の `<meta tane-version>` と `version.json` に**同じ版（コミットhash）**を刻む。
2. `build` が `sw.js` の `const CACHE = 'tane-money-<version>'` を**毎回書き換える** → デプロイ毎にSWが必ず更新され、旧キャッシュを掃除＋全ページへ更新通知。
3. アプリは起動中に `version.json` を `no-store` で定期取得し、版が違えば画面下に「**更新する**」バーを表示 → タップでキャッシュ全消し＋リロードして最新へ揃える。

**やってよい / ダメ：**
- ✅ `okozukai-v9.jsx` を編集 → `npm run check` → `npm run build` → デプロイ（`version.json`/`sw.js`は自動更新される）
- ✅ デプロイ時は `version.json`・`sw.js` を必ずコミットに含める（`deploy.sh`が自動addする）
- ❌ `sw.js` の `CACHE` 名を手で固定値に戻さない（buildが版を刻む前提）
- ❌ HTML/アプリ本体を SW で「キャッシュ優先」にしない（必ずネットワーク優先）

**動作確認：** デプロイ後、旧版を開いた端末に数分以内（or 再フォーカス時）に「更新する」バーが出ればOK。

## バックエンド（サーバープッシュ＋課金）

`api/*`（Vercel Serverless）＝Stripe課金・FCM再エンゲージ。設定は `BACKEND_SETUP.md`。
鍵未設定でもアプリは従来動作（各機能は安全に無効化）。`TANE_VAPID_KEY`/`TANE_API_BASE` は `okozukai-v9.jsx` 先頭。

---

## 過去に発生したバグ（再発防止）

| バグ | 原因 | 対策 |
|------|------|------|
| 生コード画面表示 | JSX `{` なしの条件式 | check.py パースチェック |
| Can't find variable: O | 削除済み変数の参照 | 未定義変数スキャン |
| タブバー2重表示 | 旧バーを残したまま新バー追加 | str_replace前にview確認 |
| タブ押してもコンテンツ出ない | MAIN_TABS変更後にrender条件を変えなかった | 3点セット徹底 |
| ためるタブでエラー | tabAliasで3画面が全て同じeffectiveTabに集約 | サブタブはstateで分岐 |
| 端末ごとに古い版が残る | アプリに更新検知が無く、SWのCACHE名も不変だった | build が version.json/sw.js を自動更新＋アプリが「更新する」バー表示 |
