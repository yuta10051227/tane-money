// Stripe カスタマーポータル(支払い方法変更・解約)へのリンクを発行。
// 解約はこのポータルから「いつでも・違約金なし」で可能。
// 必要な環境変数: STRIPE_SECRET_KEY / PUBLIC_BASE_URL
const { applyCors, billingRef } = require('./_lib');

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const sk = process.env.STRIPE_SECRET_KEY;
    if (!sk) return res.status(503).json({ error: 'billing_not_configured' });
    const stripe = require('stripe')(sk);

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { familyCode } = body;
    if (!familyCode) return res.status(400).json({ error: 'missing_family_code' });

    // 課金時に保存した stripeCustomerId を引く
    const snap = await billingRef(familyCode).get();
    const customer = snap.exists ? (snap.data().stripeCustomerId) : null;
    if (!customer) return res.status(404).json({ error: 'no_customer' });

    const base = process.env.PUBLIC_BASE_URL || 'https://tane-money.vercel.app';
    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${base}/?billing=portal_return`,
    });
    return res.status(200).json({ url: portal.url });
  } catch (e) {
    return res.status(500).json({ error: 'portal_failed', message: String(e && e.message || e) });
  }
};
