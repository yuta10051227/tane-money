// 株価のバッチ取得プロキシ。クライアントが外部の無料CORSプロキシ(不安定)に頼らず、
// 同一オリジン(/api/stocks)で株価を取れるようにする。
// GET /api/stocks?tickers=7974.T,AAPL,...
// 返り値: { [ticker]: <Yahoo v8 chart JSON> | null }
// 環境変数は不要。Vercel Node ランタイム(グローバルfetch)前提。
const { applyCors } = require('./_lib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

module.exports = async (req, res) => {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const tickers = String((req.query && req.query.tickers) || '')
    .split(',')
    .map(t => t.trim())
    .filter(t => /^[A-Za-z0-9.\-^=]{1,12}$/.test(t))   // ティッカー以外の文字列は弾く
    .slice(0, 60);
  if (!tickers.length) return res.status(400).json({ error: 'tickers required' });

  const out = {};
  await Promise.all(tickers.map(async (t) => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=30d`,
        { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }
      );
      out[t] = r.ok ? await r.json() : null;
    } catch (e) { out[t] = null; }
  }));

  // 10分CDNキャッシュ: 家族全員・全端末で同じ結果を再利用(Yahooへの負荷も1回分)
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
  return res.status(200).json(out);
};
