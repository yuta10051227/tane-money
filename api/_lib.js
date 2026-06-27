// 共有ヘルパー: Firebase Admin 初期化 / 家族データの読み書き / CORS。
// Vercel Serverless(Node) 上で動く。クライアント(index.html)からは呼ばれない。
//
// 必要な環境変数(Vercel の Environment Variables に設定):
//   FIREBASE_SERVICE_ACCOUNT  … Firebaseサービスアカウントの JSON 文字列(1行)
//   (Stripe系は各APIファイル参照)
const admin = require('firebase-admin');

let _app = null;
function getAdmin() {
  if (_app) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const cred = JSON.parse(raw);
  // 改行が \n エスケープされている場合に復元
  if (cred.private_key && cred.private_key.includes('\\n')) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  }
  _app = admin.apps.length ? admin.app() : admin.initializeApp({
    credential: admin.credential.cert(cred),
    projectId: cred.project_id || 'tane-money',
  });
  return admin;
}

function db() { return getAdmin().firestore(); }
function messaging() { return getAdmin().messaging(); }

// 家族ドキュメントの data(JSON文字列) を安全にパース
function parseFamily(docData) {
  try { return JSON.parse((docData && docData.data) || '{}'); } catch (e) { return {}; }
}

// 課金エンタイトルメントは families/{code}/meta/billing に置く(クライアントの data 上書きと衝突させない)
function billingRef(code) { return db().collection('families').doc(code).collection('meta').doc('billing'); }

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = { getAdmin, db, messaging, parseFamily, billingRef, readRawBody, applyCors };
