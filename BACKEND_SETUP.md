# タネマネー バックエンド設定手順（サーバープッシュ＋Stripe課金）

この手順は **一度だけ** 行えば、再エンゲージのサーバープッシュ（FCM）と本番課金（Stripe）が有効になります。
鍵を設定するまでアプリは従来どおり動き、各機能は安全に無効化されます（＝今すぐ壊れません）。

実装済みファイル:
- `api/checkout.js` … Stripe Checkout セッション作成
- `api/portal.js` … 解約・支払い管理ポータル
- `api/stripe-webhook.js` … サブスク状態を Firestore へ反映
- `api/cron-reengage.js` … 毎日 休眠の子を検知してプッシュ送信
- `firebase-messaging-sw.js` … プッシュのバックグラウンド受信
- `vercel.json` … 日次 Cron（`/api/cron-reengage`）を登録済み

---

## 1. Firebase（無料の Spark プランでOK・Blade不要）

1. Firebase Console > プロジェクト設定 > サービスアカウント > 「新しい秘密鍵を生成」→ JSON をダウンロード。
2. その JSON を **1行の文字列** にして Vercel の環境変数 `FIREBASE_SERVICE_ACCOUNT` に貼る。
3. Console > Cloud Messaging > 「ウェブプッシュ証明書」で **公開VAPIDキー** を生成。
4. `okozukai-v9.jsx` の先頭付近 `const TANE_VAPID_KEY = "";` にその公開鍵を貼る → `npm run build`。
5. Firestore ルールを反映: `firebase deploy --only firestore:rules`（`meta/billing` の read を追加済み）。

> 注: FCM の送信は Admin SDK（サービスアカウント）で行うため、Cloud Functions も Blaze も不要です。送信は Vercel の Cron 関数が担当します。

## 2. Stripe

1. Stripe ダッシュボードで商品＋価格(Price)を4つ作成（すべて月額/年額のサブスク）:
   - 1人プラン ¥980/月 → `STRIPE_PRICE_SINGLE`
   - きょうだいプラン ¥1,460/月 → `STRIPE_PRICE_SIBLING`
   - 家族プラン ¥1,480/月 → `STRIPE_PRICE_FAMILY`
   - 年額プラン ¥9,800/年 → `STRIPE_PRICE_ANNUAL`
2. APIキー（Secret key）を `STRIPE_SECRET_KEY` に設定。
3. Webhook を作成: エンドポイント `https://tane-money.vercel.app/api/stripe-webhook`、
   購読イベント = `checkout.session.completed`, `customer.subscription.created/updated/deleted`。
   署名シークレットを `STRIPE_WEBHOOK_SECRET` に設定。
4. 顧客ポータル（解約UI）を Stripe ダッシュボードの Billing > Customer portal で有効化。

## 3. Vercel 環境変数（Project Settings > Environment Variables）

| 変数 | 用途 |
|------|------|
| `FIREBASE_SERVICE_ACCOUNT` | Admin SDK（プッシュ送信・課金反映） |
| `STRIPE_SECRET_KEY` | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Webhook 署名検証 |
| `STRIPE_PRICE_SINGLE` / `_SIBLING` / `_FAMILY` / `_ANNUAL` | 各プランのPrice ID |
| `PUBLIC_BASE_URL` | 例 `https://tane-money.vercel.app`（戻り先URL） |
| `CRON_SECRET` | （任意）Cron の不正実行防止。Vercel が自動付与する Bearer と一致させる |

設定後、再デプロイすると `api/*` がビルドされ（`package.json` の `stripe` / `firebase-admin` を自動インストール）有効になります。

## 4. 動作確認

- 課金: 設定 > 💳プラン > プラン選択 > 「購入手続きへ」→ Stripe Checkout に遷移すればOK。
- 解約: 「お支払い・解約の管理ページへ」→ Stripe Portal に遷移。
- プッシュ: 子の「🔔リマインダーON」/ 保護者の「🔔休眠お知らせ」でトークン登録 → Cron（毎日09:00 UTC）で休眠の子に送信。
  - 手動テスト: `GET https://tane-money.vercel.app/api/cron-reengage`（CRON_SECRET 設定時は `Authorization: Bearer <secret>` 必須）。

## 5. 未設定時の挙動（フォールバック）

- `TANE_VAPID_KEY` 空 → サーバープッシュ登録はスキップ。起動時ローカル通知＋承認タブの💤休眠アラートは従来どおり動作。
- Stripe 鍵なし → 「購入手続きへ」は「近日対応予定（現在は無料）」と表示。偽の決済は行いません。
