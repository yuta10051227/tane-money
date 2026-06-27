// Stripe Webhook: サブスクの状態を families/{code}/meta/billing に書き込む(エンタイトルメント)。
// クライアントはこの billing ドキュメントを read して「課金中/トライアル中/解約」を判定する。
// 必要な環境変数: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / FIREBASE_SERVICE_ACCOUNT
//
// Stripe ダッシュボードで Webhook エンドポイントを作成し、署名シークレットを設定すること。
// 購読イベント: checkout.session.completed, customer.subscription.created/updated/deleted
const { applyCors, billingRef, readRawBody, getAdmin } = require('./_lib');

// 署名検証のため生ボディが必要 → Vercel の bodyParser を無効化
module.exports.config = { api: { bodyParser: false } };

async function upsertBilling(code, patch) {
  const admin = getAdmin();
  await billingRef(code).set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method !== 'POST') return res.status(405).end();
  const sk = process.env.STRIPE_SECRET_KEY;
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sk || !whsec) return res.status(503).json({ error: 'billing_not_configured' });
  const stripe = require('stripe')(sk);

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], whsec);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_signature', message: String(e && e.message || e) });
  }

  try {
    const obj = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const code = obj.client_reference_id || (obj.metadata && obj.metadata.familyCode);
      if (code) await upsertBilling(code, {
        active: true,
        status: obj.status || 'complete',
        plan: (obj.metadata && obj.metadata.plan) || null,
        stripeCustomerId: obj.customer || null,
        stripeSubscriptionId: obj.subscription || null,
      });
    } else if (event.type.startsWith('customer.subscription')) {
      const code = obj.metadata && obj.metadata.familyCode;
      if (code) {
        const active = ['active', 'trialing', 'past_due'].includes(obj.status);
        await upsertBilling(code, {
          active,
          status: obj.status,
          plan: (obj.metadata && obj.metadata.plan) || null,
          stripeCustomerId: obj.customer || null,
          stripeSubscriptionId: obj.id || null,
          currentPeriodEnd: obj.current_period_end || null,
          canceledAt: obj.canceled_at || null,
        });
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    return res.status(500).json({ error: 'handler_failed', message: String(e && e.message || e) });
  }
};
