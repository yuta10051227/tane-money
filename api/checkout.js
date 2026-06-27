// Stripe Checkout セッション作成。クライアントの「このプランで購入手続きへ」から呼ばれる。
// 必要な環境変数:
//   STRIPE_SECRET_KEY
//   STRIPE_PRICE_SINGLE / STRIPE_PRICE_SIBLING / STRIPE_PRICE_FAMILY / STRIPE_PRICE_ANNUAL
//   PUBLIC_BASE_URL  … 例 https://tane-money.vercel.app (success/cancel 戻り先)
const { applyCors } = require('./_lib');

const PRICE_ENV = {
  single: 'STRIPE_PRICE_SINGLE',
  sibling: 'STRIPE_PRICE_SIBLING',
  family: 'STRIPE_PRICE_FAMILY',
  annual: 'STRIPE_PRICE_ANNUAL',
};

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const sk = process.env.STRIPE_SECRET_KEY;
    if (!sk) return res.status(503).json({ error: 'billing_not_configured' });
    const stripe = require('stripe')(sk);

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { plan, familyCode, memberId } = body;
    const priceEnv = PRICE_ENV[plan];
    if (!priceEnv) return res.status(400).json({ error: 'invalid_plan' });
    const price = process.env[priceEnv];
    if (!price) return res.status(503).json({ error: 'price_not_configured', plan });
    if (!familyCode) return res.status(400).json({ error: 'missing_family_code' });

    const base = process.env.PUBLIC_BASE_URL || 'https://tane-money.vercel.app';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      // 14日無料体験(クレカ登録は必要だがトライアル中は課金されない)
      subscription_data: { trial_period_days: 14, metadata: { familyCode, plan } },
      client_reference_id: familyCode,
      metadata: { familyCode, plan, memberId: memberId || '' },
      allow_promotion_codes: true,
      success_url: `${base}/?billing=success`,
      cancel_url: `${base}/?billing=cancel`,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'checkout_failed', message: String(e && e.message || e) });
  }
};
