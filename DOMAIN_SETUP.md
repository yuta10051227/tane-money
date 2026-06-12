# 独自ドメイン設定手順（tanemoney.app）

目的：`tane-money.vercel.app` → **`tanemoney.app`** へ移行する。
理由：①信頼感 ②将来 Cloudflare Pages へ移すときURLが変わらず**既存ユーザーのPWA/データが切れない** ③ベンダーロック回避。

> ⚠️ 重要：**ユーザーが付く前（ローンチ直後の早い段階）に切り替えること。**
> localStorage と PWA はオリジン（ドメイン）単位。後からドメインを変えると、既存ユーザーの
> ホーム画面アプリ・キャッシュした家族コードが切れる（Firestoreから再入力で復旧は可能だが
> 「データ消えた」騒ぎになる）。

---

## ステップ1：ドメイン購入（あなたの作業・年約¥2,000）

- 推奨レジストラ：**Cloudflare Registrar**（原価販売・上乗せなし。将来の Cloudflare Pages 移行と相性良）
- 代替：お名前.com / Google Domains後継(Squarespace) など
- 取得：`tanemoney.app`（`.app` は常時HTTPS必須＝このアプリと好相性）

## ステップ2：Vercel にカスタムドメインを追加

1. Vercel ダッシュボード → プロジェクト → Settings → Domains → `tanemoney.app` を追加
2. Vercel が表示するDNSレコードを、ドメインのDNSに設定：
   - Apex（`tanemoney.app`）：A レコード `76.76.21.21`
   - `www`：CNAME `cname.vercel-dns.com`
   （※Vercelの画面に出る最新値を優先）
3. 反映後、Vercel側で `tanemoney.app` を Primary に設定。`tane-money.vercel.app` からのリダイレクトはVercelが自動付与

## ステップ3：Firebase の承認済みドメインに追加（必須）

匿名認証は**承認済みドメインでしか動かない**。これを忘れると新ドメインでログイン/同期が失敗する。

1. Firebase Console → Authentication → Settings → 承認済みドメイン
2. **`tanemoney.app` を追加**（`tane-money.vercel.app` は当面残してOK）
3. App Check を使う場合は、reCAPTCHA の許可ドメインにも `tanemoney.app` を追加

## ステップ4：コード内のURL表記を差し替え（こちらで実施可）

切替時に直すのは以下6箇所（機能には影響しない表示・検証用）：

| ファイル:行 | 内容 | 変更 |
|---|---|---|
| `okozukai-v9.jsx:6387` | シェア文言のフッターURL | `tane-money.vercel.app` → `tanemoney.app` |
| `okozukai-v9.jsx:6393` | 画面下の透かしURL | 同上 |
| `scripts/deploy.sh:56,64` | デプロイ後の反映確認URL | 同上 |
| `scripts/verify-deploy.sh:9,34` | 検証URL | 同上 |
| `CLAUDE.md:13` | ドキュメントの本番URL | 同上 |

- `manifest.json` の `start_url:"/"` は**相対なので変更不要**。
- ※任意：`index.html` に OGP（`og:url`/`og:image`/`og:title`/`og:description`）を `tanemoney.app` 基準で追加すると、SNSシェア時のカードが整う（広告・口コミに効く）。

## ステップ5（将来）：Cloudflare Pages へ移行するとき

有料化（課金）を始めたら Vercel無料枠は商用NGなので Cloudflare Pages へ。
**独自ドメインがあるのでユーザー影響ゼロ**：

1. Cloudflare Pages に GitHub リポジトリを接続してビルド設定（静的配信。`vercel.json` の rewrites は `_redirects` に `/* /index.html 200`、ヘッダは `_headers` で `sw.js` を `Cache-Control: no-cache`）
2. DNS の `tanemoney.app` の向き先を Vercel → Cloudflare Pages に変更するだけ
3. URL不変＝PWA・localStorage・家族コードすべて維持される

---

## チェックリスト

- [ ] `tanemoney.app` 購入
- [ ] Vercel にドメイン追加＋DNS設定
- [ ] Firebase 承認済みドメインに `tanemoney.app` 追加 ← 忘れ厳禁
- [ ] コード内URL6箇所を差し替え（こちらで対応）
- [ ] 実機で新ドメインを開き、セットアップ→同期が動くか確認
- [ ] （将来）Cloudflare Pages 移行時はDNS向き先変更のみ
