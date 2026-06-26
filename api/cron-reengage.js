// 再エンゲージ用 日次バッチ(Vercel Cron から GET で叩かれる)。
// 全家族をスキャンし、3日以上活動の無い子について:
//   - 保護者の端末トークンへ「◯◯ちゃんが◯日 学習していません」プッシュ(静かな解約の予防)
//   - その子自身のトークンへ「今日のミッションが待ってるよ」プッシュ(アプリ外からの引き戻し)
// トークンは各家族の data.pushTokens(クライアントが登録) を参照する。
// 必要な環境変数: FIREBASE_SERVICE_ACCOUNT / (任意)CRON_SECRET
const { db, messaging, parseFamily } = require('./_lib');

const DAY = 86400000;
const DORMANT_DAYS = 3;

function lastActivityByChild(d) {
  const map = {};
  for (const l of (d.logs || [])) {
    const t = new Date(l.date).getTime();
    if (!isNaN(t) && (!map[l.cid] || t > map[l.cid])) map[l.cid] = t;
  }
  return map;
}

module.exports = async (req, res) => {
  // Vercel Cron は Authorization: Bearer <CRON_SECRET> を送る(設定時)
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const now = Date.now();
    const snap = await db().collection('families').get();
    let families = 0, pushes = 0, dormant = 0;
    const sends = [];
    snap.forEach((doc) => {
      families++;
      const d = parseFamily(doc.data());
      const tokens = d.pushTokens || {};
      const children = d.children || [];
      const last = lastActivityByChild(d);
      // 保護者トークン一覧
      const parentTokens = Object.entries(tokens)
        .filter(([, v]) => v && v.role === 'parent' && v.token)
        .map(([, v]) => v.token);
      for (const c of children) {
        const lt = last[c.id] || 0;
        const days = lt ? Math.floor((now - lt) / DAY) : 999;
        if (days < DORMANT_DAYS) continue;
        dormant++;
        const childTok = tokens[c.id] && tokens[c.id].token;
        const dispDays = days >= 999 ? 'しばらく' : `${days}日`;
        // 子本人へ
        if (childTok) sends.push(messaging().send({
          token: childTok,
          notification: { title: 'タネマネー', body: `${c.name}の きょうの学習ミッションが まってるよ📖 れんぞくを のばそう！` },
        }).then(() => { pushes++; }).catch(() => {}));
        // 保護者へ
        for (const pt of parentTokens) sends.push(messaging().send({
          token: pt,
          notification: { title: 'タネマネー', body: `${c.name}が ${dispDays} 学習していません。ひと声 かけてみましょう🌱` },
        }).then(() => { pushes++; }).catch(() => {}));
      }
    });
    await Promise.all(sends);
    return res.status(200).json({ ok: true, families, dormant, pushes });
  } catch (e) {
    return res.status(500).json({ error: 'cron_failed', message: String(e && e.message || e) });
  }
};
