import React, { useState, useEffect, useCallback, useRef } from "react";

// ═══════════════════════════════════════════════════════
// CLOUD STORAGE (persistent across devices via claude.ai)
// ═══════════════════════════════════════════════════════
const CLOUD_KEY  = "tane_money_v9";
const LOCAL_KEY  = "tane_money_v9_local";
const LOCAL_KEY2 = "tane_money_v9_backup";
const FAMILY_CODE_KEY = "tane_money_family_code";

// window.storageが使えるか確認
const hasCloudStorage = () => {
  try { return !!(window.storage && typeof window.storage.get === "function"); }
  catch(e) { return false; }
};

// Firebase config
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCrwnL1XisVygG11z5CLq4FTPXIanZqT8E",
  authDomain: "tane-money.firebaseapp.com",
  projectId: "tane-money",
  storageBucket: "tane-money.firebasestorage.app",
  messagingSenderId: "168102674534",
  appId: "1:168102674534:web:691b66d776ed0d60b5ada7"
};
// ── バックエンド連携設定（未設定なら各機能は安全に無効化＝従来動作のまま）──
// FCM Web Push の公開VAPIDキー（Firebase Console > Cloud Messaging > Web Push 証明書）。
// 空のままだとサーバープッシュ登録はスキップされ、起動時ローカル通知のみ動く。
const TANE_VAPID_KEY = "";
// Serverless API のベースURL。同一オリジン(Vercel)に置くなら空でOK("/api/...")。
const TANE_API_BASE = "";

// 外部スクリプトの動的ロード（FCM messaging-compat 用）
function taneLoadScript(src){
  return new Promise((resolve,reject)=>{
    try{
      if(document.querySelector(`script[src="${src}"]`)){ resolve(); return; }
      const s=document.createElement("script"); s.src=src; s.async=true;
      s.onload=()=>resolve(); s.onerror=()=>reject(new Error("load_failed"));
      document.head.appendChild(s);
    }catch(e){ reject(e); }
  });
}
// FCMトークンを取得（許可が無ければ要求）。失敗時は{ok:false}で、呼び出し側は従来動作にフォールバック。
async function taneGetPushToken(){
  try{
    if(!TANE_VAPID_KEY) return {ok:false,reason:"no_vapid"};
    if(!("Notification"in window)||!("serviceWorker"in navigator)) return {ok:false,reason:"unsupported"};
    let perm=Notification.permission;
    if(perm==="default") perm=await Notification.requestPermission();
    if(perm!=="granted") return {ok:false,reason:"denied"};
    await taneLoadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");
    if(typeof firebase==="undefined"||!firebase.messaging) return {ok:false,reason:"no_lib"};
    getDB(); // app初期化＋匿名認証を保証
    const reg=await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const token=await firebase.messaging().getToken({vapidKey:TANE_VAPID_KEY,serviceWorkerRegistration:reg});
    return token?{ok:true,token}:{ok:false,reason:"no_token"};
  }catch(e){ return {ok:false,reason:String(e&&e.message||e)}; }
}
// Serverless API 呼び出し（POST JSON）
async function taneApi(path,body){
  const r=await fetch((TANE_API_BASE||"")+"/api/"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});
  let j={}; try{ j=await r.json(); }catch(e){}
  return {status:r.status,...j};
}
function taneFamilyCode(){ try{ return localStorage.getItem(FAMILY_CODE_KEY)||_familyCode||""; }catch(e){ return _familyCode||""; } }

// ── 🔄 自動アップデート検知（古いキャッシュのまま使われる問題の恒久対策）──
// 仕組み: ビルド時に index.html の <meta tane-version> と /version.json に同じ版を刻む。
// 起動中のアプリは「いま動いている版(meta)」を持ち、定期的に /version.json を no-store で取得。
// サーバーの版が違えば＝新デプロイが出た合図 → 画面下に「更新する」バーを出し、
// タップでキャッシュ全消し＋SW更新＋リロードして確実に最新へ揃える（端末ごとのズレを解消）。
function taneRunningVersion(){ try{ return (document.querySelector('meta[name="tane-version"]')||{}).content||""; }catch(e){ return ""; } }
let _taneUpdateShown=false;
function taneShowUpdateBanner(){
  try{
    if(_taneUpdateShown||!document.body) return; _taneUpdateShown=true;
    const bar=document.createElement("div");
    bar.style.cssText="position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#187A4E;color:#fff;font-family:'M PLUS Rounded 1c',sans-serif;padding:12px 14px;border-radius:14px;display:flex;align-items:center;gap:10px;box-shadow:0 6px 24px rgba(0,0,0,.25)";
    const txt=document.createElement("span");
    txt.style.cssText="flex:1;font-weight:800;font-size:13px;line-height:1.4";
    txt.textContent="新しいバージョンがあります";
    const btn=document.createElement("button");
    btn.textContent="更新する";
    btn.style.cssText="flex-shrink:0;background:#fff;color:#187A4E;border:none;border-radius:10px;padding:9px 16px;font-weight:900;font-size:13px;cursor:pointer;font-family:inherit";
    btn.onclick=taneForceUpdate;
    bar.appendChild(txt); bar.appendChild(btn);
    document.body.appendChild(bar);
  }catch(e){}
}
async function taneForceUpdate(){
  try{ if("caches"in window){ const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); } }catch(e){}
  try{ if(navigator.serviceWorker){ const rs=await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r=>r.update().catch(()=>{}))); } }catch(e){}
  try{ location.reload(); }catch(e){ location.href=location.href; }
}
async function taneCheckUpdate(){
  try{
    const cur=taneRunningVersion(); if(!cur) return;
    const r=await fetch("/version.json?_="+Date.now(),{cache:"no-store"});
    if(!r.ok) return;
    const j=await r.json();
    if(j&&j.version&&j.version!==cur) taneShowUpdateBanner();
  }catch(e){}
}
function taneStartUpdateWatcher(){
  try{
    taneCheckUpdate();
    setInterval(taneCheckUpdate,5*60*1000);
    document.addEventListener("visibilitychange",()=>{ if(!document.hidden) taneCheckUpdate(); });
    window.addEventListener("focus",taneCheckUpdate);
    if(navigator.serviceWorker&&navigator.serviceWorker.addEventListener){
      navigator.serviceWorker.addEventListener("message",e=>{
        if(e.data&&e.data.type==="SW_ACTIVATED"&&e.data.version&&e.data.version!==taneRunningVersion()) taneShowUpdateBanner();
      });
    }
  }catch(e){}
}
try{
  if(typeof document!=="undefined"){
    if(document.readyState==="complete") taneStartUpdateWatcher();
    else window.addEventListener("load",taneStartUpdateWatcher);
  }
}catch(e){}

let _db=null,_fbInit=false,_saveTimer=null,_pendingSave=null,_unsubscribe=null,_lastSyncTime=null;
// この端末が毎日タスクのセット定義を最後に編集した時刻(この端末のDate.nowのみ／同期されない)。
// リモート由来のupdatedAtを見ると時計ズレで誤作動するため、ローカル専用のこの値で「直近に自分が編集したか」を判定する。
let _lastLocalDefEditTs=0;
function markLocalDefEdit(){ _lastLocalDefEditTs=Date.now(); }
// 目標/家計簿/保有株など「ユーザーが直接編集する共有データ」の直近ローカル編集時刻（フィールド別・同期されない）。
// これで同期マージを「原則サーバ優先＋直近12秒だけローカル保護」にでき、他端末の編集/削除が確実に反映される。
// ※フィールド別にするのは、1つの編集(例:目標)が無関係フィールド(例:保有株)の受信まで12秒ブロックして
//   他端末の変更を巻き戻すのを防ぐため（フィールドを跨いだ結合を断つ）。
const _lastUserEditTs = { goals:0, expenses:0, holdings:0, forexHoldings:0 };
function markLocalUserDataEdit(field){
  const t=Date.now();
  if(field && field in _lastUserEditTs) _lastUserEditTs[field]=t;
  else { _lastUserEditTs.goals=t; _lastUserEditTs.expenses=t; _lastUserEditTs.holdings=t; _lastUserEditTs.forexHoldings=t; }
}
// ── データ消失の防止ガード ──
// クラウド保存(Firestore)はデバウンス＋fire-and-forgetなので、失敗が画面に出ない。
// 実際の書き込み成否とドキュメントサイズを1か所に集約し、UIに通知する。
// near=サイズが上限(1MB)に接近 / fail=連続して書き込み失敗(変更は端末ローカルには残る)
const SAVE_BYTE_WARN = 820000;          // 約820KBで警告(900KBの安全弁の手前)
let _saveHealth = {ok:true, near:false, bytes:0, failStreak:0};
let _saveHealthCb = null;
function setSaveHealthCb(cb){ _saveHealthCb=cb; if(cb) cb(_saveHealth); }
function reportSaveHealth(patch){ _saveHealth={..._saveHealth,...patch}; if(_saveHealthCb) _saveHealthCb(_saveHealth); }
function byteLen(str){ try{ return (typeof Blob!=="undefined")?new Blob([str]).size:Math.round((str||"").length*1.4); }catch(e){ return (str||"").length; } }
const _processedApprovalIds=new Set(); // 承認/却下済みIDをセッション中保持（同期で復活を防ぐ）
const _processedRedemptionIds=new Set(); // 交換(ごほうび)承認/却下済みIDを保持（遅延スナップショットでの復活＝二重減算を防ぐ）
let _familyCode=null; // ファミリーコードのキャッシュ

// 匿名認証（Firestoreルールの前提）。Auth未有効・オフラインでも従来動作を維持（fail-safe）
let _authTried=false;
function ensureAuth(){
  try{
    if(typeof firebase==="undefined"||!firebase.auth)return;
    if(_authTried)return; _authTried=true;
    const a=firebase.auth();
    if(!a.currentUser)a.signInAnonymously().catch(()=>{_authTried=false;});
  }catch(e){}
}

function getDB(){
  if(_db)return _db;
  try{
    if(typeof firebase==="undefined"||!firebase.firestore)return null; // 遅延ロード中
    if(!_fbInit){try{firebase.app();}catch(e){firebase.initializeApp(FIREBASE_CONFIG);}_fbInit=true;}
    ensureAuth();
    _db=firebase.firestore();return _db;
  }catch(e){return null;}
}

// Firebase(遅延ロード)の準備完了を待つ。準備済みなら即時、未ロードなら最大10秒ポーリング。
function whenFirebaseReady(cb){
  if(typeof firebase!=="undefined"&&firebase.firestore){cb();return;}
  let tries=0;
  const t=setInterval(()=>{
    if(typeof firebase!=="undefined"&&firebase.firestore){clearInterval(t);cb();}
    else if(++tries>100){clearInterval(t);cb();} // 10秒で諦め(ローカル表示は維持済み)
  },100);
}

function getFamilyCode(){
  if(_familyCode)return _familyCode;
  try{_familyCode=localStorage.getItem(FAMILY_CODE_KEY);}catch(e){}
  return _familyCode;
}

// ═══ PIN保護（SHA-256ハッシュ化。Firestoreに平文PINを保存しない）═══
// 同期版SHA-256（PinPadのcheckが同期APIのため）。定数は素数から実行時導出（転記ミス防止）
const _SHA=(()=>{
  const P=[];for(let n=2;P.length<64;n++){let ok=true;for(let i=0;i<P.length&&P[i]*P[i]<=n;i++)if(n%P[i]===0){ok=false;break;}if(ok)P.push(n);}
  const frac=(x)=>Math.floor((x-Math.floor(x))*4294967296)>>>0;
  return {K:P.map(p=>frac(Math.cbrt(p))),H0:P.slice(0,8).map(p=>frac(Math.sqrt(p)))};
})();
function sha256Hex(str){
  const rotr=(x,n)=>((x>>>n)|(x<<(32-n)))>>>0;
  const bytes=[];for(let i=0;i<str.length;i++){let c=str.codePointAt(i);if(c>0xFFFF)i++;
    if(c<0x80)bytes.push(c);
    else if(c<0x800)bytes.push(0xC0|(c>>6),0x80|(c&63));
    else if(c<0x10000)bytes.push(0xE0|(c>>12),0x80|((c>>6)&63),0x80|(c&63));
    else bytes.push(0xF0|(c>>18),0x80|((c>>12)&63),0x80|((c>>6)&63),0x80|(c&63));}
  const bitLen=bytes.length*8;
  bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);
  const hi=Math.floor(bitLen/4294967296)>>>0,lo=bitLen>>>0;
  bytes.push((hi>>>24)&255,(hi>>>16)&255,(hi>>>8)&255,hi&255,(lo>>>24)&255,(lo>>>16)&255,(lo>>>8)&255,lo&255);
  const H=_SHA.H0.slice(),K=_SHA.K,W=new Array(64);
  for(let off=0;off<bytes.length;off+=64){
    for(let t=0;t<16;t++)W[t]=((bytes[off+t*4]<<24)|(bytes[off+t*4+1]<<16)|(bytes[off+t*4+2]<<8)|bytes[off+t*4+3])>>>0;
    for(let t=16;t<64;t++){
      const s0=rotr(W[t-15],7)^rotr(W[t-15],18)^(W[t-15]>>>3);
      const s1=rotr(W[t-2],17)^rotr(W[t-2],19)^(W[t-2]>>>10);
      W[t]=(W[t-16]+s0+W[t-7]+s1)>>>0;
    }
    let[a,b,c,d2,e,f,g,h]=H;
    for(let t=0;t<64;t++){
      const S1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=(e&f)^(~e&g);
      const t1=(h+S1+ch+K[t]+W[t])>>>0;
      const S0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=(a&b)^(a&c)^(b&c);
      const t2=(S0+maj)>>>0;
      h=g;g=f;f=e;e=(d2+t1)>>>0;d2=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d2)>>>0;
    H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  return H.map(x=>x.toString(16).padStart(8,"0")).join("");
}
const PIN_SALT="tane-money:pin:v1:";
function pinHash(p){ return sha256Hex(PIN_SALT+String(p)); }
// メンバーのPIN照合。pinh(ハッシュ)優先、旧形式の平文pinにもフォールバック（移行期間の互換）
function pinMatches(input,member){
  if(!member)return false;
  if(member.pinh)return pinHash(input)===member.pinh;
  return String(input)===String(member.pin||"");
}
function parentPinMatches(input,data){
  if(data&&data.parentPinH)return pinHash(input)===data.parentPinH;
  return String(input)===String((data&&data.parentPin)||"0000");
}
// 親PINが初期値(0000)のままか（変更促しバッジ用）
function parentPinIsDefault(data){
  if(data&&data.parentPinH)return data.parentPinH===pinHash("0000");
  return ((data&&data.parentPin)||"0000")==="0000";
}

let _cloudSaveTimer=null, _cloudSavePending=null;
// 直前にサーバへ実際に書いた内容(JSON)。次回が同一なら書き込みをスキップして
// 「保存→自分のスナップショット→マージ→setData→保存…」の無限ループ／端末間ピンポンを断つ。
let _lastWrittenJson=null;
// 保存要求の世代カウンタ。await中に新しい編集が入ったら、古い保存の完了で「saved(緑)」を点けない（取りこぼし防止）。
let _saveGen=0, _retryTimer=null;
// 実際のFirestore保存結果を同期バッジ(SyncBadge)へ通知するコールバック。
// ※旧実装は cloudSave 直後に楽観的に "saved" 表示していたため、無言拒否(900KB超)やオフラインでも「同期済み」の緑だった。
let _syncStCb=null;
function setSyncStCb(cb){ _syncStCb=cb; }
function _notifySyncSt(s){ try{ _syncStCb && _syncStCb(s); }catch(e){} }
// data変更のたびに呼ばれるが、重い同期処理(JSON.stringify＋localStorage＋Firestore準備)を
// 約300msデバウンスして、タップ直後の再描画をブロックしない(肥大データでのフリーズ防止)。
async function cloudSave(d) {
  _cloudSavePending = d;
  if(_cloudSaveTimer) clearTimeout(_cloudSaveTimer);
  _cloudSaveTimer = setTimeout(()=>{ const dd=_cloudSavePending; _cloudSavePending=null; if(dd) _cloudPersist(dd); }, 300);
}
// 保存データのスリム化：メインblob(families/{code}.data)は900KB上限があり、超えると保存が“無言で失敗”して
// タスク定義/セット/特典/設定が家族に永久に届かなくなる（logsは別コレクションで同期され続けるので気づきにくい）。
// logsは logsサブコレクションが唯一の正なので、blobは残高保全のcarry＋直近少数だけ持つ。expenses/dailyProgressも上限を設ける。
function _slimForCloud(d){
  let saveD = d;
  const KEEP_LOGS = 300;
  if((d.logs||[]).length > KEEP_LOGS){
    const keep = d.logs.slice(0, KEEP_LOGS);
    const sums = {};
    d.logs.slice(KEEP_LOGS).forEach(l=>{ if(l&&l.cid!=null) sums[l.cid]=(sums[l.cid]||0)+(l.pts||0); });  // carryも含めて合算＝残高保全
    const oldestDate = d.logs[d.logs.length-1]?.date || new Date().toISOString();
    const carry = Object.entries(sums).map(([cid,pts])=>({
      id:"carry_"+cid, cid, type:"grant", label:"くりこし（これより前の合計）", pts, date:oldestDate
    }));
    saveD = {...saveD, logs:[...keep, ...carry]};
  }
  // dailyProgress: 毎日1エントリ増えるので、子ごと直近21日分だけ残す
  if(saveD.dailyProgress && typeof saveD.dailyProgress==="object"){
    const dp={};
    for(const cid of Object.keys(saveD.dailyProgress)){
      const days=saveD.dailyProgress[cid]||{};
      const ks=Object.keys(days).sort().slice(-21);
      const o={}; for(const k of ks) o[k]=days[k];
      dp[cid]=o;
    }
    saveD={...saveD, dailyProgress:dp};
  }
  // expenses(家計簿): 直近400件まで
  if((saveD.expenses||[]).length > 400){ saveD={...saveD, expenses:saveD.expenses.slice(0,400)}; }
  return saveD;
}
function _cloudPersist(d) {
  const code = getFamilyCode()||"default";
  const saveD = _slimForCloud(d);
  const json = JSON.stringify(saveD);
  // 1. コード固有のローカルストレージ（他コードと分離）。両方失敗＝この端末に保存できない＝健全性へ通知。
  let localOk=false;
  try { localStorage.setItem(LOCAL_KEY+"_"+code, json); localOk=true; } catch(e) {}
  try { localStorage.setItem(LOCAL_KEY2+"_"+code, json); localOk=true; } catch(e) {}
  if(!localOk){ reportSaveHealth({ok:false, localFail:true}); _notifySyncSt("error"); }
  // 2. Firestore（デバウンス・家族間リアルタイム同期）。同じ圧縮済みを保存
  _pendingSave = json;
  const myGen = ++_saveGen;   // この保存要求の世代（後続編集が来たら古い完了通知は無視する）
  // 「saved」を点けてよいのは、その後に新しい編集が入っていない＝自分が最新世代のときだけ。
  const okToGreen = ()=> myGen===_saveGen;
  // ドキュメントサイズを監視（1MB上限の手前で親に警告を出す）
  const near = byteLen(json) > SAVE_BYTE_WARN;
  reportSaveHealth({near, bytes:byteLen(json)});
  if(_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async function attempt(){
    if(!code||code==="default"){ reportSaveHealth({ok:true, failStreak:0}); if(okToGreen())_notifySyncSt("saved"); return; }
    const db = getDB();
    if(!db){ reportSaveHealth({ok:true, failStreak:0}); if(okToGreen())_notifySyncSt("saved"); return; }
    // 前回サーバへ書いた内容と完全一致なら書かない＝自己エコー／端末間ピンポンの保存ループを断つ。
    // (ユーザーの実編集は必ず内容が変わるので誤スキップしない。純粋な受信→再保存だけが止まる)
    if(_pendingSave === _lastWrittenJson){ reportSaveHealth({ok:true, failStreak:0}); if(okToGreen())_notifySyncSt("saved"); return; }
    try{
      const ts = new Date().toISOString();
      const payload = _pendingSave;   // await中に別の保存で_pendingSaveが変わっても“実際に書いた内容”を正確に記録する
      await db.collection("families").doc(code).set({data:payload,updatedAt:ts});
      _lastWrittenJson = payload;   // 実際に書いた内容を記録（次回同一ならスキップ）
      _lastSyncTime = ts;  // 書き込み成功後にセット＝失敗時に自己スナップショット除外が誤動作しない
      reportSaveHealth({ok:true, failStreak:0});
      if(okToGreen())_notifySyncSt("saved");   // 実際に保存成功し、かつ後続の未保存編集が無いときだけ緑にする
    }catch(e){
      console.warn("Firestore save failed:",e);
      // 2回連続で失敗したら警告（一時的なネット瞬断で過剰に出さない）
      const streak=_saveHealth.failStreak+1;
      reportSaveHealth({failStreak:streak, ok:streak<2});
      if(okToGreen()){
        _notifySyncSt(streak<2?"saving":"error");   // 1回目は保留、2回連続失敗でエラー表示
        // 後続の編集が無くてもバッジが「保存中…」で固着しないよう、最新世代なら数秒後に一度だけ再試行して収束させる。
        if(_pendingSave!==_lastWrittenJson && streak<5){
          if(_retryTimer) clearTimeout(_retryTimer);
          _retryTimer=setTimeout(()=>{ _retryTimer=null; if(okToGreen()) attempt(); }, 5000);
        }
      }
    }
  },1000); // 1秒デバウンス（目標・設定変更が素早く保存される）
  // 3. Claude.ai内ならwindow.storageにも保存
  if (hasCloudStorage()) {
    try { window.storage.set(CLOUD_KEY, json); } catch(e) {}
  }
}
// アプリが閉じる/バックグラウンドに入るときは、デバウンス待ちの保存を確実に実行(取りこぼし防止)
function flushCloudSave(){ if(_cloudSaveTimer){clearTimeout(_cloudSaveTimer);_cloudSaveTimer=null;} const dd=_cloudSavePending; _cloudSavePending=null; if(dd) _cloudPersist(dd); }
if(typeof window!=="undefined"){
  window.addEventListener("pagehide", flushCloudSave);
  window.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="hidden") flushCloudSave(); });
}

// 手動「今すぐ同期」用：サーバの最新ドキュメントを直接読む（診断＆強制取得）。
// 戻り値 {ok, data, bytes, code, err}。UIから呼ぶ。
async function forcePullFromCloud(){
  const code=getFamilyCode();
  if(!code||code==="default") return {ok:false, err:"no_code", code};
  const db=getDB();
  if(!db) return {ok:false, err:"no_db", code};
  try{
    const doc=await db.collection("families").doc(code).get();
    if(!doc.exists||!doc.data()||!doc.data().data) return {ok:false, err:"empty", code};
    const raw=doc.data().data;
    const parsed=JSON.parse(raw);
    try{localStorage.setItem(LOCAL_KEY+"_"+code,raw);}catch(e){}
    _lastSyncTime=doc.data().updatedAt||_lastSyncTime;   // 直後の自己スナップショットで二重処理しない
    return {ok:true, data:parsed, bytes:byteLen(raw), code, updatedAt:doc.data().updatedAt};
  }catch(e){ return {ok:false, err:String(e&&e.message||e), code}; }
}

async function cloudLoad() {
  const code = getFamilyCode();
  // 1. Firestoreから読む（最優先・他デバイスと同期）
  if(code){
    const db=getDB();
    if(db){
      try{
        const doc=await db.collection("families").doc(code).get();
        if(doc.exists&&doc.data()&&doc.data().data){
          const parsed=JSON.parse(doc.data().data);
          if(parsed&&parsed.children&&parsed.children.length>0){
            try{localStorage.setItem(LOCAL_KEY+"_"+code,doc.data().data);}catch(e){}
                        return parsed;
          }
        }
      }catch(e){console.warn("Firestore load failed:",e);}
    }
  }
  // 2. コード固有のローカルストレージ
  if(code){
    try{
      const local=localStorage.getItem(LOCAL_KEY+"_"+code);
      if(local){const p=JSON.parse(local);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
    try{
      const local2=localStorage.getItem(LOCAL_KEY2+"_"+code);
      if(local2){const p=JSON.parse(local2);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
  }
  // 3. 後方互換（TANE-YUTAまたは既存データの移行）
  if(!code||code==="TANE-YUTA"){
    try{
      const old=localStorage.getItem(LOCAL_KEY);
      if(old){const p=JSON.parse(old);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
  }
  // 4. 新規コード → nullを返してINITから始める
  return null;
}

// ローカル即時ロード（同期・ネット往復なし）＝起動時の初回描画用。
// cloudLoad()のstep2,3と同じローカル参照を、awaitせず即返す。
function localLoadSync() {
  const code = getFamilyCode();
  if(code){
    try{
      const local=localStorage.getItem(LOCAL_KEY+"_"+code);
      if(local){const p=JSON.parse(local);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
    try{
      const local2=localStorage.getItem(LOCAL_KEY2+"_"+code);
      if(local2){const p=JSON.parse(local2);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
  }
  if(!code||code==="TANE-YUTA"){
    try{
      const old=localStorage.getItem(LOCAL_KEY);
      if(old){const p=JSON.parse(old);if(p&&p.children&&p.children.length>0)return p;}
    }catch(e){}
  }
  return null;
}

// リアルタイム同期（他デバイスの変更を即反映）
function startRealtimeSync(updateFn){
  const code=getFamilyCode();
  if(!code||code==="default")return;
  const db=getDB();
  if(!db)return;
  if(_unsubscribe)_unsubscribe();
  try{
    _unsubscribe=db.collection("families").doc(code).onSnapshot(doc=>{
      if(!doc.exists||!doc.data()||!doc.data().data)return;
      // 自端末の未確定書き込み(Firestoreのlatency compensation)はスキップ。
      // これを処理すると「保存→自分のローカルスナップショット→巨大マージ→setData→保存…」の
      // 無限ループになり、肥大データ＋連打で端末がフリーズする（数が反映しない主因）。
      if(doc.metadata && doc.metadata.hasPendingWrites) return;
      const t=doc.data().updatedAt||"";
      if(_lastSyncTime===t)return; // 自分の保存は無視
      _lastSyncTime=t;
      try{
        const parsed=JSON.parse(doc.data().data);
        if(parsed&&parsed.children&&parsed.children.length>0){
          try{localStorage.setItem(LOCAL_KEY+"_"+code,doc.data().data);}catch(e){}
          updateFn(prev=>{
            // マージルール：設定系はFirestore反映、ユーザーデータはローカル優先
            const merged=migrate(parsed);
            if(!prev) return merged;
            // 目標/家計簿/保有株：原則サーバ優先＝他端末の編集/削除/並び替えが必ず反映される。
            // ただし自端末が直近12秒に編集した時、またはサーバ値が空/欠損の時だけローカル保護（巻き戻り・全消し防止の安全弁）。
            // ※旧実装は「ローカルが非空なら無条件ローカル優先」で、他端末の変更が永久に反映されず往復で消えるLWWロスト更新だった（goodTasksと同根）。
            {
              const _now=Date.now();
              const _rud = (f)=> _lastUserEditTs[f]>0 && (_now-_lastUserEditTs[f] < 12000);   // フィールド別に判定＝跨いだブロックをしない
              if(prev.goals&&prev.goals.length&&(_rud('goals')||!(merged.goals&&merged.goals.length))) merged.goals=prev.goals;
              if(prev.expenses&&prev.expenses.length&&(_rud('expenses')||!(merged.expenses&&merged.expenses.length))) merged.expenses=prev.expenses;
              if(prev.holdings&&Object.keys(prev.holdings).length&&(_rud('holdings')||!(merged.holdings&&Object.keys(merged.holdings).length))) merged.holdings=prev.holdings;
              if(prev.forexHoldings&&Object.keys(prev.forexHoldings).length&&(_rud('forexHoldings')||!(merged.forexHoldings&&Object.keys(merged.forexHoldings).length))) merged.forexHoldings=prev.forexHoldings;
            }
            if(prev.claimedBadges) merged.claimedBadges=prev.claimedBadges;
            if(prev.noPinIds) merged.noPinIds=prev.noPinIds;
            // お手伝い項目(タスク定義)は原則サーバ優先＝追加/編集/削除/並び替えが全端末へ必ず反映される。
            // ただし自端末が直近12秒に編集した場合だけ、保存がサーバへ伝播するまでローカルを保護(消えない)。
            // 判定は自端末のDate.now()と自端末が刻んだ編集時刻(_lastLocalDefEditTs／同期されない)だけ＝端末間の時計比較はしない。
            // ※旧実装はunion(ローカル優先)で、編集・削除・並び替えが他端末に永久に伝わらないバグがあった
            //   （＝「設定でお手伝い項目を編集しても家族の端末に反映されない」の主因）。全writerがmarkLocalDefEdit()を呼ぶ前提。
            {
              const _recentDefEdit = _lastLocalDefEditTs>0 && (Date.now()-_lastLocalDefEditTs < 12000);
              // 直近編集 or サーバ値が空/欠損のときはローカルを守る（サーバの一過性の空読みでタスク全消えを防ぐ安全弁）
              if(prev.goodTasks && prev.goodTasks.length && (_recentDefEdit || !(merged.goodTasks&&merged.goodTasks.length))) merged.goodTasks=prev.goodTasks;
              if(prev.badTasks  && prev.badTasks.length  && (_recentDefEdit || !(merged.badTasks &&merged.badTasks.length )))  merged.badTasks =prev.badTasks;
              // それ以外は merged(=サーバ値) をそのまま採用＝他端末の変更が確実に反映
            }
            if(prev.myTaskIds) merged.myTaskIds={...(merged.myTaskIds||{}),...prev.myTaskIds};
            // 毎日タスクのセット定義: 原則サーバ優先(＝他端末の追加/編集が必ず反映される)。
            // ただし「この端末が直近に編集した」場合だけ、保存が伝播するまでの数秒間ローカルを保護する。
            // ※時計ズレの影響を避けるため、比較は自端末のDate.now()と自端末が刻んだupdatedAtのみ(端末間の時刻比較はしない)。
            // ※旧実装は prev(ローカル)を無条件優先し、他端末での追加が永久に反映されないバグがあった。
            {
              // 判定は「この端末が自分で編集した時刻(_lastLocalDefEditTs／同期されない)」だけ。端末間の時刻比較はしない。
              const _recentlyEditedHere = _lastLocalDefEditTs>0 && (Date.now()-_lastLocalDefEditTs < 12000);
              if(_recentlyEditedHere && prev.dailyTaskSets && prev.dailyTaskSets.length>0){
                merged.dailyTaskSets=prev.dailyTaskSets;   // 保存が届くまで自分の編集を守る
              }
              // それ以外は merged(=サーバ値) をそのまま採用＝他端末の変更が確実に反映される
            }
            if(prev.dailyTasks&&prev.dailyTasks.length>0) merged.dailyTasks=prev.dailyTasks;
            if(prev.activeSetId!==undefined) merged.activeSetId=prev.activeSetId;
            merged.logs=prev.logs; // logsはlogsリアルタイム同期で別管理
            // リアルタイム取得系（ローカル優先）
            if(prev.stocks&&prev.stocks.length>0) merged.stocks=prev.stocks;
            if(prev.forex&&Object.keys(prev.forex).length>0) merged.forex=prev.forex;
            // ゲーム進行系（ローカル優先）
            // ※ gachaDateをここで守らないとFirestoreの遅延snaphotで1日1回制限が崩れる
            if(prev.gachaDate){merged.gachaDate={...(merged.gachaDate||{})};const _td=todayKey();Object.keys(prev.gachaDate).forEach(cid=>{if(prev.gachaDate[cid]===_td)merged.gachaDate[cid]=_td;});}
            // 利子/配当の付与記録: 進んでいる方(最新)を採用＝同期巻き戻しによる二重付与を防止
            if(prev.interestLastDate){merged.interestLastDate={...(merged.interestLastDate||{})};Object.keys(prev.interestLastDate).forEach(cid=>{const p=prev.interestLastDate[cid],m=merged.interestLastDate[cid];const pt=p?new Date(String(p).replace(/-/g,'/')).getTime():0;const mt=m?new Date(String(m).replace(/-/g,'/')).getTime():0;if(pt>mt)merged.interestLastDate[cid]=p;});}
            if(prev.holdBonusLastDate){merged.holdBonusLastDate={...(merged.holdBonusLastDate||{})};Object.keys(prev.holdBonusLastDate).forEach(cid=>{if((prev.holdBonusLastDate[cid]||0)>(merged.holdBonusLastDate[cid]||0))merged.holdBonusLastDate[cid]=prev.holdBonusLastDate[cid];});}
            // 相棒選択(ヤミノオウ/タネモン)はローカル優先＝同期で勝手に戻らない
            if(prev.activePartner) merged.activePartner={...(merged.activePartner||{}),...prev.activePartner};
            // 1日のバトル回数: 今日の分は多い方を採用＝同期巻き戻しで上限を超えられないように
            if(prev.battleCountDay){merged.battleCountDay={...(merged.battleCountDay||{})};const _td=todayKey();Object.keys(prev.battleCountDay).forEach(cid=>{const p=prev.battleCountDay[cid]||{},m=merged.battleCountDay[cid]||{};const pT=p.date===_td,mT=m.date===_td;if(pT&&mT)merged.battleCountDay[cid]={date:_td,n:Math.max(p.n||0,m.n||0)};else if(pT)merged.battleCountDay[cid]=p;else if(!mT)merged.battleCountDay[cid]=p;});}
            if(prev.streak) merged.streak=prev.streak;
            if(prev.dailyProgress) merged.dailyProgress=prev.dailyProgress;
            // モンスター進化/やり直し/転生：最終更新時刻(monsterStageAt)が新しい方を優先＝巻き戻り防止。
            // 段階では判定しない(系統を壊さない)。卵に戻す操作も新しければ保持される。
            {
              merged.monsterEvolved={...(merged.monsterEvolved||{})};
              merged.monsterEvolvedAt={...(merged.monsterEvolvedAt||{})};
              merged.monsterStageAt={...(merged.monsterStageAt||{})};
              merged.monsterIV={...(merged.monsterIV||{})};
              const _t=(o,cid)=>{const v=(o||{})[cid];return v?new Date(v).getTime():0;};
              const cids=new Set([...Object.keys(prev.monsterEvolved||{}),...Object.keys(merged.monsterEvolved||{}),...Object.keys(prev.monsterStageAt||{}),...Object.keys(merged.monsterStageAt||{})]);
              cids.forEach(cid=>{
                const pt=Math.max(_t(prev.monsterStageAt,cid),_t(prev.monsterEvolvedAt,cid));
                const mt=Math.max(_t(merged.monsterStageAt,cid),_t(merged.monsterEvolvedAt,cid));
                if(pt>=mt){ // ローカルが同じか新しい→ローカルを保持(リモートの古い状態で上書きしない)
                  if((prev.monsterEvolved||{})[cid]!==undefined) merged.monsterEvolved[cid]=prev.monsterEvolved[cid];
                  if((prev.monsterEvolvedAt||{})[cid]!==undefined) merged.monsterEvolvedAt[cid]=prev.monsterEvolvedAt[cid];
                  if((prev.monsterStageAt||{})[cid]!==undefined) merged.monsterStageAt[cid]=prev.monsterStageAt[cid];
                  if((prev.monsterIV||{})[cid]!==undefined) merged.monsterIV[cid]=prev.monsterIV[cid];
                }
              });
            }
            // 図鑑(発見済み)は和集合で減らさない
            if(prev.monsterDiscovered){
              merged.monsterDiscovered={...(merged.monsterDiscovered||{})};
              Object.keys(prev.monsterDiscovered).forEach(cid=>{
                merged.monsterDiscovered[cid]=[...new Set([...(merged.monsterDiscovered[cid]||[]),...(prev.monsterDiscovered[cid]||[])])];
              });
            }
            // なでなで(お世話)・転生回数は多い方
            if(prev.monsterCare){merged.monsterCare={...(merged.monsterCare||{})};Object.keys(prev.monsterCare).forEach(cid=>{const pc=prev.monsterCare[cid]||{},rc=merged.monsterCare[cid]||{};if((pc.days||0)>=(rc.days||0))merged.monsterCare[cid]=pc;});}
            if(prev.reincarnationCount){merged.reincarnationCount={...(merged.reincarnationCount||{})};Object.keys(prev.reincarnationCount).forEach(cid=>{merged.reincarnationCount[cid]=Math.max(prev.reincarnationCount[cid]||0,merged.reincarnationCount[cid]||0);});}
            // つけた名前(ニックネーム)・スキン装備も保護（巻き戻り防止）
            if(prev.monsterNickname) merged.monsterNickname={...(merged.monsterNickname||{}),...prev.monsterNickname};
            if(prev.monsterSkin) merged.monsterSkin={...(merged.monsterSkin||{}),...prev.monsterSkin};
            // まめちしきクイズの正解履歴は端末間でユニオン(消えない)
            if(prev.tipsQuiz){merged.tipsQuiz={...(merged.tipsQuiz||{})};Object.keys(prev.tipsQuiz).forEach(cid=>{merged.tipsQuiz[cid]=Array.from(new Set([...(merged.tipsQuiz[cid]||[]),...(prev.tipsQuiz[cid]||[])]));});}
            if(prev.enemyDex){merged.enemyDex={...(merged.enemyDex||{})};Object.keys(prev.enemyDex).forEach(cid=>{merged.enemyDex[cid]=Array.from(new Set([...(merged.enemyDex[cid]||[]),...(prev.enemyDex[cid]||[])]));});}
            // バトル/育成の進行(EXP・チケットは多い方、HP/ボス解放はローカル優先)
            if(prev.monsterExp){merged.monsterExp={...(merged.monsterExp||{})};Object.keys(prev.monsterExp).forEach(cid=>{merged.monsterExp[cid]=Math.max(prev.monsterExp[cid]||0,merged.monsterExp[cid]||0);});}
            if(prev.reincPower){merged.reincPower={...(merged.reincPower||{})};Object.keys(prev.reincPower).forEach(cid=>{merged.reincPower[cid]=Math.max(prev.reincPower[cid]||0,merged.reincPower[cid]||0);});}
            if(prev.monsterLevelSeen){merged.monsterLevelSeen={...(merged.monsterLevelSeen||{})};Object.keys(prev.monsterLevelSeen).forEach(cid=>{merged.monsterLevelSeen[cid]=Math.max(prev.monsterLevelSeen[cid]||0,merged.monsterLevelSeen[cid]||0);});}
            if(prev.battleTickets){merged.battleTickets={...(merged.battleTickets||{})};Object.keys(prev.battleTickets).forEach(cid=>{merged.battleTickets[cid]=Math.max(prev.battleTickets[cid]||0,merged.battleTickets[cid]||0);});}
            if(prev.battleFragments){merged.battleFragments={...(merged.battleFragments||{})};Object.keys(prev.battleFragments).forEach(cid=>{merged.battleFragments[cid]=Math.max(prev.battleFragments[cid]||0,merged.battleFragments[cid]||0);});}
            if(prev.battleFragDate) merged.battleFragDate={...(merged.battleFragDate||{}),...prev.battleFragDate};
            if(prev.battleFragOpps) merged.battleFragOpps={...(merged.battleFragOpps||{}),...prev.battleFragOpps};
            if(prev.battleWins){merged.battleWins={...(merged.battleWins||{})};Object.keys(prev.battleWins).forEach(cid=>{merged.battleWins[cid]=Math.max(prev.battleWins[cid]||0,merged.battleWins[cid]||0);});}
            if(prev.monsterEquip) merged.monsterEquip={...(merged.monsterEquip||{}),...prev.monsterEquip};
            if(prev.healPotions){merged.healPotions={...(merged.healPotions||{})};Object.keys(prev.healPotions).forEach(cid=>{merged.healPotions[cid]=Math.max(prev.healPotions[cid]||0,merged.healPotions[cid]||0);});}
            if(prev.healCaps){merged.healCaps={...(merged.healCaps||{})};Object.keys(prev.healCaps).forEach(cid=>{const p=prev.healCaps[cid]||{},m=merged.healCaps[cid]||{};merged.healCaps[cid]={hs:Math.max(p.hs||0,m.hs||0),hm:Math.max(p.hm||0,m.hm||0)};});}
            if(prev.equipUnlock){merged.equipUnlock={...(merged.equipUnlock||{})};Object.keys(prev.equipUnlock).forEach(cid=>{merged.equipUnlock[cid]=[...new Set([...(merged.equipUnlock[cid]||[]),...(prev.equipUnlock[cid]||[])])];});}
            if(prev.missionClaimed) merged.missionClaimed={...(merged.missionClaimed||{}),...prev.missionClaimed};
            if(prev.expedition) merged.expedition={...(merged.expedition||{}),...prev.expedition};
            // taskExpDay: 同じ日なら使用量(amt)は多い方＝同期巻き戻しでEXP日次上限がリセットされるのを防ぐ
            if(prev.taskExpDay){merged.taskExpDay={...(merged.taskExpDay||{})};Object.keys(prev.taskExpDay).forEach(cid=>{const p=prev.taskExpDay[cid]||{},m=merged.taskExpDay[cid]||{};merged.taskExpDay[cid]=(p.date===m.date)?{date:p.date,amt:Math.max(p.amt||0,m.amt||0)}:p;});}
            if(prev.monsterHP) merged.monsterHP={...(merged.monsterHP||{}),...prev.monsterHP};
            if(prev.monsterHPDate) merged.monsterHPDate={...(merged.monsterHPDate||{}),...prev.monsterHPDate};
            if(prev.monsterHPTs) merged.monsterHPTs={...(merged.monsterHPTs||{}),...prev.monsterHPTs};
            if(prev.battleWinDate) merged.battleWinDate={...(merged.battleWinDate||{}),...prev.battleWinDate};
            if(prev.battleBossUnlocked) merged.battleBossUnlocked={...(merged.battleBossUnlocked||{}),...prev.battleBossUnlocked};
            // darkEgg(ヤミノオウの卵): お世話度は多い方を採用＝同期巻き戻しで育成が消えない
            if(prev.darkEgg){merged.darkEgg={...(merged.darkEgg||{})};Object.keys(prev.darkEgg).forEach(cid=>{const p=prev.darkEgg[cid]||{},m=merged.darkEgg[cid]||{};merged.darkEgg[cid]=((p.care||0)>=(m.care||0))?p:m;});}
            // ヤミノオウのタマゴ所持フラグ: どちらかがtrueなら保持(同期で消えない)。未育成のみ意味を持つ
            if(prev.yamiEgg){merged.yamiEgg={...(merged.yamiEgg||{})};Object.keys(prev.yamiEgg).forEach(cid=>{if(prev.yamiEgg[cid]) merged.yamiEgg[cid]=true;});}
            // eggDrops(ヤミノタマゴ累積ドロップ=基礎ステ+1%/個): 多い方を採用
            if(prev.eggDrops){merged.eggDrops={...(merged.eggDrops||{})};Object.keys(prev.eggDrops).forEach(cid=>{merged.eggDrops[cid]=Math.max(prev.eggDrops[cid]||0,merged.eggDrops[cid]||0);});}
            // pendingApprovals: 承認/却下済みentryをリモートから復活させない
            if(_processedApprovalIds.size>0){
              merged.pendingApprovals=(merged.pendingApprovals||[]).filter(p=>!_processedApprovalIds.has(p.id));
            }
            // pendingRedemptions(ごほうび交換): 承認/却下済みを遅延スナップショットで復活させない＝再承認による二重減算を防ぐ
            if(_processedRedemptionIds.size>0){
              merged.pendingRedemptions=(merged.pendingRedemptions||[]).filter(p=>!_processedRedemptionIds.has(p.id));
            }
            // 新しいpendingApprovalsがあれば親デバイスで通知
            const _prevIds=new Set((prev.pendingApprovals||[]).map(p=>p.id));
            const _newPending=(merged.pendingApprovals||[]).filter(p=>!_prevIds.has(p.id)&&!_processedApprovalIds.has(p.id));
            if(_newPending.length>0&&(prev.familySettings||{}).approvalNotification&&"Notification"in window&&Notification.permission==="granted"){
              _newPending.forEach(p=>{try{new Notification("承認リクエスト 📬",{body:`${p.taskLabel||"タスク"}（+${p.pts||0}pt）`,icon:"/assets/tab_daily.png"});}catch(e){}});
            }
            return merged;
          });
                  }
      }catch(e){}
    },err=>console.warn("Realtime sync error:",err));
      }catch(e){console.warn("Could not start realtime sync:",e);}
}

// ── ログ1件をFirestoreに直接追記（上書きなし・衝突なし）──
async function addLogToFirestore(logEntry) {
  const code = getFamilyCode();
  if(!code || code==="default") return;
  const db = getDB();
  if(!db) return;
  try {
    // docIdはログのidをそのまま使う＝同一idの再書き込みは同じdocへ上書き(冪等)。
    // これで利子/配当のような決定的id(interest_cid_日付 等)は端末が同時付与しても重複docを作らない。
    const docId = String(logEntry.id || `log_${logEntry.cid}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`);
    await db.collection("families").doc(code)
            .collection("logs").doc(docId).set({
      ...logEntry,
      id: logEntry.id || docId,
      savedAt: new Date().toISOString()
    });
  } catch(e) { console.warn("Firestore log write failed:", e); }
}

// ── Firestoreのlogsコレクションを全件読み込む（ページングで漏れなく取得）──
// ※旧実装は limit(5000) 固定で、生涯ログが5000件を超えると最古(多くは獲得＝プラス)が窓から漏れ、
//   reconcileFullLogs が carry を捨てるため残高が全端末で目減りしていた（"fsLogs=全件"の前提が壊れる）。
async function loadLogsFromFirestore() {
  const code = getFamilyCode();
  if(!code || code==="default") return null;
  const db = getDB();
  if(!db) return null;
  try {
    const PAGE = 2000;
    let all = [], last = null;
    for(;;){
      let q = db.collection("families").doc(code).collection("logs").orderBy("date","desc").limit(PAGE);
      if(last) q = q.startAfter(last);
      const snap = await q.get();
      if(snap.empty) break;
      all = all.concat(snap.docs.map(d => d.data()));
      if(snap.docs.length < PAGE) break;       // 最終ページ
      last = snap.docs[snap.docs.length-1];
      if(all.length > 100000) break;           // 暴走安全弁（現実には到達しない）
    }
    return all.length ? all : null;
  } catch(e) {
    console.warn("Firestore logs load failed:", e);
    return null;
  }
}

// ── 端末間でポイント残高がズレる問題の収束ロジック ──
// Firestoreのlogsサブコレクション(全件=唯一の正)へ収束させる。
// carry(くりこし)は全件取得できている時は二重計上になるため除外する。
function _isCarryLog(l){ return !!(l && typeof l.id==="string" && l.id.indexOf("carry_")===0); }
function reconcileFullLogs(prevLogs, fsLogs){
  // id で完全に重複排除(Firestore側・ローカル側どちらの重複も残高に二重計上しない)。
  // carry(くりこし)は全件取得時は二重計上になるため捨てる。
  const out=[]; const seen=new Set();
  const push=(l)=>{ if(l && l.id!=null && !_isCarryLog(l) && !seen.has(l.id)){ seen.add(l.id); out.push(l); } };
  (fsLogs||[]).forEach(push);  // Firestore全件(=唯一の正)を優先採用
  const fsIds = new Set((fsLogs||[]).filter(l=>l&&l.id!=null).map(l=>l.id));
  const localOnly = [];
  (prevLogs||[]).forEach(l=>{
    if(l && l.id!=null && !_isCarryLog(l) && !fsIds.has(l.id) && !seen.has(l.id)) localOnly.push(l);
    push(l);  // ローカルにしか無い未同期ログも残す(重複は自動的に弾かれる)
  });
  out.sort((a,b)=> (a.date<b.date?1:a.date>b.date?-1:0));   // ISO文字列は辞書順=時刻順。Date生成を避けて大量ログでも軽い
  return { merged: out, localOnly };
}

// ── logsコレクションのリアルタイム監視 ──
let _logsUnsubscribe = null;
function startLogsRealtimeSync(updateFn) {
  const code = getFamilyCode();
  if(!code || code==="default") return;
  const db = getDB();
  if(!db) return;
  if(_logsUnsubscribe) _logsUnsubscribe();
  try {
    // 直近24時間分のログをリアルタイム監視
    const since = new Date(Date.now() - 24*60*60*1000).toISOString();
    _logsUnsubscribe = db.collection("families").doc(code)
      .collection("logs")
      .where("date", ">=", since)
      .onSnapshot(snap => {
        if(snap.empty) return;
        const newLogs = snap.docs.map(d => d.data());
        updateFn(prev => {
          if(!prev) return prev;
          // 既存ログと新ログをマージ（重複排除・日付順）
          const existingIds = new Set((prev.logs||[]).map(l=>l.id));
          const added = newLogs.filter(l => !existingIds.has(l.id));
          if(added.length === 0) return prev;
          const merged = [...added, ...(prev.logs||[])];
          merged.sort((a,b) => (a.date<b.date?1:a.date>b.date?-1:0));   // ISO文字列比較=時刻順。Date生成を避ける
                    return {...prev, logs: merged};
        });
      }, err => console.warn("Logs realtime sync error:", err));
      } catch(e) { console.warn("Could not start logs realtime sync:", e); }
}


// ═══════════════════════════════════════════════════════
// MONSTER TREE
// ═══════════════════════════════════════════════════════
const MONSTER_TREE = {
  egg:  { id:"egg", name:"タマゴ", rarity:1, line:"", stage:0, evolveTo:"m01",
          desc:"なにが生まれるかわからない、ふしぎなタマゴ。タッチしてあたためよう。", edu:"" },
  // ── 幼年期（共通）──
  m01:  { id:"m01", name:"ミンタモ", rarity:1, line:"", stage:1, evolveTo:"m02",
          desc:"コインのタネから生まれたばかりの赤ちゃん。げんきにぴょこぴょこ動く。",
          edu:"お金は「ためる」と少しずつ増えていく。小さなタネも、毎日の水やりで大きく育つよ。" },
  m02:  { id:"m02", name:"コロミント", rarity:1, line:"", stage:2, branch:["m03","m07","m11"],
          desc:"葉っぱの芽が出てきた幼年期。これから3つの道のどれかに進化する。",
          edu:"ここで3つの道に分かれるよ。もくひょうを達成すると「まなび」、れんぞく7日で「森」、ちょきん1000で「たから」へ進化！" },
  // ── A系統：自然・森（こつこつ継続で寄る）──
  m03:  { id:"m03", name:"バドゥクン", rarity:2, line:"a", stage:3, evolveTo:"m04",
          branchHint:"まいにちつづけて さいこう7日れんぞくで こっちに進化！",
          desc:"森の若芽をせおったいたずら好き。毎日の小さな積み重ねが大すき。",
          edu:"毎日コツコツ続けることを「習慣」という。少しずつでも毎日ためると、1年で大きな差になる。" },
  m04:  { id:"m04", name:"フロラクン", rarity:3, line:"a", stage:4, evolveTo:"m05",
          desc:"花と緑をまとった成熟期。仲間思いで、まわりを元気にする。",
          edu:"植物は太陽の力で養分をつくる(光合成)。お金も「はたらく」と新しい価値を生み出せる。" },
  m05:  { id:"m05", name:"シダーハート", rarity:4, line:"a", stage:5, evolveTo:"m06",
          desc:"大樹の心をもつ完全体。根を深くはり、どっしりかまえる。",
          edu:"大きな木も、もとは一粒のタネ。今ためているお金が、将来の大きな安心になる。" },
  m06:  { id:"m06", name:"ワールドミント", rarity:5, line:"a", stage:6, evolveTo:null,
          desc:"世界をやどす森の王・究極体。ふれた大地に緑とゆたかさを広げる。",
          edu:"自然はみんなの大切な財産。お金も、人やまわりと分け合うと、もっと大きな力になる。" },
  // ── B系統：竜・歴史（タスク&バッジで強くなると寄る）──
  m07:  { id:"m07", name:"スパイドラ", rarity:2, line:"b", stage:3, evolveTo:"m08",
          branchHint:"ちょきんを 1000までためると こっちに進化！",
          desc:"小さな竜の子。たからものを集めるのが得意で、好奇心おうせい。",
          edu:"大むかし、人は貝や石をお金として使った。やがて金や銀の「硬貨」が生まれた。" },
  m08:  { id:"m08", name:"ギルドレイク", rarity:3, line:"b", stage:4, evolveTo:"m09",
          desc:"黄金にかがやくウロコの成熟期。たからの番人として知られる。",
          edu:"硬貨のふちのギザギザは、けずって金属をぬすむズルを防ぐための昔の工夫。" },
  m09:  { id:"m09", name:"レリックワーム", rarity:4, line:"b", stage:5, evolveTo:"m10",
          desc:"古代の遺産を守る完全体。長い時を生き、歴史をその身に刻む。",
          edu:"紙のお金(紙幣)が広まったのは約1000年前の中国から。重い硬貨より持ち運びが楽になった。" },
  m10:  { id:"m10", name:"クロノドレイク", rarity:5, line:"b", stage:6, evolveTo:null,
          desc:"時をあやつる究極の竜。過去と未来をつなぎ、富の流れを見通す。",
          edu:"いまは「電子マネー」で形のないお金も使える時代。お金の形は時代とともに進化する。" },
  // ── C系統：民話・学問（まなび&目標で寄る）──
  m11:  { id:"m11", name:"トーテモル", rarity:2, line:"c", stage:3, evolveTo:"m12",
          branchHint:"もくひょうを 1つたっせいすると こっちに進化！",
          desc:"おまもりを身につけた森の精。ものしりで、なぞなぞが大すき。",
          edu:"世界には「お金のことわざ」がたくさん。『時は金なり』は時間の大切さを教える。" },
  m12:  { id:"m12", name:"スクロベア", rarity:3, line:"c", stage:4, evolveTo:"m13",
          desc:"巻物をかかえた学者グマの成熟期。知ることが何よりの楽しみ。",
          edu:"お金の使い方の計画を「予算(よさん)」という。先に決めておくと、むだづかいが減る。" },
  m13:  { id:"m13", name:"アーキヴル", rarity:4, line:"c", stage:5, evolveTo:"m14",
          desc:"知識の書庫を守るフクロウの完全体。あらゆる知恵を記録する。",
          edu:"お金を貸し借りすると「利子(りし)」がつくことがある。ふやす力にも、借りすぎの注意にもなる。" },
  m14:  { id:"m14", name:"ミスミント", rarity:5, line:"c", stage:6, evolveTo:null,
          desc:"伝説をつむぐ賢者・究極体。学びの力で、人々をゆたかにみちびく。",
          edu:"いちばん大切な財産は「学び」。知識は使ってもへらず、一生きみを助けてくれる。" },
  // ── ヤミノオウ系統(ボス撃破で稀にドロップする卵から育てる。通常タネモンと同じく「育てた度」＋時間で直線進化。gs=gacha_gs_*スプライト) ──
  yami_egg:{ id:"yami_egg", name:"ヤミノタマゴ", rarity:5, line:"yami", stage:0, evolveTo:"yami1", gs:"yamiegg",
          desc:"ヤミノオウが のこした なぞの たまご。あたたかく 育てて 孵そう。",
          edu:"中で 命が 育っている。すぐには かえらない。お金も おなじで、待つ力が 大きく育てる。" },
  yami1:{ id:"yami1", name:"ヤミの雫", rarity:5, line:"yami", stage:1, evolveTo:"yami2", gs:"yami1",
          desc:"殻を やぶって 生まれたばかりの 闇の しずく。まだ ぷるぷる。",
          edu:"どんな 強いものも 始まりは 小さい。お金も コツコツが 力になる。" },
  yami2:{ id:"yami2", name:"ヤミッコ", rarity:5, line:"yami", stage:2, evolveTo:"yami3", gs:"yami2",
          desc:"手足が 生えた 小さな 影。よちよち 動きはじめた。",
          edu:"少しずつ できることが 増えていく。続けるほど 育つのが 育成も 貯金も おなじ。" },
  yami3:{ id:"yami3", name:"ヤミドラゴ", rarity:5, line:"yami", stage:3, evolveTo:"yami4", gs:"yami3",
          desc:"子竜らしく なってきた。小さな ツノと 牙が 生えた。",
          edu:"ここまで 続けられたのが すごい。やめずに 続ける力が、いちばんの 才能だよ。" },
  yami4:{ id:"yami4", name:"ヤミノツバサ", rarity:5, line:"yami", stage:4, evolveTo:"yami5", gs:"yami4",
          desc:"大きな 翼が 生えた 闇の竜。空を かけるように なった。",
          edu:"コツコツの つみ重ねが、目に見える 大きな力に なってきた。投資の 複利と おなじだね。" },
  yami5:{ id:"yami5", name:"ヤミノリュウ", rarity:5, line:"yami", stage:5, evolveTo:"yami_u", gs:"yami5",
          desc:"闇の力が 満ちた 龍。頭上には 光の輪が ともり、王の あと一歩。",
          edu:"あと少し。最後まで やりきる人は そう多くない。ゴールの 目前こそ ふんばりどき。" },
  yami_u:{ id:"yami_u", name:"ヤミノオウ", rarity:5, line:"yami", stage:6, evolveTo:null, gs:"yami",
          desc:"育てて 闇の力を 光に変え、王として めざめた すがた！じぶんだけの ヤミノオウ。",
          edu:"つづける力が いちばん つよい。毎日の 小さな つみ重ねが、伝説の王を 育てあげた。" },
  // ── 猫タネもん：プリン(cpurin) egg→b1→b2→mature→[森の力/星の力]→ult ──
  cpurin_egg:    { id:"cpurin_egg",    name:"プリンのタマゴ", rarity:1, line:"cat", stage:0, evolveTo:"cpurin_b1",
          desc:"鈴のついた、ねこのタマゴ。あたためるとプリンが生まれる。", edu:"いきものを育てるには毎日のお世話が大切。お金も毎日コツコツ育てよう。" },
  cpurin_b1:     { id:"cpurin_b1",     name:"こねこプリン", rarity:1, line:"cat", stage:1, evolveTo:"cpurin_b2",
          desc:"生まれたての、ちいさなプリン。げんきいっぱい。", edu:"小さな一歩のつみ重ねが、大きな成長になるよ。" },
  cpurin_b2:     { id:"cpurin_b2",     name:"わんぱくプリン", rarity:2, line:"cat", stage:2, evolveTo:"cpurin_mature",
          desc:"あそびざかりのプリン。しっぽをふってごきげん。", edu:"毎日つづけると「習慣」になる。続ける力はお金を育てる力。" },
  cpurin_mature: { id:"cpurin_mature", name:"つぶらのプリン", rarity:3, line:"cat", stage:3, branch:["cpurin_perfA","cpurin_perfB"],
          desc:"成熟期のプリン。育て方で2つの道に分かれる。",
          edu:"ここで分岐！れんぞく7日で『森の力』、もくひょう達成で『星の力』へ進化するよ。" },
  cpurin_perfA:  { id:"cpurin_perfA",  name:"森導士プリン", rarity:4, line:"cat", stage:4, evolveTo:"cpurin_ultA",
          branchHint:"まいにちつづけて さいこう7日れんぞくで こっちに進化！",
          desc:"森の力にめざめた完全体。みどりの杖で自然をあやつる。", edu:"自然はみんなの大切な財産。続ける力が大きな実りを生む。" },
  cpurin_perfB:  { id:"cpurin_perfB",  name:"星見導師プリン", rarity:4, line:"cat", stage:4, evolveTo:"cpurin_ultB",
          branchHint:"もくひょうを たっせいすると こっちに進化！",
          desc:"星の力にめざめた完全体。星をよんで未来を見る。", edu:"目標を決めてやりとげる力は、夢をかなえる第一歩。" },
  cpurin_ultA:   { id:"cpurin_ultA",   name:"聖天使プリンエル", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・天使のプリン。光の輪と翼をもつ守り神。", edu:"コツコツ続けた先に、いちばん輝くすがたが待っている。" },
  cpurin_ultB:   { id:"cpurin_ultB",   name:"星界神プリンゾーン", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・星界の神プリン。宇宙の星々をしたがえる。", edu:"目標をかなえ続けた者だけが届く、伝説のすがた。" },
  // ── 猫タネもん：クー(cku) 黒猫 ──
  cku_egg:    { id:"cku_egg",    name:"クーのタマゴ", rarity:1, line:"cat", stage:0, evolveTo:"cku_b1",
          desc:"よるのようにくろい、ねこのタマゴ。", edu:"いきものを育てるには毎日のお世話が大切。お金も毎日コツコツ。" },
  cku_b1:     { id:"cku_b1",     name:"こねこクー", rarity:1, line:"cat", stage:1, evolveTo:"cku_b2",
          desc:"生まれたての黒いこねこ。目がきらきら。", edu:"小さな一歩のつみ重ねが大きな成長に。" },
  cku_b2:     { id:"cku_b2",     name:"わんぱくクー", rarity:2, line:"cat", stage:2, evolveTo:"cku_mature",
          desc:"やんちゃな黒ねこ。よるのおさんぽが大すき。", edu:"毎日つづけると習慣になる。続ける力はお金を育てる力。" },
  cku_mature: { id:"cku_mature", name:"つぶらのクー", rarity:3, line:"cat", stage:3, branch:["cku_perfA","cku_perfB"],
          desc:"成熟期のクー。育て方で2つの道に分かれる。",
          edu:"ここで分岐！れんぞく7日で『森の力』、もくひょう達成で『星の力』へ。" },
  cku_perfA:  { id:"cku_perfA",  name:"森導士クー", rarity:4, line:"cat", stage:4, evolveTo:"cku_ultA",
          branchHint:"まいにちつづけて さいこう7日れんぞくで こっちに進化！",
          desc:"森の力にめざめた完全体のクー。", edu:"続ける力が大きな実りを生む。" },
  cku_perfB:  { id:"cku_perfB",  name:"星見導師クー", rarity:4, line:"cat", stage:4, evolveTo:"cku_ultB",
          branchHint:"もくひょうを たっせいすると こっちに進化！",
          desc:"星の力にめざめた完全体のクー。", edu:"目標をやりとげる力は夢への第一歩。" },
  cku_ultA:   { id:"cku_ultA",   name:"聖天使クーエル", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・天使のクー。", edu:"コツコツ続けた先に、いちばん輝くすがたが待っている。" },
  cku_ultB:   { id:"cku_ultB",   name:"星界神クーゾーン", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・星界の神クー。", edu:"目標をかなえ続けた者だけが届く伝説のすがた。" },
  // ── 猫タネもん：シー(cshi) 白黒猫 ──
  cshi_egg:    { id:"cshi_egg",    name:"シーのタマゴ", rarity:1, line:"cat", stage:0, evolveTo:"cshi_b1",
          desc:"白と黒のもようの、ねこのタマゴ。", edu:"いきものを育てるには毎日のお世話が大切。お金も毎日コツコツ。" },
  cshi_b1:     { id:"cshi_b1",     name:"こねこシー", rarity:1, line:"cat", stage:1, evolveTo:"cshi_b2",
          desc:"生まれたての白黒こねこ。あしあとが大きい。", edu:"小さな一歩のつみ重ねが大きな成長に。" },
  cshi_b2:     { id:"cshi_b2",     name:"わんぱくシー", rarity:2, line:"cat", stage:2, evolveTo:"cshi_mature",
          desc:"げんきな白黒ねこ。とびはねるのが大すき。", edu:"毎日つづけると習慣になる。続ける力はお金を育てる力。" },
  cshi_mature: { id:"cshi_mature", name:"つぶらのシー", rarity:3, line:"cat", stage:3, branch:["cshi_perfA","cshi_perfB"],
          desc:"成熟期のシー。育て方で2つの道に分かれる。",
          edu:"ここで分岐！れんぞく7日で『森の力』、もくひょう達成で『星の力』へ。" },
  cshi_perfA:  { id:"cshi_perfA",  name:"森導士シー", rarity:4, line:"cat", stage:4, evolveTo:"cshi_ultA",
          branchHint:"まいにちつづけて さいこう7日れんぞくで こっちに進化！",
          desc:"森の力にめざめた完全体のシー。剣と盾の騎士。", edu:"続ける力が大きな実りを生む。" },
  cshi_perfB:  { id:"cshi_perfB",  name:"星見導師シー", rarity:4, line:"cat", stage:4, evolveTo:"cshi_ultB",
          branchHint:"もくひょうを たっせいすると こっちに進化！",
          desc:"星の力にめざめた完全体のシー。", edu:"目標をやりとげる力は夢への第一歩。" },
  cshi_ultA:   { id:"cshi_ultA",   name:"聖天使シーエル", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・天使のシー。", edu:"コツコツ続けた先に、いちばん輝くすがたが待っている。" },
  cshi_ultB:   { id:"cshi_ultB",   name:"星界神シーゾーン", rarity:5, line:"cat", stage:5, evolveTo:null,
          desc:"究極体・星界の神シー。", edu:"目標をかなえ続けた者だけが届く伝説のすがた。" },
  // ── ✨ひみつ系統「スラリル」(隠し・保護者がプレゼントで配布。表には出さない特別枠) ──
  // 異世界転生スライム風: しずく→転生スライム→名付け→嵐竜の友→あおの魔人→竜魔王。直線進化(yami式)。
  srimu_egg: { id:"srimu_egg", name:"ひかるしずく", rarity:5, line:"srimu", stage:0, evolveTo:"srimu1",
          desc:"どこかから ころんと あらわれた、ふしぎに ひかる しずくの タマゴ。なかで なにかが ねむっている。",
          edu:"小さな 一しずくも、たいせつに 育てれば 大きくなる。お金も 育成も、はじまりは いつも ちいさい。" },
  srimu1:    { id:"srimu1", name:"スラっこ", rarity:5, line:"srimu", stage:1, evolveTo:"srimu2",
          desc:"べつの せかいから 生まれかわった ちいさな スライム。よわいけど、だれより げんきで すなお。",
          edu:"いちばん よわい スタートでも、まいにちの つみ重ねで だれでも 強くなれる。コツコツが 才能だよ。" },
  srimu2:    { id:"srimu2", name:"うつしスライム", rarity:5, line:"srimu", stage:2, evolveTo:"srimu3",
          desc:"見たものの かたちや わざを 「うつして」 おぼえる スライム。まねっこ 名人。",
          edu:"上手な人の まねから 学ぶのが いちばんの 近道。お金の つかい方も、上手な人を まねしてみよう。" },
  srimu3:    { id:"srimu3", name:"なまえスライム", rarity:5, line:"srimu", stage:3, evolveTo:"srimu4",
          desc:"友だちに 「名前」を もらって ぐんと 成長した すがた。名前は こころの きずな。",
          edu:"だいじに されると 力が わく。お金も「なんの ための お金か」名前(目的)を つけると 大切にできる。" },
  srimu4:    { id:"srimu4", name:"あらし竜の友", rarity:5, line:"srimu", stage:4, evolveTo:"srimu5",
          desc:"ちいさな 嵐の子竜と 仲よくなり、ツノと 風の翼を 手に入れた。竜の力が めばえはじめた。",
          edu:"いい 仲間と つながると、ひとりでは できない 力が 出る。たすけ合いも 大きな『たから』。" },
  srimu5:    { id:"srimu5", name:"あおの魔人", rarity:5, line:"srimu", stage:5, evolveTo:"srimu_u",
          desc:"人の すがたも とれるようになった、あおく かがやく 魔人。やさしくて たよれる リーダー。",
          edu:"強くなるほど、まわりを たすける 力にも なる。お金も 同じで、ふやした力で 人を しあわせにできる。" },
  srimu_u:   { id:"srimu_u", name:"竜魔王スラリル", rarity:5, line:"srimu", stage:6, evolveTo:null,
          desc:"竜と 魔の 力を あわせもつ やさしき 王・究極体。みんなの 国を まもる、せかいに ひとつの あいぼう。",
          edu:"いちばん つよい 王は、ちからを みんなの ために つかう。育てる力・まもる力こそ 本物の つよさ。" },
};

// 6フレームアニメ素材を持つモンスター(IDLE/BOUNCE/WOBBLE等のコマをf0..f5で順送り)
const MON_FRAMES6 = { egg:1, m01:1,m02:1,m03:1,m04:1,m05:1,m06:1,m07:1,m08:1,m09:1,m10:1 };

// ✨ ひみつ系統「スラリル」: 進化系統(スラっこ以降)はまだ表に出さない＝卵だけ公開。
//   進化アートが揃ったら true にすると、srimu_egg→srimu1→…→srimu_u の全進化が解禁される。
const SLIME_EVOLVE_ENABLED = false;

// ═══════════════════════════════════════════════════════
// 背景テーマ（累計タスク数で解放。暗色なので白文字でも読みやすい）
const BG_THEMES = [
  { id:"auto",   name:"じかんたい", emoji:"🕒", need:0,   grad:null, stars:false },
  // 🌸 きせかえ背景（オリジナルのドット絵シーン）。すぐ使える春＋少しずつ解放
  { id:"harumachi", name:"はるのまち", emoji:"🌸", need:0,  grad:"linear-gradient(180deg,#123a2a 0%,#1e5a3e 45%,#2a3a6a 100%)", stars:false, img:"/assets/bg_spring.jpg" },
  { id:"umibe",     name:"なつのうみ", emoji:"🏖", need:5,  grad:"linear-gradient(180deg,#083a5a 0%,#0e5a7a 45%,#0a6a5a 100%)", stars:false, img:"/assets/bg_summer.jpg" },
  { id:"akimori",   name:"あきのもり", emoji:"🍂", need:10, grad:"linear-gradient(180deg,#3a2410 0%,#5a3a1a 45%,#6a4a20 100%)", stars:false, img:"/assets/bg_autumn.jpg" },
  { id:"yorumachi", name:"よるのまち", emoji:"🌙", need:18, grad:"linear-gradient(180deg,#040820 0%,#0a1440 45%,#101a4a 100%)", stars:true,  img:"/assets/bg_yorumachi.jpg" },
  { id:"forest", name:"もり",       emoji:"🌲", need:8,   grad:"linear-gradient(180deg,#0a1a12 0%,#0e2b1a 45%,#103a22 100%)", stars:false, img:"/assets/bg_forest.jpg" },
  { id:"ocean",  name:"ふかい海",   emoji:"🌊", need:12,  grad:"linear-gradient(180deg,#04121f 0%,#06283d 40%,#063a4a 75%,#0a4a3a 100%)", stars:false, img:"/assets/bg_ocean.jpg" },
  { id:"sunset", name:"ゆうやけ",   emoji:"🌇", need:25,  grad:"linear-gradient(180deg,#1a0a1e 0%,#5a1530 35%,#a8442a 70%,#3a1a10 100%)", stars:false, img:"/assets/bg_sunset.jpg" },
  { id:"night",  name:"よぞら",     emoji:"🌙", need:45,  grad:"linear-gradient(180deg,#020410 0%,#0a1330 45%,#101a40 100%)", stars:true, img:"/assets/bg_night.jpg" },
  { id:"galaxy", name:"うちゅう",   emoji:"🌌", need:75,  grad:"linear-gradient(180deg,#0a0618 0%,#1a0d33 45%,#0d0820 100%)", stars:true, img:"/assets/bg_galaxy.jpg" },
  { id:"aurora", name:"オーロラ",   emoji:"✨", need:120, grad:"linear-gradient(180deg,#03101a 0%,#06281f 40%,#10103a 80%,#06281f 100%)", stars:true, img:"/assets/bg_aurora.jpg" },
  { id:"sakura", name:"さくら",     emoji:"🌸", need:180, grad:"linear-gradient(180deg,#1a0a16 0%,#4a1a36 40%,#6a2a4a 75%,#2a1020 100%)", stars:true, img:"/assets/bg_sakura.jpg" },
];


// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// 進化の状態（時間ゲート＋育てた度ゲージの二重条件）
// EVO_HOURS:  現ステージを「出る」のに必要な最低経過時間(h)。幼年期1=2h,幼年期2=2h,成長期=24〜42h(個体差),成熟期=24h,完全体=72h
// EVO_GROWTH: 現ステージを「出る」のに必要な累計"育てた度"(=お手伝い + バッジ*3 + なでなで日数*2)
const EVO_HOURS  = { 0:2, 1:2, 2:33, 3:24, 4:72, 5:72 };
// 成長期(stage2)だけは24〜42hの個体差(子ごとに決まる)
function evoHoursFor(stage, cid){
  if(stage===2){ let n=0; for(const c of String(cid)) n=(n*31+c.charCodeAt(0))%19; return 24+n; }
  return EVO_HOURS[stage] ?? 0;
}
const EVO_GROWTH = { 0:2, 1:5, 2:9, 3:16, 4:26, 5:40 };
const REINC_HOURS = 96;   // 究極体→転生できるまで(4日)
function getMonState(data, child){
  const cid = child.id;
  const logs = (data.logs||[]).filter(l=>l.cid===cid);
  const tasksDone  = logs.filter(l=>l.type==="good"||l.type==="daily").length;
  const badgeCount = logs.filter(l=>l.type==="badge").length;
  const careDays   = ((data.monsterCare||{})[cid]||{}).days || 0;
  // 配当ごはん: 長期保有の配当(interestログのうち「配当」)を相棒の育てた度に加算(上限30=投資→育成の融合)
  const dividendFeed = Math.min(30, logs.filter(l=>l.type==="interest" && /配当/.test(l.label||"")).length);
  const gauge      = tasksDone + badgeCount*3 + careDays*2 + dividendFeed;   // 育てた度
  const rawId = (data.monsterEvolved||{})[cid] || null;
  const curId = (rawId && MONSTER_TREE[rawId]) ? rawId : "egg";
  const def   = MONSTER_TREE[curId];
  const stage = def.stage||0;
  const isFinal = !def.evolveTo && !def.branch;
  // テスト進化モード(1時間限定): 時間ゲート＆育てた度をスキップして即進化/即卒業できる
  const testEvolve = ((data.testEvolveUntil||{})[cid] || 0) > Date.now();
  const need     = EVO_GROWTH[stage] ?? 0;
  const prevNeed = stage>0 ? (EVO_GROWTH[stage-1] ?? 0) : 0;
  const growthOk = testEvolve ? true : (gauge >= need);
  const growthPct = isFinal ? 100 : Math.max(0, Math.min(100, Math.round((gauge-prevNeed)/Math.max(1,need-prevNeed)*100)));
  const growthRemain = isFinal ? 0 : Math.max(0, need - gauge);
  const stageAt = (data.monsterStageAt||{})[cid] || (data.monsterEvolvedAt||{})[cid] || null;
  const elapsedMs = stageAt ? (Date.now() - new Date(stageAt).getTime()) : Infinity;
  // ヤミノオウの卵を育成中(究極体前)は、通常モンスターの進化が1.5倍遅くなる(育てる力が分散)
  const _eggRaising = false;   // (旧)ヤミノオウ卵の育成中に通常進化を1.5倍遅くする仕様は廃止。今は1体ずつ育てる
  const reqMs = evoHoursFor(stage, cid) * 3600000 * (_eggRaising ? 1.5 : 1);
  const timeOk = testEvolve ? true : (elapsedMs >= reqMs);
  const timeRemainMs = Math.max(0, reqMs - elapsedMs);
  const canEvolve = !isFinal && timeOk && growthOk;
  const reincRemainMs = isFinal ? Math.max(0, REINC_HOURS*3600000 - elapsedMs) : 0;
  const canReincarnate = isFinal && (testEvolve || elapsedMs >= REINC_HOURS*3600000);
  return { curId, def, stage, isFinal, tasksDone, badgeCount, careDays, gauge, need, testEvolve,
           growthOk, growthPct, growthRemain, timeOk, timeRemainMs, canEvolve,
           canReincarnate, reincRemainMs };
}
function fmtTimeRemain(ms){
  if(ms<=0 || !isFinite(ms)) return "";
  const h = Math.ceil(ms/3600000);
  if(h>=24){ const d=Math.ceil(h/24); return `あと${d}日`; }
  return `あと${h}時間`;
}

const INIT = {
  parentPinH: pinHash("0000"),
  children: [
    { id: "c1", name: "れいか", emoji: "🌸", pinh: pinHash("1111"), ageMode: "middle",
      displayMode: "teen", role: "child", gradeLabel: "中学生",
      permissions: { investment: "trade", forex: "trade", dailyBonus: true, ranking: true },
      visibility: { balanceToFamily: "hidden", goalToFamily: "progress_only", investmentResultToFamily: "ranking_only", rankingParticipation: true, operationRankingParticipation: true, rankingMetric: "approved_activity_points" }
    },
    { id: "c2", name: "かなと", emoji: "⚡", pinh: pinHash("2222"), ageMode: "senior",
      displayMode: "teen", role: "child", gradeLabel: "高校生",
      permissions: { investment: "trade", forex: "trade", dailyBonus: true, ranking: true },
      visibility: { balanceToFamily: "hidden", goalToFamily: "progress_only", investmentResultToFamily: "ranking_only", rankingParticipation: true, operationRankingParticipation: true, rankingMetric: "approved_activity_points" }
    },
  ],
  goodTasks: [
    {id:"g01",emoji:"📝",label:"テスト点100点",pts:500,over:{}},
    {id:"g02",emoji:"🗑",label:"ゴミ袋大",pts:20,over:{}},
    {id:"g03",emoji:"🗑",label:"ゴミ袋小",pts:10,over:{}},
    {id:"g04",emoji:"🍚",label:"お米を炊く",pts:30,over:{}},
    {id:"g05",emoji:"👟",label:"玄関の靴を全てきれいに並べる",pts:10,over:{}},
    {id:"g06",emoji:"🤖",label:"ルンバのゴミを捨てる",pts:10,over:{}},
    {id:"g07",emoji:"💧",label:"水のボトルに水を入れる",pts:10,over:{}},
    {id:"g08",emoji:"🐱",label:"猫の汚物の掃除",pts:30,over:{}},
    {id:"g09",emoji:"🛁",label:"お風呂掃除をする",pts:20,over:{}},
    {id:"g10",emoji:"🐱",label:"猫の排泄物を掃除する",pts:50,over:{}},
    {id:"g11",emoji:"🚽",label:"猫のトイレ掃除を手伝う",pts:100,over:{}},
    {id:"g12",emoji:"🌙",label:"23時までに寝る",pts:20,over:{}},
    {id:"g13",emoji:"🌙",label:"22時までに寝る",pts:30,over:{}},
    {id:"g14",emoji:"👕",label:"自分の乾いた洗濯物を片付ける",pts:5,over:{}},
    {id:"g15",emoji:"⏰",label:"朝6時35分までに自分で起きる",pts:10,over:{}},
    {id:"g16",emoji:"🧹",label:"一部屋掃除機をかける",pts:50,over:{}},
    {id:"g17",emoji:"🍬",label:"お菓子コーナーの片付け(2週間に1回)",pts:100,over:{}},
    {id:"g18",emoji:"🛏",label:"朝10時までに布団を干す&回収する",pts:100,over:{}},
    {id:"g19",emoji:"📐",label:"自分の机の上・下の整理整頓",pts:50,over:{}},
    {id:"g20",emoji:"👔",label:"洗濯物を洗濯機から出す&干す",pts:50,over:{}},
    {id:"g21",emoji:"👚",label:"クローゼットの整理整頓",pts:50,over:{}},
    {id:"g22",emoji:"🛏",label:"家族の布団を整える",pts:30,over:{}},
    {id:"g23",emoji:"🧺",label:"洗濯物をたたむ",pts:30,over:{}},
    {id:"g24",emoji:"🍽",label:"食洗機に食器を入れて回す&片付け",pts:30,over:{}},
    {id:"g25",emoji:"🌀",label:"換気扇フィルターを変える",pts:30,over:{}},
    {id:"g26",emoji:"🗑",label:"ゴミの日にゴミを集める",pts:10,over:{}},
    {id:"g27",emoji:"🧻",label:"テーブルを拭く(制限時間3分)",pts:20,over:{}},
    {id:"g28",emoji:"🛏",label:"ベッドメイク",pts:5,over:{}},
    {id:"g29",emoji:"🧺",label:"1枚タオルを畳む&直す",pts:5,over:{}},
    {id:"g30",emoji:"👟",label:"シューズを持って帰ってくる",pts:5,over:{}},
    {id:"g31",emoji:"👕",label:"朝パジャマを片付ける",pts:5,over:{}},
    {id:"g32",emoji:"🪑",label:"テーブル周りに何も置かない",pts:10,over:{}},
    {id:"g33",emoji:"🗑",label:"ゴミ袋をゴミ箱にセットする",pts:5,over:{}},
    {id:"g34",emoji:"🗑",label:"落ちているゴミを2個捨てる",pts:5,over:{}},
    {id:"g35",emoji:"👶",label:"おむつを捨てる",pts:5,over:{}},
    {id:"g36",emoji:"📝",label:"テストで満点を取る",pts:1000,over:{}},
  ],
  badTasks: [
    {id:"b01",emoji:"📺",label:"勝手にYouTubeを見る",pts:-50,over:{}},
    {id:"b02",emoji:"🍽",label:"積極的にご飯を準備しない",pts:-50,over:{}},
    {id:"b03",emoji:"🙈",label:"返事をしない",pts:-50,over:{}},
    {id:"b04",emoji:"🪑",label:"テーブル周りに自分のものを置きっぱなし",pts:-30,over:{}},
    {id:"b05",emoji:"🎒",label:"下校後に学校カバンを指定の場所にしまわない",pts:-10,over:{}},
    {id:"b06",emoji:"👟",label:"自分の靴が揃っていない",pts:-10,over:{}},
    {id:"b07",emoji:"👔",label:"下校後すぐに制服をハンガーにかけない",pts:-10,over:{}},
    {id:"b08",emoji:"👕",label:"服・パジャマの置きっぱなし",pts:-20,over:{}},
    {id:"b09",emoji:"😮",label:"口を5回開ける",pts:-500,over:{}},
    {id:"b10",emoji:"🤥",label:"嘘をつく",pts:-500,over:{}},
    {id:"b11",emoji:"📚",label:"勉強机の周りに不要なものが落ちている",pts:-200,over:{}},
  ],
  rewards: [
    {id:"r01",emoji:"🎮",label:"スイッチオンライン代(毎月1日)",cost:200,unit:"毎月の支払いに充てる"},
    {id:"r02",emoji:"📱",label:"スマートフォン30分",cost:200,unit:"スマホ使用時間+30分"},
    {id:"r03",emoji:"🍬",label:"好きなお菓子いっこ",cost:200,unit:"好きなお菓子1つ"},
    {id:"r04",emoji:"🎬",label:"Netflix 30分",cost:200,unit:"Netflix視聴+30分"},
    {id:"r05",emoji:"📺",label:"YouTube 30分",cost:200,unit:"YouTube視聴+30分"},
    {id:"r06",emoji:"🎮",label:"ゲーム30分",cost:200,unit:"ゲーム時間+30分"},
    {id:"r07",emoji:"💴",label:"500円交換",cost:2000,unit:"現金500円と交換"},
  ],
  gacha: [
    { id: "gc1", emoji: "⚪", label: "ノーマル",     color: "#9a917a", rate: 60, min: 1,  max: 10  },
    { id: "gc2", emoji: "🔵", label: "レア",         color: "#4a9eff", rate: 25, min: 11, max: 25  },
    { id: "gc3", emoji: "🟡", label: "スーパーレア", color: "#f5c842", rate: 12, min: 26, max: 40  },
    { id: "gc4", emoji: "🔴", label: "激レア",       color: "#f0605a", rate: 3,  min: 41, max: 50  },
  ],
  cats: [
    { id: "cat1", emoji: "🍕", label: "食べもの",     color: "#f97316" },
    { id: "cat2", emoji: "🎮", label: "ゲーム・遊び", color: "#8b5cf6" },
    { id: "cat3", emoji: "📚", label: "本・文具",     color: "#3b82f6" },
    { id: "cat4", emoji: "👗", label: "服・グッズ",   color: "#ec4899" },
    { id: "cat5", emoji: "🎁", label: "プレゼント",   color: "#10b981" },
    { id: "cat6", emoji: "💡", label: "その他",       color: "#9a917a" },
  ],
  logs: [],      // {id,cid,type,label,pts,date,rid?}
  expenses: [],  // {id,cid,catId,label,amt,date}
  goals: [],     // {id,cid,emoji,label,target,done,doneDate?}
  gachaDate: {}, // {[cid]: "YYYY-M-D"}
  streak: {},    // {[cid]: {cur,max,last}}
  // daily tasks: checklist or count, reset each day
  dailyTasks: [
    { id: "d1", emoji: "🧹", label: "部屋の片付け",       type: "check", pts: 30, target: 1 },
    { id: "d2", emoji: "🍽", label: "皿洗い",            type: "count", pts: 20, target: 1 },
    { id: "d3", emoji: "📐", label: "机の上を片付ける",   type: "check", pts: 20, target: 1 },
  ],
  dailyBonus: 50,
  // 複数タスクセット管理
  dailyTaskSets: [
    {
      id: "set_default",
      name: "通常セット",
      emoji: "📋",
      tasks: [
        { id: "d1", emoji: "🧹", label: "部屋の片付け",     type: "check", pts: 30, target: 1 },
        { id: "d2", emoji: "🍽", label: "皿洗い",          type: "count", pts: 20, target: 1 },
        { id: "d3", emoji: "📐", label: "机の上を片付ける", type: "check", pts: 20, target: 1 },
      ],
      bonus: 50,
      startDate: "",   // "" = 常時有効
      endDate: "",
      active: true,
    }
  ],
  activeSetId: "set_default",  // 後方互換(単一)
  activeSetIds: ["set_default"],  // 同時アクティブ(最大2)
  dailyProgress: {},
  parents: [
    {id:"p1",name:"パパ",emoji:"👨",pinh:pinHash("3333"),
      displayMode:"adult", role:"parent", gradeLabel:"",
      participationMode:"player_and_guardian",
      permissions:{investment:"trade",forex:"trade",dailyBonus:true,ranking:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"}
    },
    {id:"p2",name:"ママ",emoji:"👩",pinh:pinHash("4444"),
      displayMode:"adult", role:"parent", gradeLabel:"",
      participationMode:"player_and_guardian",
      permissions:{investment:"trade",forex:"trade",dailyBonus:true,ranking:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"}
    },
  ],
  parentLogs: {},
  parentTasks: [
    {id:"pt1",emoji:"🍳",label:"朝食を作る",pts:30},
    {id:"pt2",emoji:"🧹",label:"掃除機をかける",pts:40},
    {id:"pt3",emoji:"🛒",label:"買い物をする",pts:30},
  ],
  familyRewards: [
    {id:"fr1",emoji:"🍕",label:"家族でピザ",cost:500},
    {id:"fr2",emoji:"🎬",label:"映画を見る",cost:300},
  ],
  violations: [],
  tutorialSeen: {},
  pinChanged: {},
  lockEnabled: {},
  interestEnabled: true,
  interestRate: 0.01,
  interestLastDate: {},
  holdBonusLastDate: {},
  weeklyReportSeen: {},
  stocks: [
    {id:"s1",emoji:"🎮",name:"任天堂",ticker:"7974.T",sector:"ゲーム",price:8000,history:[8000],currency:"JPY"},
    // ── 架空の学習用銘柄（親が設定できる・リアル取得せずシミュレーションで動く。bias=日次ドリフト/vol=ゆれ幅/floor=下限）──
    {id:"f1",emoji:"🌱",name:"タネのめ食品",fake:true,sector:"架空・学習用",price:1000,currency:"JPY",bias:0.004,vol:0.012,floor:300,history:[840,855,870,885,905,925,950,970,990,1000]},
    {id:"f2",emoji:"🚀",name:"ロケットゲームズ",fake:true,sector:"架空・学習用",price:1500,currency:"JPY",bias:0.006,vol:0.05,floor:300,history:[900,1100,950,1300,1150,1500,1250,1600,1400,1500]},
    {id:"f3",emoji:"🎈",name:"バブルソーダ",fake:true,sector:"架空・学習用",price:600,currency:"JPY",bias:-0.004,vol:0.045,floor:100,history:[400,520,640,780,900,820,720,640,610,600]},
    {id:"f4",emoji:"⛅",name:"おてんき牧場",fake:true,sector:"架空・学習用",price:800,currency:"JPY",bias:0,vol:0.02,floor:200,history:[800,820,790,810,785,805,815,790,800,800]},
    {id:"f5",emoji:"💎",name:"きらめき鉱山",fake:true,sector:"架空・学習用",price:2000,currency:"JPY",bias:0.002,vol:0.03,floor:500,history:[1850,1900,1870,1950,1980,1940,2010,1990,2030,2000]},
    {id:"s2",emoji:"🎵",name:"ソニー",ticker:"6758.T",sector:"エンタメ",price:2800,history:[2800],currency:"JPY"},
    {id:"s3",emoji:"🚗",name:"トヨタ",ticker:"7203.T",sector:"自動車",price:3000,history:[3000],currency:"JPY"},
    {id:"s4",emoji:"🍔",name:"マクドナルド",ticker:"MCD",sector:"食品",price:380,history:[380],currency:"USD"},
    {id:"s5",emoji:"🍎",name:"Apple",ticker:"AAPL",sector:"テクノロジー",price:220,history:[220],currency:"USD"},
    {id:"s6",emoji:"🧸",name:"タカラトミー",ticker:"7867.T",sector:"おもちゃ",price:2800,history:[2800],currency:"JPY"},
    {id:"s7",emoji:"🎀",name:"サンリオ",ticker:"8136.T",sector:"キャラクター",price:6000,history:[6000],currency:"JPY"},
    {id:"s8",emoji:"🥤",name:"コカ・コーラ",ticker:"KO",sector:"飲料",price:62,history:[62],currency:"USD"},
    {id:"s9",emoji:"📦",name:"アマゾン",ticker:"AMZN",sector:"小売",price:220,history:[220],currency:"USD"},
    {id:"s10",emoji:"👟",name:"ナイキ",ticker:"NKE",sector:"スポーツ",price:75,history:[75],currency:"USD"},
    {id:"s11",emoji:"🏰",name:"ディズニー",ticker:"DIS",sector:"エンタメ",price:110,history:[110],currency:"USD"},
    {id:"s12",emoji:"👕",name:"ユニクロ",ticker:"9983.T",sector:"衣料",price:48000,history:[48000],currency:"JPY"},
    {id:"s13",emoji:"🏦",name:"三菱UFJ",ticker:"8306.T",sector:"銀行",price:1800,history:[1800],currency:"JPY"},
    {id:"s14",emoji:"📱",name:"ソフトバンク",ticker:"9984.T",sector:"通信",price:9000,history:[9000],currency:"JPY"},
    {id:"s15",emoji:"🍜",name:"日清食品",ticker:"2897.T",sector:"食品",price:3700,history:[3700],currency:"JPY"},
    {id:"s16",emoji:"⚡",name:"テスラ",ticker:"TSLA",sector:"自動車",price:340,history:[340],currency:"USD"},
    {id:"s17",emoji:"🔍",name:"グーグル",ticker:"GOOGL",sector:"テクノロジー",price:175,history:[175],currency:"USD"},
    {id:"s18",emoji:"🪟",name:"マイクロソフト",ticker:"MSFT",sector:"テクノロジー",price:420,history:[420],currency:"USD"},
    {id:"s19",emoji:"💻",name:"エヌビディア",ticker:"NVDA",sector:"半導体",price:130,history:[130],currency:"USD"},
    {id:"s20",emoji:"🎬",name:"ネットフリックス",ticker:"NFLX",sector:"エンタメ",price:900,history:[900],currency:"USD"},
    {id:"s21",emoji:"🍫",name:"明治",ticker:"2269.T",sector:"お菓子",price:3300,history:[3300],currency:"JPY"},
    {id:"s22",emoji:"🍙",name:"セブン&アイ",ticker:"3382.T",sector:"コンビニ",price:2200,history:[2200],currency:"JPY"},
    {id:"s23",emoji:"✈",name:"ANA",ticker:"9202.T",sector:"航空",price:3000,history:[3000],currency:"JPY"},
    {id:"s24",emoji:"🚄",name:"JR東日本",ticker:"9020.T",sector:"鉄道",price:2800,history:[2800],currency:"JPY"},
    {id:"s25",emoji:"🧴",name:"資生堂",ticker:"4911.T",sector:"化粧品",price:2500,history:[2500],currency:"JPY"},
    {id:"s26",emoji:"🎢",name:"オリエンタルランド",ticker:"4661.T",sector:"レジャー",price:3500,history:[3500],currency:"JPY"},
    {id:"s27",emoji:"🌍",name:"全世界株(オルカン)",ticker:"VT",sector:"インデックス",price:125,history:[125],currency:"USD",isIndex:true},
    {id:"s28",emoji:"🇺🇸",name:"米国株(S&P500)",ticker:"VOO",sector:"インデックス",price:560,history:[560],currency:"USD",isIndex:true},
  ],
  holdings: {},
  stockLastUpdate: "",
  stockFetchStatus: "idle",
  myTaskIds: {},
  tipsRead: {},
  tipsQuiz: {},
  childDailyBonus: {},
  parentMultiplier: 1.0,
  forexHoldings: {},  // {memberId: {USD:10, EUR:5, ...}}
  claimedBadges: {},  // {memberId: ["b01","b02",...]}
  noPinIds: {},       // {memberId: true} PINなし設定
  familySettings: {
    parentPointRule: "partner_approval",  // self_record_only | partner_approval | family_fixed_tasks | guardian_only
    rankingDefaultMetric: "approved_activity_points",
    enabledRankingMetrics: ["approved_activity_points","streak","learning_completed","goals_completed","operation_return_rate"],
    operationRanking: { enabled: true, defaultTab: "total", rankingBasis: "return_rate", includeFees: true, allowParents: true },
    familyMission: { enabled: true, label: "みんなの活動で 3,000 pt を育てよう", target: 3000, reward: "週末に家族でアイスを選ぶ" },
    requireApproval: false,
    approvalNotification: false,
    rewardApproval: false,
    gachaSimple: true,  // 初期値=ガチャ演出シンプル(まぶしさ/タメ演出を省く＝射幸性を抑える安全寄りの初期値)
    gameMode: "full",   // full=全部 / light=バトル・旅オフ / money=お小遣い帳中心(ゲーム要素オフ)
    dailyBattleLimit: 0,   // 1日のバトル回数上限(0=無制限・周回しすぎ防止)
    vacationMode: false,   // 🏖 長期休みモード(ONで vacation:true のセットを優先表示)
    privileges: [          // 🎁 やくそくのごほうび(⭐やくそく全達成で翌日つかえる。ポイントとは別)
      {id:"pv1",emoji:"📱",label:"スマホ"},
      {id:"pv2",emoji:"🎮",label:"スイッチ"},
      {id:"pv3",emoji:"📺",label:"どうが"},
    ],
  },
  pendingApprovals: [],
  pendingRedemptions: [],
  yakusokuDone: {},   // {childId:'YYYY-M-D'} ⭐やくそく全達成した日(翌日にごほうび解放)
};

function migrate(d) {
  if (!d) return {...INIT};
  if (!d.logs)         d.logs=[];
  if (!d.expenses)     d.expenses=[];
  if (!d.goals)        d.goals=[];
  if (!d.children||d.children.length===0) d.children=INIT.children;
  if (!d.cats)         d.cats=INIT.cats;
  if (!d.gachaDate)    d.gachaDate={};
  if (!d.streak)       d.streak={};
  if (!d.dailyTasks)   d.dailyTasks=INIT.dailyTasks;
  if(d.dailyBonus===undefined) d.dailyBonus=50;
  if(!d.forexHoldings) d.forexHoldings={};
  if(!d.claimedBadges) d.claimedBadges={};
  if(!d.noPinIds)      d.noPinIds={};
  if(!d.pendingApprovals) d.pendingApprovals=[];
  if(!d.pendingRedemptions) d.pendingRedemptions=[];
  if(!d.familySettings) d.familySettings={...INIT.familySettings};
  if(d.familySettings.requireApproval===undefined) d.familySettings.requireApproval=false;
  if(d.familySettings.approvalNotification===undefined) d.familySettings.approvalNotification=false;
  if(d.familySettings.rewardApproval===undefined) d.familySettings.rewardApproval=false;
  if(d.familySettings.vacationMode===undefined) d.familySettings.vacationMode=false;
  if(!Array.isArray(d.familySettings.privileges)) d.familySettings.privileges=INIT.familySettings.privileges.map(p=>({...p}));
  if(!d.yakusokuDone) d.yakusokuDone={};
  if(!d.familySettings.familyMission) d.familySettings.familyMission={...INIT.familySettings.familyMission};
  if(!d.monsterEvolved) d.monsterEvolved={};
  if(!d.monsterIV) d.monsterIV={};
  if(!d.monsterDiscovered) d.monsterDiscovered={};
  if(!d.monsterEvolvedAt) d.monsterEvolvedAt={};
  if(!d.reincarnationCount) d.reincarnationCount={};
  if(!d.reincarnationBonus) d.reincarnationBonus={};
  if(!d.reincPower) d.reincPower={};
  if(!d.monsterLevelSeen) d.monsterLevelSeen={};
  if(!d.monsterStageAt) d.monsterStageAt={};
  if(!d.monsterCare) d.monsterCare={};
  if(!d.collectedMons) d.collectedMons={};   // うちのこ(卒業した猫)コレクション
  if(!d.yamiEgg) d.yamiEgg={};   // ヤミノオウのタマゴ所持フラグ(未育成)
  // 旧・闇の卵お世話システム(darkEgg)→ ヤミノオウは通常タネモン化。育成度はリセットし、所持者には新タマゴを配る
  if(d.darkEgg){ Object.keys(d.darkEgg).forEach(cid=>{ if(!String((d.monsterEvolved||{})[cid]||"").startsWith("yami")) d.yamiEgg[cid]=true; }); d.darkEgg={}; }
  // 旧モンスター体系(1a/2a1…)の保存値は新ツリーに無いので卵へリセット
  Object.keys(d.monsterEvolved||{}).forEach(cid=>{ if(d.monsterEvolved[cid] && !MONSTER_TREE[d.monsterEvolved[cid]]) d.monsterEvolved[cid]=null; });
  Object.keys(d.monsterDiscovered||{}).forEach(cid=>{ d.monsterDiscovered[cid]=(d.monsterDiscovered[cid]||[]).filter(id=>MONSTER_TREE[id]); });
  // 全子供に egg を図鑑登録（初期値）
  (d.children||[]).forEach(c=>{
    if(!d.monsterDiscovered[c.id]) d.monsterDiscovered[c.id]=["egg"];
    else if(!d.monsterDiscovered[c.id].includes("egg")) d.monsterDiscovered[c.id]=["egg",...d.monsterDiscovered[c.id]];
    // 既に進化済みの場合は進化先も図鑑に追加
    const evo=d.monsterEvolved[c.id];
    if(evo && !d.monsterDiscovered[c.id].includes(evo)) d.monsterDiscovered[c.id]=[...d.monsterDiscovered[c.id],evo];
  });
  if(!d.onboardingChecks) d.onboardingChecks={};
  if(!d.claimedMissions) d.claimedMissions={};
  if(!d.beginnerMissionDone) d.beginnerMissionDone={};
  if(!d.gachaCollection) d.gachaCollection={};
  // 既存メンバーにdisplayMode・permissions・visibilityを後付け（後方互換）
  const defaultChildPerms={investment:"trade",forex:"trade",dailyBonus:true,ranking:true};
  const defaultChildVis={balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"};
  const defaultParentPerms={investment:"trade",forex:"trade",dailyBonus:true,ranking:true};
  const defaultParentVis={balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"};
  d.children=d.children.map(c=>({displayMode:"teen",role:"child",gradeLabel:"",permissions:defaultChildPerms,visibility:defaultChildVis,...c}));
  if(d.parents) d.parents=d.parents.map(p=>({displayMode:"adult",role:"parent",gradeLabel:"",participationMode:"player_and_guardian",permissions:defaultParentPerms,visibility:defaultParentVis,...p}));
  // PIN平文→ハッシュ移行（クラウドに平文PINを残さない。旧データは初回ロード時に自動変換）
  d.children=d.children.map(c=>{ if(c.pin&&!c.pinh){const{pin,...rest}=c;return{...rest,pinh:pinHash(pin)};} return c; });
  if(d.parents) d.parents=d.parents.map(p=>{ if(p.pin&&!p.pinh){const{pin,...rest}=p;return{...rest,pinh:pinHash(pin)};} return p; });
  if(d.parentPin&&!d.parentPinH){ d.parentPinH=pinHash(d.parentPin); delete d.parentPin; }
  // dailyTaskSetsがなければdailyTasksから自動生成
  if(!d.dailyTaskSets||d.dailyTaskSets.length===0){
    d.dailyTaskSets=[{
      id:"set_default",name:"通常セット",emoji:"📋",
      tasks:(d.dailyTasks||[]).map(t=>({...t})),
      bonus:d.dailyBonus||50,
      startDate:"",endDate:"",active:true
    }];
    d.activeSetId="set_default";
  }
  // 各セットのtasksがarrayでない場合を修正
  d.dailyTaskSets=d.dailyTaskSets.map(s=>({
    ...s,
    tasks:Array.isArray(s.tasks)?s.tasks:[],
    bonus:s.bonus??50,
    active:s.active!==false,
  }));
  if(!d.activeSetId) d.activeSetId=d.dailyTaskSets[0]?.id||"set_default";
  // 同時アクティブ配列を保証(旧データはactiveSetIdから生成)。存在するセットのみ・最大2件
  if(!Array.isArray(d.activeSetIds)||d.activeSetIds.length===0) d.activeSetIds=[d.activeSetId].filter(Boolean);
  d.activeSetIds=d.activeSetIds.filter(id=>d.dailyTaskSets.some(s=>s.id===id)).slice(0,4);
  if(d.activeSetIds.length===0&&d.dailyTaskSets[0]) d.activeSetIds=[d.dailyTaskSets[0].id];
  if(!d.dailyProgress) d.dailyProgress={};
  if(!d.rewards||d.rewards.length===0) d.rewards=INIT.rewards;
  if(d.rewards.length<=3&&d.rewards.some(r=>r.id==="r1"||r.id==="r2")) d.rewards=INIT.rewards;
  if(!d.gacha||d.gacha.length===0) d.gacha=INIT.gacha;
  if(!d.parentTasks)   d.parentTasks=INIT.parentTasks;
  if(!d.familyRewards) d.familyRewards=INIT.familyRewards;
  if(!d.parentLogs)    d.parentLogs={};
  if(!d.violations)    d.violations=[];
  if(!d.tutorialSeen)  d.tutorialSeen={};
  if(!d.pinChanged)    d.pinChanged={};
  if(!d.lockEnabled)   d.lockEnabled={};
  if(!d.parents)       d.parents=INIT.parents;
  if(d.parentMultiplier===undefined) d.parentMultiplier=1.0;
  if(d.interestRate===undefined)     d.interestRate=0.01;
  if(d.interestEnabled===undefined)  d.interestEnabled=true;
  if(!d.interestLastDate)            d.interestLastDate={};
  if(!d.holdBonusLastDate)           d.holdBonusLastDate={};
  if(!d.weeklyReportSeen)            d.weeklyReportSeen={};
  if(!d.stocks||d.stocks.length===0) d.stocks=INIT.stocks;
  if(d.stocks&&d.stocks[0]&&!d.stocks[0].ticker) d.stocks=INIT.stocks;
  // 架空の学習用銘柄を既存ユーザーにも追加（増える/下がる感覚の教材）
  if(d.stocks && !d.stocks.some(s=>s.fake)) d.stocks=[...d.stocks, ...INIT.stocks.filter(s=>s.fake)];
  // 銘柄拡充マイグレーション: 既存ユーザーのstocksにINITの新銘柄を追加し、株価取得を強制再実行(チャート用の30日履歴を入れる)
  if(d.stocks){ const have=new Set(d.stocks.map(s=>s.id)); const add=INIT.stocks.filter(s=>!have.has(s.id)); if(add.length){ d.stocks=[...d.stocks,...add]; d.stockLastUpdate=""; d.stockFetchStatus="idle"; } }
  if(!d.forex||Object.keys(d.forex).length===0) d.forex={
    "USDJPY=X":{code:"USD",flag:"🇺🇸",name:"アメリカ ドル",price:155,prev:155,history:[152,153,154,155,155],changePct:0,realData:false},
    "EURJPY=X":{code:"EUR",flag:"🇪🇺",name:"ユーロ",price:168,prev:168,history:[165,166,167,168,168],changePct:0,realData:false},
    "GBPJPY=X":{code:"GBP",flag:"🇬🇧",name:"イギリス ポンド",price:196,prev:196,history:[193,194,195,196,196],changePct:0,realData:false},
    "CNYJPY=X":{code:"CNY",flag:"🇨🇳",name:"中国 人民元",price:21.4,prev:21.4,history:[21.0,21.1,21.2,21.4,21.4],changePct:0,realData:false},
    "KRWJPY=X":{code:"KRW",flag:"🇰🇷",name:"韓国 ウォン",price:0.112,prev:0.112,history:[0.110,0.111,0.112,0.112,0.112],changePct:0,realData:false},
  };
  if(!d.holdings)      d.holdings={};
  if(!d.stockLastUpdate) d.stockLastUpdate="";
  if(!d.stockFetchStatus) d.stockFetchStatus="idle";
  if(!d.myTaskIds)     d.myTaskIds={};
  if(!d.tipsRead)      d.tipsRead={};
  if(!d.tipsQuiz)      d.tipsQuiz={};
  if(!d.childDailyBonus) d.childDailyBonus={};
  if(Array.isArray(d.parentLogs)){
    const obj={};
    (d.parents||[]).forEach(p=>{obj[p.id]=[];});
    d.parentLogs=obj;
  }
  if(!d.parentLogs||typeof d.parentLogs!=="object") d.parentLogs={};
  d.goodTasks=(d.goodTasks||[]).map(t=>({...t,over:t.over||t.overrides||{}}));
  d.badTasks =(d.badTasks||[]).map(t=>({...t,over:t.over||t.overrides||{}}));
  d.children =(d.children||[]).map(c=>({...c,ageMode:c.ageMode||"middle"}));
  // 旧形式(g1/g2)の既定タスクをINITへ移行。ただしユーザー追加分(旧ID以外)は必ず残す
  if(d.goodTasks.length<=4&&d.goodTasks.some(t=>t.id==="g1"||t.id==="g2")){ const _c=d.goodTasks.filter(t=>!/^g\d$/.test(String(t.id))); d.goodTasks=[...INIT.goodTasks,..._c]; }
  if(d.badTasks.length<=3&&d.badTasks.some(t=>t.id==="b1"||t.id==="b2")){   const _c=d.badTasks.filter(t=>!/^b\d$/.test(String(t.id)));  d.badTasks =[...INIT.badTasks,..._c]; }
  if(!d.tutorialSeen||Object.keys(d.tutorialSeen).length===0){
    if((d.logs||[]).length>0){
      const seen={"parent":true};
      (d.children||[]).forEach(c=>{seen[c.id]=true;});
      (d.parents||[]).forEach(p=>{seen[p.id]=true;});
      d.tutorialSeen=seen;
    }
  }
  if(!d.pinChanged&&(d.logs||[]).length>0){
    const changed={};
    (d.children||[]).forEach(c=>{changed[c.id]=true;});
    d.pinChanged=changed;
  }
  return d;
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
const todayKey = () => { const d=new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; };
// 期間(startDate/endDate)はtype="date"のゼロ埋め"YYYY-MM-DD"。比較はこちらで揃える(todayKeyはゼロ埋め無しなので文字列比較が壊れる)
const todayISO = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
// ログのdateはUTCのISO文字列。startsWith(todayISO())だと端末ローカルの早朝(JSTの0〜9時など)はUTC日付が前日になり「今日」判定が崩れる。
// 必ずローカル日付に変換してから「今日かどうか」を比較する。
const isTodayLocal = (iso) => { if(!iso) return false; const d=new Date(iso); if(isNaN(d)) return String(iso).startsWith(todayISO()); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` === todayISO(); };
// 触覚フィードバック(マイクロインタラクション)。対応端末(主にAndroid)は振動、iOS Safari等は安全にno-op。
// reduced-motion時は鳴らさない。種類: tap/success/strong/warn。
function taneHaptic(kind){
  try{
    if(typeof navigator==="undefined" || typeof navigator.vibrate!=="function") return;
    if(typeof window!=="undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const P={ tap:10, success:[14,40,24], strong:[20,55,30,55,45], warn:30 };
    navigator.vibrate(P[kind]||10);
  }catch(e){}
}
// タネモンの励まし一言(compassionate)。結果より「続けたこと・自分のペース」を肯定する＝Finch流のやさしさ。
const _TANE_CHEERS=[
  "えらい！つづけるの、さいこう🌱","ナイス！コツコツが ちからに なるよ","やったね！きみの ペースで いいんだよ",
  "グッジョブ！タネモンも よろこんでる🌿","いい かんじ！すこしずつで だいじょうぶ","おつかれさま！がんばったね",
  "まいにちの 一歩が、大きな めに なるよ","うれしい！きみが つづけてくれて","その ちょうし！むりせず いこうね",
  "ありがとう！タネモンが げんきに なったよ"
];
function taneCheer(){ return _TANE_CHEERS[Math.floor(Math.random()*_TANE_CHEERS.length)]; }
// 押し心地(マイクロインタラクション): 全ボタンに「スプリングの押下」＋「タップ・リップル」を一括付与。
// リップルは画面直付け(position:fixed)なので、ボタンのoverflowや外側バッジ(達成!等)を壊さない。
// reduced-motion では押下アニメ・リップルとも無効。1回だけ自己インストール。
(function installTapFeel(){
  if(typeof document==="undefined" || document.__taneTapFeel) return;
  try{
    document.__taneTapFeel = true;
    const st=document.createElement("style");
    st.textContent =
      "@media (prefers-reduced-motion: no-preference){"+
      " button{ transition: transform .12s cubic-bezier(.34,1.56,.64,1), box-shadow .12s ease; -webkit-tap-highlight-color: transparent; }"+
      " button:not(:disabled):active{ transform: scale(.95); }"+
      "}"+
      "@keyframes taneRipple{ from{ transform:translate(-50%,-50%) scale(.2); opacity:.5 } to{ transform:translate(-50%,-50%) scale(1); opacity:0 } }"+
      ".tane-ripple{ position:fixed; z-index:99999; pointer-events:none; width:120px; height:120px; border-radius:50%;"+
      " background:radial-gradient(circle, rgba(255,255,255,.7) 0%, rgba(232,184,62,.38) 45%, rgba(232,184,62,0) 70%);"+
      " animation:taneRipple .5s ease-out forwards; }";
    (document.head||document.documentElement).appendChild(st);
    const reduce=()=> !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    document.addEventListener("pointerdown", function(e){
      try{
        const btn = e.target && e.target.closest && e.target.closest("button");
        if(!btn || btn.disabled || reduce()) return;
        const r=document.createElement("span");
        r.className="tane-ripple";
        r.style.left=e.clientX+"px"; r.style.top=e.clientY+"px";
        document.body.appendChild(r);
        setTimeout(function(){ if(r&&r.parentNode) r.parentNode.removeChild(r); }, 520);
      }catch(_e){}
    }, {passive:true});
  }catch(e){}
})();
// 連打/二重実行ガード(モジュール共通)。同じkeyはms以内の2回目を弾く＝お金系操作の二重実行を防止
const _txLocks={};
function txGuard(key, ms=800){ const now=Date.now(); if(_txLocks[key] && now-_txLocks[key]<ms) return false; _txLocks[key]=now; return true; }

// ── 運用損益計算ヘルパー ──────────────────────────────
// 手数料込みの実質損益率を計算
const calcReturnRate = (totalCost, currentNetValue) => {
  if(!totalCost || totalCost<=0) return null;
  return ((currentNetValue - totalCost) / totalCost) * 100;
};

// メンバーの運用成績を計算（株・為替・総合）
const calcMemberOperation = (memberId, data, type="total") => {
  const logs = (data.logs||[]).filter(l=>l.cid===memberId);
  // 株式の損益計算
  const stockBuyCost = logs.filter(l=>l.type==="invest_buy").reduce((s,l)=>s+Math.abs(l.pts),0);
  const stockSellEarn = logs.filter(l=>l.type==="invest_sell").reduce((s,l)=>s+l.pts,0);
  const holdings = (data.holdings||{})[memberId]||[];
  const stocks = data.stocks||[];
  const stockCurrentValue = holdings.reduce((s,h)=>{
    const st=stocks.find(x=>x.id===h.stockId);
    if(!st)return s;
    const price=st.price;
    const currency=st.currency;
    const pts=currency==="JPY"?Math.round(price*h.qty):Math.round(price*h.qty*10);
    return s + Math.floor(pts*0.98); // 売却時2%手数料を考慮
  },0);
  // 為替の損益計算
  const forexBuyCost = logs.filter(l=>l.type==="forex_buy").reduce((s,l)=>s+Math.abs(l.pts),0);
  const forexSellEarn = logs.filter(l=>l.type==="forex_sell").reduce((s,l)=>s+l.pts,0);
  const forexHeld = (data.forexHoldings||{})[memberId]||{};
  const forexData = data.forex||{};
  const forexCurrentValue = Object.entries(forexHeld).reduce((s,[code,amt])=>{
    const fxEntry = Object.values(forexData).find(f=>f.code===code);
    if(!fxEntry||!amt)return s;
    return s + Math.floor(amt*(fxEntry.price||0)*0.995); // 売却時0.5%手数料
  },0);

  const stockNetCost = stockBuyCost - stockSellEarn;
  const stockNetValue = stockCurrentValue + stockSellEarn;
  const forexNetCost = forexBuyCost - forexSellEarn;
  const forexNetValue = forexCurrentValue + forexSellEarn;

  if(type==="stocks") {
    if(stockBuyCost===0) return null;
    const rate=calcReturnRate(stockBuyCost, stockCurrentValue+stockSellEarn);
    return{cost:stockBuyCost, net:Math.round(stockCurrentValue+stockSellEarn), rate, pt:Math.round(stockCurrentValue+stockSellEarn-stockBuyCost)};
  }
  if(type==="forex") {
    if(forexBuyCost===0) return null;
    const rate=calcReturnRate(forexBuyCost, forexCurrentValue+forexSellEarn);
    return{cost:forexBuyCost, net:Math.round(forexCurrentValue+forexSellEarn), rate, pt:Math.round(forexCurrentValue+forexSellEarn-forexBuyCost)};
  }
  // total
  const totalCost = stockBuyCost + forexBuyCost;
  if(totalCost===0) return null;
  const totalNet = stockCurrentValue+stockSellEarn+forexCurrentValue+forexSellEarn;
  const rate=calcReturnRate(totalCost, totalNet);
  return{cost:totalCost, net:Math.round(totalNet), rate, pt:Math.round(totalNet-totalCost)};
};

// 今月の承認済み活動ptを計算（投資・為替除外）
const ACTIVITY_TYPES = ["good","bad","daily"];
const calcMonthlyActivity = (memberId, logs) => {
  const thisMonth = new Date().toISOString().slice(0,7);
  return (logs||[])
    .filter(l=>l.cid===memberId && ACTIVITY_TYPES.includes(l.type) && (l.date||"").startsWith(thisMonth))
    .reduce((s,l)=>s+(l.pts>0?l.pts:0),0);
};
const monthKey = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
const fmtDate  = iso => { const d=new Date(iso); return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`; };
const uid      = () => Math.random().toString(36).slice(2,10);
const bal      = (logs, cid) => (logs||[]).filter(l=>l.cid===cid).reduce((s,l)=>s+l.pts,0);
const parentBal= (pLogs, pid) => ((pLogs||{})[pid]||[]).reduce((s,l)=>s+(l.pts||0),0);
const weekKey  = (d=new Date())=>{const jan1=new Date(d.getFullYear(),0,1);const w=Math.ceil((((d-jan1)/86400000)+jan1.getDay()+1)/7);return `${d.getFullYear()}-${String(w).padStart(2,"0")}`;};
const taskPts  = (task, cid) => task.over?.[cid] ?? task.pts;

// ═══════════════════════════════════════════════════════
// DESIGN SYSTEM v2 — Tane Money
// ═══════════════════════════════════════════════════════
const BG    = "#F7F5EF";
const BG2   = "#FCFBF8";
const CARD  = "#FFFFFF";
const CARDS = "#F2EFE7";
const GP    = "#187A4E";   // green-primary
const G     = "#34C77B";   // green-bright（CTA）
const GS    = "#DDF3E7";   // green-soft
const GOLD  = "#E8B83E";   // gold
const GOLDS = "#FFF1CB";
const R     = "#D95C55";   // red
const RS    = "#FCE6E4";
const B     = "#3478D4";   // blue
const BS    = "#E5F0FF";
const P     = "#7B61C9";
const PS    = "#EFEAFE";
const TEXT  = "#18231D";
const TEXTS = "#59645E";
const MUTED = "#929B95";
const BORDER= "#E8E3D8";
const Y     = GOLD;        // 後方互換
const SHADOW = "0 4px 16px rgba(24,35,29,0.05)";
const F  = "'Noto Sans JP','M PLUS Rounded 1c','Hiragino Maru Gothic ProN',sans-serif";
const FB = "'M PLUS Rounded 1c','Hiragino Maru Gothic ProN',sans-serif";
// ===== UIクロム・デザイントークン（プレミアム化：角丸/影/枠/余白を統一）=====
// 既存カラー定数のみで構成（新ブランド色を作らない）。
const RAD_CARD = 16;   // カード・畑の額縁
const RAD_CHIP = 12;   // 小チップ・スタット
const RAD_PILL = 999;  // ピル・ラベル
const BD_THIN   = `1px solid ${BORDER}`;
const BD_ACCENT = (c)=>`1px solid ${c}`;
const SHADOW_SM = "0 1px 4px rgba(24,35,29,0.07)";   // チップ（うっすら浮かせる）
const SHADOW_MD = "0 6px 20px rgba(24,35,29,0.10)";  // 主役カード（畑）
const PRESS = { transform:"translateY(1px)" };       // 押下の沈み込み（onPointerで適用）
const SP = { xs:4, sm:8, md:12, lg:16 };
const AGE={young:{label:"低学年",emoji:"🌱"},middle:{label:"中学年",emoji:"🌿"},senior:{label:"中高生",emoji:"🌳"}};
// 🎓 専門家監修（手配できたら name/title を埋める。空のままなら監修バッジは表示されない＝虚偽表示しない）
const SUPERVISOR = { name: "", title: "" };  // 例: { name:"山田 太郎", title:"ファイナンシャルプランナー(CFP®)" }
const INP = { fontFamily:F, padding:"9px 11px", borderRadius:10, border:`1.5px solid ${BORDER}`, fontSize:14, background:BG2, color:TEXT, width:"100%", boxSizing:"border-box" };

// ═══════════════════════════════════════════════════════
// TINY COMPONENTS
// ═══════════════════════════════════════════════════════
const Pt = ({v,sz=14}) => (
  <span style={{color:v>=0?G:R, fontWeight:800, fontSize:sz, display:"inline-flex", alignItems:"center", gap:1}}>
    {v>=0?"+":""}{v.toLocaleString()}<span style={{fontSize:sz-2}}>pt</span>
  </span>
);
const Yen = Pt;

const Btn = ({c,label,onClick,disabled,full,sm}) => (
  <button onClick={onClick} disabled={!!disabled}
    style={{background:disabled?BORDER:c, border:"none", borderRadius:8,
      padding:sm?"4px 8px":"7px 13px", color:"#fff", fontWeight:700,
      fontSize:sm?11:12, cursor:disabled?"default":"pointer", fontFamily:F,
      width:full?"100%":undefined, opacity:disabled?0.6:1}}>
    {label}
  </button>
);

const SyncBadge = ({status}) => {
  const map = { saving:"💾 同期中…", saved:"☁ 同期済み", error:"⚠ オフライン" };
  const col  = { saving:B, saved:G, error:R };
  const code = (()=>{try{return localStorage.getItem("tane_money_family_code")||"NO_CODE";}catch(e){return "ERR";}})();
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>
      <span style={{fontSize:11, color:col[status]||MUTED, fontWeight:700, background:`${col[status]||MUTED}15`, padding:"2px 7px", borderRadius:10}}>{map[status]||status}</span>
      <span style={{fontSize:11, color:MUTED, fontWeight:700, padding:"1px 5px"}}>{code}</span>
    </div>
  );
};

// データ消失の防止ガード：保存失敗 or サイズ上限接近を画面上部に警告（保護者に気づかせる）
const SaveGuardBanner = () => {
  const [h,setH]=useState(null);
  const [closed,setClosed]=useState(false);
  useEffect(()=>{ setSaveHealthCb(setH); return ()=>setSaveHealthCb(null); },[]);
  if(!h) return null;
  const fail=!h.ok, near=h.near;
  if(!fail && !near) return null;
  if(closed && !fail) return null; // 失敗時は閉じても出し続ける（重要）
  const kb=Math.round((h.bytes||0)/1024);
  return (
    <div style={{position:"fixed",top:0,left:0,right:0,zIndex:9500,background:fail?R:GOLD,color:fail?"#fff":TEXT,
      padding:"9px 14px",fontFamily:F,fontSize:12.5,fontWeight:800,textAlign:"center",
      boxShadow:"0 2px 10px rgba(0,0,0,.18)",display:"flex",alignItems:"center",gap:8,justifyContent:"center"}}>
      <span style={{flex:1}}>
        {fail
          ? (h.localFail
              ? "⚠ この端末にデータを保存できません。プライベートモードを解除するか、ブラウザの空き容量を確認してください。"
              : "⚠ クラウド保存に失敗中。変更はこの端末に残っています。通信環境を確認してください。")
          : `⚠ データ量が上限に近づいています（約${kb}KB）。古い記録は自動でまとめられます。`}
      </span>
      {!fail && <button onClick={()=>setClosed(true)} style={{background:"rgba(0,0,0,.12)",border:"none",borderRadius:8,padding:"3px 9px",fontWeight:800,fontSize:12,color:TEXT,cursor:"pointer",fontFamily:F,flexShrink:0}}>×</button>}
    </div>
  );
};

// ═══════════════════════════════════════════════════════
// PIN PAD
// ═══════════════════════════════════════════════════════
function PinPad({ title, emoji, hint, check, onOk, onBack, extra }) {
  const [val, setVal] = useState("");
  const [shake, setShake] = useState(false);

  const press = k => {
    if (val.length >= 4) return;
    const nxt = val + k;
    setVal(nxt);
    if (nxt.length === 4) {
      if (check(nxt)) { onOk(); }
      else { setShake(true); setTimeout(()=>{ setVal(""); setShake(false); }, 600); }
    }
  };

  return (
    <div style={{minHeight:"100vh",background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:F,padding:24,position:"relative"}}>
      <button onClick={onBack} style={{position:"absolute",top:20,left:20,background:"none",border:"none",fontSize:28,cursor:"pointer",color:MUTED}}>‹</button>
      <div style={{marginBottom:6}}><Emo e={emoji} size={52}/></div>
      <h2 style={{color:TEXT,fontSize:20,fontWeight:800,margin:"0 0 4px"}}>{title}</h2>
      {hint && <p style={{color:MUTED,fontSize:11,margin:"0 0 20px",textAlign:"center",maxWidth:260}}>{hint}</p>}
      <div style={{display:"flex",gap:14,marginBottom:28,animation:shake?"shk .5s":undefined}}>
        {[0,1,2,3].map(i=>(
          <div key={i} style={{width:15,height:15,borderRadius:"50%",background:val.length>i?Y:"transparent",border:`2.5px solid ${shake?R:Y}`,transition:"background .15s"}}/>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,70px)",gap:10}}>
        {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
          <button key={i}
            onClick={()=>{ if(k==="⌫") setVal(v=>v.slice(0,-1)); else if(k!=="") press(String(k)); }}
            style={{width:70,height:70,borderRadius:18,background:k===""?"transparent":CARD,border:k===""?"none":`2px solid ${BORDER}`,fontSize:22,fontWeight:700,color:TEXT,cursor:k===""?"default":"pointer",fontFamily:F}}>
            {k}
          </button>
        ))}
      </div>
      {extra && <div style={{marginTop:20}}>{extra}</div>}
      <style>{`@keyframes shk{0%,100%{transform:translateX(0)}25%,75%{transform:translateX(-8px)}50%{transform:translateX(8px)}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// PIE CHART
// ═══════════════════════════════════════════════════════
function Pie({ data, size=140 }) {
  if (!data||!data.length) return <div style={{width:size,height:size,borderRadius:"50%",background:BORDER,display:"flex",alignItems:"center",justifyContent:"center",color:MUTED,fontSize:11}}>データなし</div>;
  const total = data.reduce((s,d)=>s+d.v,0);
  let a = -Math.PI/2;
  const cx=size/2, cy=size/2, r=size/2-4;
  return (
    <svg width={size} height={size}>
      {data.map((d,i)=>{
        const pct=d.v/total, s=a; a+=pct*2*Math.PI;
        const x1=cx+r*Math.cos(s),y1=cy+r*Math.sin(s),x2=cx+r*Math.cos(a),y2=cy+r*Math.sin(a);
        return <path key={i} d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${pct>.5?1:0} 1 ${x2},${y2} Z`} fill={d.color} stroke="#fff" strokeWidth={2}/>;
      })}
    </svg>
  );
}

// ═══════════════════════════════════════════════════════
// GACHA — 月テーマ定義
// ═══════════════════════════════════════════════════════
const GACHA_THEMES = [
  {name:"お正月",  emoji:"🎍", color:"#D95C55", bg:"#FCE6E4"},
  {name:"バレンタイン",emoji:"💝",color:"#ec4899",bg:"#fce7f3"},
  {name:"はる",   emoji:"🌸", color:"#e879a0", bg:"#fce7f3"},
  {name:"はな",   emoji:"🌺", color:"#f97316", bg:"#ffedd5"},
  {name:"こどもの日",emoji:"🎏",color:"#3478D4", bg:"#E5F0FF"},
  {name:"あめ",   emoji:"☔", color:"#3478D4", bg:"#E5F0FF"},
  {name:"なつ",   emoji:"🌊", color:"#06b6d4", bg:"#cffafe"},
  {name:"なつまつり",emoji:"🎆",color:"#f97316",bg:"#ffedd5"},
  {name:"つき",   emoji:"🌕", color:"#E8B83E", bg:"#FFF1CB"},
  {name:"ハロウィン",emoji:"🎃",color:"#f97316",bg:"#ffedd5"},
  {name:"あき",   emoji:"🍂", color:"#E8B83E", bg:"#FFF1CB"},
  {name:"クリスマス",emoji:"🎄",color:"#34C77B",bg:"#DDF3E7"},
];
function getMonthTheme(){ return GACHA_THEMES[new Date().getMonth()]; }

const GACHA_ITEMS = [
  // ── 第0弾「はじめてのタネ図鑑」(setId:s00) 各カードにedu=お金/努力の学び ──
  {id:"gi_n1",tierId:"gc1",setId:"s00",emoji:"🌱",name:"タネっち",  desc:"まいにちのタネ",   edu:"おかねは タネみたい。少しずつ ためると 大きく そだつよ"},
  {id:"gi_n2",tierId:"gc1",setId:"s00",emoji:"🌿",name:"わかば",    desc:"みどりのわかば",   edu:"まいにち コツコツ つづけると ちからが ついてくる"},
  {id:"gi_n3",tierId:"gc1",setId:"s00",emoji:"🍀",name:"よつば",    desc:"しあわせのよつば", edu:"ラッキーも うれしいけど、コツコツが いちばん つよい"},
  {id:"gi_n4",tierId:"gc1",setId:"s00",emoji:"🌾",name:"こむぎ",    desc:"ゆたかなみのり",   edu:"むかしは こくもつが おかねの かわりだった ことも"},
  {id:"gi_n5",tierId:"gc1",setId:"s00",emoji:"🍂",name:"おちば",    desc:"あきのきおく",     edu:"おかねは つかうと へる。たいせつに つかおう"},
  {id:"gi_n6",tierId:"gc1",setId:"s00",emoji:"🌻",name:"ひまわり",  desc:"たいようのちから", edu:"たいようの ように、おかねも はたらくと そだつ"},
  {id:"gi_r1",tierId:"gc2",setId:"s00",emoji:"⭐",name:"スター",     desc:"かがやくほし",     edu:"もくひょうを きめると ゆめに ちかづくよ"},
  {id:"gi_r2",tierId:"gc2",setId:"s00",emoji:"🦋",name:"ちょうちょ",desc:"はねのかがやき",   edu:"コツコツが おおきな へんかに なる(さなぎ→ちょう)"},
  {id:"gi_r3",tierId:"gc2",setId:"s00",emoji:"🐠",name:"さかな",    desc:"うみのたから",     edu:"うみの めぐみも しげん。とりすぎないのが たいせつ"},
  {id:"gi_r4",tierId:"gc2",setId:"s00",emoji:"🌙",name:"みかづき",  desc:"よるのひかり",     edu:"ねている あいだに 利子で おかねが ふえる ことも"},
  {id:"gi_r5",tierId:"gc2",setId:"s00",emoji:"🎵",name:"おんぷ",    desc:"こころのメロディ", edu:"すきな ことに つかうと こころが ゆたかに なる"},
  {id:"gi_r6",tierId:"gc2",setId:"s00",emoji:"🔮",name:"まほうだま",desc:"ふしぎなちから",   edu:"おかねの まほうは『ふくり』。利子に 利子が つく"},
  {id:"gi_sr1",tierId:"gc3",setId:"s00",emoji:"🌈",name:"にじ",     desc:"そらにかかるにじ", edu:"あめの あとに にじ。がまんの あとに ごほうび"},
  {id:"gi_sr2",tierId:"gc3",setId:"s00",emoji:"💎",name:"ダイヤ",   desc:"しんぴのほうせき", edu:"みんなが ほしがるほど ねだんが 上がる=きしょうせい"},
  {id:"gi_sr3",tierId:"gc3",setId:"s00",emoji:"🦄",name:"ユニコーン",desc:"まほうのいきもの",edu:"めずらしい ものは かちが 高い。でも 本当の たからは けいけん"},
  {id:"gi_sr4",tierId:"gc3",setId:"s00",emoji:"🐉",name:"ドラゴン", desc:"でんせつのりゅう", edu:"むかしの ものがたりでは りゅうが たからを まもった"},
  {id:"gi_ur1",tierId:"gc4",setId:"s00",emoji:"👑",name:"おうかん",  desc:"さいこうのしるし", edu:"むかし 王さまが おかねを つくった。いまは くにが かんり"},
  {id:"gi_ur2",tierId:"gc4",setId:"s00",emoji:"🌟",name:"ゴールドスター",desc:"きょくちょうのかがやき",edu:"きんは さびずに かがやく。だから せかいじゅうで たからもの"},
  // ── 第1弾「世界のお金 図鑑」(setId:s01) お金の知識カード ──
  {id:"gm_y1",  tierId:"gc1",setId:"s01",emoji:"🪙",name:"1円玉",  desc:"いちばん かるいコイン", edu:"1円玉は アルミ。とても かるくて 水に うくことも あるよ"},
  {id:"gm_y10", tierId:"gc1",setId:"s01",emoji:"🪙",name:"10円玉", desc:"どうの コイン",       edu:"10円玉は どう(銅)。つかうほど 色が かわっていく"},
  {id:"gm_y100",tierId:"gc1",setId:"s01",emoji:"🪙",name:"100円玉",desc:"ぎざぎざコイン",     edu:"ふちの ギザギザは けずって ズルするのを ふせぐ くふう"},
  {id:"gm_bill",tierId:"gc1",setId:"s01",emoji:"💴",name:"おさつ", desc:"かみのお金",         edu:"おさつは とくべつな かみと インク。にせもの ぼうしの ため"},
  {id:"gm_usd", tierId:"gc2",setId:"s01",emoji:"💵",name:"ドル",   desc:"アメリカのお金",     edu:"ドルは せかいで いちばん つかわれる お金。りょうがえで 円と こうかん"},
  {id:"gm_eur", tierId:"gc2",setId:"s01",emoji:"💶",name:"ユーロ", desc:"ヨーロッパのお金",   edu:"ヨーロッパの たくさんの くにが おなじ ユーロを つかう"},
  {id:"gm_koban",tierId:"gc3",setId:"s01",emoji:"🟡",name:"小判",  desc:"江戸のきんか",       edu:"小判は 江戸じだいの きんか。おさむらいが つかった お金"},
  {id:"gm_oban", tierId:"gc4",setId:"s01",emoji:"🟡",name:"大判",  desc:"でっかいきんか",     edu:"大判は とても 大きな きんか。むかしの さいこうきゅうの お金"},
];

// ═══════════════════════════════════════════════════════
// GACHA ANIMATION
// ═══════════════════════════════════════════════════════
// ドット絵アイコン共通部品(画像が無ければ絵文字fbにフォールバック)
function Ico({name,size=20,fb,style}){
  return <img src={`/assets/icon_${name}.png`} alt="" draggable="false"
    onError={fb?e=>{const s=document.createElement("span");s.textContent=fb;s.style.fontSize=Math.round(size*0.92)+"px";s.style.lineHeight="1";e.target.replaceWith(s);}:e=>{e.target.style.display="none";}}
    style={{width:size,height:size,objectFit:"contain",imageRendering:"pixelated",verticalAlign:"middle",display:"inline-block",...style}}/>;
}

// 絵文字 or ドット絵アイコン(値が "ico:name" ならアイコン画像)を出し分ける共通レンダラ
function Emo({e,size=20,style}){
  if(typeof e==="string" && e.startsWith("ico:")) return <Ico name={e.slice(4)} size={size} fb="🙂" style={style}/>;
  return <span style={{fontSize:size,lineHeight:1,...style}}>{e}</span>;
}

function GachaAnim({ result, onClose }) {
  const theme = result.theme || getMonthTheme();
  const isSuper = result.rate <= 3;             // 激レア(虹)
  const isSR    = result.rate <= 12;            // スーパーレア以上(金以上)
  const tier    = isSuper ? "super" : isSR ? "sr" : result.rate <= 25 ? "rare" : "normal";
  const TF      = ({normal:"n",rare:"r",sr:"sr",super:"super"})[tier]; // 最終レア度(額縁用)
  // レア度が上がるほど多段階でニョキニョキ育つ: 芽→つぼみ(青)→花(金)→大樹(虹)
  const STAGES  = result.simpleAnim ? [TF] : (isSuper ? ["n","r","super"] : isSR ? ["n","r","sr"] : (result.rate<=25 ? ["n","r"] : ["n"]));
  const AURA_OF = { n:"#eae2c8", r:"#4a9eff", sr:"#f5c842", super:"#f5c842" };

  const [phase, setPhase]       = useState("charge");   // charge→tap→grow→burst→show
  const [stage, setStage]       = useState(0);          // 成長段階(STAGESのindex)
  const timers = useRef([]);
  const at = (fn, ms) => { const t = setTimeout(fn, ms); timers.current.push(t); };
  useEffect(()=>()=>timers.current.forEach(clearTimeout), []);
  useEffect(()=>{ at(()=>setPhase(p=>p==="charge"?"tap":p), 600); }, []);

  const buzz = (pat)=>{ try{ navigator.vibrate(pat); }catch(e){} };
  // 確定演出(予兆): SR以上は水やり直前にそっと振動でワクワクを煽る
  useEffect(()=>{ if(isSR) at(()=>buzz(isSuper?[0,60,80,60,80,140]:[0,50,90,50]), 680); }, []);

  const HOLD = 1450, HUSH = isSuper ? 2300 : 1650;  // 段階ごとのタメ / 暗転の静寂(激レアほど長い)
  const hasHush = isSR && !result.simpleAnim;   // SR以上で暗転→解放（シンプル演出時はOFF）
  const reveal = () => {
    if(phase!=="tap") return;
    setPhase("grow"); setStage(0); buzz([60]);
    const last = STAGES.length-1;
    // 最終段の手前まで順に育てる＝わざと低レアっぽく見せる（裏切りの布石）
    for(let i=1;i<last;i++){ const j=i; at(()=>{ setStage(j); buzz([70]); }, i*HOLD); }
    if(hasHush){
      const hushT = last*HOLD;             // 最後の手前で暗転(静寂のタメ)
      at(()=>{ setPhase("hush"); buzz([30]); }, hushT);
      // 暗転中に加速する鼓動＝緊張を「充電」していく
      at(()=>buzz([40]), hushT+400);
      at(()=>buzz([60]), hushT+800);
      if(isSuper){ at(()=>buzz([90]), hushT+1100); at(()=>buzz([150]), hushT+1350); }
      const releaseT = hushT + HUSH;       // 限界までタメてから爆発的に解放
      at(()=>{ setStage(last); setPhase("burst"); buzz(isSuper?[0,90,40,40,560]:[0,340]); }, releaseT);
      at(()=>setPhase("show"), releaseT + 950);
    } else {
      if(last>0) at(()=>setStage(last), last*HOLD);
      const endT = last*HOLD + 900;
      at(()=>setPhase("burst"), endT);
      at(()=>setPhase("show"),  endT+520);
    }
  };
  const skip = () => { timers.current.forEach(clearTimeout); setStage(STAGES.length-1); setPhase("show"); };

  const curTier   = STAGES[Math.min(stage, STAGES.length-1)];
  const AURA      = AURA_OF[curTier];
  const rainbow   = curTier === "super";
  const grown     = phase==="grow" || phase==="hush" || phase==="burst" || phase==="show";
  const starCount = isSuper ? 30 : isSR ? 16 : 0;

  const PETALS = ["gacha_petal_pink1","gacha_petal_pink2","gacha_petal_pink3","gacha_petal_gold1","gacha_petal_gold2","gacha_petal_gold3","gacha_petal_blue1","gacha_petal_blue2"];
  const N = isSuper ? 34 : isSR ? 24 : 16;
  const [parts] = useState(()=> [...Array(N)].map((_,i)=>{
    const a = (Math.PI*2*i)/N + Math.random()*0.5;
    const d = 160 + Math.random()*240;
    return { tx:(Math.cos(a)*d).toFixed(0), ty:(Math.sin(a)*d).toFixed(0),
             img:PETALS[Math.floor(Math.random()*PETALS.length)], s:44+Math.round(Math.random()*42),
             rot:Math.round(Math.random()*720-360), dur:(1.2+Math.random()*0.8).toFixed(2),
             dl:(Math.random()*0.18).toFixed(2) };
  }));

  const stop = (e)=>{ e.stopPropagation(); };

  // ── 確定演出(予兆): SR以上で水やりの瞬間に発生。3種からランダムでワクワク ──
  const [premo] = useState(()=> isSR ? ["star","coin","firefly"][Math.floor(Math.random()*3)] : null);
  const [coins] = useState(()=> [...Array(16)].map(()=>({
    l:Math.round(Math.random()*100), s:18+Math.round(Math.random()*16),
    d:(Math.random()*1.4).toFixed(2), dur:(1.7+Math.random()*1.3).toFixed(2), rot:Math.round(Math.random()*40-20) })));
  const [flies] = useState(()=> [...Array(18)].map(()=>({
    l:Math.round(Math.random()*100), dx:Math.round(Math.random()*70-35), s:7+Math.round(Math.random()*9),
    d:(Math.random()*1.8).toFixed(2), dur:(2.2+Math.random()*1.7).toFixed(2),
    c:["#bff0c8","#ffe9a8","#bfe6ff","#ffd1ec"][Math.floor(Math.random()*4)] })));
  const premoTxt = premo==="coin" ? "コインが ふってきた…！？ 水を！🪙"
                 : premo==="firefly" ? "ひかりが あつまってる…！？ 水を！✨"
                 : premo==="star" ? "ながれ星が…！？ いそいで水を！🌠" : "タップして水をあげよう！💧";

  return (
    <div onClick={(phase==="grow"||phase==="burst")?skip:undefined}
      style={{position:"fixed",inset:0,zIndex:999,fontFamily:F,overflow:"hidden",background:"#1a1024"}}>

      <img src="/assets/gacha_stage_bg.png" alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",
        filter: phase==="charge"?"brightness(.7)":"brightness(1)",transition:"filter .6s ease"}}
        onError={e=>{e.target.style.display="none";}}/>
      <div style={{position:"absolute",inset:0,background:phase==="show"?"rgba(10,6,18,.35)":"rgba(10,6,18,.18)",transition:"background .5s"}}/>

      {grown && (curTier==="sr"||curTier==="super") && (
        <div key={"p"+stage} style={{position:"absolute",top:0,bottom:"18%",left:"50%",width:rainbow?190:110,transform:"translateX(-50%)",
          background:`linear-gradient(${rainbow?"#ffffff":AURA}00,${rainbow?"#ffffff":AURA}77,${rainbow?"#ffffff":AURA}00)`,
          filter:"blur(8px)",animation:"gPillar .7s ease-out",pointerEvents:"none"}}/>
      )}

      {grown && (
        <div style={{position:"absolute",left:"50%",bottom:"22%",transform:"translateX(-50%)",width:isSuper?340:240,height:isSuper?340:240,borderRadius:"50%",
          background: rainbow
            ? "conic-gradient(from 0deg,#ff3b3b,#ffb02e,#ffe53b,#3bd16f,#3b9eff,#9b5bff,#ff3b3b)"
            : `radial-gradient(circle,${AURA}aa 0%,${AURA}00 65%)`,
          filter:"blur(10px)",opacity:.85,animation: rainbow?"gRing 2.4s linear infinite":"gPulse 1s ease-in-out infinite",pointerEvents:"none"}}/>
      )}

      {/* ── 確定演出(予兆): 水やりの瞬間にSR以上で発生。虹は更にオーロラが重なる ── */}
      {(phase==="charge"||phase==="tap") && isSuper && (
        <div style={{position:"absolute",top:0,left:0,right:0,height:"52%",pointerEvents:"none",zIndex:2,overflow:"hidden"}}>
          {[0,1,2,3].map(i=>{const c=["#3bd16f","#3b9eff","#9b5bff","#ff5ea8"][i];return(
            <div key={"aur"+i} style={{position:"absolute",top:0,left:`${-25+i*22}%`,width:"78%",height:"100%",
              background:`linear-gradient(180deg,${c}00 0%,${c}88 42%,${c}00 100%)`,
              filter:"blur(20px)",mixBlendMode:"screen",
              animation:`gAurora ${3.6+i*0.7}s ease-in-out ${(i*0.4).toFixed(1)}s infinite alternate`}}/>);})}
        </div>
      )}
      {(phase==="charge"||phase==="tap") && premo==="star" && (
        <div style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:3,overflow:"hidden"}}>
          {[0,1,2,3].map(i=>(
            <div key={"shoot"+i} style={{position:"absolute",top:`${2+i*9}%`,left:0,width:150,height:3,
              borderRadius:3,background:isSuper?"linear-gradient(90deg,transparent,#bfe6ff,#fff)":"linear-gradient(90deg,transparent,#ffe9a8,#fff)",
              boxShadow:isSuper?"0 0 10px #bfe6ff":"0 0 10px #ffd86b",
              animation:`gShoot 2.2s linear ${(i*0.5).toFixed(2)}s infinite`}}/>
          ))}
        </div>
      )}
      {(phase==="charge"||phase==="tap") && premo==="coin" && (
        <div style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:3,overflow:"hidden"}}>
          {coins.map((c,i)=>(
            <span key={"coin"+i} style={{position:"absolute",left:`${c.l}%`,top:"-9%",fontSize:c.s,
              filter:"drop-shadow(0 0 6px #ffd86b)",animation:`gCoinFall ${c.dur}s ${c.d}s linear infinite`}}>🪙</span>
          ))}
        </div>
      )}
      {(phase==="charge"||phase==="tap") && premo==="firefly" && (
        <div style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:3,overflow:"hidden"}}>
          {flies.map((f,i)=>(
            <span key={"fly"+i} style={{position:"absolute",left:`${f.l}%`,bottom:"-4%",width:f.s,height:f.s,borderRadius:"50%",
              background:f.c,boxShadow:`0 0 ${f.s}px ${f.c}`,["--dx"]:`${f.dx}px`,
              animation:`gRise ${f.dur}s ${f.d}s ease-in-out infinite`}}/>
          ))}
        </div>
      )}

      {(phase==="charge"||phase==="tap") && (
        <div style={{position:"absolute",left:"50%",bottom:"22%",transform:"translateX(-50%)",textAlign:"center",cursor:phase==="tap"?"pointer":"default"}}
             onClick={phase==="tap"?reveal:undefined}>
          {phase==="tap" && <img src="/assets/gacha_can.png" alt="" style={{position:"absolute",left:-2,top:-70,width:78,transformOrigin:"30% 72%",animation:"gPour 1.8s ease-in-out infinite",pointerEvents:"none",filter:"drop-shadow(0 4px 8px rgba(0,0,0,.35))"}} onError={e=>{e.target.style.display="none";}}/>}
          {phase==="tap" && [0,1,2,3,4].map(i=>(
            <img key={"wd"+i} src="/assets/gacha_waterdrop.png" alt="" style={{position:"absolute",left:18+i*5,top:-12,width:10+(i%2)*4,animation:`gWdrop 1s ease-in ${(i*0.2).toFixed(2)}s infinite`,pointerEvents:"none"}} onError={e=>{e.target.style.display="none";}}/>
          ))}
          <img src="/assets/gacha_seed.png" alt="" style={{width:86,display:"block",margin:"0 auto",animation:phase==="tap"?"gSeedBob 1.1s ease-in-out infinite":"gSeedBob 1.6s ease-in-out infinite",filter:`drop-shadow(0 6px 12px ${AURA}cc)`}} onError={e=>{e.target.style.display="none";}}/>
        </div>
      )}

      {grown && (
        <div style={{position:"absolute",left:0,right:0,bottom:"21%",display:"flex",justifyContent:"center",alignItems:"flex-end",pointerEvents:"none"}}>
          <img key={stage} src={`/assets/gacha_grow_${curTier}.png`} alt=""
            style={{transformOrigin:"50% 100%",
              height:`${38+stage*7}vh`,width:"auto",maxWidth:"94vw",objectFit:"contain",
              animation:(phase==="grow")?"gNyoki .7s cubic-bezier(.2,.9,.3,1.4) forwards":(phase==="burst"&&hasHush)?"gNyoki .6s cubic-bezier(.15,.9,.3,1.5) forwards":"none",
              opacity:phase==="hush"?0.25:1,transition:"opacity .15s",
              filter:`drop-shadow(0 0 20px ${rainbow?"#ffffff":AURA}cc)`}}
            onError={e=>{e.target.style.display="none";}}/>
        </div>
      )}
      {phase==="grow" && (
        <div key={"puff"+stage} style={{position:"absolute",left:"50%",bottom:`${30+stage*6}%`,transform:"translateX(-50%)",pointerEvents:"none",zIndex:4}}>
          <div style={{position:"absolute",left:-65,top:-65,width:130,height:130,borderRadius:"50%",background:`radial-gradient(circle,${rainbow?"#ffffff":AURA}cc,transparent 66%)`,animation:"gPuff .6s ease-out forwards"}}/>
          {[...Array(rainbow?12:8)].map((_,i)=>{const ang=Math.PI*2*i/(rainbow?12:8);const dx=Math.round(Math.cos(ang)*(70+stage*8));const dy=Math.round(Math.sin(ang)*(70+stage*8));return <img key={i} src={`/assets/${PETALS[(i+stage)%PETALS.length]}.png`} alt="" style={{position:"absolute",left:0,top:0,width:22+stage*4,["--tx"]:`${dx}px`,["--ty"]:`${dy}px`,["--rot"]:`${i*44}deg`,animation:"gPetal .62s ease-out forwards"}} onError={e=>{e.target.style.display="none";}}/>;})}
        </div>
      )}

      {phase==="hush" && (
        <div style={{position:"absolute",inset:0,background:"rgba(22,10,42,0.8)",animation:"gHush .4s ease-in forwards",display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none",zIndex:7,overflow:"hidden"}}>
          <div style={{position:"absolute",left:"50%",top:"47%",transform:"translate(-50%,-50%)",width:60,height:60,borderRadius:"50%",
            background: isSuper?"conic-gradient(from 0deg,#ff3b3b,#ffb02e,#ffe53b,#3bd16f,#3b9eff,#9b5bff,#ff3b3b)":"radial-gradient(circle,#ffffff,#f5c842)",
            filter:"blur(7px)",animation:`gCharge ${isSuper?1.45:0.95}s ease-in forwards`}}/>
          <div style={{position:"relative",color:"#fff",fontSize:30,fontWeight:900,letterSpacing:5,textShadow:"0 0 22px #fff",animation:"gHushBeat .42s ease-in-out infinite"}}>なにか 来る…！</div>
        </div>
      )}
      {phase==="burst" && <div style={{position:"absolute",inset:0,background: hasHush?"radial-gradient(circle at 50% 46%,#ffffff 0%,#fff0c2 28%,#ffd97a66 52%,#ffd97a00 80%)":"radial-gradient(circle at 50% 46%,#fff 0%,#fff8 45%,#fff0 75%)",animation:hasHush?"gFlash .6s ease-out":"gFlash .45s ease-out",pointerEvents:"none",zIndex:8}}/>}
      {(phase==="burst"||phase==="show") && (
        <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:6}}>
          {parts.map((p,i)=>(
            <img key={i} src={`/assets/${p.img}.png`} alt="" style={{position:"absolute",left:"50%",top:"45%",width:p.s,["--tx"]:`${p.tx}px`,["--ty"]:`${p.ty}px`,["--rot"]:`${p.rot}deg`,animation:`gPetal ${p.dur}s cubic-bezier(.15,.7,.3,1) ${p.dl}s forwards`}} onError={e=>{e.target.style.display="none";}}/>
          ))}
        </div>
      )}

      {(phase==="charge"||phase==="tap"||phase==="grow") && (
        <div style={{position:"absolute",top:"9%",left:0,right:0,textAlign:"center",pointerEvents:"none"}}>
          <div style={{fontSize:15,color:"rgba(255,255,255,0.75)",letterSpacing:1,marginBottom:6,textShadow:"0 2px 8px #000"}}>{theme.emoji} {theme.name}ガチャ</div>
          {(phase==="charge"||phase==="tap") && result.todayTasks>0 && <div style={{fontSize:13,color:"#bff0c8",fontWeight:800,marginBottom:8,textShadow:"0 2px 8px #000"}}>きょう {result.todayTasks}こ おてつだいしたから タネが げんき！🌱</div>}
          <div style={{fontSize:phase==="grow"&&isSuper?24:19,fontWeight:900,color:rainbow?"#fff":phase==="grow"?AURA:"#fff",textShadow:rainbow?"0 0 16px #fff,0 2px 8px #000":"0 2px 8px #000",animation:"fadePulse .8s ease-in-out infinite"}}>
            {phase==="charge" ? "タネを植えるよ…"
             : phase==="tap" ? (isSuper ? "そらが にじいろに…！？ 水をあげて！🌈" : premoTxt)
             : rainbow ? "にじいろの大樹だ‼"
             : curTier==="sr" ? "金の花が さいた…⁉"
             : curTier==="r" ? "ニョキッ！まだ育つ…！？"
             : "なにが育つかな…？"}
          </div>
          {(phase==="grow"||phase==="hush") && <div onClick={(e)=>{e.stopPropagation();skip();}} style={{display:"inline-block",marginTop:16,background:"rgba(255,255,255,.16)",border:"1.5px solid rgba(255,255,255,.55)",borderRadius:999,padding:"7px 20px",color:"#fff",fontSize:15,fontWeight:800,pointerEvents:"auto",cursor:"pointer"}}>スキップ ⏭</div>}
        </div>
      )}

      {phase==="show" && (
        <div style={{position:"absolute",left:0,right:0,bottom:0,padding:"30px 22px calc(28px + env(safe-area-inset-bottom))",
          background:"linear-gradient(to top,rgba(8,5,16,.92) 60%,rgba(8,5,16,0))",animation:"gCardUp .5s cubic-bezier(.2,.8,.3,1.1) forwards",textAlign:"center"}}>
          {starCount>0 && <div style={{position:"fixed",inset:0,pointerEvents:"none"}}>{[...Array(starCount)].map((_,i)=><span key={i} style={{position:"absolute",left:`${Math.random()*100}%`,top:"-5%",fontSize:isSuper?22:16,animation:`fall ${1.4+Math.random()*1.6}s ${Math.random()*.6}s linear forwards`}}>{"⭐✨🌟💫🎊"[i%5]}</span>)}</div>}
          <div style={{display:"inline-block",fontSize:12,color:"#1a1024",fontWeight:900,background:result.color,padding:"4px 16px",borderRadius:999,marginBottom:10,boxShadow:`0 0 18px ${result.color}aa`}}>{result.emoji} {result.label}</div>
          <div style={{position:"relative",width:130,height:130,margin:"0 auto 8px"}}>
            <img src={`/assets/gacha_frame_${TF}.png`} alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain",filter:`drop-shadow(0 0 12px ${result.color}aa)`,animation:isSuper?"gPulse2 1.6s ease-in-out infinite":"none"}} onError={e=>{e.target.style.display="none";}}/>
            <span style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:44,filter:`drop-shadow(0 0 8px ${result.color})`}}>{result.collItem?result.collItem.emoji:(isSuper?"👑":"🎁")}</span>
            {result.isNewItem&&<span style={{position:"absolute",top:2,right:2,background:R,color:"#fff",borderRadius:999,padding:"2px 9px",fontSize:11,fontWeight:900}}>NEW!</span>}
          </div>
          {result.collItem && <div style={{fontWeight:900,fontSize:17,color:"#fff",marginBottom:2}}>{result.collItem.name}</div>}
          {result.collItem && <div style={{fontSize:11,color:"rgba(255,255,255,.7)",marginBottom:result.collItem.edu?6:8}}>{result.collItem.desc}</div>}
          {result.collItem && result.collItem.edu && <div style={{fontSize:11.5,color:"#bff0c8",fontWeight:700,background:"rgba(52,199,123,.16)",borderRadius:10,padding:"7px 12px",margin:"0 auto 12px",maxWidth:300,lineHeight:1.55}}>💡 {result.collItem.edu}</div>}
          <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:6,marginBottom:result.bonusPts>0?6:16}}>
            <span style={{fontSize:24}}>🪙</span>
            <span style={{color:GOLD,fontSize:46,fontWeight:900,lineHeight:1,textShadow:"0 2px 10px #000"}}>+{result.pts}</span>
            <span style={{color:"rgba(255,255,255,.8)",fontSize:14,fontWeight:700}}>pt</span>
          </div>
          {result.bonusPts>0&&<div style={{display:"inline-block",background:GOLDS,borderRadius:10,padding:"5px 14px",marginBottom:14,fontSize:12,fontWeight:800,color:"#9a7000"}}>🔥 ストリークボーナス +{result.bonusPts}pt</div>}
          <div style={{display:"flex",gap:10,width:"100%",maxWidth:360,margin:"0 auto"}}>
            {isSR && <button onClick={(e)=>{stop(e);shareCard({emoji:result.collItem?result.collItem.emoji:(isSuper?"👑":"🎁"), img:result.collItem?`/assets/${result.collItem.id.replace("gi_","gacha_").replace("gm_","gacha_gm_")}.png`:null, rarity:result.label, title:result.collItem?`${result.collItem.name} が出た！`:`${result.label} が出た！`, subtitle:`ガチャで +${result.pts}pt`, color:result.color});}} style={{flex:1,background:"rgba(255,255,255,.14)",border:"1.5px solid rgba(255,255,255,.55)",borderRadius:16,padding:"15px 0",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>シェア 📤</button>}
            <button onClick={(e)=>{stop(e);onClose();}} style={{flex:1.5,background:result.color,border:"none",borderRadius:16,padding:"15px 0",color:"#1a1024",fontWeight:900,fontSize:17,cursor:"pointer",fontFamily:F,boxShadow:`0 6px 24px ${result.color}66`}}>{isSuper?"🎊 やったー！":"やったー🎉"}</button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes sp{to{transform:rotate(360deg)}}
        @keyframes pop{from{transform:scale(.3);opacity:0}to{transform:scale(1);opacity:1}}
        @keyframes fall{to{transform:translateY(110vh) rotate(360deg);opacity:0}}
        @keyframes heartbeat{0%,100%{transform:scale(1)}14%{transform:scale(1.22)}28%{transform:scale(1.08)}42%{transform:scale(1.26)}70%{transform:scale(1)}}
        @keyframes fadePulse{0%,100%{opacity:1}50%{opacity:0.45}}
        @keyframes gRing{to{transform:translateX(-50%) rotate(360deg)}}
        @keyframes gPulse{0%,100%{transform:translateX(-50%) scale(1);opacity:.75}50%{transform:translateX(-50%) scale(1.1);opacity:.95}}
        @keyframes gPillar{from{opacity:0;transform:translateX(-50%) scaleY(.25)}to{opacity:1;transform:translateX(-50%) scaleY(1)}}
        @keyframes gFlash{0%{opacity:0}12%{opacity:.7}100%{opacity:0}}
        @keyframes gBurst{from{transform:translate(-50%,-50%) scale(1);opacity:1}to{transform:translate(calc(-50% + var(--tx)),calc(-50% + var(--ty))) scale(.3);opacity:0}}
        @keyframes gGrow{0%{transform:translateX(-50%) scaleY(.04) scaleX(.5);opacity:.5}55%{transform:translateX(-50%) scaleY(1.07) scaleX(1.03);opacity:1}78%{transform:translateX(-50%) scaleY(.97) scaleX(.99)}100%{transform:translateX(-50%) scale(1);opacity:1}}
        @keyframes gNyoki{0%{transform:scaleY(.12);opacity:.3}50%{transform:scaleY(1.12);opacity:1}72%{transform:scaleY(.96)}88%{transform:scaleY(1.03)}100%{transform:scaleY(1);opacity:1}}
        @keyframes gPuff{0%{transform:scale(.3);opacity:.9}100%{transform:scale(1.9);opacity:0}}
        @keyframes gHush{from{opacity:0}to{opacity:1}}
        @keyframes gCharge{0%{transform:translate(-50%,-50%) scale(.25);opacity:.35}70%{opacity:.9}100%{transform:translate(-50%,-50%) scale(8);opacity:1}}
        @keyframes gHushBeat{0%,100%{transform:scale(1);opacity:.65}50%{transform:scale(1.22);opacity:1}}
        @keyframes gSeedBob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-6px) scale(1.05)}}
        @keyframes gPour{0%,100%{transform:rotate(8deg)}50%{transform:rotate(26deg)}}
        @keyframes gShoot{0%{transform:translate(-45vw,-22vh) rotate(30deg);opacity:0}4%{opacity:1}33%{opacity:1;transform:translate(128vw,32vh) rotate(30deg)}38%{opacity:0;transform:translate(128vw,32vh) rotate(30deg)}100%{opacity:0;transform:translate(128vw,32vh) rotate(30deg)}}
        @keyframes gAurora{0%{transform:translateX(-10%) scaleY(.88);opacity:.45}100%{transform:translateX(10%) scaleY(1.12);opacity:.92}}
        @keyframes gCoinFall{0%{transform:translateY(0) rotate(0deg);opacity:0}10%{opacity:1}85%{opacity:1}100%{transform:translateY(118vh) rotate(540deg);opacity:0}}
        @keyframes gRise{0%{transform:translate(0,0) scale(.5);opacity:0}15%{opacity:1}80%{opacity:.9}100%{transform:translate(var(--dx),-72vh) scale(1.1);opacity:0}}
        @keyframes gWdrop{0%{transform:translateY(0) scale(.7);opacity:0}25%{opacity:1}100%{transform:translateY(78px) scale(1);opacity:0}}
        @keyframes gPetal{0%{transform:translate(-50%,-50%) rotate(0deg) scale(.4);opacity:0}18%{opacity:1}100%{transform:translate(calc(-50% + var(--tx)),calc(-50% + var(--ty) + 50px)) rotate(var(--rot)) scale(1);opacity:0}}
        @keyframes gPulse2{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
        @keyframes gCardUp{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}
      `}</style>
    </div>
  );
}

// そうび(アイテム): ぶき＋たての2スロット。レア度(rarity)と強さは別。premium=貯金/目標達成で解放する最強クラス
const EQUIPMENT = [
  // ── ぶき(weapon)＝こうげき系 ──
  {id:"eq_w_basic", slot:"weapon", rarity:1, name:"きほんのつるぎ", e:"🗡", atk:4, def:0, hp:0,  need:{k:"lv",v:1},     hint:"さいしょから"},
  {id:"eq_w_fire",  slot:"weapon", rarity:2, name:"ほのおのつるぎ", e:"🔥", atk:7, def:0, hp:0,  need:{k:"streak",v:7}, hint:"7日れんぞくで"},
  {id:"eq_w_brave", slot:"weapon", rarity:3, name:"ゆうきのつるぎ", e:"⚔", atk:11,def:0, hp:0,  need:{k:"wins",v:5},   hint:"バトル5勝で"},
  {id:"eq_w_star",  slot:"weapon", rarity:3, name:"スターロッド",   e:"🌟", atk:8, def:0, hp:12, need:{k:"lv",v:12},    hint:"レベル12で"},
  {id:"eq_w_thunder",slot:"weapon",rarity:4, name:"いかずちの剣",   e:"⚡", atk:17,def:0, hp:0,  need:{k:"bal",v:500},  premium:true, hint:"貯金500ptで"},
  {id:"eq_w_dragon", slot:"weapon",rarity:5, name:"りゅうおうの剣", e:"🐉", atk:23,def:0, hp:12, need:{k:"goals",v:3}, premium:true, hint:"目標を3回 達成で"},
  // ── たて(shield)＝ぼうぎょ系 ──
  {id:"eq_s_basic", slot:"shield", rarity:1, name:"きほんのたて",   e:"🔰", atk:0, def:4, hp:0,  need:{k:"tasks",v:10}, hint:"おてつだい10回で"},
  {id:"eq_s_guard", slot:"shield", rarity:2, name:"まもりのたて",   e:"🛡", atk:0, def:9, hp:0,  need:{k:"tasks",v:40}, hint:"おてつだい40回で"},
  {id:"eq_s_ribbon",slot:"shield", rarity:2, name:"げんきリボン",   e:"🎀", atk:0, def:2, hp:32, need:{k:"care",v:5},   hint:"なでなで5日で"},
  {id:"eq_s_crown", slot:"shield", rarity:3, name:"おうじゃのかんむり",e:"👑",atk:0, def:7, hp:26, need:{k:"lv",v:15},    hint:"レベル15で"},
  {id:"eq_s_diamond",slot:"shield",rarity:4, name:"ダイヤのよろい", e:"💎", atk:0, def:17,hp:22, need:{k:"bal",v:1000}, premium:true, hint:"貯金1000ptで"},
  {id:"eq_s_rainbow",slot:"shield",rarity:5, name:"にじのオーラ",   e:"🌈", atk:0, def:13,hp:42, need:{k:"goals",v:5}, premium:true, hint:"目標を5回 達成で"},
  // ── モンスター固有ドロップ武器(そのモンスターを倒すと低確率で入手・図鑑対応)。need:dropは条件解放されず、ドロップ限定 ──
  {id:"eq_w_slime", slot:"weapon", rarity:2, name:"スライムソード", e:"🟢", atk:6, def:0, hp:4,  need:{k:"drop",v:1}, dropFrom:"wild_slime",  hint:"スライムンを 倒すと"},
  {id:"eq_w_bat",   slot:"weapon", rarity:2, name:"ナイトファング", e:"🦇", atk:9, def:0, hp:0,  need:{k:"drop",v:1}, dropFrom:"wild_bat",    hint:"コウモリンを 倒すと"},
  {id:"eq_w_spike", slot:"weapon", rarity:3, name:"トゲのやり",     e:"📌", atk:12,def:3, hp:0,  need:{k:"drop",v:1}, dropFrom:"wild_spike",  hint:"トゲちゃんを 倒すと"},
  {id:"eq_w_bone",  slot:"weapon", rarity:3, name:"ボーンブレード", e:"🦴", atk:15,def:0, hp:0,  need:{k:"drop",v:1}, dropFrom:"wild_bone",   hint:"ガイコツンを 倒すと"},
  {id:"eq_w_flame", slot:"weapon", rarity:4, name:"フレイムランス", e:"🔥", atk:18,def:0, hp:6,  need:{k:"drop",v:1}, dropFrom:"wild_fire",   hint:"オニビを 倒すと"},
  {id:"eq_w_drago", slot:"weapon", rarity:4, name:"ドラゴンクロー", e:"🐲", atk:22,def:0, hp:8,  need:{k:"drop",v:1}, dropFrom:"wild_dragon", hint:"ヌシ・ドラゴを 倒すと"},
  {id:"eq_w_yami",  slot:"weapon", rarity:5, name:"ヤミノツルギ",   e:"🌑", atk:28,def:0, hp:14, need:{k:"drop",v:1}, dropFrom:"wild_boss",   hint:"ヤミノオウを 倒すと"},
];
// 自分のモンスターの技(進化先=curIdごとに固定で割り当て→姿が変わると技も変わる)
const PLAYER_MOVES = [
  {n:"エナジーボール", e:"🔆", c:"#34C77B"},
  {n:"スターショット", e:"⭐", c:"#ffd24a"},
  {n:"はっぱカッター", e:"🍃", c:"#5fd17a"},
  {n:"アクアジェット", e:"💧", c:"#4a9eff"},
  {n:"マジックフレア", e:"✨", c:"#b07bff"},
  {n:"こがねブラスト", e:"🪙", c:"#E8B83E"},
  {n:"いなずまスパーク", e:"⚡", c:"#ffe14a"},
];
const pickMove = (id)=> PLAYER_MOVES[[...String(id||"")].reduce((a,c)=>a+c.charCodeAt(0),0) % PLAYER_MOVES.length];
// レベル(EXP→Lv)。お手伝い・バトルでEXPが貯まる。Lvが上がるとステ上昇(IVは伸び率=才能)
function monLevel(exp){ let lv=1,need=60,e=exp||0; while(e>=need&&lv<50){e-=need;lv++;need=Math.round(need*1.16);} return {lv,into:Math.round(e),need}; }
// レベル称号(レベル帯で変わる)
function monRank(lv){ return lv>=40?"でんせつ":lv>=25?"たつじん":lv>=15?"いっぱし":lv>=7?"みならい":"かけだし"; }
// バトルのステータス(進化段階 × レベル(努力) × IV(才能))を一元化
function battleStats(data, child){
  const m=getMonState(data,child); const iv=(data.monsterIV||{})[child.id]||{hp:5,atk:5,def:5,spd:5};
  const L=monLevel((data.monsterExp||{})[child.id]||0); const lv=L.lv;
  const eqRaw=(data.monsterEquip||{})[child.id];
  const eqIds=(eqRaw&&typeof eqRaw==="object")?[eqRaw.weapon,eqRaw.shield]:(eqRaw?[eqRaw]:[]);
  const eqItems=eqIds.map(id=>EQUIPMENT.find(e=>e.id===id)).filter(Boolean);
  const eb=(k)=>eqItems.reduce((s,e)=>s+(e[k]||0),0);
  // 基礎倍率: B=全体+5%底上げ / A=ヤミノタマゴのドロップ毎+1%(累積・永続)。装備ぶん(eb)は倍率外で加算
  const eggDrops=(data.eggDrops||{})[child.id]||0;
  const reincPower=(data.reincPower||{})[child.id]||0;   // 転生プレステージ(到達Lvの累計)。0.5%/Lv
  const baseMul=1.05*(1+0.01*eggDrops+0.005*reincPower);
  return {
    hp: Math.round((50+(m.stage||0)*22+Math.round(lv*(3+(iv.hp||5)*0.5))+(m.careDays||0)*2)*baseMul)+eb("hp"),
    atk:Math.round((10+(m.stage||0)*4+Math.round(lv*(1.2+(iv.atk||5)*0.18))+Math.floor((m.gauge||0)/6))*baseMul)+eb("atk"),
    def:Math.round((5+(m.stage||0)*3+Math.round(lv*(0.8+(iv.def||5)*0.14)))*baseMul)+eb("def"),
    spd:Math.round((6+(m.stage||0)*2+Math.round(lv*(0.6+(iv.spd||5)*0.12)))*baseMul)+eb("spd"),
    lv, exp:L, iv, equip:eqItems, eggDrops,
    curId:m.curId, name:(data.monsterNickname||{})[child.id]||m.def?.name||m.def?.label||"あいぼう",
    move:pickMove(m.curId), img:m.def?.gs?`/assets/gacha_gs_${m.def.gs}_a.png`:`/assets/monster_${m.curId}_f0.png`,
  };
}
// HP自然回復: 1分で1回復(時間経過ぶんを保存値に加算)
const HP_REGEN_MS=60000;
function regenHP(stored, ts, max){
  const regen = ts ? Math.floor((Date.now()-ts)/HP_REGEN_MS) : 0;
  return Math.max(0, Math.min(max, stored + Math.max(0,regen)));
}
// お世話で回復(ratio=最大HPの割合ぶん回復)。満タンなら何もしない
function healMon(d, cid, ratio){
  const max=battleStats(d,{id:cid}).hp;
  const sameDay=(d.monsterHPDate||{})[cid]===todayKey();
  const cur=(sameDay && (d.monsterHP||{})[cid]!==undefined)?regenHP((d.monsterHP||{})[cid],(d.monsterHPTs||{})[cid]||0,max):max;
  if(cur>=max) return d;
  return {...d, monsterHP:{...(d.monsterHP||{}),[cid]:Math.min(max,Math.round(cur+max*ratio))}, monsterHPDate:{...(d.monsterHPDate||{}),[cid]:todayKey()}, monsterHPTs:{...(d.monsterHPTs||{}),[cid]:Date.now()}};
}
const TASK_EXP_CAP = 300; // タスク由来EXPの1日上限(連打青天井の防止)
// タスクEXP: HP回復＋EXP。ただし1日の上限あり(超過分は付与しない)
function careCap(d, cid, ratio, rawExp){
  let nd = ratio?healMon(d,cid,ratio):d;
  const today=todayKey(); const te=(nd.taskExpDay||{})[cid];
  const used=(te&&te.date===today)?(te.amt||0):0;
  const grant=Math.max(0, Math.min(Math.round(rawExp), TASK_EXP_CAP-used));
  if(grant>0){ nd={...nd, monsterExp:{...(nd.monsterExp||{}),[cid]:((nd.monsterExp||{})[cid]||0)+grant}, taskExpDay:{...(nd.taskExpDay||{}),[cid]:{date:today,amt:used+grant}}}; }
  return nd;
}

// ═══════════════════════════════════════════════════════
// お知らせ(新機能のおしらせ)。先頭が最新。idは重複しない文字列に
// ═══════════════════════════════════════════════════════
const NEWS = [
  {id:"n26", e:"🌟", t:"タネマネーが 新しくなりました！", b:"アプリを「ためる・推し株」中心に シンプルにリニューアル！✨\n・🌟推し株：すきな会社を「推し」にえらんで おうえんできる（ためるタブから）\n・🌱まいにちのタネ：毎日ひらくと かならずボーナスpt。連続でちょっとずつ増えるよ（ランダムのガチャは卒業！）\n・🏠ホームもスッキリ：タネモンが 大きく主役に\n・お手伝いの ならびかえ（親の設定で ≡ をドラッグ）や、履歴の左スワイプ取り消しも できるように！\nモンスター育成とバトルは おやすみに入りました。これまで育ててくれて ありがとう🌱"},
  {id:"n04", e:"🎨", t:"アプリのアイコンがドット絵に", b:"ホームの統計や見出しのアイコンを、オリジナルのドット絵に変更中。メンバー編集から“ドット絵アバター”も選べます。"},
  {id:"n03", e:"📅", t:"おてつだいが 平日/休日タブに", b:"毎日のおてつだいを、平日／休日のタブで切り替えられるようになりました。今日に合うタブが自動で開きます。"},
];
// デイリーミッション(毎日リセット)。クリアでEXP、全クリアで🧩かけら
const MISSIONS = [
  {id:"m_task",   e:"✅", label:"お手伝いを 3かい", goal:3, metric:"tasks",  exp:10},
  {id:"m_care",   e:"🤚", label:"モンスターを なでなで", goal:1, metric:"care", exp:8},
  {id:"m_learn",  e:"💡", label:"まめちしきを 読む", goal:1, metric:"learn", exp:8},
  {id:"m_battle", e:"⚔", label:"バトルに 1かい かつ", goal:1, metric:"battle", exp:12},
];
function NewsModal({onClose}){
  useEffect(()=>{ const prev=document.body.style.overflow; document.body.style.overflow="hidden"; return ()=>{ document.body.style.overflow=prev; }; },[]);
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:1100,background:"rgba(8,6,18,.6)",backdropFilter:"blur(2px)",display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:F}}>
      <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:480,maxHeight:"82vh",background:BG,borderRadius:"22px 22px 0 0",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 -8px 30px rgba(0,0,0,.3)"}}>
        <div style={{padding:"16px 18px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`}}>
          <span style={{fontWeight:900,fontSize:17,color:TEXT}}>📢 おしらせ</span>
          <button onClick={onClose} style={{background:CARDS,border:`1px solid ${BORDER}`,borderRadius:10,color:TEXT,padding:"6px 12px",fontWeight:800,cursor:"pointer",fontFamily:F}}>とじる</button>
        </div>
        <div style={{flex:1,minHeight:0,overflowY:"auto",WebkitOverflowScrolling:"touch",overscrollBehavior:"contain",padding:"12px 16px calc(20px + env(safe-area-inset-bottom))"}}>
          {NEWS.map((n,i)=>(
            <div key={n.id} style={{background:CARD,border:`1.5px solid ${i===0?G:BORDER}`,borderRadius:16,padding:"13px 14px",marginBottom:10,display:"flex",gap:11}}>
              <div style={{fontSize:26,flexShrink:0}}>{n.e}</div>
              <div style={{flex:1}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontWeight:900,fontSize:14,color:TEXT}}>{n.t}</span>
                  {i===0&&<span style={{fontSize:10,fontWeight:900,color:"#fff",background:R,borderRadius:999,padding:"1px 6px"}}>NEW</span>}
                </div>
                <div style={{fontSize:12.5,color:TEXTS,lineHeight:1.6,marginTop:4}}>{n.b}</div>
              </div>
            </div>
          ))}
          <div style={{textAlign:"center",color:MUTED,fontSize:11,marginTop:6}}>🌱 Tane Money は どんどん あたらしくなるよ</div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// DAILY TASKS
// ═══════════════════════════════════════════════════════
// ⭐やくそく: その日に表示される必須タスク(req:true)の達成状況を返す
// (DailyTasksと同じセット自動選択＋曜日フィルタ。dateObj省略時は今日)
function getYakusokuInfo(data, childId, dateObj) {
  try {
    const now = dateObj || new Date();
    const day = now.getDay();
    const iso = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
    const key = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
    const sets = data.dailyTaskSets || [];
    const inW = s => !!s && s.active!==false &&
      (!s.startDate || iso >= s.startDate) && (!s.endDate || iso <= s.endDate);
    const vac = !!(data.familySettings && data.familySettings.vacationMode);
    let chosen;
    if (vac && sets.some(s => !!s && s.vacation===true && inW(s))) {
      chosen = sets.filter(s => !!s && s.vacation===true && inW(s)).slice(0,4);
    } else {
      const ids = (Array.isArray(data.activeSetIds) && data.activeSetIds.length)
        ? data.activeSetIds : (data.activeSetId ? [data.activeSetId] : []);
      chosen = ids.map(id => sets.find(s => s.id === id)).filter(inW);
      if (chosen.length === 0) {
        const fb = sets.find(inW) || sets.find(s => !!s && s.active!==false) || sets[0];
        chosen = fb ? [fb] : [];
      }
      if (!vac) {
        const nv = chosen.filter(s => !s.vacation);
        if (nv.length) chosen = nv;
        else { const fb2 = sets.find(s => !!s && !s.vacation && inW(s)); if (fb2) chosen = [fb2]; }
      }
      chosen = chosen.slice(0,4);
    }
    // その日のセット自動選択(DailyTasksの_pickTodayと同じ)
    const wkend = [0,6].includes(day);
    const pick = (vac && chosen[0] && chosen[0].vacation) ? chosen[0] : (() => {
      const wk  = chosen.find(s=>(s.name||"").includes("平日"));
      const hol = chosen.find(s=>/休|週末|土日/.test(s.name||""));
      return (wkend ? (hol||wk) : (wk||hol)) || chosen[0] || null;
    })();
    if (!pick) return { reqTasks:[], done:0, allDone:false };
    const dowOk = t => !Array.isArray(t.dow) || t.dow.length===0 || t.dow.includes(day);
    const reqTasks = (Array.isArray(pick.tasks)?pick.tasks:[]).filter(t => t.req===true && dowOk(t));
    const p = (data.dailyProgress?.[childId]?.[key]) || {};
    const done = reqTasks.filter(t => t.type==="check" ? !!p[`${pick.id}::${t.id}`] : (p[`${pick.id}::${t.id}`]||0) >= (t.target||1)).length;
    return { reqTasks, done, allDone: reqTasks.length>0 && done===reqTasks.length };
  } catch(e) { return { reqTasks:[], done:0, allDone:false }; }
}

function DailyTasks({ child, data, update }) {
  const today  = todayKey();
  // アクティブセットを取得（最大2セットを同時に。期間チェック・null安全）
  const sets = data.dailyTaskSets || [];
  const _todayISO = todayISO();
  const inWindow = s => !!s && s.active!==false &&
    (!s.startDate || _todayISO >= s.startDate) && (!s.endDate || _todayISO <= s.endDate);
  const vacMode = !!(data.familySettings && data.familySettings.vacationMode);
  const activeSets = (() => {
    try {
      if (sets.length === 0) return [];
      // 🏖 長期休みモードON: vacation:true のセットがあればそれだけを表示
      if (vacMode) {
        const vs = sets.filter(s => !!s && s.vacation === true && inWindow(s));
        if (vs.length) return vs.slice(0, 4);
      }
      const ids = (Array.isArray(data.activeSetIds) && data.activeSetIds.length)
        ? data.activeSetIds : (data.activeSetId ? [data.activeSetId] : []);
      let chosen = ids.map(id => sets.find(s => s.id === id)).filter(inWindow);
      if (chosen.length === 0) {
        const fb = sets.find(inWindow) || sets.find(s => s.active!==false) || sets[0];
        chosen = fb ? [fb] : [];
      }
      // 長期休みモードOFF: 長期休み用セットはタブから除外(通常の平日/休日運用に戻す)
      if (!vacMode) {
        const nv = chosen.filter(s => !s.vacation);
        if (nv.length) chosen = nv;
        else {
          const fb2 = sets.find(s => !s.vacation && inWindow(s));
          if (fb2) chosen = [fb2];
        }
      }
      return chosen.slice(0, 4);
    } catch(e) { return []; }
  })();
  const activeSet = activeSets[0] || null;   // 後方互換(ヘッダ表示等)
  // 平日/休日タブ: 1セットずつ表示。今日に合うセットを自動選択(手動でも切替可)
  const _isWeekend = [0,6].includes(new Date().getDay());
  const _pickToday = () => {
    if (vacMode && activeSets[0] && activeSets[0].vacation) return activeSets[0].id;   // 長期休み中は先頭の長期休み用セット
    const wk  = activeSets.find(s=>(s.name||"").includes("平日"));
    const hol = activeSets.find(s=>/休|週末|土日/.test(s.name||""));
    return ((_isWeekend ? (hol||wk) : (wk||hol)) || activeSets[0] || {}).id || null;
  };
  const [selSetId, setSelSetId] = useState(null);
  const selId   = (selSetId && activeSets.some(s=>s.id===selSetId)) ? selSetId : _pickToday();
  const viewSet = activeSets.find(s=>s.id===selId) || activeSets[0] || null;
  // 曜日指定(dow)タスクは今日の曜日だけ表示。dowなし/空=毎日(後方互換)
  const dowOk = t => !Array.isArray(t.dow) || t.dow.length===0 || t.dow.includes(new Date().getDay());
  // 完了キーは「セットID::タスクID」で名前空間化(ID衝突回避)
  const tasks = (viewSet
    ? (Array.isArray(viewSet.tasks)?viewSet.tasks:[]).map(t =>
        ({...t, _k:`${viewSet.id}::${t.id}`, _setId:viewSet.id, _setName:viewSet.name, _setEmoji:viewSet.emoji}))
    : (data.dailyTasks || []).map(t => ({...t, _k:t.id, _setId:"", _setName:"", _setEmoji:""}))
  ).filter(dowOk);
  const bonusTotal = viewSet ? (viewSet.bonus??0) : (data.dailyBonus??50);
  const prog   = (data.dailyProgress?.[child.id]?.[today]) || {};
  const [flash, setFlash] = useState(null);
  const [justDone, setJustDone] = useState({});
  const [combo, setCombo] = useState(0);
  const [openOverride, setOpenOverride] = useState(null);   // null=自動(未完で開く/完了で畳む), true/false=手動
  const comboTimer = useRef(null);
  const totalDoneMon = (data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="good"||l.type==="daily")).length;
  const _rawMonStage = ((data.monsterEvolved||{})[child.id]) || "egg";
  const monStageId = MONSTER_TREE[_rawMonStage] ? _rawMonStage : "egg";
  // 背景テーマ解決（累計タスクで解放。未解放/autoならデフォルト時間帯背景）
  const _bgTid = (data.bgTheme||{})[child.id] || "auto";
  const _bgTheme = BG_THEMES.find(t=>t.id===_bgTid) || BG_THEMES[0];
  const _bgUnlocked = (_bgTheme.need||0) <= totalDoneMon;
  const heroGrad = (_bgUnlocked && _bgTheme.grad) ? _bgTheme.grad : null;
  const heroImg  = (_bgUnlocked && _bgTheme.img) ? _bgTheme.img : null;
  const heroStars = _bgUnlocked && _bgTheme.stars;

  const showFlash = (pts, emoji, yaku) => { taneHaptic(pts>=0?"success":"warn"); setFlash({pts,emoji,yaku:!!yaku,cheer:pts>0?taneCheer():null}); setTimeout(()=>setFlash(null),1100); };
  const markJustDone = id => {
    setJustDone(p=>({...p,[id]:true}));
    setTimeout(()=>setJustDone(p=>{const n={...p};delete n[id];return n;}),550);
    setCombo(c=>c+1);
    if(comboTimer.current) clearTimeout(comboTimer.current);
    comboTimer.current=setTimeout(()=>setCombo(0),3000);
  };

  const isCheck   = t => t.type === "check";
  const isDone    = t => isCheck(t) ? !!prog[t._k] : (prog[t._k]||0) >= (t.target||1);
  const doneCount = tasks.filter(t => isDone(t)).length;
  const allDone   = doneCount === tasks.length && tasks.length > 0;
  // セット単位の完了/ボーナス判定(2セットそれぞれに全達成ボーナス)
  const bonusKey  = s => `__bonus__::${s.id}`;
  const setDoneIn = (s, p) => (Array.isArray(s.tasks)?s.tasks:[]).filter(dowOk).every(tt =>
    tt.type==="check" ? !!p[`${s.id}::${tt.id}`] : (p[`${s.id}::${tt.id}`]||0) >= (tt.target||1));
  const setGivesBonus = s => { const rw=s?.bonusReward||"pts"; return (((rw==="pts"||rw==="both")&&(s?.bonus>0)) || (rw==="yaku"||rw==="both")); };
  const allBonusGiven = viewSet ? (!setGivesBonus(viewSet) || !!prog[bonusKey(viewSet)]) : true;
  // 開閉: 既定は「未完なら開く・全部できたら畳む」。タップで手動上書き。
  const open = openOverride !== null ? openOverride : !allDone;
  const toggleOpen = () => setOpenOverride(!open);

  const mkEntry = (label, pts) => ({ id:uid(), cid:child.id, type:"daily", label, pts, date:new Date().toISOString() });
  const setDailyProg = (d, extra) => ({
    ...d,
    dailyProgress: {
      ...d.dailyProgress,
      [child.id]: { ...(d.dailyProgress?.[child.id]||{}), [today]: { ...((d.dailyProgress?.[child.id]?.[today])||{}), ...extra } }
    }
  });

  // 該当セットが全部終わったら、そのセットのボーナスを付与(1回だけ)
  const awardSetBonus = (setId, newProg) => {
    const s = activeSets.find(x => x.id === setId);
    if (!s) return;
    const rw = s.bonusReward || "pts";                       // pts / yaku / both（全クリア時のごほうび種別）
    const givesPts  = (rw==="pts"||rw==="both") && (s.bonus>0);
    const givesYaku = (rw==="yaku"||rw==="both");
    if (!givesPts && !givesYaku) return;
    if (prog[bonusKey(s)]) return;
    if (!setDoneIn(s, newProg)) return;
    setTimeout(() => {
      update(d => {
        let nd = setDailyProg(d, {[bonusKey(s)]:true});
        if (givesPts) {
          const bonusEntry = mkEntry(`🌟 ${s.name} ぜんぶ達成ボーナス！`, s.bonus);
          addLogToFirestore(bonusEntry);
          nd = { ...nd, logs:[bonusEntry, ...nd.logs] };
        }
        if (givesYaku) {                                     // 全クリアで翌日のごほうび(スマホ等)を解放
          nd = { ...nd, yakusokuDone: { ...(nd.yakusokuDone||{}), [child.id]: today } };
        }
        return nd;
      });
      setFlash({ pts: givesPts ? s.bonus : 0, emoji:"🌟", yaku: givesYaku && !givesPts });
      setTimeout(()=>setFlash(null),1400);
    }, 600);
  };

  // ⭐やくそく: 完了直後、今日表示の必須タスクが全部できていたら達成日を記録(翌日のごほうび解放)
  const markYakusoku = d => {
    const info = getYakusokuInfo(d, child.id);
    if (!info.reqTasks.length || !info.allDone) return d;
    return { ...d, yakusokuDone: { ...(d.yakusokuDone||{}), [child.id]: today } };
  };

  const handleCheck = t => {
    if (isDone(t)) return;
    showFlash(t.pts, t.emoji, (t.pts||0)===0&&t.req);
    markJustDone(t._k);
    const entry = mkEntry(`✅ ${t.label}`, t.pts);
    update(d => markYakusoku(careCap({ ...setDailyProg(d, {[t._k]:true}), logs:[entry,...d.logs] }, child.id, 0.2, Math.max(1,t.pts))));
    addLogToFirestore(entry);
    awardSetBonus(t._setId, { ...prog, [t._k]: true });
  };

  const handleCount = t => {
    const cur = prog[t._k] || 0;
    if (cur >= (t.target||1) && isDone(t)) return;
    const nxt = cur + 1;
    showFlash(t.pts, t.emoji, (t.pts||0)===0&&t.req);
    if(nxt>=(t.target||1)) markJustDone(t._k);
    const entry = mkEntry(`🔢 ${t.label}（${nxt}回目）`, t.pts);
    update(d => markYakusoku(careCap({ ...setDailyProg(d, {[t._k]:nxt}), logs:[entry,...d.logs] }, child.id, 0.12, Math.max(1, t.pts))));
    addLogToFirestore(entry);
    if (nxt>=(t.target||1)) awardSetBonus(t._setId, { ...prog, [t._k]: nxt });
  };

  return (
    <div style={{padding:"12px 16px",paddingBottom:0}}>
      {flash && (
        <div style={{position:"fixed",top:"28%",left:"50%",transform:"translate(-50%,-50%)",background:flash.yaku?GOLD:(flash.pts>=0?G:R),color:"#fff",borderRadius:20,padding:"13px 24px",zIndex:900,textAlign:"center",animation:"popIn .3s ease",pointerEvents:"none"}}>
          <div style={{fontSize:36}}>{flash.emoji}</div>
          {flash.yaku?<div style={{fontSize:16,fontWeight:900}}>⭐やくそく クリア！</div>:<Yen v={flash.pts} sz={20}/>}
          {flash.pts>0&&<>
            <img src={`/assets/monster_${monStageId}_f0.png`} style={{width:48,height:48,objectFit:"contain",display:"block",margin:"5px auto 2px",imageRendering:"pixelated",animation:"heartbeat .6s ease-in-out"}} onError={e=>{e.target.style.display="none"}}/>
            <div style={{fontSize:11.5,fontWeight:800,color:"rgba(255,255,255,0.95)",maxWidth:210,lineHeight:1.45,margin:"0 auto"}}>{flash.cheer||"✨ なかまがよろこんだ！"}</div>
          </>}
          {combo>=3&&<div style={{fontSize:13,fontWeight:900,color:"#fde68a",marginTop:4}}>🔥 {combo}コンボ！</div>}
        </div>
      )}

      {/* Progress bar（タップで下のタスク一覧を開閉するヘッダー） */}
      <div onClick={toggleOpen} role="button" style={{background:CARD,border:`2px solid ${allDone?"#34c77b":BORDER}`,borderRadius:18,padding:16,marginBottom:14,cursor:"pointer",userSelect:"none"}}>
        {/* 平日/休日タブ(2セット以上で切替・タップで選択。今日に合うセットを自動選択) */}
        {activeSets.length>1 ? (
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,flexWrap:"wrap"}}>
            {activeSets.map(s=>{const sel=s.id===selId;const sdone=setDoneIn(s,prog);return(
              <button key={s.id} onClick={(e)=>{e.stopPropagation();setSelSetId(s.id);}}
                style={{display:"inline-flex",alignItems:"center",gap:4,background:sel?GP:`${P}10`,border:`1.5px solid ${sel?GP:"transparent"}`,borderRadius:999,padding:"5px 13px",cursor:"pointer",fontFamily:F}}>
                <span style={{fontSize:14}}>{s.emoji}</span>
                <span style={{fontWeight:800,fontSize:12,color:sel?"#fff":P}}>{s.name}</span>
                {sdone&&<span style={{fontSize:11,fontWeight:900,color:sel?"#fff":G}}>✓</span>}
              </button>);})}
          </div>
        ) : activeSets.length===1 ? (
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
            <span style={{display:"inline-flex",alignItems:"center",gap:4,background:`${P}12`,borderRadius:10,padding:"2px 8px"}}>
              <span style={{fontSize:14}}>{activeSets[0].emoji}</span>
              <span style={{fontWeight:800,fontSize:11,color:P}}>{activeSets[0].name}</span>
            </span>
          </div>
        ) : null}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <p style={{fontWeight:900,fontSize:14,margin:0,color:allDone?G:TEXT}}>
            {allDone ? "🌟 今日は全部できた！" : "📋 今日のやること"}
          </p>
          <span style={{fontWeight:800,fontSize:13,color:allDone?G:MUTED,display:"flex",alignItems:"center",gap:6}}>
            {doneCount}/{tasks.length}
            <span style={{fontSize:11,opacity:.7,transition:"transform .25s",transform:open?"rotate(0deg)":"rotate(-90deg)"}}>▼</span>
          </span>
        </div>
        <div style={{height:10,background:BORDER,borderRadius:5,overflow:"hidden",marginBottom:8}}>
          <div style={{height:"100%",width:`${tasks.length?doneCount/tasks.length*100:0}%`,background:allDone?G:Y,borderRadius:5,transition:"width .5s ease"}}/>
        </div>
        {viewSet && setGivesBonus(viewSet) && (()=>{
          const rw=viewSet.bonusReward||"pts";
          const showPts=(rw==="pts"||rw==="both")&&bonusTotal>0;
          const showYaku=(rw==="yaku"||rw==="both");
          const rwTxt=`${showPts?`+${bonusTotal}pt`:""}${showPts&&showYaku?"＋":""}${showYaku?"あしたのごほうび🎁":""}`;
          return (
          <p style={{color:allBonusGiven?G:MUTED,fontSize:12,fontWeight:700,margin:0}}>
            {allBonusGiven ? `✅ ${rwTxt} ゲット！` : `🎁 ぜんぶやると ${rwTxt}！`}
          </p>
          );
        })()}
        {tasks.length===0&&<p style={{color:MUTED,fontSize:12,margin:"8px 0 0"}}>アクティブなタスクセットがないよ</p>}
      </div>

      {/* Task list（開いているときだけ表示。セットごとに見出しを付けて2セットまとめ表示） */}
      {open && <>
      {tasks.length === 0 && (
        <p style={{color:MUTED,textAlign:"center",fontSize:13,marginTop:20}}>まだデイリータスクがないよ</p>
      )}
      {tasks.map((t,i) => {
        const done = isDone(t);
        const count = isCheck(t) ? null : (prog[t._k]||0);
        const showHeader = false; // 平日/休日はタブで切替表示するため、一覧内の見出しは不要
        return (
          <React.Fragment key={t._k}>
          {showHeader&&(
            <div style={{display:"flex",alignItems:"center",gap:6,margin:"6px 2px 8px",paddingTop:i===0?0:6}}>
              <span style={{fontSize:15}}>{t._setEmoji}</span>
              <span style={{fontWeight:800,fontSize:12,color:P}}>{t._setName}</span>
              <div style={{flex:1,height:1,background:BORDER}}/>
            </div>
          )}
          <div
            style={{background:done?"#e8faf0":CARD, border:`2px solid ${done?G:BORDER}`, borderRadius:16, padding:"14px 16px", marginBottom:10, display:"flex", alignItems:"center", gap:12, transition:"all .25s", transform:justDone[t._k]?"scale(1.08)":"scale(1)", boxShadow:justDone[t._k]?`0 0 0 4px ${G}90`:"none"}}>
            <span style={{fontSize:32}}>{t.emoji}</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:800,fontSize:15,color:done?G:TEXT,textDecoration:done&&isCheck(t)?"line-through":"none"}}>{t.label}{t.req&&<span style={{color:GOLD,fontSize:12,marginLeft:4}}>⭐</span>}</div>
              <div style={{color:MUTED,fontSize:12,marginTop:2}}>
                {(t.pts||0)===0
                  ? <><span style={{color:GOLD,fontWeight:800}}>⭐やくそく</span>{!isCheck(t)&&`　目標: ${t.target||1}回`}</>
                  : (isCheck(t) ? `+${t.pts}pt` : `1回 +${t.pts}pt　目標: ${t.target||1}回`)}
              </div>
            </div>
            {isCheck(t) ? (
              <button onClick={()=>handleCheck(t)} disabled={done}
                style={{width:44,height:44,borderRadius:"50%",border:`2.5px solid ${done?G:BORDER}`,background:done?G:"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,cursor:done?"default":"pointer",flexShrink:0,transition:"all .2s"}}>
                {done ? "✓" : ""}
              </button>
            ) : (
              <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                <span style={{fontWeight:800,fontSize:14,color:done?G:TEXT}}>{count}/{t.target||1}</span>
                <button onClick={()=>handleCount(t)} disabled={done}
                  style={{width:44,height:44,borderRadius:"50%",border:"none",background:done?G:Y,color:"#fff",fontSize:22,fontWeight:900,cursor:done?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .2s"}}>
                  {done?"✓":"+"}
                </button>
              </div>
            )}
          </div>
          </React.Fragment>
        );
      })}
      </>}
      <style>{`@keyframes popIn{from{transform:translate(-50%,-50%) scale(.5);opacity:0}to{transform:translate(-50%,-50%) scale(1);opacity:1}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// CHILD SCREEN
// ═══════════════════════════════════════════════════════
// ── SettingsModal（親PIN認証後に表示） ────────────────
// ── お手伝い・マイナスタスク管理コンポーネント ──
function TaskManagerSection({data, update}){
  const [tab, setTab] = useState("good"); // good | bad
  const [showAdd, setShowAdd] = useState(false);
  const [newEmoji, setNewEmoji] = useState("⭐");
  const [newLabel, setNewLabel] = useState("");
  const [newPts, setNewPts] = useState("");

  const tasks = tab==="good" ? (data.goodTasks||[]) : (data.badTasks||[]);
  const key = tab==="good" ? "goodTasks" : "badTasks";

  const doAdd = () => {
    if(!newLabel.trim()||!newPts) return;
    const pts = parseInt(newPts);
    if(isNaN(pts)) return;
    const finalPts = tab==="bad" ? -Math.abs(pts) : Math.abs(pts);
    update(d=>({...d,[key]:[...d[key],{id:uid(),emoji:newEmoji,label:newLabel.trim(),pts:finalPts,over:{}}]}));
    setNewLabel(""); setNewPts(""); setNewEmoji("⭐"); setShowAdd(false);
  };

  const doDelete = (id) => {
    update(d=>({...d,[key]:d[key].filter(t=>t.id!==id)}));
  };

  return(
    <div style={{marginBottom:8}}>
      <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 8px"}}>
        {tab==="good"?"✅ お手伝い項目":"❌ マイナス項目"}
      </p>
      {/* good/bad切替 */}
      <div style={{display:"flex",gap:6,marginBottom:10}}>
        {[["good","✅ お手伝い"],["bad","❌ マイナス"]].map(([v,l])=>(
          <button key={v} onClick={()=>{setTab(v);setShowAdd(false);}}
            style={{flex:1,padding:"7px 0",border:`1.5px solid ${tab===v?(v==="good"?G:R):BORDER}`,
              borderRadius:10,background:tab===v?(v==="good"?`${G}15`:`${R}15`):"transparent",
              color:tab===v?(v==="good"?G:R):MUTED,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
            {l}
          </button>
        ))}
      </div>
      {/* タスク一覧 */}
      <div style={{maxHeight:200,overflowY:"auto",marginBottom:8}}>
        {tasks.map(t=>(
          <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,background:CARD,
            border:`1.5px solid ${BORDER}`,borderRadius:10,padding:"8px 10px",marginBottom:5}}>
            <span style={{fontSize:18}}>{t.emoji}</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:12,color:TEXT}}>{t.label}</div>
              <div style={{fontSize:11,color:t.pts>0?G:R,fontWeight:700}}>{t.pts>0?"+":""}{t.pts}pt</div>
            </div>
            <button onClick={()=>doDelete(t.id)}
              style={{padding:"3px 8px",background:`${R}15`,border:`1.5px solid ${R}`,
                borderRadius:7,color:R,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
              削除
            </button>
          </div>
        ))}
      </div>
      {/* 追加フォーム */}
      {showAdd ? (
        <div style={{background:BG,borderRadius:12,padding:"12px",border:`1.5px solid ${tab==="good"?G:R}`}}>
          <div style={{display:"flex",gap:6,marginBottom:8}}>
            <input value={newEmoji} onChange={e=>setNewEmoji(e.target.value)}
              style={{width:50,padding:"8px",border:`1.5px solid ${BORDER}`,borderRadius:8,
                fontSize:18,textAlign:"center",fontFamily:F,background:CARD}}/>
            <input value={newLabel} onChange={e=>setNewLabel(e.target.value)}
              placeholder="項目名" maxLength={20}
              style={{flex:1,padding:"8px 10px",border:`1.5px solid ${BORDER}`,borderRadius:8,
                fontSize:13,fontFamily:F,background:CARD}}/>
          </div>
          <div style={{display:"flex",gap:6,marginBottom:8}}>
            <input value={newPts} onChange={e=>setNewPts(e.target.value)}
              type="number" placeholder="pt数"
              style={{flex:1,padding:"8px 10px",border:`1.5px solid ${BORDER}`,borderRadius:8,
                fontSize:13,fontFamily:F,background:CARD}}/>
            <span style={{padding:"8px 4px",fontSize:12,color:MUTED,alignSelf:"center"}}>pt</span>
          </div>
          {/* クイック選択pt */}
          <div style={{display:"flex",gap:4,marginBottom:10,flexWrap:"wrap"}}>
            {[5,10,20,30,50,100].map(v=>(
              <button key={v} onClick={()=>setNewPts(String(v))}
                style={{padding:"4px 10px",border:`1.5px solid ${newPts===String(v)?(tab==="good"?G:R):BORDER}`,
                  borderRadius:8,background:newPts===String(v)?(tab==="good"?`${G}20`:`${R}20`):"transparent",
                  color:newPts===String(v)?(tab==="good"?G:R):MUTED,
                  fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
                {v}
              </button>
            ))}
          </div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={doAdd}
              style={{flex:1,padding:"9px",background:tab==="good"?G:R,border:"none",borderRadius:10,
                color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
              ✅ 追加する
            </button>
            <button onClick={()=>setShowAdd(false)}
              style={{padding:"9px 14px",background:`${MUTED}20`,border:`1.5px solid ${BORDER}`,
                borderRadius:10,color:MUTED,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <button onClick={()=>setShowAdd(true)}
          style={{width:"100%",padding:"10px",background:`${tab==="good"?G:R}15`,
            border:`2px dashed ${tab==="good"?G:R}`,borderRadius:12,
            color:tab==="good"?G:R,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
          ＋ 新しい{tab==="good"?"お手伝い":"マイナス"}項目を追加
        </button>
      )}
    </div>
  );
}


// prompt()の代替：モバイルでも崩れない自前の入力モーダル付きボタン（自己完結）
function PromptModalButton({ btnStyle, btnLabel, title, desc, type, maxLen, initial, placeholder, onSubmit }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(initial||"");
  return (
    <>
      <button onClick={()=>{ setV(initial||""); setOpen(true); }} style={btnStyle}>{btnLabel}</button>
      {open && (
        <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,background:"#000a",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:24,fontFamily:F}}>
          <div onClick={e=>e.stopPropagation()} style={{background:CARD,borderRadius:20,padding:"24px 22px",width:"100%",maxWidth:340,boxShadow:"0 12px 48px #0005"}}>
            <div style={{fontWeight:900,fontSize:17,color:TEXT,marginBottom:desc?6:14}}>{title}</div>
            {desc&&<div style={{fontSize:13,color:MUTED,marginBottom:14,lineHeight:1.6}}>{desc}</div>}
            <input autoFocus value={v}
              onChange={e=>{const raw=e.target.value; setV(type==="number"?raw.replace(/[^0-9]/g,"").slice(0,maxLen||6):raw.slice(0,maxLen||40));}}
              type="text" inputMode={type==="number"?"numeric":"text"} placeholder={placeholder||""}
              style={{width:"100%",padding:"13px 14px",border:`2px solid ${BORDER}`,borderRadius:12,fontSize:18,fontWeight:700,fontFamily:F,background:BG,outline:"none",textAlign:"center",letterSpacing:type==="number"?6:1,boxSizing:"border-box",marginBottom:16}}/>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setOpen(false)} style={{flex:1,padding:"13px",background:"transparent",border:`1.5px solid ${BORDER}`,borderRadius:12,color:MUTED,fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F}}>キャンセル</button>
              <button onClick={()=>{ const val=v; setOpen(false); onSubmit(val); }} style={{flex:1.4,padding:"13px",background:GP,border:"none",borderRadius:12,color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>けってい</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SettingsModal({data, update, onClose, currentMemberId}) {
  const [authed, setAuthed] = useState(false);
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState(false);
  const [settingsGroup, setSettingsGroup] = useState("quick");
  const [settingsTab, setSettingsTab] = useState((data.pendingApprovals||[]).length>0?"approval":"grant");
  const [grantChild, setGrantChild] = useState(null);
  const [grantAmt, setGrantAmt] = useState("");
  const [taskAssignChild, setTaskAssignChild] = useState(null);
  const [copied, setCopied] = useState(false);
  const [smEditReward, setSmEditReward] = useState(null);
  const [smAddOpen, setSmAddOpen] = useState(false);
  const [smREmoji, setSmREmoji] = useState("🎁");
  const [smRLabel, setSmRLabel] = useState("");
  const [smRCost, setSmRCost] = useState("5");
  const [smRUnit, setSmRUnit] = useState("");
  const [planMsg, setPlanMsg] = useState("");
  const [planBusy, setPlanBusy] = useState(false);
  // 背面(個別ページ)のスクロール抜けを防ぐ：モーダル表示中は body のスクロールをロック
  useEffect(()=>{ const prev=document.body.style.overflow; document.body.style.overflow="hidden"; return ()=>{ document.body.style.overflow=prev; }; },[]);

  const F = "'M PLUS Rounded 1c','Hiragino Maru Gothic ProN',sans-serif";
  const G="#34c77b",Y="#f5c842",R="#f0605a",B="#4a9eff",P="#a855f7";
  const TEXT="#1a1a2a",MUTED="#9ca3af",CARD="#ffffff",BG="#f8f9fa",BORDER="#e5e7eb";
  const INP = {width:"100%",padding:"10px 14px",border:`1.5px solid ${BORDER}`,borderRadius:10,fontSize:14,fontFamily:F,background:BG,outline:"none"};

  // PIN認証
  const handlePin = (k) => {
    if(pinErr){setPinErr(false);setPin("");}
    const next = pin + k;
    setPin(next);
    if(next.length === 4) {
      if(parentPinMatches(next, data)) {
        setTimeout(()=>{
          setAuthed(true);
          if(parentPinIsDefault(data)){ setSettingsGroup("adv"); setSettingsTab("members"); }
        }, 200);
      } else {
        setTimeout(()=>{setPinErr(true);setPin("");}, 300);
      }
    }
  };

  const QUICK_TABS = [["grant","🎁 pt付与"],["approval","✅ 承認"]];
  const ADV_TABS   = [["tasks","📋 タスク"],["assign","👤 割当"],["rewards","🎁 特典"],["interest","💹 利子"],["family","🏆 家族目標"],["plan","💳 プラン"],["members","🔐 PIN"],["transfer","🔄 引継"]];
  const SETTING_TABS = settingsGroup==="quick" ? QUICK_TABS : ADV_TABS;

  if(!authed) return (
    <div style={{position:"fixed",inset:0,background:"#000a",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>
      <div style={{background:CARD,borderRadius:24,padding:"32px 24px",width:"100%",maxWidth:320,textAlign:"center",boxShadow:"0 8px 40px #0004"}}>
        <div style={{fontSize:44,marginBottom:8}}>🔐</div>
        <h3 style={{fontWeight:900,fontSize:18,color:TEXT,margin:"0 0 4px"}}>設定・管理</h3>
        <p style={{color:MUTED,fontSize:12,margin:"0 0 12px"}}>おや用PIN（初期：0000）</p>
        {parentPinIsDefault(data)&&(
          <div style={{background:`${R}12`,border:`1.5px solid ${R}50`,borderRadius:12,padding:"10px 14px",marginBottom:14,textAlign:"left"}}>
            <p style={{margin:0,fontSize:12,color:R,fontWeight:700}}>⚠ PINが初期値のままです</p>
            <p style={{margin:"3px 0 0",fontSize:11,color:MUTED}}>認証後、すぐに変更してください</p>
          </div>
        )}
        <div style={{display:"flex",justifyContent:"center",gap:10,marginBottom:16}}>
          {[0,1,2,3].map(i=>(
            <div key={i} style={{width:14,height:14,borderRadius:"50%",background:pin.length>i?(pinErr?R:TEXT):BORDER,transition:"background .15s"}}/>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
          {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
            <button key={i} onClick={()=>k==="⌫"?setPin(p=>p.slice(0,-1)):k!==""&&handlePin(String(k))}
              style={{padding:"16px 0",border:`1.5px solid ${BORDER}`,borderRadius:12,background:k===""?"transparent":CARD,fontSize:20,fontWeight:700,cursor:k===""?"default":"pointer",fontFamily:F,color:TEXT}}>
              {k}
            </button>
          ))}
        </div>
        {pinErr&&<p style={{color:R,fontSize:12,margin:"0 0 8px",fontWeight:700}}>PINが違います</p>}
        <button onClick={onClose} style={{background:"none",border:"none",color:MUTED,fontSize:13,cursor:"pointer",fontFamily:F}}>キャンセル</button>
      </div>
    </div>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"#000a",zIndex:9999,display:"flex",alignItems:"flex-end",fontFamily:F}}>
      <div style={{background:CARD,borderRadius:"24px 24px 0 0",width:"100%",maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>
        {/* ヘッダー */}
        <div style={{padding:"20px 20px 0",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <div>
            <h3 style={{fontWeight:900,fontSize:18,color:TEXT,margin:"0 0 2px"}}><Ico name="gear" fb="⚙" size={17} style={{marginRight:5}}/>全体管理</h3>
            <p style={{color:MUTED,fontSize:11,margin:0}}>家族全員のポイント・タスクを管理</p>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:MUTED}}>✕</button>
        </div>
        {/* グループ切り替え */}
        <div style={{display:"flex",gap:6,padding:"12px 16px 0",flexShrink:0}}>
          {[["quick","⚡ よく使う"],["adv","⚙ 詳細設定"]].map(([g,l])=>(
            <button key={g} onClick={()=>{setSettingsGroup(g);setSettingsTab(g==="quick"?"grant":"tasks");}}
              style={{flex:1,padding:"7px 0",borderRadius:10,border:"none",background:settingsGroup===g?GP:"transparent",color:settingsGroup===g?"#fff":MUTED,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>
              {l}
            </button>
          ))}
        </div>
        {/* タブ */}
        <div style={{display:"flex",gap:0,padding:"6px 16px 0",overflowX:"auto",flexShrink:0}}>
          {SETTING_TABS.map(([v,l])=>(
            <button key={v} onClick={()=>setSettingsTab(v)}
              style={{padding:"8px 14px",border:"none",borderBottom:settingsTab===v?`3px solid ${Y}`:"3px solid transparent",background:"none",color:settingsTab===v?TEXT:MUTED,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap"}}>
              {l}{v==="approval"&&((data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length)>0&&<span style={{marginLeft:5,background:R,color:"#fff",borderRadius:999,padding:"0 5px",fontSize:11,fontWeight:900}}>{(data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length}</span>}
            </button>
          ))}
        </div>
        {/* コンテンツ */}
        <div style={{flex:1,minHeight:0,overflowY:"auto",WebkitOverflowScrolling:"touch",overscrollBehavior:"contain",padding:"16px"}}>

          {/* ── pt付与タブ ── */}
          {settingsTab==="grant"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>ポイントを付与する</p>
              {[...data.children,...(data.parents||[])].map(member=>(
                <div key={member.id} style={{background:grantChild===member.id?`${Y}15`:BG,border:`1.5px solid ${grantChild===member.id?Y:BORDER}`,borderRadius:14,padding:"12px 14px",marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:grantChild===member.id?10:0}}>
                    <ChildAvatar child={member} size={36}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:14}}>{member.name}</div>
                      <div style={{color:MUTED,fontSize:11}}>{bal(data.logs,member.id).toLocaleString()}pt</div>
                    </div>
                    <button onClick={()=>setGrantChild(grantChild===member.id?null:member.id)}
                      style={{padding:"6px 14px",background:Y,border:"none",borderRadius:10,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,color:TEXT}}>
                      {grantChild===member.id?"閉じる":"付与"}
                    </button>
                  </div>
                  {grantChild===member.id&&(
                    <div>
                      <div style={{display:"flex",gap:6,marginBottom:8}}>
                        {[10,30,50,100,200,500].map(v=>(
                          <button key={v} onClick={()=>setGrantAmt(String(v))}
                            style={{flex:1,padding:"6px 0",border:`1.5px solid ${grantAmt===String(v)?Y:BORDER}`,borderRadius:8,background:grantAmt===String(v)?`${Y}20`:"transparent",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,color:grantAmt===String(v)?"#9a7000":MUTED}}>
                            {v}
                          </button>
                        ))}
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <input value={grantAmt} onChange={e=>setGrantAmt(e.target.value)} type="number" placeholder="pt数" style={{...INP,flex:1}}/>
                        <button onClick={()=>{
                          const amt=parseInt(grantAmt);
                          if(isNaN(amt)||amt===0) return;
                          if(!txGuard("grant_"+member.id)) return;   // 連打ガード(二重付与防止)
                          (()=>{const _e={id:uid(),cid:member.id,type:"grant",label:`🎁 親からのポイント付与`,pts:amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);})();
                          setGrantAmt("");setGrantChild(null);
                        }} style={{padding:"10px 16px",background:G,border:"none",borderRadius:10,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                          付与
                        </button>
                      </div>
                      <div style={{display:"flex",gap:8,marginTop:6}}>
                        <button onClick={()=>{
                          const amt=parseInt(grantAmt);
                          if(isNaN(amt)||amt===0) return;
                          if(!txGuard("deduct_"+member.id)) return;   // 連打ガード(二重減算防止)
                          (()=>{const _e={id:uid(),cid:member.id,type:"grant",label:`⚠ ポイント減算`,pts:-amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);})();
                          setGrantAmt("");setGrantChild(null);
                        }} style={{flex:1,padding:"8px 0",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:10,color:R,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
                          −減算
                        </button>
                      </div>
                      {/* 育成タマゴ・ガチャチケットのプレゼントは、育成廃止＆ガチャ→まいにちのタネ化に伴い撤去 */}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── タスク管理タブ ── */}
          {settingsTab==="tasks"&&(
            <div>
              {/* お手伝い項目管理 */}
              <TaskManagerSection data={data} update={update}/>
              {/* 毎日タスク管理 */}
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"16px 0 8px"}}>📋 毎日タスク管理</p>
              <ParentDailyTab data={data} update={update} sb={(c,l,fn)=><button onClick={fn} style={{padding:"5px 10px",background:`${c}20`,border:`1.5px solid ${c}`,borderRadius:8,color:c,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>}/>
            </div>
          )}

          {/* ── 個別タスク割り当てタブ ── */}
          {settingsTab==="assign"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>メンバーごとのタスク割り当て</p>
              {[...data.children,...(data.parents||[])].map(member=>(
                <div key={member.id} style={{marginBottom:12}}>
                  <button onClick={()=>setTaskAssignChild(taskAssignChild===member.id?null:member.id)}
                    style={{width:"100%",background:taskAssignChild===member.id?`${B}10`:CARD,border:`2px solid ${taskAssignChild===member.id?B:BORDER}`,borderRadius:14,padding:"12px 14px",display:"flex",alignItems:"center",gap:10,cursor:"pointer",textAlign:"left",fontFamily:F}}>
                    <ChildAvatar child={member} size={36}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:14}}>{member.name}</div>
                      <div style={{color:MUTED,fontSize:11}}>
                        カスタムタスク: {((data.myTaskIds||{})[member.id]||[]).length}件
                      </div>
                    </div>
                    <span style={{color:MUTED,fontSize:16}}>{taskAssignChild===member.id?"▲":"▼"}</span>
                  </button>
                  {taskAssignChild===member.id&&(
                    <div style={{background:BG,borderRadius:"0 0 14px 14px",padding:"12px 14px",border:`2px solid ${B}`,borderTop:"none"}}>
                      <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>
                        タスクを選んで{member.name}専用リストに追加
                      </p>
                      <div style={{maxHeight:240,overflowY:"auto",display:"flex",flexDirection:"column",gap:5}}>
                        {(data.goodTasks||[]).map(t=>{
                          const assigned=((data.myTaskIds||{})[member.id]||[]).includes(t.id);
                          return(
                            <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,background:assigned?`${G}10`:CARD,border:`1.5px solid ${assigned?G:BORDER}`,borderRadius:10,padding:"8px 12px"}}>
                              <span style={{fontSize:18}}>{t.emoji}</span>
                              <div style={{flex:1}}>
                                <div style={{fontWeight:700,fontSize:12}}>{t.label}</div>
                                <div style={{color:MUTED,fontSize:11}}>+{t.pts}pt</div>
                              </div>
                              <button onClick={()=>update(d=>{
                                const cur=(d.myTaskIds||{})[member.id]||[];
                                const next=assigned?cur.filter(id=>id!==t.id):[...cur,t.id];
                                return{...d,myTaskIds:{...(d.myTaskIds||{}),[member.id]:next}};
                              })} style={{padding:"4px 10px",background:assigned?`${R}15`:`${G}15`,border:`1.5px solid ${assigned?R:G}`,borderRadius:8,color:assigned?R:G,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
                                {assigned?"解除":"追加"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── 特典管理タブ ── */}
          {settingsTab==="rewards"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>こうかんアイテムの管理</p>
              {(data.rewards||[]).map(r=>(
                <div key={r.id}>
                  {smEditReward?.id===r.id ? (
                    <div style={{background:BG,border:`1.5px solid ${B}`,borderRadius:12,padding:"12px 14px",marginBottom:8}}>
                      <div style={{display:"flex",gap:6,marginBottom:6}}>
                        <input value={smEditReward.emoji} onChange={e=>setSmEditReward(v=>({...v,emoji:e.target.value}))} style={{...INP,width:52,textAlign:"center"}}/>
                        <input value={smEditReward.label} onChange={e=>setSmEditReward(v=>({...v,label:e.target.value}))} placeholder="特典名" style={INP}/>
                      </div>
                      <input value={smEditReward.cost} onChange={e=>setSmEditReward(v=>({...v,cost:e.target.value}))} type="number" placeholder="必要pt" style={{...INP,marginBottom:6}}/>
                      <input value={smEditReward.unit} onChange={e=>setSmEditReward(v=>({...v,unit:e.target.value}))} placeholder="内容説明（例: 30分延長）" style={{...INP,marginBottom:10}}/>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>{
                          const cost=parseInt(smEditReward.cost);
                          if(!smEditReward.label||isNaN(cost)||cost<=0)return;
                          update(d=>({...d,rewards:d.rewards.map(x=>x.id===smEditReward.id?{...smEditReward,cost}:x)}));
                          setSmEditReward(null);
                        }} style={{flex:1,padding:"8px",background:G,border:"none",borderRadius:10,color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>保存</button>
                        <button onClick={()=>setSmEditReward(null)} style={{flex:1,padding:"8px",background:BORDER,border:"none",borderRadius:10,color:MUTED,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>キャンセル</button>
                      </div>
                    </div>
                  ):(
                    <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"10px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                      {/^r0\d$/.test(r.id)?<img src={`/assets/reward_${r.id}.png`} style={{width:30,height:30,objectFit:"contain",borderRadius:6,flexShrink:0}} alt=""/>:<span style={{fontSize:22}}>{r.emoji}</span>}
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13}}>{r.label}</div>
                        <div style={{color:MUTED,fontSize:11}}>{r.cost}pt · {r.unit}</div>
                      </div>
                      <button onClick={()=>setSmEditReward({...r,cost:String(r.cost)})}
                        style={{padding:"4px 10px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:8,color:B,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,marginRight:4}}>編集</button>
                      <button onClick={()=>update(d=>({...d,rewards:d.rewards.filter(x=>x.id!==r.id)}))}
                        style={{padding:"4px 10px",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:8,color:R,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>削除</button>
                    </div>
                  )}
                </div>
              ))}
              {smAddOpen ? (
                <div style={{background:BG,border:`1.5px solid ${G}`,borderRadius:12,padding:"12px 14px",marginBottom:8}}>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>
                    <input value={smREmoji} onChange={e=>setSmREmoji(e.target.value)} style={{...INP,width:52,textAlign:"center"}}/>
                    <input value={smRLabel} onChange={e=>setSmRLabel(e.target.value)} placeholder="特典名" style={INP}/>
                  </div>
                  <input value={smRCost} onChange={e=>setSmRCost(e.target.value)} type="number" placeholder="必要pt（例: 5）" style={{...INP,marginBottom:6}}/>
                  <input value={smRUnit} onChange={e=>setSmRUnit(e.target.value)} placeholder="内容説明（例: 1回）" style={{...INP,marginBottom:10}}/>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{
                      const cost=parseInt(smRCost);
                      if(!smRLabel||isNaN(cost)||cost<=0)return;
                      update(d=>({...d,rewards:[...d.rewards,{id:uid(),emoji:smREmoji,label:smRLabel,cost,unit:smRUnit||"1回"}]}));
                      setSmRLabel("");setSmREmoji("🎁");setSmRCost("5");setSmRUnit("");setSmAddOpen(false);
                    }} style={{flex:1,padding:"8px",background:G,border:"none",borderRadius:10,color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>追加</button>
                    <button onClick={()=>setSmAddOpen(false)} style={{flex:1,padding:"8px",background:BORDER,border:"none",borderRadius:10,color:MUTED,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>キャンセル</button>
                  </div>
                </div>
              ):(
                <button onClick={()=>setSmAddOpen(true)}
                  style={{width:"100%",padding:"12px",background:`${G}15`,border:`2px dashed ${G}`,borderRadius:12,color:G,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                  ＋ 新しいご褒美を追加
                </button>
              )}
            </div>
          )}

          {/* ── メンバー管理タブ ── */}
          {settingsTab==="interest"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 16px"}}>週次利子の設定</p>
              {/* 利子ON/OFF */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>利子システム</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>週1回、残高に利子を付与</div>
                </div>
                <button onClick={()=>update(d=>({...d,interestEnabled:!d.interestEnabled}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:data.interestEnabled?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:data.interestEnabled?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* 利率設定 */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10}}>
                <div style={{fontWeight:800,fontSize:14,color:TEXT,marginBottom:8}}>利率</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                  {[1,2,3,5,10].map(r=>(
                    <button key={r} onClick={()=>update(d=>({...d,interestRate:r/100}))}
                      style={{padding:"6px 14px",border:`1.5px solid ${Math.round((data.interestRate||0.05)*100)===r?G:BORDER}`,
                        borderRadius:10,background:Math.round((data.interestRate||0.05)*100)===r?`${G}20`:"transparent",
                        color:Math.round((data.interestRate||0.05)*100)===r?G:MUTED,
                        fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                      {r}%
                    </button>
                  ))}
                </div>
                <div style={{fontSize:12,color:MUTED}}>
                  現在の利率：<span style={{fontWeight:800,color:G}}>{Math.round((data.interestRate||0.05)*100)}%</span>
                </div>
              </div>
              {/* 対象メンバー別残高と予想利子 */}
              <div style={{background:BG,borderRadius:14,padding:"12px 14px",border:`1.5px solid ${BORDER}`}}>
                <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>次回付与予定（参考）</p>
                {[...data.children,...(data.parents||[])].map(m=>{
                  const b=bal(data.logs,m.id);
                  const interest=data.interestEnabled&&b>0?Math.floor(b*(data.interestRate||0.05)):0;
                  return(
                    <div key={m.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                      <Emo e={m.emoji} size={18}/>
                      <div style={{flex:1,fontWeight:700,fontSize:12,color:TEXT}}>{m.name}</div>
                      <div style={{fontSize:12,color:MUTED}}>{b.toLocaleString()}pt</div>
                      <div style={{fontSize:12,fontWeight:700,color:interest>0?G:MUTED}}>
                        {interest>0?`+${interest}pt`:"−"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {settingsTab==="members"&&(
            <div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>メンバーとPIN管理</p>
              {[{id:"parent",name:"おや管理",emoji:"🔐",isParent:true},...data.children,(data.parents||[])].flat().filter((x,i,a)=>x&&a.findIndex(y=>y&&y.id===x.id)===i).map(m=>{
                if(!m) return null;
                return(
                  <div key={m.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                    <Emo e={m.emoji} size={24}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13}}>{m.name}</div>
                      <div style={{color:MUTED,fontSize:11}}>PIN: {'*'.repeat(4)}</div>
                    </div>
                    <PromptModalButton btnLabel="PIN変更" title={`${m.name}の あたらしい PIN`} desc="4けたの すうじを いれてね" type="number" maxLen={4} placeholder="0000"
                      btnStyle={{padding:"6px 12px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:8,color:B,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}
                      onSubmit={(np)=>{
                        if(!np||np.length!==4){alert("4桁の数字を入力してください");return;}
                        if(m.isParent||m.id==="parent") update(d=>{const{parentPin,...rest}=d;return{...rest,parentPinH:pinHash(np)};});
                        else update(d=>({...d,children:d.children.map(c=>c.id===m.id?(({pin,...r})=>({...r,pinh:pinHash(np)}))(c):c),parents:(d.parents||[]).map(p=>p.id===m.id?(({pin,...r})=>({...r,pinh:pinHash(np)}))(p):p),pinChanged:{...(d.pinChanged||{}),[m.id]:true}}));
                      }}/>
                    {/* 親以外はPINなしトグル */}
                    {!m.isParent&&m.id!=="parent"&&(
                      <button onClick={()=>{
                        const noPinNow = !!(data.noPinIds||{})[m.id];
                        update(d=>({...d,
                          noPinIds:{...(d.noPinIds||{}),[m.id]:!noPinNow},
                          pinChanged:{...(d.pinChanged||{}),[m.id]:true}, // 強制変更スキップ
                          lockEnabled:{...(d.lockEnabled||{}),[m.id]:false}, // lockをOFFに
                        }));
                      }} style={{padding:"6px 12px",
                        background:(data.noPinIds||{})[m.id]?`${R}15`:`${G}15`,
                        border:`1.5px solid ${(data.noPinIds||{})[m.id]?R:G}`,
                        borderRadius:8,color:(data.noPinIds||{})[m.id]?R:G,
                        fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
                        {(data.noPinIds||{})[m.id]?"🔓 PINなし":"🔒 PIN有り"}
                      </button>
                    )}
                  </div>
                );
              })}
              {/* ファミリーコード */}
              <div style={{background:BG,borderRadius:12,padding:"12px 14px",marginTop:8,border:`1.5px solid ${BORDER}`}}>
                <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 4px"}}>ファミリーコード</p>
                <p style={{fontWeight:900,fontSize:16,letterSpacing:3,margin:"0 0 8px"}}>{(()=>{try{return localStorage.getItem("tane_money_family_code")||"---";}catch(e){return "---";}})()}</p>
                <p style={{color:MUTED,fontSize:11,margin:"0 0 10px"}}>このコードを家族に共有してください（全端末で同じであること）</p>
                {/* 今すぐ同期：サーバの最新を強制取得。反映されない時の手動リカバリ＋診断 */}
                <button onClick={async()=>{
                  const r=await forcePullFromCloud();
                  if(!r.ok){ alert(r.err==="no_code"?"ファミリーコードが未設定です。":r.err==="empty"?"サーバにまだデータがありません。":"同期できませんでした（通信を確認）。\n"+(r.err||"")); return; }
                  const kb=Math.round((r.bytes||0)/1024);
                  // サーバの設定系(定義)を取り込む。ログ/進行はローカル(別途同期)を維持。
                  update(d=>({...d,
                    goodTasks:r.data.goodTasks||d.goodTasks, badTasks:r.data.badTasks||d.badTasks,
                    dailyTaskSets:r.data.dailyTaskSets||d.dailyTaskSets, dailyTasks:r.data.dailyTasks||d.dailyTasks,
                    rewards:r.data.rewards||d.rewards, familySettings:{...(d.familySettings||{}),...(r.data.familySettings||{})},
                    children:r.data.children||d.children, parents:r.data.parents||d.parents,
                    activeSetIds:r.data.activeSetIds||d.activeSetIds, activeSetId:r.data.activeSetId||d.activeSetId,
                  }));
                  alert(`✅ 家族の最新を取り込みました（データ量 約${kb}KB）。\nタスクや特典が反映されているか確認してください。`);
                }}
                  style={{width:"100%",padding:"9px",background:`${G}15`,border:`1.5px solid ${G}`,borderRadius:10,color:GP,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F,marginBottom:8}}>
                  🔄 今すぐ同期（家族の最新を取得）
                </button>
                <PromptModalButton btnLabel="🔗 ファミリーコードを変更" title="ファミリーコードを変更" desc="参加したいコードを入力（家族の端末の設定で確認できます）" type="text" maxLen={20} placeholder="TANE-XXXX-XXXX"
                  btnStyle={{width:"100%",padding:"9px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:10,color:B,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,marginBottom:8}}
                  onSubmit={(newCode)=>{
                    if(!newCode)return;
                    const code=newCode.trim().toUpperCase();
                    if(!/^[A-Z0-9\-]{8,20}$/.test(code)){alert("コードの形式が正しくありません（8文字以上の英数字）");return;}
                    if(!confirm(`「${code}」のファミリーに切り替えますか？\n今のファミリーのデータはクラウドに残ります。`))return;
                    try{localStorage.setItem("tane_money_family_code",code);}catch(e){}
                    _familyCode=code;
                    window.location.reload();
                  }}/>
                <button onClick={()=>{
                  if(!confirm("この端末からログアウトしますか？\nファミリーコード入力画面に戻ります。"))return;
                  try{localStorage.removeItem("tane_money_family_code");}catch(e){}
                  _familyCode=null;
                  window.location.reload();
                }} style={{width:"100%",padding:"9px",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:10,color:R,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
                  🚪 この端末からログアウト
                </button>
              </div>
            </div>
          )}

          {/* ── 承認タブ ── */}
          {settingsTab==="approval"&&(()=>{
            const fs=data.familySettings||INIT.familySettings;
            const pending=data.pendingApprovals||[];
            const approve=(entry)=>{
              _processedApprovalIds.add(entry.id);
              const log={id:uid(),cid:entry.cid,type:"good",label:entry.taskLabel,pts:entry.pts,date:new Date().toISOString(),rid:entry.taskId};
              addLogToFirestore(log);
              update(d=>({...d,logs:[log,...d.logs],pendingApprovals:(d.pendingApprovals||[]).filter(p=>p.id!==entry.id)}));
            };
            const reject=(entry)=>{
              _processedApprovalIds.add(entry.id);
              update(d=>({...d,pendingApprovals:(d.pendingApprovals||[]).filter(p=>p.id!==entry.id)}));
            };
            return(<div>
              {/* 💤 休眠アラート（子が数日ログインしていない＝静かな解約の予兆を親に知らせる） */}
              {(()=>{
                const DAY=86400000;const now=Date.now();
                const rows=(data.children||[]).map(c=>{
                  const ls=(data.logs||[]).filter(l=>l.cid===c.id).map(l=>new Date(l.date).getTime());
                  const last=ls.length?Math.max(...ls):0;
                  const days=last?Math.floor((now-last)/DAY):999;
                  return {c,days,ever:!!last};
                });
                const sleeping=rows.filter(r=>r.days>=3);
                if(sleeping.length===0) return null;
                return(<div style={{background:RS,border:`1.5px solid ${R}`,borderRadius:14,padding:"13px 15px",marginBottom:12}}>
                  <div style={{fontWeight:900,fontSize:13,color:R,marginBottom:6}}>💤 しばらく使っていないお子さま</div>
                  {sleeping.map(r=>(
                    <div key={r.c.id} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0"}}>
                      <span style={{fontSize:18}}>{r.c.emoji||"🧒"}</span>
                      <span style={{flex:1,fontWeight:800,fontSize:12.5,color:TEXT}}>{r.c.name}</span>
                      <span style={{fontWeight:900,fontSize:12,color:R}}>{r.ever?`${r.days}日 ログインなし`:"まだ未ログイン"}</span>
                    </div>
                  ))}
                  <div style={{fontSize:10.5,color:TEXTS,fontWeight:700,marginTop:6,lineHeight:1.5}}>声かけのチャンスです。「きょうのミッション」や 推し株を 見に さそってみましょう。学習の連続が途切れる前のひと声が継続のコツです。</div>
                </div>);
              })()}
              {/* 承認モード切り替え */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>タスク承認が必要</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>ONにすると、子どものお手伝い記録を親が承認</div>
                </div>
                <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),requireApproval:!fs.requireApproval}}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:fs.requireApproval?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:fs.requireApproval?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* ガチャ演出をシンプルに（暗転・段階成長をOFF） */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>ガチャ演出をシンプルに</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>ONにすると暗転やタメ演出を省いてすぐ結果に（まぶしさ/待ち時間が苦手な子に）</div>
                </div>
                <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),gachaSimple:!(d.familySettings?.gachaSimple)}}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:(fs.gachaSimple)?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:(fs.gachaSimple)?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* ゲームの強さ設定: ガチャ/バトル/旅をどこまで見せるか */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12}}>
                <div style={{fontWeight:800,fontSize:14,color:TEXT}}>ゲームの強さ</div>
                <div style={{color:MUTED,fontSize:11,marginTop:2,marginBottom:10}}>遊びの要素をどこまで出すか選べます。お金の管理に集中させたいときは「ひかえめ」へ。</div>
                {[
                  {v:"full", t:"ぜんぶ", d:"ガチャ・バトル・とっくんの旅をすべて表示（標準）"},
                  {v:"light",t:"バトル控えめ",d:"ガチャと育成はOK。バトル・とっくんの旅を非表示に"},
                  {v:"money",t:"お小遣い帳中心",d:"ガチャ・バトル・旅・ミッションを隠して、お金の記録に集中"},
                ].map(o=>{
                  const sel=(fs.gameMode||"full")===o.v;
                  return (
                    <button key={o.v} onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),gameMode:o.v}}))}
                      style={{display:"flex",alignItems:"flex-start",gap:10,width:"100%",textAlign:"left",background:sel?GS:CARD,border:sel?`2px solid ${GP}`:`1.5px solid ${BORDER}`,borderRadius:12,padding:"10px 12px",marginBottom:7,cursor:"pointer",fontFamily:F}}>
                      <span style={{marginTop:1,width:18,height:18,borderRadius:"50%",border:sel?`5px solid ${GP}`:`2px solid ${BORDER}`,flexShrink:0,boxSizing:"border-box",background:"#fff"}}/>
                      <span style={{flex:1}}>
                        <span style={{display:"block",fontWeight:800,fontSize:13,color:sel?GP:TEXT}}>{o.t}</span>
                        <span style={{display:"block",fontSize:11,color:MUTED,marginTop:2,lineHeight:1.4}}>{o.d}</span>
                      </span>
                    </button>
                  );
                })}
                {/* 1日のバトル回数(周回しすぎ防止) ※「ぜんぶ」のときだけ有効 */}
                {(fs.gameMode||"full")==="full" && (
                  <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${BORDER}`}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT}}>1日のバトル回数</div>
                    <div style={{color:MUTED,fontSize:11,marginTop:2,marginBottom:8}}>やりすぎ(周回)が気になるときに上限を設定。とっくんの旅は時間でゆっくり進むので対象外です。</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {[{v:0,t:"なし"},{v:3,t:"3回"},{v:5,t:"5回"},{v:10,t:"10回"}].map(o=>{
                        const sel=((fs.dailyBattleLimit)||0)===o.v;
                        return (
                          <button key={o.v} onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),dailyBattleLimit:o.v}}))}
                            style={{flex:1,minWidth:60,background:sel?GP:CARD,border:sel?`2px solid ${GP}`:`1.5px solid ${BORDER}`,borderRadius:10,padding:"8px 4px",color:sel?"#fff":TEXT,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>{o.t}</button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              {/* 投資ワールド設定: 投資のON/OFF・為替だけOFF・1日の売買回数(小中向けに親が手綱を握れる) */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12}}>
                <div style={{fontWeight:800,fontSize:14,color:TEXT}}>🌟 推し株</div>
                <div style={{color:MUTED,fontSize:11,marginTop:2,marginBottom:10}}>好きな会社を「応援」する体験。お金はポイントで、実際のお金は動きません。</div>
                {/* 推し株 ON/OFF */}
                <div style={{display:"flex",alignItems:"center",gap:12,paddingBottom:10,borderBottom:`1px solid ${BORDER}`}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT}}>推し株を見せる</div>
                    <div style={{color:MUTED,fontSize:11,marginTop:2}}>OFFにすると「推し株」を まるごと非表示に</div>
                  </div>
                  <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),investOff:!(d.familySettings?.investOff)}}))}
                    style={{position:"relative",width:48,height:26,borderRadius:13,background:(!fs.investOff)?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s",flexShrink:0}}>
                    <div style={{position:"absolute",top:3,left:(!fs.investOff)?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                  </button>
                </div>
                {/* 為替は株に一本化したため、為替トグルは撤去 */}
                {/* 1日の売買回数(張り付き・回転売買の防止) */}
                {!fs.investOff && (
                  <div style={{marginTop:10}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT}}>1日の売り買い回数</div>
                    <div style={{color:MUTED,fontSize:11,marginTop:2,marginBottom:8}}>何度も売り買い（回転売買）が気になるときに上限を。投資は「待つ」のが学びです。</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {[{v:0,t:"なし"},{v:1,t:"1回"},{v:3,t:"3回"},{v:5,t:"5回"}].map(o=>{
                        const sel=((fs.dailyTradeLimit)||0)===o.v;
                        return (
                          <button key={o.v} onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),dailyTradeLimit:o.v}}))}
                            style={{flex:1,minWidth:56,background:sel?GP:CARD,border:sel?`2px solid ${GP}`:`1.5px solid ${BORDER}`,borderRadius:10,padding:"8px 4px",color:sel?"#fff":TEXT,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>{o.t}</button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {!fs.investOff && (
                  <div style={{marginTop:14,borderTop:`1px dashed ${BORDER}`,paddingTop:12}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT}}>🌱 架空銘柄を調整（学習用）</div>
                    <div style={{color:MUTED,fontSize:11,marginTop:2,marginBottom:8}}>増える/下がる感覚を教える練習用。「上がりやすさ」と「ゆれ」を親が設定できます（実在企業ではありません）。</div>
                    {(data.stocks||[]).filter(s=>s.fake).map(s=>{
                      const setS=(patch)=>update(d=>({...d,stocks:(d.stocks||[]).map(x=>{
                        if(x.id!==s.id) return x;
                        let nx={...x,...patch};
                        if(("bias" in patch)||("power" in patch)){
                          // 設定した方向＆倍率が すぐ見えるよう、その場で価格を動かす（学習用の即時フィードバック）
                          const pw=nx.power||1;
                          let h=(nx.history&&nx.history.length)?nx.history.slice(-30):[nx.price];
                          let last=h[h.length-1]||nx.price; const prev=last;
                          for(let k=0;k<6;k++){ let nv=Math.max(1,Math.round(last*(1+(nx.bias||0)*3*pw))); if(nx.floor&&nv<nx.floor) nv=nx.floor; last=nv; h=[...h,last].slice(-30); }
                          nx={...nx,price:last,history:h,lastChange:Math.round((last-prev)/(prev||1)*1000)/10};
                        }
                        return nx;
                      })}));
                      const BIAS=[{v:-0.004,t:"下げ"},{v:0,t:"横ばい"},{v:0.004,t:"上げ"},{v:0.008,t:"急上昇"}];
                      const VOL=[{v:0.012,t:"小"},{v:0.03,t:"中"},{v:0.05,t:"大"}];
                      const POWER=[{v:1,t:"ふつう"},{v:2,t:"強め"},{v:3,t:"最強"}];
                      return (
                        <div key={s.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"10px 12px",marginBottom:8}}>
                          <div style={{fontWeight:800,fontSize:13,marginBottom:6}}>{s.emoji} {s.name}</div>
                          <div style={{fontSize:11,color:MUTED,marginBottom:3}}>上がりやすさ</div>
                          <div style={{display:"flex",gap:5,marginBottom:7}}>
                            {BIAS.map(o=>{const sel=(s.bias||0)===o.v;return <button key={o.t} onClick={()=>setS({bias:o.v})} style={{flex:1,background:sel?GP:"transparent",border:`1.5px solid ${sel?GP:BORDER}`,borderRadius:8,padding:"5px 0",color:sel?"#fff":TEXT,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>{o.t}</button>;})}
                          </div>
                          <div style={{fontSize:11,color:MUTED,marginBottom:3}}>ゆれ（値動きの大きさ）</div>
                          <div style={{display:"flex",gap:5,marginBottom:7}}>
                            {VOL.map(o=>{const sel=(s.vol||0.03)===o.v;return <button key={o.t} onClick={()=>setS({vol:o.v})} style={{flex:1,background:sel?B:"transparent",border:`1.5px solid ${sel?B:BORDER}`,borderRadius:8,padding:"5px 0",color:sel?"#fff":TEXT,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>{o.t}</button>;})}
                          </div>
                          <div style={{fontSize:11,color:MUTED,marginBottom:3}}>強さ（倍率）— 大きいほど ドカンと動く</div>
                          <div style={{display:"flex",gap:5}}>
                            {POWER.map(o=>{const sel=(s.power||1)===o.v;return <button key={o.t} onClick={()=>setS({power:o.v})} style={{flex:1,background:sel?GOLD:"transparent",border:`1.5px solid ${sel?GOLD:BORDER}`,borderRadius:8,padding:"5px 0",color:sel?"#fff":TEXT,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>{o.t}{o.v>1?`×${o.v}`:""}</button>;})}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {/* 学習特化モード（ゲーム要素をOFF＝学びに集中） */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>学習特化モード</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>畑のゲーム要素（デコ・なでなで・みず・連続ログイン・レベル）を隠して、お金の学びと記録に集中。受験期などに。</div>
                </div>
                <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),studyMode:!(d.familySettings?.studyMode)}}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:(fs.studyMode)?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s",flexShrink:0}}>
                  <div style={{position:"absolute",top:3,left:(fs.studyMode)?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* 承認通知 */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:fs.approvalNotification?8:16,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>承認通知</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>申請が届いたらブラウザ通知でお知らせ</div>
                  {"Notification" in window && Notification.permission==="denied" && (
                    <div style={{color:R,fontSize:11,marginTop:4}}>通知がブロックされています。ブラウザ設定から許可してください</div>
                  )}
                </div>
                <button onClick={async()=>{
                  if(!fs.approvalNotification){
                    if(!("Notification" in window)) return;
                    const perm = await Notification.requestPermission();
                    if(perm==="granted") update(d=>({...d,familySettings:{...(d.familySettings||{}),approvalNotification:true}}));
                  } else {
                    update(d=>({...d,familySettings:{...(d.familySettings||{}),approvalNotification:false}}));
                  }
                }}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:fs.approvalNotification?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:fs.approvalNotification?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {fs.approvalNotification && "Notification" in window && Notification.permission==="granted" && (
                <div style={{background:GS,border:`1.5px solid ${G}`,borderRadius:12,padding:"10px 14px",marginBottom:16,display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:18}}>✅</span>
                  <div>
                    <div style={{fontWeight:700,fontSize:12,color:GP}}>通知の準備ができました！</div>
                    <div style={{fontSize:11,color:MUTED,marginTop:1}}>子どもが申請するとスマホに通知が届きます</div>
                  </div>
                </div>
              )}
              {/* 交換承認が必要 */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>交換承認が必要</div>
                  <div style={{color:MUTED,fontSize:11,marginTop:2}}>ONにすると、報酬の交換を親が承認してからptを消費</div>
                </div>
                <button onClick={()=>update(d=>({...d,familySettings:{...(d.familySettings||{}),rewardApproval:!fs.rewardApproval}}))}
                  style={{position:"relative",width:48,height:26,borderRadius:13,background:fs.rewardApproval?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:fs.rewardApproval?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                </button>
              </div>
              {/* タスク承認待ちキュー */}
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 10px"}}>タスク承認待ち（{pending.length}件）</p>
              {pending.length===0&&<div style={{textAlign:"center",padding:"16px 0",color:MUTED,fontSize:13}}>承認待ちのタスクはありません</div>}
              {pending.map(entry=>{
                const member=[...data.children,...(data.parents||[])].find(m=>m.id===entry.cid);
                return(
                  <div key={entry.id} style={{background:GOLDS,border:`1.5px solid ${GOLD}`,borderRadius:14,padding:"12px 14px",marginBottom:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      <span style={{fontSize:26}}>{entry.taskEmoji}</span>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{entry.taskLabel}</div>
                        <div style={{fontSize:11,color:MUTED}}>{member?.name||"?"} · +{entry.pts}pt</div>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>approve(entry)} style={{flex:1,background:G,border:"none",borderRadius:10,padding:"9px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>✅ 承認</button>
                      <button onClick={()=>reject(entry)} style={{flex:1,background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:10,padding:"9px",color:R,fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>❌ 却下</button>
                    </div>
                  </div>
                );
              })}
              {/* 交換承認待ちキュー */}
              {(()=>{
                const pendingR=data.pendingRedemptions||[];
                const approveR=(entry)=>{
                  if(_processedRedemptionIds.has(entry.id)) return;   // 冪等化＝二重承認/復活後の再承認による二重減算を防ぐ
                  _processedRedemptionIds.add(entry.id);
                  const log={id:uid(),cid:entry.cid,type:"reward",label:`${entry.rewardLabel}（${entry.rewardUnit}）`,pts:-entry.cost,rid:entry.rewardId,date:new Date().toISOString()};
                  addLogToFirestore(log);
                  update(d=>({...d,logs:[log,...d.logs],pendingRedemptions:(d.pendingRedemptions||[]).filter(p=>p.id!==entry.id)}));
                };
                const rejectR=(entry)=>{
                  _processedRedemptionIds.add(entry.id);   // 却下済みも遅延スナップショットで復活させない
                  update(d=>({...d,pendingRedemptions:(d.pendingRedemptions||[]).filter(p=>p.id!==entry.id)}));
                };
                if(pendingR.length===0) return null;
                return(<>
                  <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"16px 0 10px"}}>交換承認待ち（{pendingR.length}件）</p>
                  {pendingR.map(entry=>{
                    const member=[...data.children,...(data.parents||[])].find(m=>m.id===entry.cid);
                    return(
                      <div key={entry.id} style={{background:PS,border:`1.5px solid ${P}`,borderRadius:14,padding:"12px 14px",marginBottom:10}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                          <span style={{fontSize:26}}>{entry.rewardEmoji}</span>
                          <div style={{flex:1}}>
                            <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{entry.rewardLabel}</div>
                            <div style={{fontSize:11,color:MUTED}}>{member?.name||"?"} · {entry.cost}pt</div>
                          </div>
                        </div>
                        <div style={{display:"flex",gap:8}}>
                          <button onClick={()=>approveR(entry)} style={{flex:1,background:G,border:"none",borderRadius:10,padding:"9px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>✅ 承認</button>
                          <button onClick={()=>rejectR(entry)} style={{flex:1,background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:10,padding:"9px",color:R,fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>❌ 却下</button>
                        </div>
                      </div>
                    );
                  })}
                </>);
              })()}
            </div>);
          })()}

          {/* ── 家族目標タブ ── */}
          {settingsTab==="family"&&(()=>{
            const fm=data.familySettings?.familyMission||{enabled:true,label:"みんなの活動で 3,000 pt を育てよう",target:3000,reward:"週末に家族でアイスを選ぶ"};
            const setFm=patch=>update(d=>({...d,familySettings:{...(d.familySettings||{}),familyMission:{...(d.familySettings?.familyMission||{enabled:true,label:"みんなの活動で 3,000 pt を育てよう",target:3000,reward:"週末に家族でアイスを選ぶ"}),...patch}}}));
            return(
              <div>
                <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 16px"}}>家族全員で目指す共通ゴールを設定します</p>
                {/* ON/OFF */}
                <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10,display:"flex",alignItems:"center",gap:12}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:800,fontSize:14,color:TEXT}}>家族目標を表示する</div>
                    <div style={{color:MUTED,fontSize:11,marginTop:2}}>ランキング画面と毎日タブに進捗を表示</div>
                  </div>
                  <button onClick={()=>setFm({enabled:!fm.enabled})}
                    style={{position:"relative",width:48,height:26,borderRadius:13,background:fm.enabled?G:BORDER,border:"none",cursor:"pointer",transition:"background .2s"}}>
                    <div style={{position:"absolute",top:3,left:fm.enabled?24:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                  </button>
                </div>
                {fm.enabled&&<>
                  {/* 目標文 */}
                  <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT,marginBottom:8}}>目標の文章</div>
                    <input value={fm.label} onChange={e=>setFm({label:e.target.value})}
                      placeholder="例：みんなの活動で 3,000 pt を育てよう"
                      style={{...INP,marginBottom:0}}/>
                  </div>
                  {/* 目標pt */}
                  <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT,marginBottom:8}}>目標ポイント</div>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                      {[1000,2000,3000,5000,10000].map(v=>(
                        <button key={v} onClick={()=>setFm({target:v})}
                          style={{padding:"6px 14px",border:`1.5px solid ${fm.target===v?G:BORDER}`,borderRadius:10,background:fm.target===v?`${G}20`:"transparent",color:fm.target===v?G:MUTED,fontWeight:fm.target===v?700:400,fontSize:12,cursor:"pointer",fontFamily:F}}>
                          {v.toLocaleString()}pt
                        </button>
                      ))}
                    </div>
                    <input value={fm.target} onChange={e=>{const v=parseInt(e.target.value);if(!isNaN(v)&&v>0)setFm({target:v});}}
                      type="number" placeholder="カスタム値" style={{...INP,marginBottom:0}}/>
                  </div>
                  {/* 達成報酬 */}
                  <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginBottom:10}}>
                    <div style={{fontWeight:800,fontSize:13,color:TEXT,marginBottom:8}}>達成したらやること</div>
                    <input value={fm.reward} onChange={e=>setFm({reward:e.target.value})}
                      placeholder="例：週末に家族でアイスを選ぶ"
                      style={{...INP,marginBottom:0}}/>
                  </div>
                </>}
              </div>
            );
          })()}

          {/* ── プランタブ（料金・無料体験・解約） ── */}
          {settingsTab==="plan"&&(()=>{
            const sub=data.subscription||{};
            const nKids=Math.max(1,(data.children||[]).length);
            const DAY=86400000;
            const trialStart=sub.trialStart?new Date(sub.trialStart).getTime():null;
            const trialDaysLeft=trialStart?Math.max(0,14-Math.floor((Date.now()-trialStart)/DAY)):null;
            const inTrial=trialDaysLeft!==null&&trialDaysLeft>0&&!sub.active;
            const PLANS=[
              {id:"single",e:"🌱",name:"月額プラン",price:"¥1,100",unit:"/月",sub:"お子さま1人・いつでも解約OK",rec:nKids===1},
              {id:"annual",e:"📅",name:"年額プラン",price:"¥10,560",unit:"/年",sub:"実質 月¥880・2ヶ月分以上おトク",rec:nKids===1},
              {id:"family",e:"👨👩👧👦",name:"ファミリー年額",price:"¥21,120",unit:"/年",sub:"最大4人・4人なら1人1日 約14円",rec:nKids>=2},
            ];
            const setPlan=(id)=>update(d=>({...d,subscription:{...(d.subscription||{}),plan:id}}));
            const startTrial=()=>update(d=>(d.subscription?.trialStart?d:{...d,subscription:{...(d.subscription||{}),trialStart:new Date().toISOString()}}));
            return(<div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 12px"}}>料金プラン・お支払い</p>
              {/* 現在の状態 */}
              <div style={{background:`linear-gradient(135deg,${GS},#fff)`,border:`2px solid ${G}`,borderRadius:16,padding:"16px",marginBottom:14,textAlign:"center"}}>
                {inTrial?(<>
                  <div style={{fontSize:12,color:GP,fontWeight:800,marginBottom:4}}>🎉 無料体験中</div>
                  <div style={{fontSize:24,fontWeight:900,color:GP}}>あと {trialDaysLeft}日</div>
                  <div style={{fontSize:11,color:MUTED,marginTop:6}}>体験中はすべての機能が使えます。体験が終わっても自動課金はされません。</div>
                </>):trialStart?(<>
                  <div style={{fontSize:13,fontWeight:900,color:TEXT,marginBottom:4}}>無料体験は終了しました</div>
                  <div style={{fontSize:11,color:MUTED}}>下のプランから選んでご継続いただけます。</div>
                </>):(<>
                  <div style={{fontSize:13,color:TEXT,fontWeight:800,marginBottom:8}}>まずは14日間 無料でお試し</div>
                  <div style={{fontSize:11,color:MUTED,marginBottom:12}}>クレジットカード登録不要・自動課金なし。お子さまが続くか見てから決められます。</div>
                  <button onClick={startTrial} style={{background:GP,border:"none",borderRadius:12,padding:"11px 28px",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F}}>14日間の無料体験を始める</button>
                </>)}
              </div>
              {/* おすすめバッジ付きプラン一覧 */}
              <div style={{fontSize:11,fontWeight:800,color:TEXTS,margin:"0 0 8px"}}>お子さま{nKids}人のご家庭におすすめのプラン</div>
              <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
                {PLANS.map(p=>{const sel=sub.plan===p.id;return(
                  <button key={p.id} onClick={()=>setPlan(p.id)}
                    style={{textAlign:"left",background:sel?GS:CARD,border:`2px solid ${sel?G:p.rec?GOLD:BORDER}`,borderRadius:14,padding:"12px 14px",cursor:"pointer",fontFamily:F,display:"flex",alignItems:"center",gap:12,position:"relative"}}>
                    <span style={{fontSize:24,flexShrink:0}}>{p.e}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontWeight:900,fontSize:14,color:TEXT}}>{p.name}</span>
                        {p.rec&&<span style={{fontSize:9,fontWeight:900,color:"#7a5a00",background:GOLDS,borderRadius:6,padding:"1px 6px"}}>おすすめ</span>}
                        {sel&&<span style={{fontSize:9,fontWeight:900,color:"#fff",background:G,borderRadius:6,padding:"1px 6px"}}>選択中</span>}
                      </div>
                      <div style={{fontSize:10.5,color:MUTED,fontWeight:700,marginTop:2}}>{p.sub}</div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <span style={{fontWeight:900,fontSize:16,color:GP}}>{p.price}</span>
                      <span style={{fontSize:10,color:MUTED,fontWeight:700}}>{p.unit}</span>
                    </div>
                  </button>
                );})}
              </div>
              {/* 購入導線（Stripe Checkout。バックエンド未設定なら正直に案内） */}
              <button disabled={!sub.plan||planBusy} onClick={async()=>{
                if(!sub.plan)return; setPlanMsg(""); setPlanBusy(true);
                try{
                  const code=taneFamilyCode();
                  const r=await taneApi("checkout",{plan:sub.plan,familyCode:code});
                  if(r.url){ window.location.href=r.url; return; }
                  if(r.error==="billing_not_configured"||r.error==="price_not_configured"||r.status===503)
                    setPlanMsg("オンライン決済は近日対応予定です。現在は無料でご利用いただけます。");
                  else setPlanMsg("手続きを開始できませんでした。時間をおいてお試しください。");
                }catch(e){ setPlanMsg("オンライン決済は近日対応予定です。現在は無料でご利用いただけます。"); }
                setPlanBusy(false);
              }}
                style={{width:"100%",padding:"13px",background:sub.plan&&!planBusy?GP:BORDER,border:"none",borderRadius:12,color:"#fff",fontWeight:800,fontSize:14,cursor:sub.plan&&!planBusy?"pointer":"default",fontFamily:F,marginBottom:8}}>
                {planBusy?"処理中…":sub.plan?"このプランで購入手続きへ":"プランを選んでください"}
              </button>
              {planMsg&&<div style={{background:BS,border:`1px solid ${B}`,borderRadius:10,padding:"9px 12px",marginBottom:8}}>
                <div style={{fontSize:10.5,color:B,fontWeight:800,lineHeight:1.5}}>{planMsg}</div>
              </div>}
              <div style={{fontSize:10,color:MUTED,fontWeight:700,lineHeight:1.5,marginBottom:12}}>※ 14日間は無料体験。トライアル終了までは課金されません。正式リリース時に選択中のプランをそのまま引き継げます。</div>
              {/* 保護者の端末で通知を受け取る（サーバープッシュ登録） */}
              <button onClick={async()=>{
                setPlanMsg("");
                const pt=await taneGetPushToken();
                const me=(data.parents||[])[0];
                if(pt.ok&&me){ update(d=>({...d,pushTokens:{...(d.pushTokens||{}),[me.id]:{token:pt.token,role:"parent",name:me.name||"保護者",ts:Date.now()}}})); setPlanMsg("保護者の端末で通知を受け取ります🔔（お子さまが数日使わないとお知らせします）"); }
                else if(pt.reason==="no_vapid") setPlanMsg("プッシュ通知は近日対応予定です（現在は承認タブの休眠アラートでご確認いただけます）。");
                else if(pt.reason==="denied") setPlanMsg("通知がブロックされています。端末の設定から許可してください。");
                else setPlanMsg("通知を登録できませんでした。");
              }} style={{width:"100%",padding:"11px",background:BS,border:`1.5px solid ${B}`,borderRadius:12,color:B,fontWeight:800,fontSize:12.5,cursor:"pointer",fontFamily:F,marginBottom:12}}>
                🔔 保護者の端末で「休眠お知らせ」を受け取る
              </button>
              {/* 解約・支払い管理 */}
              <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"11px 14px"}}>
                <div style={{fontWeight:800,fontSize:12,color:TEXT,marginBottom:3}}>解約・お支払い管理</div>
                <div style={{fontSize:10.5,color:MUTED,fontWeight:700,lineHeight:1.5,marginBottom:8}}>いつでも解約できます（解約後も期間終了までは利用可能）。違約金や最低利用期間はありません。学んだ記録・級は解約後も残ります。</div>
                <button onClick={async()=>{
                  setPlanMsg("");
                  const code=taneFamilyCode();
                  const r=await taneApi("portal",{familyCode:code});
                  if(r.url){ window.location.href=r.url; return; }
                  if(r.error==="no_customer") setPlanMsg("現在は無料体験中です（解約手続きは課金開始後にご利用いただけます）。");
                  else setPlanMsg("お支払い管理は近日対応予定です。");
                }} style={{width:"100%",padding:"9px",background:"transparent",border:`1.5px solid ${BORDER}`,borderRadius:10,color:TEXTS,fontWeight:800,fontSize:11.5,cursor:"pointer",fontFamily:F}}>
                  お支払い・解約の管理ページへ
                </button>
              </div>
            </div>);
          })()}

          {/* ── 引き継ぎタブ ── */}
          {settingsTab==="transfer"&&(()=>{
            const code=(()=>{try{return localStorage.getItem(FAMILY_CODE_KEY)||"---";}catch(e){return"---";}})();
            return(<div>
              <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:"0 0 16px"}}>スマホ引き継ぎ・共有</p>
              {/* ファミリーコード表示 */}
              <div style={{background:`linear-gradient(135deg,${GS},#fff)`,border:`2px solid ${G}`,borderRadius:16,padding:"20px",textAlign:"center",marginBottom:16}}>
                <div style={{fontSize:12,color:MUTED,fontWeight:700,marginBottom:8}}>あなたのファミリーコード</div>
                <div style={{fontWeight:900,fontSize:28,letterSpacing:4,color:GP,marginBottom:8}}>{code}</div>
                <div style={{fontSize:11,color:MUTED,marginBottom:14}}>このコードを新しいスマホや家族に共有してください</div>
                <button onClick={()=>{try{navigator.clipboard.writeText(code);}catch(e){}setCopied(true);setTimeout(()=>setCopied(false),2000);}}
                  style={{background:copied?G:GP,border:"none",borderRadius:12,padding:"10px 28px",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F,transition:"background .3s"}}>
                  {copied?"✅ コピーしました！":"📋 コードをコピー"}
                </button>
              </div>
              {/* 手順説明 */}
              <div style={{background:BG,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px"}}>
                <p style={{fontWeight:800,fontSize:13,color:TEXT,margin:"0 0 10px"}}>📱 新しいスマホへの引き継ぎ手順</p>
                {[["1","新しいスマホでTane Moneyを開く"],["2","「すでにコードがある」をタップ"],["3","上のコードを入力"],["4","データが同期される"]].map(([n,t])=>(
                  <div key={n} style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:8}}>
                    <div style={{width:22,height:22,borderRadius:"50%",background:GP,color:"#fff",fontWeight:800,fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{n}</div>
                    <div style={{fontSize:12,color:TEXT,lineHeight:1.6,paddingTop:2}}>{t}</div>
                  </div>
                ))}
              </div>
              {/* データエクスポート */}
              <div style={{background:BG,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"14px 16px",marginTop:14}}>
                <p style={{fontWeight:800,fontSize:13,color:TEXT,margin:"0 0 8px"}}>📊 データをエクスポート</p>
                <p style={{fontSize:11,color:MUTED,margin:"0 0 12px"}}>全ログをCSVファイルでダウンロードできます（Excel対応）</p>
                <button onClick={()=>{
                  const rows=[["日付","子ども","種別","内容","pt"]];
                  (data.logs||[]).forEach(l=>{
                    const c=(data.children||[]).find(x=>x.id===l.cid);
                    rows.push([(l.date||"").slice(0,10),c?.name||"",l.type,l.label||"",l.pts||0]);
                  });
                  const csv=rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(",")).join("\n");
                  const blob=new Blob([""+csv],{type:"text/csv;charset=utf-8"});
                  const url=URL.createObjectURL(blob);
                  const a=document.createElement("a");
                  a.href=url;a.download=`tane-money-${new Date().toISOString().slice(0,7)}.csv`;
                  document.body.appendChild(a);a.click();document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }} style={{width:"100%",padding:"11px",background:`${B}15`,border:`1.5px solid ${B}`,borderRadius:12,color:B,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                  ⬇ CSVダウンロード
                </button>
              </div>
              {/* ログアウト */}
              <button onClick={()=>{
                if(!confirm("この端末からログアウトしますか？\nコードを入力すれば再びアクセスできます。"))return;
                try{localStorage.removeItem(FAMILY_CODE_KEY);}catch(e){}
                _familyCode=null;window.location.reload();
              }} style={{width:"100%",padding:"11px",background:`${R}15`,border:`1.5px solid ${R}`,borderRadius:12,color:R,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F,marginTop:14}}>
                🚪 この端末からログアウト
              </button>
            </div>);
          })()}
        </div>
      </div>
    </div>
  );
}


// 履歴の1行。取り消しは誤タップ防止のため2タップ確認制(ポイントの増減操作なので慎重に)
function LogRow({ l, emoji, canDelete, child, update, showFlash }){
  const [confirm,setConfirm]=useState(false);
  const [dx,setDx]=useState(0);                 // 左スワイプ量(iOS風・負値で開く)
  const t=useRef({x:0,y:0,base:0,lock:null});
  const OPEN=-86;
  const deleteLog=()=>{
    const rev={id:uid(),cid:child.id,type:"grant",label:`🗑 取り消し: ${l.label}`,pts:-l.pts,date:new Date().toISOString()};
    addLogToFirestore(rev);
    update(d=>({...d,logs:[rev,...d.logs]}));
    showFlash(-l.pts,"🗑");
    setConfirm(false); setDx(0);
  };
  const onStart=e=>{ if(!canDelete)return; const tt=e.touches[0]; t.current={x:tt.clientX,y:tt.clientY,base:dx,lock:null}; };
  const onMove=e=>{ if(!canDelete)return; const tt=e.touches[0]; const ddx=tt.clientX-t.current.x, ddy=tt.clientY-t.current.y;
    if(t.current.lock===null && (Math.abs(ddx)>6||Math.abs(ddy)>6)) t.current.lock=Math.abs(ddx)>Math.abs(ddy)?"x":"y";
    if(t.current.lock==="x") setDx(Math.max(OPEN,Math.min(0,t.current.base+ddx))); };
  const onEnd=()=>{ if(t.current.lock==="x") setDx(dx<OPEN/2?OPEN:0); t.current.lock=null; };
  return(
    <div style={{position:"relative",marginBottom:8,borderRadius:14,overflow:"hidden"}}>
      {canDelete&&(
        <div style={{position:"absolute",inset:0,display:"flex",justifyContent:"flex-end"}}>
          <button onClick={deleteLog} style={{width:86,border:"none",background:R,color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>取り消す</button>
        </div>
      )}
      <div onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onClick={()=>{ if(dx!==0) setDx(0); }}
        style={{position:"relative",background:CARD,border:`1.5px solid ${(confirm||dx!==0)?R:BORDER}`,borderRadius:14,padding:"11px 13px",display:"flex",alignItems:"center",gap:10,transform:`translateX(${dx}px)`,transition:t.current.lock==="x"?"none":"transform .22s",touchAction:"pan-y"}}>
        <span style={{fontSize:20}}>{emoji}</span>
        <div style={{flex:1,minWidth:0}}><div style={{fontWeight:700,fontSize:13}}>{l.label}</div><div style={{color:MUTED,fontSize:11}}>{fmtDate(l.date)}</div></div>
        <Pt v={l.pts}/>
        {canDelete&&(confirm
          ? <div style={{display:"flex",gap:5,flexShrink:0}}>
              <button onClick={deleteLog} style={{background:R,border:"none",borderRadius:9,minWidth:60,height:38,color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>取り消す</button>
              <button onClick={()=>setConfirm(false)} style={{background:CARDS,border:`1px solid ${BORDER}`,borderRadius:9,minWidth:44,height:38,color:TEXTS,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>やめる</button>
            </div>
          : <button onClick={()=>setConfirm(true)} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:MUTED,width:44,height:44,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} title="取り消し">🗑</button>)}
      </div>
    </div>
  );
}

function ChildScreen({ child, data, update, onBack, onFamily }) {
  const [tab, setTab]   = useState("daily");
  // 背景テーマ解決（累計タスクで解放。未解放/autoならデフォルト時間帯背景）
  const _cTotalDone = (data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="good"||l.type==="daily")).length;
  const totalDoneMon = _cTotalDone;   // もっとタブ(背景/隠しモンスター)の解放判定で使用
  const _bgTid      = (data.bgTheme||{})[child.id] || "auto";   // 背景きせかえの選択中判定で使用
  const _cBgTheme   = BG_THEMES.find(t=>t.id===_bgTid) || BG_THEMES[0];
  const _cBgUnlock  = (_cBgTheme.need||0) <= _cTotalDone;
  const heroGrad    = (_cBgUnlock && _cBgTheme.grad) ? _cBgTheme.grad : null;
  const heroImg     = (_cBgUnlock && _cBgTheme.img) ? _cBgTheme.img : null;
  const heroStars   = _cBgUnlock && _cBgTheme.stars;
  const [flash, setFlash] = useState(null);
  const [pressed, setPressed] = useState({});
  const [scrollY, setScrollY] = useState(0);   // iOS風 大きいタイトルのスクロール縮小用
  const [showTips, setShowTips] = useState(false);   // まめちしき(旧・学ぶタブ)を毎日タブ内で開閉
  // スクロール縮小演出。rAFで1フレーム1回に間引き＋56pxでクランプ＋同値なら更新しない。
  // ※旧実装は毎スクロールイベントで巨大ChildScreen全体を再描画し、慣性スクロール中にログ全走査が多発してカクついた。
  useEffect(()=>{ let raf=0;
    const on=()=>{ if(raf) return; raf=requestAnimationFrame(()=>{ raf=0; const y=Math.min(56,window.scrollY||0); setScrollY(prev=> prev===y?prev:y); }); };
    window.addEventListener("scroll",on,{passive:true});
    return ()=>{ window.removeEventListener("scroll",on); if(raf) cancelAnimationFrame(raf); };
  },[]);
  const [gachaRes, setGachaRes] = useState(null);
  const gachaBusyRef = useRef(false);   // ガチャ連打ガード(0.1秒更新中の二重発火/多重回しを防止)
  const [rewardPop, setRewardPop] = useState(null);
  const [showWeekly, setShowWeekly] = useState(false);
  const [showCustomizer, setShowCustomizer] = useState(false);
  const [goalCelebration, setGoalCelebration] = useState(null);
  const [actTab, setActTab] = useState("tasks");
  const [moreOpen, setMoreOpen] = useState(false);
  const [monTab, setMonTab] = useState("goals");
  const [worldFull, setWorldFull] = useState(false);   // 🏙 投資ワールドを別ページ(全画面)で開く
  const [taskSort, setTaskSort] = useState("default");
  const [rewardSort, setRewardSort] = useState("default");
  const [logSort, setLogSort] = useState("new");
  const [showSettings, setShowSettings] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showZukan, setShowZukan] = useState(false);
  const [showBattle, setShowBattle] = useState(false);
  const [showNews, setShowNews] = useState(false);
  const [showExped, setShowExped] = useState(false);
  // (削除) nowTs は一度も参照されない死んだstateで、20秒ごとに巨大ChildScreen全体を無意味に再描画していた。
  const [newsSeen, setNewsSeen] = useState(()=>{try{return localStorage.getItem("tane_news_seen")||"";}catch(e){return "";}});
  const hasNews = NEWS.length>0 && newsSeen!==NEWS[0].id;
  const openNews = ()=>{ setShowNews(true); try{localStorage.setItem("tane_news_seen",NEWS[0].id);}catch(e){} setNewsSeen(NEWS[0].id); };

  const ageMode  = child.ageMode || "middle";
  const young    = ageMode === "young";
  const isJunior = child.displayMode === "junior"; // Junior/Teenモード分岐
  // 「ためる」タブのセグメントが非表示化(投資OFF/junior/young)されたのにmonTabがそれを指したままだと
  // コンテンツが1つも描画されず真っ白になる。表示可能な先頭"goals"へフォールバックする。
  useEffect(()=>{
    if(monTab==="oshi" && data.familySettings?.investOff) setMonTab("goals");
    else if(monTab==="kakeibo" && isJunior) setMonTab("goals");   // kakeibo非表示はjuniorのみ。youngは使い道タブを使える(バウンスさせない)
  },[data.familySettings?.investOff, monTab, isJunior]);
  // 保護者のゲーム強度設定(familySettings.gameMode): full=全部 / light=ガチャ育成はOKだがバトル・旅オフ / money=お小遣い帳中心(ゲーム要素オフ)
  const gameMode    = (data.familySettings?.gameMode) || "full";
  const showGacha   = gameMode !== "money";   // デイリーガチャ
  const showBattleF = false;    // モンスターバトルは撤去（別アプリ化のため docs/battle_system_spec.md に保存）。gameModeは他UIで使用
  const showExpedF  = false;    // とっくんの旅は撤去（純化）。gameModeは他UIで使用
  const showMissions= gameMode !== "money";   // きょうのミッション
  const thisMonth = new Date().toISOString().slice(0,7);
  const monthDelta = (data.logs||[]).filter(l=>l.cid===child.id&&(l.date||"").startsWith(thisMonth)).reduce((s,l)=>s+l.pts,0);
  // 🌱 これまでにためた合計（累計・リセットしないのがうちの強み。競合の要望上位を先取り）
  const lifetimeEarned = (data.logs||[]).filter(l=>l.cid===child.id&&l.pts>0).reduce((s,l)=>s+l.pts,0);
  const myBal    = bal(data.logs, child.id);
  const myLogs   = (data.logs||[]).filter(l=>l.cid===child.id);
  // ── レベルアップ検知→演出＆報酬(回復カプセル。ptは配らない) ──
  const _mLv = monLevel((data.monsterExp||{})[child.id]||0).lv;
  const [lvPop,setLvPop]=useState(null);
  useEffect(()=>{
    const seen = data.monsterLevelSeen?.[child.id];
    if(seen===undefined){ update(d=> (d.monsterLevelSeen?.[child.id]!==undefined ? d : {...d, monsterLevelSeen:{...(d.monsterLevelSeen||{}),[child.id]:_mLv}}) ); return; }
    if(_mLv>seen){
      // バトル撤去により回復アイテム報酬は廃止。レベルアップは「おめでとう」演出のみ。
      update(d=>{
        const cur=(d.monsterLevelSeen||{})[child.id]; if(cur!==undefined && cur>=_mLv) return d;
        return {...d, monsterLevelSeen:{...(d.monsterLevelSeen||{}),[child.id]:_mLv}};
      });
      setLvPop({to:_mLv});
      setTimeout(()=>setLvPop(null),3600);
    }
  // eslint-disable-next-line
  },[_mLv]);
  const todayDone= data.gachaDate?.[child.id] === todayKey();
  const curStreak= data.streak?.[child.id]?.cur || 0;
  const doneTodayIds = new Set(myLogs.filter(l=>l.rid&&isTodayLocal(l.date)).map(l=>l.rid));
  const todayTaskDone = myLogs.some(l=>l.type==="good"&&isTodayLocal(l.date));

  // Apply interest on open
  useEffect(()=>{ applyInterest(data,update,child.id); applyHoldingBonus(data,update,child.id); fetchRealStockPrices(data,update); },[]);

  const showFlash = (pts, emoji) => {
    taneHaptic(pts>=0?"success":"warn");
    setFlash({pts,emoji,cheer:pts>0?taneCheer():null}); setTimeout(()=>setFlash(null),1200);
  };

  const addLog = (entry) => {
    // ログはlogsサブコレクションが唯一の正＝Firestoreにも必ず送る。
    // ※旧実装はローカルd.logsに積むだけでaddLogToFirestore未呼び出し。承認不要のごほうび交換(doRedeem)の
    //   ポイント減算が他端末に伝播せず、300件超のslim化でcarryに畳まれて減算が恒久消失＝残高水増しになっていた。
    const log = { id:uid(), date:new Date().toISOString(), ...entry };
    update(d => ({ ...d, logs: [log, ...d.logs] }));
    addLogToFirestore(log);
  };

  const doTask = task => {
    if(pressed[task.id]) return;   // 連打ガード(二重記録＆巨大state連続再描画でのフリーズ防止)
    const basePts = taskPts(task, child.id);
    // 転生ボーナス適用
    const reincBonus = data.reincarnationBonus?.[child.id];
    const reincActive = reincBonus && new Date().toISOString() < reincBonus.until;
    const pts = (reincActive && basePts > 0) ? Math.round(basePts * (1 + reincBonus.rate)) : basePts;
    const fs = data.familySettings || INIT.familySettings;
    const needApproval = fs.requireApproval && pts > 0;
    const alreadyPending = (data.pendingApprovals||[]).some(p=>p.cid===child.id&&p.taskId===task.id);
    if(alreadyPending) return;
    setPressed(p=>({...p,[task.id]:true}));
    setTimeout(()=>setPressed(p=>{const n={...p};delete n[task.id];return n;}),500);
    if(needApproval) {
      setFlash({pts:0,emoji:"⏳",pending:true});
      setTimeout(()=>setFlash(null),1400);
      const entry={id:uid(),cid:child.id,taskId:task.id,taskLabel:task.label,taskEmoji:task.emoji,pts,date:new Date().toISOString()};
      update(d=>({...d,pendingApprovals:[...(d.pendingApprovals||[]),entry]}));
      if(fs.approvalNotification && "Notification" in window && Notification.permission==="granted"){
        try{new Notification("承認リクエスト 📬",{body:`${child.name}が「${task.label}」を完了しました（+${pts}pt）`,icon:"/assets/tab_daily.png"});}catch(e){}
      }
    } else {
      showFlash(pts, task.emoji);
      // ログ追加＋お手伝いEXP(毎回フラット・日次上限のみ)を1回のupdateに統合(再描画を半減)
      update(d=>{
        const e={ id:uid(), date:new Date().toISOString(), cid:child.id, type: pts>=0?"good":"bad", label:task.label, pts, rid:task.id };
        const withLog={...d, logs:[e, ...d.logs]};
        if(pts>0){ return careCap(withLog,child.id,0.25,Math.max(1,pts)); }
        return withLog;
      });
    }
  };

  const doRedeem = r => {
    if(!txGuard("redeem_"+child.id+"_"+r.id)) return;   // 連打ガード(二重交換/二重消費防止)
    setRewardPop(null);
    const _rfs = data.familySettings || INIT.familySettings;
    if(_rfs.rewardApproval) {
      const entry={id:uid(),cid:child.id,rewardId:r.id,rewardEmoji:r.emoji,rewardLabel:r.label,rewardUnit:r.unit,cost:r.cost,date:new Date().toISOString()};
      update(d=>({...d,pendingRedemptions:[...(d.pendingRedemptions||[]),entry]}));
      setFlash({pts:0,emoji:"⏳",pending:true});
      setTimeout(()=>setFlash(null),1400);
    } else {
      showFlash(-r.cost, r.emoji);
      addLog({ cid:child.id, type:"reward", label:`${r.label}（${r.unit}）`, pts:-r.cost, rid:r.id });
    }
  };

  const hasTicket = (data.battleTickets?.[child.id]||0) > 0;
  // 🌱 まいにちのタネ（ログインボーナス）：ランダム・レア・チケットを廃止し射幸性カット。
  //   毎日ひらく理由(開ける演出)は維持。ポイントは固定＋連続日数で少し増える。図鑑は順番に解放。
  const doGacha = () => {
    if (gachaBusyRef.current) return;   // 連打ガード
    if (todayDone) return;              // 1日1回のみ
    gachaBusyRef.current = true;
    const today = todayKey();
    const prev  = data.streak?.[child.id] || { cur:0, max:0, last:"" };
    const yesterday = (()=>{ const d=new Date(); d.setDate(d.getDate()-1); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; })();
    const newCur = prev.last===yesterday ? prev.cur+1 : 1;
    const base = 5;
    const bonus = newCur>=30?15 : newCur>=14?10 : newCur>=7?5 : newCur>=3?3 : 0;   // 連続でちょいプラス(煽りなし)
    const dayPts = base + bonus;
    const theme = getMonthTheme();
    // 図鑑コレクション：ランダムをやめ「まだ持ってないものを順番に」解放（毎日コツコツ集まる）
    const owned = data.gachaCollection?.[child.id] || {};
    const collItem = GACHA_ITEMS.find(i=>!owned[i.id]) || null;
    const isNewItem = !!collItem;
    const todayTasks = myLogs.filter(l=>(l.type==="good"||l.type==="daily")&&isTodayLocal(l.date)).length;
    const finalRes = { id:"daily", label:"まいにちのタネ", rate:30, pts:dayPts, bonusPts:bonus, theme, collItem, isNewItem, todayTasks, streakDay:newCur, simpleAnim:!!(data.familySettings?.gachaSimple) };
    setGachaRes(finalRes);
    taneHaptic("success");
    update(d => ({
      ...d,
      logs: (()=>{ const _e={ id:uid(), cid:child.id, type:"gacha", label:`🌱 まいにちのタネ（+${dayPts}pt${bonus>0?` ・連続${newCur}日`:""}）`, pts:dayPts, date:new Date().toISOString(), tierId:"daily", collItemId:collItem?.id }; addLogToFirestore(_e); return[_e,...d.logs]; })(),
      gachaDate: {...(d.gachaDate||{}), [child.id]: today},
      streak: {...(d.streak||{}), [child.id]: { cur:newCur, max:Math.max(prev.max||0,newCur), last:today }},
      gachaCollection: collItem ? {...(d.gachaCollection||{}), [child.id]: {...(d.gachaCollection?.[child.id]||{}), [collItem.id]:((d.gachaCollection?.[child.id]?.[collItem.id]||0)+1)}} : (d.gachaCollection||{}),
    }));
  };

  // Kakeibo state
  const [kTab,  setKTab]  = useState("graph");
  const [kMonth,setKMonth]= useState(monthKey());
  const [kForm, setKForm] = useState({catId:"cat1",label:"",amt:""});
  const [kAdd,  setKAdd]  = useState(false);

  const kExps = (data.expenses||[]).filter(e=>e.cid===child.id&&(e.date||"").startsWith(kMonth));
  const kCatData = (data.cats||[]).map(cat=>({ ...cat, v:kExps.filter(e=>e.catId===cat.id).reduce((s,e)=>s+e.amt,0) })).filter(c=>c.v>0).sort((a,b)=>b.v-a.v);
  const kTotal = kExps.reduce((s,e)=>s+e.amt,0);
  const kLife  = (data.expenses||[]).filter(e=>e.cid===child.id).reduce((s,e)=>s+e.amt,0);
  const kMax   = kCatData[0]?.v||1;

  const addExpense = () => {
    const amt=parseInt(kForm.amt); if(!kForm.label||isNaN(amt)||amt<=0)return;
    markLocalUserDataEdit('expenses');
    update(d=>({...d,expenses:[{id:uid(),cid:child.id,catId:kForm.catId,label:kForm.label,amt,date:new Date().toISOString()},...(d.expenses||[])]}));
    setKForm({catId:"cat1",label:"",amt:""}); setKAdd(false);
  };
  const delExpense = id => { markLocalUserDataEdit('expenses'); update(d=>({...d,expenses:(d.expenses||[]).filter(e=>e.id!==id)})); };

  // Goals
  const [gForm,setGForm]=useState({emoji:"🎯",label:"",target:""});
  const [gAdd,setGAdd]=useState(false);
  const myGoals = (data.goals||[]).filter(g=>g.cid===child.id);

  const addGoal = () => {
    const t=parseInt(gForm.target); if(!gForm.label||isNaN(t)||t<=0)return;
    markLocalUserDataEdit('goals');
    update(d=>({...d,goals:[...( d.goals||[]),{id:uid(),cid:child.id,emoji:gForm.emoji,label:gForm.label,target:t,done:false}]}));
    setGForm({emoji:"🎯",label:"",target:""}); setGAdd(false);
  };
  const markGoal = id => {
    const g=(data.goals||[]).find(x=>x.id===id);
    markLocalUserDataEdit('goals');
    update(d=>({...d,goals:(d.goals||[]).map(x=>x.id===id?{...x,done:true,doneDate:new Date().toISOString()}:x)}));
    if(g) setGoalCelebration(g);
  };
  const delGoal  = id => { markLocalUserDataEdit('goals'); update(d=>({...d,goals:(d.goals||[]).filter(g=>g.id!==id)})); };

  // MyTasks filter（マイタスクリスト＝メンバー専用リスト）
  // ・自分の専用リストがある→そのタスクだけ表示
  // ・空→「誰の専用リストにも入っていない共有タスク」だけ表示（他メンバー専用のタスクは出さない＝家族に漏れない）
  const myIds = (data.myTaskIds||{})[child.id]||[];
  const hasFilter = myIds.length>0;
  const _assignedElsewhere = (()=>{ const s=new Set(); Object.entries(data.myTaskIds||{}).forEach(([mid,ids])=>{ if(mid!==child.id)(ids||[]).forEach(id=>s.add(id)); }); return s; })();
  const _taskVisible = t => hasFilter ? myIds.includes(t.id) : !_assignedElsewhere.has(t.id);
  const filtGood = (data.goodTasks||[]).filter(_taskVisible);
  const filtBad  = (data.badTasks||[]).filter(_taskVisible);
  const sortTaskFn = (a,b) =>
    taskSort==="pts_high"?Math.abs(taskPts(b,child.id))-Math.abs(taskPts(a,child.id)):
    taskSort==="pts_low"?Math.abs(taskPts(a,child.id))-Math.abs(taskPts(b,child.id)):
    taskSort==="name"?a.label.localeCompare(b.label,"ja"):0;

  // 4-tab grouped nav（学ぶは独立タブをやめ「毎日」内に差し込み＝North StarのシンプルIA）
  const MAIN_TABS = isJunior
    ? [["daily","📋 まいにち"],["tasks","✅ やること"],["goals","🌱 ためる"]]
    : [["daily","毎日"],["activity","活動"],["money","ためる"],["more","記録"]];
  // 新タブ体系マッピング（旧→新）
  const tabAlias = {
    tasks:"activity", invest:"money", kakeibo:"money",
    goals:"money", rewards:"money", log:"more",
    badges:"more", tips:"more", ranking:"more", gacha:"daily", learn:"daily"
  };
  const effectiveTab = tabAlias[tab] || tab;
  // タブ画像の事故時フォールバック（全タブ🐣化＝IA崩壊を防ぐ・タブごとに個別の絵文字）
  const TAB_FB = {daily:"☀",activity:"✅",money:"🌱",learn:"📖",more:"🏅",tasks:"✅",goals:"🎯"};
  const darkBG = !isJunior; // teen/adultはダークモード

  return (
    <div style={{minHeight:"100vh",background:darkBG?"#040810":BG,fontFamily:F,paddingBottom:80}}>
      {/* ヒーローエリア */}
      {isJunior ? (()=>{
        const h=new Date().getHours();
        const bgAuto=h>=7&&h<11
          ?"linear-gradient(180deg,#1a0a00 0%,#7c2d00 25%,#c2612a 50%,#e8a06a 70%,#2d6a3a 100%)"
          :h>=11&&h<17
          ?"linear-gradient(180deg,#0a2a4a 0%,#1a5c8a 30%,#2a8a5a 65%,#1f7038 100%)"
          :h>=17&&h<20
          ?"linear-gradient(180deg,#1a0a20 0%,#6b2d00 20%,#c25a1a 45%,#7b3a8a 65%,#1a4a28 100%)"
          :h>=20&&h<22
          ?"linear-gradient(180deg,#050d1a 0%,#0a1a30 35%,#0d2a1a 65%,#164a28 100%)"
          :"linear-gradient(180deg,#020508 0%,#050d10 40%,#0a1a10 70%,#0f3020 100%)";
        const bg = heroImg ? `linear-gradient(180deg,rgba(6,10,18,.5) 0%,rgba(6,10,18,.12) 38%,rgba(6,10,18,.42) 100%), url(${heroImg}) center top/cover no-repeat` : (heroGrad || bgAuto);
        const starOpacity=h>=7&&h<17?0.2:0.6;
        return(
      <div style={{background:bg,position:"relative",overflow:"hidden",paddingBottom:0}}>
        {[[10,15],[25,8],[70,12],[85,6],[50,22],[38,4],[62,18],[15,30]].map(([l,t],i)=>(
          <div key={i} style={{position:"absolute",top:`${t}%`,left:`${l}%`,width:i%3===0?3:2,height:i%3===0?3:2,borderRadius:"50%",background:"#fff",opacity:(starOpacity+i*0.03),animation:`twinkle ${1.4+i*0.25}s ease-in-out infinite alternate`,pointerEvents:"none"}}/>
        ))}
        <div style={{position:"absolute",bottom:60,left:0,right:0,height:50,pointerEvents:"none"}}>
          {[[5,40],[15,55],[82,48],[92,38]].map(([l,h],i)=>(
            <div key={i} style={{position:"absolute",bottom:0,left:`${l}%`,width:18,height:h,background:"#0d2a14",borderRadius:"50% 50% 0 0"}}/>
          ))}
        </div>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:36,background:"linear-gradient(0deg,#1a5c30 0%,#1f7038 60%,transparent 100%)",pointerEvents:"none"}}/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 20px 0",position:"relative",zIndex:2}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.12)",border:"1.5px solid rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,color:"#fff"}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:14,color:"rgba(255,255,255,0.9)",letterSpacing:0.5}}>Tane Money</div>
          <button onClick={()=>setShowSettings(true)} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.12)",border:"1.5px solid rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:"#fff",position:"relative"}}>
            ⚙
            {((data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length)>0&&(<div style={{position:"absolute",top:-5,right:-5,minWidth:17,height:17,borderRadius:999,background:R,color:"#fff",fontSize:11,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px",lineHeight:1}}>{(data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length}</div>)}
          </button>
        </div>
        <div style={{textAlign:"center",position:"relative",zIndex:2,padding:"16px 0 4px"}}>
          <Buddy child={child} data={data} size={130} update={update}/>
        </div>
        {(()=>{
          const m=getMonState(data, child);
          if(m.isFinal) return null;          // 最終形はヒント非表示
          const ready=m.canEvolve;
          const eggS = m.curId==="egg" || /_egg$/.test(String(m.curId));  // 卵は「うまれる」
          const label = ready ? (eggS?"🐣 いまなら うまれるよ！":"🌟 いまならしんかできるよ！")
            : !m.growthOk ? `${eggS?"🐣":"🌟"} あと${m.growthRemain}で${eggS?"うまれる":"しんか"}よ！`
            : `⏳ ${fmtTimeRemain(m.timeRemainMs)}で${eggS?"うまれる":"しんか"}`;
          return(
            <div style={{margin:"0 20px 6px",position:"relative",zIndex:2}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:"#fde68a",fontWeight:700}}>{label}</span>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.45)"}}>{m.growthOk?100:m.growthPct}%</span>
              </div>
              <div style={{height:6,background:"rgba(255,255,255,0.15)",borderRadius:999,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${m.growthOk?100:m.growthPct}%`,background:"linear-gradient(90deg,#fde68a,#f59e0b)",borderRadius:999,transition:"width .6s ease",boxShadow:"0 0 8px rgba(251,191,36,0.6)"}}/>
              </div>
            </div>
          );
        })()}
        <div style={{position:"relative",zIndex:2,margin:"0 16px",background:"rgba(255,255,255,0.12)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",borderRadius:"18px 18px 0 0",border:"1px solid rgba(255,255,255,0.18)",borderBottom:"none",padding:"14px 18px 16px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{color:"rgba(255,255,255,0.65)",fontSize:11,fontWeight:600,marginBottom:2}}><Emo e={child.emoji} size={12} style={{marginRight:3}}/>{child.name}</div>
              <div style={{display:"flex",alignItems:"flex-end",gap:5}}>
                <span style={{color:"#fff",fontSize:30,fontWeight:900,lineHeight:1,letterSpacing:-1}}>{myBal.toLocaleString()}</span>
                <span style={{color:"rgba(255,255,255,0.7)",fontSize:12,fontWeight:600,marginBottom:3}}>pt</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4,flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.55)"}}>今月</span>
                <span style={{fontSize:12,fontWeight:700,color:monthDelta>=0?"#86efac":"#fca5a5"}}>{monthDelta>=0?"+":""}{monthDelta.toLocaleString()}pt</span>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.55)"}}>つうさん</span>
                <span style={{fontSize:12,fontWeight:800,color:"#86efac"}}>{lifetimeEarned.toLocaleString()}pt</span>
                {curStreak>=3&&<span style={{fontSize:11,background:"rgba(255,200,0,0.2)",color:"#fde68a",padding:"2px 7px",borderRadius:999,fontWeight:700}}>🔥 {curStreak}日</span>}
              </div>
            </div>
            <button onClick={()=>setShowTransfer(true)} style={{background:"rgba(255,255,255,0.18)",border:"1.5px solid rgba(255,255,255,0.3)",borderRadius:12,padding:"8px 14px",color:"#fff",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:F}}><Ico name="billfly" fb="💸" size={14} style={{marginRight:3}}/>おくる</button>
          </div>
          {(()=>{const ag=myGoals.find(g=>!g.done&&g.target>0);if(!ag)return null;const pct=Math.min(100,Math.round(myBal/ag.target*100));const rem=Math.max(0,ag.target-myBal);return(
            <div style={{marginTop:10}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"rgba(255,255,255,0.6)",marginBottom:5,fontWeight:700}}>
                <span><Ico name="target" fb="🎯" size={13} style={{marginRight:3}}/>{ag.label}</span><span>{rem>0?`あと ${rem.toLocaleString()}pt`:"たっせい！🎉"}</span>
              </div>
              <div style={{height:7,borderRadius:999,background:"rgba(255,255,255,0.16)",overflow:"hidden"}}>
                <div style={{height:"100%",width:`${pct}%`,borderRadius:999,background:`linear-gradient(90deg,${G},#4ade80)`,transition:"width .4s"}}/>
              </div>
            </div>
          );})()}
          {(()=>{
            const rankable=[...data.children,...(data.parents||[])].filter(m=>m.visibility?.rankingParticipation!==false);
            if(rankable.length<2) return null;
            const sorted=[...rankable].sort((a,b)=>calcMonthlyActivity(b.id,data.logs)-calcMonthlyActivity(a.id,data.logs));
            const rIdx=sorted.findIndex(m=>m.id===child.id);
            if(rIdx<0) return null;
            const medals=["🥇","🥈","🥉"];
            return(
              <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid rgba(255,255,255,0.15)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.45)"}}>今月のがんばり</span>
                <button onClick={()=>{setTab("more");setMoreOpen("ranking");}} style={{background:"none",border:"none",cursor:"pointer",fontFamily:F,display:"flex",alignItems:"center",gap:5,padding:0}}>
                  <span style={{fontSize:16}}>🌱</span>
                  <span style={{fontSize:13,fontWeight:900,color:"#bff0c8"}}>がんばってる</span>
                  <span style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>›</span>
                </button>
              </div>
            );
          })()}
        </div>
        <style>{`@keyframes twinkle{0%{opacity:0.3;transform:scale(1)}100%{opacity:0.9;transform:scale(1.4)}}`}</style>
      </div>
        );
      })() : (()=>{
        // Teen: ダークダッシュボード
        const ttd=(data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="good"||l.type==="daily")).length;
        const myBadges=(data.logs||[]).filter(l=>l.cid===child.id&&l.type==="badge").length;
        const stocks2=data.stocks||[];
        const myH2=(data.holdings||{})[child.id]||[];
        const toPts2=(s,p)=>s.currency==="USD"?Math.max(1,Math.round(p*1.5)):Math.max(1,Math.round(p/100));
        const portV2=myH2.reduce((s,h)=>{const st=stocks2.find(x=>x.id===h.stockId);return s+(st?toPts2(st,st.price)*h.qty:0);},0);
        return(
      <div style={{background:heroImg?`linear-gradient(180deg,rgba(6,10,18,.55) 0%,rgba(6,10,18,.12) 38%,rgba(6,10,18,.45) 100%), url(${heroImg}) center top/cover no-repeat`:(heroGrad||"linear-gradient(160deg,#060d1a 0%,#0f1a2e 50%,#091220 100%)"),position:"relative",overflow:"hidden"}}>
        {/* 背景グリッド */}
        <div style={{position:"absolute",inset:0,backgroundImage:"linear-gradient(rgba(74,158,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(74,158,255,0.04) 1px,transparent 1px)",backgroundSize:"32px 32px",pointerEvents:"none"}}/>
        {/* 背景テーマの星(うちゅう/よぞら等) */}
        {heroStars && [[10,12],[24,7],[68,10],[84,16],[46,20],[33,5],[58,24],[16,28],[78,30],[90,9],[40,33],[63,38]].map(([l,t],i)=>(
          <div key={"st"+i} style={{position:"absolute",top:`${t}%`,left:`${l}%`,width:i%3===0?3:2,height:i%3===0?3:2,borderRadius:"50%",background:"#fff",opacity:0.45+(i%5)*0.08,pointerEvents:"none"}}/>
        ))}
        {/* アクセントライン */}
        <div style={{position:"absolute",top:0,left:"10%",right:"10%",height:1,background:"linear-gradient(90deg,transparent,rgba(74,158,255,0.4),transparent)",pointerEvents:"none"}}/>
        {/* トップバー */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"52px 20px 0",position:"relative",zIndex:2}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,color:"#e2e8f0"}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:12,color:"rgba(74,158,255,0.7)",letterSpacing:2,textTransform:"uppercase"}}>Tane Money</div>
          <button onClick={()=>setShowSettings(true)} style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.12)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,color:"#e2e8f0",position:"relative"}}>
            ⚙
            {((data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length)>0&&(<div style={{position:"absolute",top:-5,right:-5,minWidth:17,height:17,borderRadius:999,background:"#ef4444",color:"#fff",fontSize:11,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px",lineHeight:1}}>{(data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length}</div>)}
          </button>
        </div>
        {/* 残高表示 */}
        <div style={{padding:"20px 20px 18px",position:"relative",zIndex:2,display:"flex",alignItems:"center",gap:12}}>
          <div style={{flex:1}}>
            <div style={{color:"rgba(255,255,255,0.62)",fontSize:11,fontWeight:700,marginBottom:4,letterSpacing:0.5}}><Emo e={child.emoji} size={12} style={{marginRight:3}}/>{child.name}</div>
            <div style={{display:"flex",alignItems:"flex-end",gap:8,marginBottom:2}}>
              <span style={{color:"#fff",fontSize:38,fontWeight:900,lineHeight:1,letterSpacing:-2}}>{myBal.toLocaleString()}</span>
              <span style={{color:"#4ade80",fontSize:15,fontWeight:700,marginBottom:5}}>pt</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:2}}>
              <span style={{color:"rgba(255,255,255,0.5)",fontSize:11,fontWeight:700}}>今月 <span style={{color:monthDelta>=0?"#4ade80":"#f87171",fontWeight:800}}>{monthDelta>=0?"+":""}{monthDelta.toLocaleString()}</span><span style={{color:"rgba(255,255,255,0.28)"}}> · </span>つうさん <span style={{color:"#4ade80",fontWeight:800}}>{lifetimeEarned.toLocaleString()}</span></span>
              <button onClick={()=>setShowTransfer(true)} style={{marginLeft:"auto",background:"rgba(52,199,123,0.14)",border:"1px solid rgba(52,199,123,0.3)",borderRadius:10,padding:"5px 13px",color:"#4ade80",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F}}><Ico name="billfly" fb="💸" size={14} style={{marginRight:3}}/>おくる</button>
            </div>
          </div>
          <Buddy child={child} data={data} size={118} update={update}/>
        </div>
        {/* 目標までの進捗バー(参考ゲームの進行感を健全に: 直近の未達成目標を1本だけ) */}
        {(()=>{const ag=myGoals.find(g=>!g.done&&g.target>0);if(!ag)return null;const pct=Math.min(100,Math.round(myBal/ag.target*100));const rem=Math.max(0,ag.target-myBal);return(
          <div style={{padding:"0 20px 16px",position:"relative",zIndex:2}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"rgba(255,255,255,0.55)",marginBottom:5,fontWeight:700}}>
              <span><Ico name="target" fb="🎯" size={13} style={{marginRight:3}}/>{ag.label}</span><span>{rem>0?`あと ${rem.toLocaleString()}pt`:"たっせい！🎉"}</span>
            </div>
            <div style={{height:7,borderRadius:999,background:"rgba(255,255,255,0.13)",overflow:"hidden"}}>
              <div style={{height:"100%",width:`${pct}%`,borderRadius:999,background:`linear-gradient(90deg,${G},#4ade80)`,transition:"width .4s"}}/>
            </div>
          </div>
        );})()}
        <div style={{height:6}}/>
      </div>
        );
      })()}
      {/* タブナビゲーション（iOS 26 リキッドグラス：半透明＋backdrop-blur） */}
      <div style={{display:"flex",background:isJunior?"rgba(255,255,255,0.72)":"rgba(15,26,46,0.66)",backdropFilter:"saturate(180%) blur(20px)",WebkitBackdropFilter:"saturate(180%) blur(20px)",borderBottom:isJunior?"1px solid rgba(24,35,29,0.06)":"1px solid rgba(255,255,255,0.08)",overflowX:"auto",scrollbarWidth:"none",position:"sticky",top:0,zIndex:100,boxShadow:isJunior?"0 1px 14px rgba(24,35,29,0.05)":"0 1px 18px rgba(0,0,0,0.35)"}}>
        {MAIN_TABS.map(([v,l])=>{
          // 控えめな金色ドット: 「今日まだのおてつだい」と「今日まだのガチャ」だけ(最大2個)。やり終えたら消える。
          const tabDot = ((v==="activity"||v==="tasks") && !todayTaskDone) || (v==="daily" && showGacha && !todayDone);
          // juniorのタブは生キー(tasks/goals)だがeffectiveTabはエイリアス(activity/money)になるため、
          // 比較用に同じ変換をかける。非juniorは tabAlias に無いので activeKey===v で従来通り。
          const activeKey = tabAlias[v]||v;
          const isActive = effectiveTab===activeKey;
          return (
          <button key={v} onClick={()=>setTab(v)}
            style={{position:"relative",flex:1,padding:"7px 4px 7px",border:"none",borderBottom:isActive?`2.5px solid ${isJunior?GP:"#4ade80"}`:"2.5px solid transparent",background:"none",color:isActive?(isJunior?GP:"#4ade80"):(isJunior?MUTED:"rgba(255,255,255,0.35)"),fontWeight:isActive?700:500,fontSize:12,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap",minWidth:56,transition:"all .15s",display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
            <span style={{position:"relative",display:"inline-flex"}}>
              <img src={`/assets/tab_${v}.png`} alt="" style={{width:22,height:22,objectFit:"contain",opacity:isActive?1:0.4,filter:(!isJunior&&!isActive)?"brightness(0.6)":"none",transition:"opacity .15s"}} onError={e=>{const s=document.createElement("span");s.textContent=TAB_FB[v]||"🌱";s.style.fontSize="20px";s.style.opacity=isActive?"1":"0.5";e.target.replaceWith(s);}}/>
              {tabDot && <span style={{position:"absolute",top:-3,right:-6,width:9,height:9,borderRadius:"50%",background:GOLD,border:`1.5px solid ${isJunior?CARD:"#0f1a2e"}`}}/>}
            </span>
            {l.replace(/^\S+\s+/,"")}
          </button>
          );
        })}
      </div>

      {/* iOS 26風 大きいタイトル：タブバー直下・スクロールで縮んで消える */}
      {(()=>{
        const titleMap={daily:"きょう",activity:"かつどう",tasks:"やること",money:"ためる",goals:"ためる",learn:"まなぶ",more:"きろく"};
        const title=titleMap[effectiveTab];
        if(!title) return null;
        const p=Math.min(1,scrollY/56);          // 0=上, 1=スクロール済み
        const h=Math.round(44*(1-p));
        return (
          <div style={{height:h,overflow:"hidden",padding:"0 20px"}}>
            <div style={{fontSize:28-11*p,fontWeight:900,letterSpacing:-0.5,paddingTop:8,lineHeight:1,color:darkBG?"#fff":TEXT,opacity:1-p*0.9,transform:`translateY(${-8*p}px)`}}>{title}</div>
          </div>
        );
      })()}

      {/* 育成RPG(そだてるFAB)・投資ワールド全画面(まちFAB)は廃止。投資はmoneyタブ内「推し株」に統合。 */}

      {/* 📢 おしらせ(新機能の告知) */}
      {effectiveTab==="daily" && (
        <div style={{padding:"10px 16px 0"}}>
          <button onClick={openNews} style={{width:"100%",display:"flex",alignItems:"center",gap:8,background:darkBG?"rgba(255,255,255,0.05)":CARD,border:`1.5px solid ${hasNews?GOLD:(darkBG?"rgba(255,255,255,0.1)":BORDER)}`,borderRadius:14,padding:"9px 14px",cursor:"pointer",fontFamily:F}}>
            <span style={{fontSize:16}}>📢</span>
            <span style={{flex:1,textAlign:"left",fontWeight:800,fontSize:13,color:darkBG?"rgba(255,255,255,0.85)":TEXT}}>おしらせ{hasNews?"・新機能があるよ！":""}</span>
            {hasNews && <span style={{fontSize:10,fontWeight:900,color:"#fff",background:R,borderRadius:999,padding:"2px 8px"}}>NEW</span>}
            <span style={{fontSize:13,color:MUTED}}>›</span>
          </button>
        </div>
      )}

      {/* ⭐ やくそくカード（ぜんぶクリアで あしたのおたのしみ解放。ポイントとは別） */}
      {effectiveTab==="daily" && (()=>{
        const _yd = new Date(); _yd.setDate(_yd.getDate()-1);
        const yesterdayKey = `${_yd.getFullYear()}-${_yd.getMonth()+1}-${_yd.getDate()}`;
        const info = getYakusokuInfo(data, child.id);
        const okToday = (data.yakusokuDone||{})[child.id] === yesterdayKey;
        if (info.reqTasks.length===0 && !okToday) return null;
        const privs = (data.familySettings&&Array.isArray(data.familySettings.privileges))?data.familySettings.privileges:[];
        const privStr = privs.length ? privs.map(p=>`${p.emoji}${p.label}`).join("・") : "おたのしみ";
        const hadReqYesterday = getYakusokuInfo(data, child.id, _yd).reqTasks.length>0;
        return (
          <div style={{padding:"10px 16px 0"}}>
            <div style={{background:okToday?GS:(darkBG?"rgba(255,255,255,0.05)":CARD),border:`1.5px solid ${okToday?G:(darkBG?"rgba(255,255,255,0.1)":BORDER)}`,borderRadius:14,padding:"10px 14px"}}>
              {okToday
                ? <p style={{margin:0,fontWeight:900,fontSize:13,color:GP}}>🎉 きょうは {privStr} OK！</p>
                : hadReqYesterday
                  ? <p style={{margin:0,fontWeight:700,fontSize:11.5,lineHeight:1.5,color:darkBG?"rgba(255,255,255,0.55)":MUTED}}>きょうの おたのしみは おやすみ…きょうの やくそくで あしたゲット！</p>
                  : null}
              {info.reqTasks.length>0 && <>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:(okToday||hadReqYesterday)?"8px 0 4px":"0 0 4px"}}>
                  <span style={{fontWeight:800,fontSize:12,color:darkBG?"rgba(255,255,255,0.85)":TEXT}}>⭐きょうの やくそく</span>
                  <span style={{fontWeight:800,fontSize:12,color:info.allDone?G:MUTED}}>{info.done}/{info.reqTasks.length}</span>
                </div>
                <div style={{height:8,background:darkBG?"rgba(255,255,255,0.12)":BORDER,borderRadius:4,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${info.done/info.reqTasks.length*100}%`,background:info.allDone?G:GOLD,borderRadius:4,transition:"width .5s ease"}}/>
                </div>
                {info.allDone && <p style={{margin:"6px 0 0",fontWeight:900,fontSize:12,color:G}}>🎉 あしたは {privStr} つかえるよ！</p>}
              </>}
            </div>
          </div>
        );
      })()}

      {/* かぞく会議カードは廃止（ユーザー要望・シンプル化） */}

      {/* 🎯 きょうのミッション(毎日リセット) ※ユーザー要望で非表示(falseで無効化・復活可) */}
      {false && effectiveTab==="daily" && showMissions && (()=>{
        const tISO=todayISO(), tk=todayKey();
        const metrics={
          tasks: myLogs.filter(l=>(l.type==="good"||l.type==="daily")&&(l.date||"").startsWith(tISO)).length,
          care: (data.monsterCare?.[child.id]?.last===tk)?1:0,
          learn: myLogs.filter(l=>l.type==="tips"&&(l.date||"").startsWith(tISO)).length,
          battle: (data.battleWinDate?.[child.id]===tk)?1:0,
        };
        // まめちしきはJuniorに無い画面なので除外。バトルオフ(light/money)ではバトルミッションも除外
        const dailyMissions=MISSIONS.filter(m=>(isJunior?m.metric!=="learn":true) && (showBattleF?true:m.metric!=="battle"));
        const mcRaw=data.missionClaimed?.[child.id];
        const claimed=(mcRaw&&mcRaw.date===tk)?(mcRaw.ids||[]):[];
        const allClaimed=claimed.length>=dailyMissions.length;
        const doneCount=dailyMissions.filter(m=>metrics[m.metric]>=m.goal).length;
        const claim=(id,exp)=>update(d=>{
          const mc=d.missionClaimed?.[child.id]; const ids=(mc&&mc.date===tk)?(mc.ids||[]):[];
          if(ids.includes(id))return d; const nids=[...ids,id];
          let nd={...d, missionClaimed:{...(d.missionClaimed||{}),[child.id]:{date:tk,ids:nids}}, monsterExp:{...(d.monsterExp||{}),[child.id]:((d.monsterExp?.[child.id])||0)+exp}};
          if(nids.length>=dailyMissions.length){ let frag=((d.battleFragments?.[child.id])||0)+1; let tic=(d.battleTickets?.[child.id])||0; if(frag>=5){frag-=5;tic+=1;} nd.battleFragments={...(d.battleFragments||{}),[child.id]:frag}; nd.battleTickets={...(d.battleTickets||{}),[child.id]:tic}; }
          return nd;
        });
        return (
          <div style={{padding:"10px 16px 0"}}>
            <div style={{background:darkBG?"rgba(255,255,255,0.05)":CARD,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.1)":BORDER}`,borderRadius:16,padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                <span style={{fontWeight:800,fontSize:13,color:darkBG?"rgba(255,255,255,0.85)":TEXT}}>🎯 きょうのミッション</span>
                <span style={{fontSize:11,color:MUTED,fontWeight:700}}>{doneCount}/{dailyMissions.length}{allClaimed?" ✓":""}</span>
              </div>
              {dailyMissions.map(m=>{
                const prog=Math.min(metrics[m.metric],m.goal); const done=prog>=m.goal; const isClaimed=claimed.includes(m.id);
                return <div key={m.id} style={{display:"flex",alignItems:"center",gap:9,padding:"5px 0"}}>
                  <span style={{fontSize:17,width:22,textAlign:"center"}}>{m.e}</span>
                  <div style={{flex:1,minWidth:0,fontSize:12.5,fontWeight:700,color:done?(darkBG?"#bff0c8":G):(darkBG?"rgba(255,255,255,0.75)":TEXT)}}>{m.label} <span style={{color:MUTED,fontWeight:600}}>{prog}/{m.goal}</span></div>
                  {isClaimed
                    ? <span style={{fontSize:11,fontWeight:800,color:MUTED,flexShrink:0}}>✓ もらった</span>
                    : done
                    ? <button onClick={()=>claim(m.id,m.exp)} style={{background:GP,border:"none",borderRadius:999,padding:"5px 12px",color:"#fff",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F,flexShrink:0}}>+{m.exp}EXP</button>
                    : <span style={{fontSize:11,color:MUTED,flexShrink:0}}>あと{m.goal-prog}</span>}
                </div>;
              })}
              {allClaimed && <div style={{marginTop:6,fontSize:11,color:darkBG?"#bff0c8":G,fontWeight:700,textAlign:"center"}}>🎉 ぜんぶ達成！🧩 かけらGET！</div>}
            </div>
          </div>
        );
      })()}


      {curStreak>=3 && !todayTaskDone && effectiveTab==="daily" && (
        <div style={{margin:"10px 16px 0",background:`linear-gradient(135deg,#fff8e1,#fffde7)`,border:`2px solid ${GOLD}`,borderRadius:14,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:24}}>🔥</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:13,color:"#b45309"}}>連続{curStreak}日！すごいね✨</div>
            <div style={{fontSize:11,color:MUTED,marginTop:1}}>きょうも 1つ やって つづけよう！</div>
          </div>
        </div>
      )}

      {/* ── まめちしき（旧・学ぶタブ→毎日タブ内の1枚に。独立タブ廃止） ── */}
      {effectiveTab==="daily" && !isJunior && (
        <div style={{padding:"10px 16px 0"}}>
          <button onClick={()=>{taneHaptic("tap");setShowTips(v=>!v);}} style={{width:"100%",display:"flex",alignItems:"center",gap:8,background:darkBG?"rgba(255,255,255,0.05)":CARD,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.1)":BORDER}`,borderRadius:14,padding:"9px 14px",cursor:"pointer",fontFamily:F}}>
            <span style={{fontSize:16}}>📖</span>
            <span style={{flex:1,textAlign:"left",fontWeight:800,fontSize:13,color:darkBG?"rgba(255,255,255,0.85)":TEXT}}>まめちしき（お金のまなび）</span>
            <span style={{fontSize:13,color:MUTED}}>{showTips?"▲":"›"}</span>
          </button>
          {showTips && <TipsSection ageMode={child.ageMode||"middle"} child={child} data={data} update={update}/>}
        </div>
      )}

      {/* ── 家族ミッション導線（ホームタブ内の小カード） ── */}
      {effectiveTab==="daily" && (()=>{
        const fs=data.familySettings||INIT.familySettings;
        if(!fs.familyMission?.enabled) return null;
        const missionPts=(data.logs||[]).filter(l=>["daily","good","bad"].includes(l.type)&&l.pts>0).reduce((s,l)=>s+l.pts,0);
        const target=fs.familyMission?.target||3000;
        const pct=Math.min(100,Math.floor(missionPts/target*100));
        return(
          <div style={{padding:"0 16px 12px"}}>
            <div style={{background:CARD,borderRadius:14,padding:"12px 14px",border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",gap:10,boxShadow:"0 2px 8px rgba(24,35,29,0.04)"}}>
              <span style={{fontSize:14}}>❤</span>
              <div style={{flex:1}}>
                <div style={{fontSize:12,fontWeight:700,color:TEXT}}>家族ミッション</div>
                <div style={{fontSize:11,color:MUTED}}>みんなであと{(target-missionPts).toLocaleString()}pt</div>
                <div style={{background:BORDER,borderRadius:999,height:4,marginTop:5,overflow:"hidden"}}>
                  <div style={{width:`${pct}%`,height:"100%",background:G,borderRadius:999}}/>
                </div>
              </div>
              <div style={{fontSize:11,fontWeight:700,color:GP}}>{pct}%</div>
            </div>
          </div>
        );
      })()}

      {/* Modals */}
      {showTransfer&&<PointTransferModal child={child} data={data} update={update} onClose={()=>setShowTransfer(false)}/>}
      {showWeekly&&<WeeklyReport child={child} data={data} onClose={()=>setShowWeekly(false)}/>}
      {showCustomizer&&<TaskCustomizer child={child} data={data} update={update} onClose={()=>setShowCustomizer(false)}/>}
      {goalCelebration&&<GoalCelebration goal={goalCelebration} onClose={()=>setGoalCelebration(null)}/>}

      {/* Flash */}
      {flash && (
        <div style={{position:"fixed",top:"28%",left:"50%",transform:"translate(-50%,-50%)",background:flash.pending?GOLD:flash.pts>=0?G:R,color:"#fff",borderRadius:20,padding:"14px 26px",zIndex:900,textAlign:"center",boxShadow:"0 8px 30px #0003",animation:"popIn .3s ease",pointerEvents:"none"}}>
          <div style={{fontSize:38}}>{flash.emoji}</div>
          {flash.pending
            ? <div style={{fontSize:12,fontWeight:700,marginTop:4}}>おうちの人に確認するね</div>
            : <Pt v={flash.pts} sz={22}/>
          }
          {flash.cheer&&<div style={{fontSize:11.5,fontWeight:800,color:"rgba(255,255,255,0.95)",maxWidth:210,lineHeight:1.45,margin:"4px auto 0"}}>{flash.cheer}</div>}
        </div>
      )}

      {/* Gacha anim */}
      {gachaRes && <GachaAnim result={gachaRes} onClose={()=>{setGachaRes(null); gachaBusyRef.current=false;}}/>}
      {/* 🎉 レベルアップ演出（おめでとうのみ・回復アイテム報酬は廃止） */}
      {lvPop && (
        <div onClick={()=>setLvPop(null)} style={{position:"fixed",inset:0,background:"#0007",zIndex:1200,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F,pointerEvents:"auto"}}>
          <div style={{background:"linear-gradient(135deg,#fff7e0,#ffe9a8)",border:"3px solid #E8B83E",borderRadius:22,padding:"22px 26px",textAlign:"center",boxShadow:"0 0 40px rgba(232,184,62,.8)",animation:"lvPopIn .5s cubic-bezier(.2,1.4,.4,1)"}}>
            <div style={{fontSize:13,fontWeight:900,color:"#9a7000",letterSpacing:2}}>✨ レベルアップ！ ✨</div>
            <div style={{fontWeight:900,fontSize:42,color:"#E8B83E",lineHeight:1.1,margin:"4px 0",textShadow:"0 2px 0 #fff"}}>Lv.{lvPop.to}</div>
            <div style={{fontSize:12,fontWeight:800,color:"#7c5a00"}}>称号：{monRank(lvPop.to)}</div>
            <div style={{fontSize:12,color:"#7c5a00",marginTop:10,lineHeight:1.6,fontWeight:800}}>つみ重ねた努力が タネモンの力に🌱<br/>その ちょうしで つづけよう！</div>
            <button onClick={()=>setLvPop(null)} style={{marginTop:12,background:"#E8B83E",border:"none",borderRadius:12,padding:"9px 22px",color:"#3a2a00",fontWeight:900,fontSize:14,cursor:"pointer",fontFamily:F}}>やったー！</button>
          </div>
          <style>{`@keyframes lvPopIn{0%{transform:scale(.3) rotate(-8deg);opacity:0}100%{transform:scale(1) rotate(0);opacity:1}}`}</style>
        </div>
      )}
      {showNews && <NewsModal onClose={()=>setShowNews(false)}/>}

      {/* Reward confirm */}
      {rewardPop && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.32)",backdropFilter:"blur(3px)",WebkitBackdropFilter:"blur(3px)",zIndex:800,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:"rgba(255,255,255,0.92)",backdropFilter:"saturate(180%) blur(24px)",WebkitBackdropFilter:"saturate(180%) blur(24px)",border:"1px solid rgba(255,255,255,0.6)",borderRadius:28,padding:28,width:"100%",maxWidth:320,textAlign:"center",fontFamily:F,boxShadow:"0 20px 60px rgba(0,0,0,0.22)"}}>
            <div style={{fontSize:52}}>{rewardPop.emoji}</div>
            <h3 style={{fontWeight:900,fontSize:18,margin:"8px 0 4px"}}>{rewardPop.label}</h3>
            <p style={{color:MUTED,fontSize:13,margin:"0 0 14px"}}>{rewardPop.unit}</p>
            <div style={{background:BG,borderRadius:12,padding:"10px 14px",marginBottom:16}}>
              <p style={{fontWeight:800,fontSize:16,margin:0}}>{rewardPop.cost.toLocaleString()}pt つかう</p>
              {myBal >= rewardPop.cost
                ? <p style={{color:MUTED,fontSize:12,margin:"4px 0 0"}}>残高: {myBal.toLocaleString()}pt → <span style={{color:G,fontWeight:800}}>{(myBal-rewardPop.cost).toLocaleString()}pt</span></p>
                : <p style={{color:R,fontWeight:700,fontSize:13,margin:"4px 0 0"}}>残高がたりないよ</p>}
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setRewardPop(null)} style={{flex:1,background:BORDER,border:"none",borderRadius:12,padding:12,fontWeight:800,color:MUTED,cursor:"pointer",fontFamily:F}}>やめる</button>
              {myBal>=rewardPop.cost && <button onClick={()=>doRedeem(rewardPop)} style={{flex:1,background:Y,border:"none",borderRadius:12,padding:12,fontWeight:900,color:TEXT,cursor:"pointer",fontFamily:F}}>こうかん🎉</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── DAILY ── */}
      {effectiveTab==="daily" && showGacha && <>
        {/* フローティング・まいにちのタネ ボタン(1日1回・ログインボーナス) */}
        {(()=>{ const ft=getMonthTheme(); return (
          <button onClick={()=>{ if(!todayDone) doGacha(); }} disabled={todayDone} aria-label="まいにちのタネ"
            style={{position:"fixed",right:16,bottom:24,zIndex:120,width:66,height:66,borderRadius:"50%",
              border:todayDone?`2px solid ${BORDER}`:"3px solid #fff",
              background:todayDone?"radial-gradient(circle at 35% 35%,#d2d2d2,#a8a8a8)":`radial-gradient(circle at 35% 35%,${ft.bg},${ft.color})`,
              boxShadow:todayDone?"0 4px 12px rgba(0,0,0,0.25)":`0 6px 22px ${ft.color}95`,
              cursor:todayDone?"default":"pointer",fontSize:30,display:"flex",alignItems:"center",justifyContent:"center",
              animation:todayDone?"none":"gachaFab 1.6s ease-in-out infinite",fontFamily:F}}>
            {todayDone?"✓":"🌱"}
            {!todayDone&&<span style={{position:"absolute",top:-7,right:-8,background:R,color:"#fff",fontSize:10,fontWeight:900,borderRadius:10,padding:"1px 6px",border:"1.5px solid #fff",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}>どうぞ</span>}
          </button>
        );})()}
        <style>{`@keyframes gachaFab{0%,100%{transform:scale(1) translateY(0)}50%{transform:scale(1.09) translateY(-3px)}}`}</style>
        {data.firstActionPending&&(data.goodTasks||[]).length>0&&(
          <div style={{background:GS,border:`2px solid ${G}`,borderRadius:16,padding:"14px 16px",marginBottom:16,position:"relative"}}>
            <button onClick={()=>update(d=>({...d,firstActionPending:false}))} style={{position:"absolute",top:8,right:10,background:"none",border:"none",fontSize:16,cursor:"pointer",color:MUTED}}>✕</button>
            <div style={{fontWeight:900,fontSize:14,color:GP,marginBottom:6}}>🌱 さあ、はじめよう！</div>
            <div style={{color:TEXTS,fontSize:13,lineHeight:1.7,marginBottom:10}}>
              「活動」タブを開いて、{(data.goodTasks||[])[0]?.emoji}{(data.goodTasks||[])[0]?.label}をタップしてみよう！
            </div>
            <button onClick={()=>{
              update(d=>({...d,firstActionPending:false}));
              setTab(isJunior?"tasks":"activity");
            }} style={{background:GP,border:"none",borderRadius:10,padding:"8px 18px",color:"#fff",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:F}}>
              活動タブへ →
            </button>
          </div>
        )}
        {/* ── スタートクエスト ── */}
        {!((data.beginnerMissionDone||{})[child.id])&&(()=>{
          const claimed=(data.claimedMissions||{})[child.id]||[];
          const quests=[
            {id:"q1",emoji:"⭐",label:"タスクをやろう",hint:isJunior?"「やること」タブでお手伝いをやってみよう":"「活動」タブでお手伝いをやってみよう",done:myLogs.some(l=>l.type==="good"||l.type==="bad")||(data.pendingApprovals||[]).some(p=>p.cid===child.id),nav:()=>setTab(isJunior?"tasks":"activity")},
            {id:"q2",emoji:"🌱",label:"まいにちのタネを開こう",hint:"今日のタネを1回ひらいてボーナスをうけとろう",done:myLogs.some(l=>l.type==="gacha"),nav:null},
            {id:"q3",emoji:"🎯",label:"目標を1つ決めよう",hint:"「ためる」タブで貯金の目標を作ってみよう",done:(data.goals||[]).some(g=>g.cid===child.id),nav:()=>{if(isJunior){setTab("goals");}else{setTab("money");setMonTab("goals");}}},
            ...(!isJunior?[{id:"q4",emoji:"🛍",label:"ポイントをつかってみよう",hint:"「ためる」タブのこうかんで使えるよ",done:myLogs.some(l=>l.type==="reward"),nav:()=>{setTab("money");setMonTab("rewards");}}]:[]),
          ];
          const totalQ=quests.length;
          const doneCnt=quests.filter(q=>q.done).length;
          const totalBonus=totalQ===4?300:250;
          const claimQuest=(qId)=>{
            const qLabel=quests.find(q=>q.id===qId)?.label||"";
            const e={id:uid(),cid:child.id,type:"grant",label:`🎉 クエスト完了「${qLabel}」`,pts:50,date:new Date().toISOString()};
            update(d=>{
              const nc=[...(d.claimedMissions?.[child.id]||[]),qId];
              const allQ=quests.every(q=>nc.includes(q.id));
              const alreadyDone=!!(d.beginnerMissionDone?.[child.id]);
              const newLogs=[e,...d.logs];
              if(allQ&&!alreadyDone){
                const e2={id:uid(),cid:child.id,type:"grant",label:"🏆 スタートクエスト全クリア！",pts:100,date:new Date().toISOString()};
                addLogToFirestore(e); addLogToFirestore(e2);
                return{...d,logs:[e2,...newLogs],claimedMissions:{...(d.claimedMissions||{}),[child.id]:nc},beginnerMissionDone:{...(d.beginnerMissionDone||{}),[child.id]:true}};
              }
              addLogToFirestore(e);
              return{...d,logs:newLogs,claimedMissions:{...(d.claimedMissions||{}),[child.id]:nc}};
            });
            showFlash(50,"🎉");
          };
          const unclaimed=quests.filter(q=>!claimed.includes(q.id));
          if(unclaimed.length===0) return null;
          return(
            <div style={{padding:"10px 16px 0"}}>
              <div style={{background:CARD,borderRadius:16,padding:"14px 14px 10px",border:`1.5px solid ${BORDER}`,boxShadow:SHADOW}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <span style={{fontSize:20}}>🌱</span>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:900,fontSize:13,color:TEXT}}>スタートクエスト</div>
                    <div style={{fontSize:11,color:MUTED}}>全部やると合計+{totalBonus}pt！</div>
                  </div>
                  <div style={{fontSize:11,fontWeight:800,color:doneCnt===totalQ?GP:MUTED}}>{doneCnt}/{totalQ}</div>
                </div>
                <div style={{background:BORDER,borderRadius:999,height:4,marginBottom:10,overflow:"hidden"}}>
                  <div style={{width:`${doneCnt/totalQ*100}%`,height:"100%",background:G,borderRadius:999,transition:"width .4s"}}/>
                </div>
                {unclaimed.map(q=>(
                  <div key={q.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderTop:`1px solid ${BORDER}`}}>
                    <span style={{fontSize:16,flexShrink:0}}>{q.done?"✅":q.emoji}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:12,color:q.done?GP:TEXT}}>{q.label}</div>
                      {!q.done&&<div style={{fontSize:11,color:MUTED,marginTop:1}}>{q.hint}</div>}
                      {q.done&&<div style={{fontSize:11,color:GP,marginTop:1}}>達成！+50pt うけとれるよ</div>}
                    </div>
                    {q.done
                      ?<button onClick={()=>claimQuest(q.id)} style={{background:G,border:"none",borderRadius:10,padding:"5px 12px",color:"#fff",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F,flexShrink:0}}>うけとる</button>
                      :<button onClick={()=>q.nav&&q.nav()} disabled={!q.nav} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,padding:"5px 12px",color:MUTED,fontWeight:700,fontSize:11,cursor:q.nav?"pointer":"default",fontFamily:F,flexShrink:0}}>やってみる</button>
                    }
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
        {/* タスクを先に表示（ガチャより優先）— Junior/Teen共通 */}
        {!isJunior && <>
          <div style={{color:"rgba(255,255,255,0.6)",fontSize:11,fontWeight:700,letterSpacing:1.5,padding:"14px 16px 0"}}>きょうの やること</div>
          <TabHint id="daily" text="今日のタスクをやってポイントをゲット！連続記録でボーナスも🌟" data={data} update={update} cid={child.id}/>
          <DailyTasks child={child} data={data} update={update}/>
        </>}
        {isJunior && <>
          <TabHint id="daily" text="毎日タスクをチェックしよう！全部クリアするとボーナスポイントがもらえるよ🌟" data={data} update={update} cid={child.id}/>
          <DailyTasks child={child} data={data} update={update}/>
        </>}
        {/* ── デイリーガチャ（タスクの下＝ごほうび。Junior/Teen共通）。money モードでは非表示 ── */}
        {showGacha && <div style={{padding:"12px 16px 4px"}}>
          {!isJunior&&<div style={{color:"rgba(255,255,255,0.58)",fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:8}}>🌱 まいにちのタネ</div>}
          {(()=>{
            const mTheme=getMonthTheme();
            const bonusLabel=curStreak>=30?"+15pt":curStreak>=14?"+10pt":curStreak>=7?"+5pt":curStreak>=3?"+3pt":null;
            const monthGacha=myLogs.filter(l=>l.type==="gacha"&&(l.date||"").startsWith(monthKey()));
            const todayChores=myLogs.filter(l=>(l.type==="good"||l.type==="daily")&&isTodayLocal(l.date)).length;
            const tierCounts=(data.gacha||[]).map(tier=>({...tier,count:monthGacha.filter(l=>l.tierId===tier.id||(l.label||"").includes(tier.label)).length}));
            return(<>
              <div style={{background:darkBG?(todayDone?"rgba(255,255,255,0.05)":"rgba(255,255,255,0.07)"):(todayDone?CARD:`linear-gradient(135deg,${mTheme.bg},#fffbe6)`),border:darkBG?`1px solid ${todayDone?"rgba(255,255,255,0.1)":mTheme.color+"50"}`:`2px solid ${todayDone?BORDER:mTheme.color}`,borderRadius:20,padding:"16px 18px",display:"flex",alignItems:"center",gap:14}}>
                <button onClick={doGacha} disabled={todayDone}
                  style={{width:62,height:62,borderRadius:"50%",border:"none",flexShrink:0,
                    background:todayDone?"radial-gradient(circle at 35% 35%,#ccc,#aaa)":`radial-gradient(circle at 35% 35%,${mTheme.bg},${mTheme.color})`,
                    fontSize:28,cursor:todayDone?"default":"pointer",
                    boxShadow:todayDone?"none":`0 4px 16px ${mTheme.color}60`,
                    animation:todayDone?"none":"glow 2s ease-in-out infinite"}}>
                  {mTheme.emoji}
                </button>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:mTheme.color,fontWeight:700,marginBottom:2}}>{mTheme.emoji} {mTheme.name}のタネ</div>
                  <div style={{fontWeight:800,fontSize:14,color:darkBG?(todayDone?"rgba(255,255,255,0.35)":"#fff"):(todayDone?MUTED:TEXT)}}>
                    {todayDone?(darkBG?"うけとった！":"✅ 今日は受け取り済み！"):"まいにちのタネ"}
                  </div>
                  <div style={{fontSize:12,color:darkBG?"rgba(255,255,255,0.3)":MUTED,marginTop:2}}>
                    {todayDone?(darkBG?"また あした":"また明日ね🌙"):"1日1回 ひらくと ボーナスpt"}
                  </div>
                  {bonusLabel&&!todayDone&&<div style={{marginTop:4,fontSize:11,color:R,fontWeight:700}}>🔥 {curStreak}日連続ボーナス {bonusLabel}！</div>}
                  {!bonusLabel&&curStreak>=1&&!todayDone&&<div style={{marginTop:4,fontSize:11,color:R,fontWeight:700}}>🔥 {curStreak}日連続中！3日でボーナス</div>}
                  {todayDone&&darkBG&&(()=>{const coll=data.gachaCollection?.[child.id]||{};const rem=GACHA_ITEMS.length-GACHA_ITEMS.filter(i=>(coll[i.id]||0)>0).length;return rem>0?<div style={{marginTop:5,fontSize:11,color:"rgba(52,199,123,0.65)",fontWeight:700}}>図鑑のこり{rem}体 · ぜんぶ あつめよう</div>:<div style={{marginTop:5,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:11,color:"#fbbf24",fontWeight:700}}>ぜんぶ あつめた ★</span><span onClick={(e)=>{e.stopPropagation();shareCard({emoji:"🏆",title:"ずかん コンプリート！",subtitle:`${GACHA_ITEMS.length}しゅるい ぜんぶ あつめた`,color:"#fbbf24"});}} style={{fontSize:11,color:"#4ade80",fontWeight:800,cursor:"pointer"}}>シェア 📤</span></div>;})()}
                </div>
                {!todayDone&&<div style={{fontSize:11,background:mTheme.bg,color:mTheme.color,padding:"4px 10px",borderRadius:999,fontWeight:700,flexShrink:0,border:`1px solid ${mTheme.color}40`}}>TAP！</div>}
              </div>
              <div style={{marginTop:6,display:"flex",gap:10,flexWrap:"wrap",fontSize:11,fontWeight:800}}>
                {!todayDone&&(todayChores>0
                  ? <span style={{color:darkBG?"#bff0c8":G}}>🌱 きょうのお手伝い {todayChores}こ・タネが げんき！</span>
                  : <span style={{color:darkBG?"#ffd9a8":"#9a7000"}}>💪 まいにち ひらいて 連続を のばそう！</span>)}
              </div>
              {monthGacha.length>0&&(
                <div style={{marginTop:8,fontSize:11,color:darkBG?"rgba(255,255,255,0.45)":MUTED,fontWeight:700}}>
                  🌱 今月 {monthGacha.length}日 ひらいた
                </div>
              )}
              {/* 図鑑 */}
              {(()=>{
                const coll=data.gachaCollection?.[child.id]||{};
                const zukanCount=GACHA_ITEMS.filter(i=>coll[i.id]>0).length;
                const tierColorMap=Object.fromEntries((data.gacha||[]).map(g=>[g.id,g.color]));
                return(<div style={{marginTop:10}}>
                  <button onClick={()=>setShowZukan(v=>!v)} style={{width:"100%",background:darkBG?"rgba(255,255,255,0.05)":CARDS,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.1)":BORDER}`,borderRadius:showZukan?"14px 14px 0 0":14,padding:"9px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",fontFamily:F}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <Ico name="book" fb="📖" size={16}/>
                      <span style={{fontWeight:800,fontSize:13,color:darkBG?"rgba(255,255,255,0.8)":TEXT}}>図鑑</span>
                      <span style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.3)":MUTED}}>{zukanCount}/{GACHA_ITEMS.length}コンプリート</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{height:5,width:60,background:BORDER,borderRadius:999,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${zukanCount/GACHA_ITEMS.length*100}%`,background:G,borderRadius:999}}/>
                      </div>
                      <span style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.3)":MUTED}}>{showZukan?"▲":"▼"}</span>
                    </div>
                  </button>
                  {showZukan&&(
                    <div style={{background:darkBG?"rgba(255,255,255,0.04)":CARDS,borderRadius:"0 0 14px 14px",padding:"10px",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.1)":BORDER}`,borderTop:"none"}}>
                      {GACHA_ITEMS.map(item=>{
                        const cnt=coll[item.id]||0;
                        const tc=tierColorMap[item.tierId]||BORDER;
                        return(<div key={item.id} style={{textAlign:"center",background:cnt>0?(darkBG?"rgba(255,255,255,0.08)":CARD):(darkBG?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.04)"),borderRadius:11,padding:"8px 3px",border:`1.5px solid ${cnt>0?tc:(darkBG?"rgba(255,255,255,0.1)":BORDER)}`,transition:"all .2s"}}>
                          {cnt>0
                            ? (item.id.startsWith("gs_")
                                ? (()=>{const b=item.id.replace("gs_","gacha_gs_");return(
                                    <div style={{position:"relative",width:42,height:42,margin:"0 auto",animation:"gsBob 1.6s ease-in-out infinite"}}>
                                      <img src={`/assets/${b}_b.png`} alt={item.name} onError={e=>{const sp=document.createElement("span");sp.textContent=item.emoji;sp.style.cssText="font-size:30px;position:absolute;inset:0;display:flex;align-items:center;justify-content:center;";e.target.replaceWith(sp);}} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain"}}/>
                                    </div>);})()
                                : <img src={`/assets/${item.id.replace("gi_","gacha_").replace("gm_","gacha_gm_")}.png`} alt={item.name} onError={e=>{const sp=document.createElement("span");sp.textContent=item.emoji;sp.style.fontSize="30px";e.target.replaceWith(sp);}} style={{width:38,height:38,objectFit:"contain",borderRadius:6,display:"block",margin:"0 auto"}}/>)
                            : <div style={{fontSize:22,opacity:0.3}}>❓</div>
                          }
                          <div style={{fontSize:11,fontWeight:700,color:cnt>0?(darkBG?"rgba(255,255,255,0.8)":TEXT):MUTED,marginTop:3,lineHeight:1.3}}>{cnt>0?item.name:"???"}</div>
                          {cnt>1&&<div style={{fontSize:11,color:MUTED}}>×{cnt}</div>}
                        </div>);
                      })}
                    </div>
                  )}
                </div>);
              })()}
              {/* 提供割合 */}
              <div style={{marginTop:8,background:darkBG?"rgba(255,255,255,0.04)":CARDS,borderRadius:12,padding:"8px 12px",border:`1px solid ${darkBG?"rgba(255,255,255,0.08)":BORDER}`}}>
                <div style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.35)":MUTED,fontWeight:700,marginBottom:6}}>🎲 提供割合</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {(data.gacha||[]).map(t=>(
                    <div key={t.id} style={{display:"flex",alignItems:"center",gap:4,background:darkBG?"rgba(255,255,255,0.06)":CARD,borderRadius:8,padding:"3px 8px",border:`1px solid ${t.color}40`}}>
                      <span style={{fontSize:11}}>{t.emoji}</span>
                      <span style={{fontSize:11,fontWeight:700,color:t.color}}>{t.label}</span>
                      <span style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.5)":MUTED}}>{t.rate}%</span>
                      <span style={{fontSize:11,color:darkBG?"rgba(255,255,255,0.3)":MUTED}}>{t.min}〜{t.max}pt</span>
                    </div>
                  ))}
                </div>
              </div>
            </>);
          })()}
          <style>{`@keyframes glow{0%,100%{box-shadow:0 4px 16px #f5c84260,0 0 0 4px #f5c84225}50%{box-shadow:0 4px 24px #f5c84290,0 0 0 8px #f5c84240}}
          @keyframes gsBlink{0%{opacity:1}49.9%{opacity:1}50%{opacity:0}99.9%{opacity:0}100%{opacity:1}}
          @keyframes gsBlinkB{0%{opacity:0}49.9%{opacity:0}50%{opacity:1}99.9%{opacity:1}100%{opacity:0}}
          @keyframes gsBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}`}</style>
        </div>}
        {/* Junior: ガチャの後はショートカット＆きろくのみ（タスク本体はガチャの前へ移動済み） */}
        {isJunior && <>
          {/* やることへのショートカット */}
          <div style={{padding:"8px 16px 4px"}}>
            <button onClick={()=>setTab("tasks")}
              style={{width:"100%",background:`linear-gradient(135deg,${GS},#fff)`,border:`2px solid ${G}`,borderRadius:20,padding:"16px 20px",cursor:"pointer",display:"flex",alignItems:"center",gap:14,fontFamily:F,textAlign:"left",boxShadow:SHADOW}}>
              <span style={{fontSize:36}}>✅</span>
              <div>
                <div style={{fontWeight:900,fontSize:16,color:GP}}>きょうのやること</div>
                <div style={{fontSize:12,color:TEXTS,marginTop:2}}>タップしてポイントをもらおう！</div>
              </div>
              <span style={{marginLeft:"auto",fontSize:24,color:G}}>›</span>
            </button>
          </div>
          {/* さいきんのきろく */}
          {myLogs.length>0&&(
            <div style={{padding:"8px 16px 16px"}}>
              <div style={{fontWeight:800,fontSize:13,color:MUTED,marginBottom:8}}>📋 さいきんのきろく</div>
              {[...myLogs].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).slice(0,3).map(l=>{
                const emoji=l.type==="grant"?"🎁":l.type==="gacha"?"🎰":l.type==="reward"?"🎁":l.type==="transfer_in"?"💌":l.type==="transfer_out"?"💸":"⭐";
                return(
                  <div key={l.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"11px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:22}}>{emoji}</span>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{l.label}</div>
                      <div style={{color:MUTED,fontSize:11}}>{fmtDate(l.date)}</div>
                    </div>
                    <Pt v={l.pts}/>
                  </div>
                );
              })}
            </div>
          )}
        </>}
      </>}

      {/* ── ACTIVITY サブナビ ──（投資ワールドが保護者設定でOFFのときは投資/為替タブごと隠す） */}
      {/* ── ACTIVITY（活動=タスク専用に純化。投資「はたけ」は全モード「ためる」へ統一＝卒業時の再学習ゼロ）── */}
      {effectiveTab==="activity"&&(()=>{
        return(<div style={{padding:16}}>
          <TabHint id="tasks" text="やったお手伝いをタップして記録しよう！✏リスト編集で自分用のタスクを選べるよ" data={data} update={update} cid={child.id}/>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
            <div style={{flex:1}}><SortBar options={[["default","デフォルト"],["pts_high","pt高い順"],["pts_low","pt低い順"],["name","名前順"]]} value={taskSort} onChange={setTaskSort}/></div>
            <button onClick={()=>setShowCustomizer(true)} style={{flexShrink:0,padding:"5px 11px",border:`1.5px solid ${hasFilter?G:BORDER}`,borderRadius:20,background:hasFilter?`${G}15`:"transparent",color:hasFilter?G:MUTED,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
              {hasFilter?`✏ ${myIds.length}個選択中`:"✏ リスト編集"}
            </button>
          </div>
          {filtGood.length>0&&<>
            <p style={{color:MUTED,fontSize:12,fontWeight:700,marginBottom:10}}>✅ {young?"いいこと":"いいこと（プラス）"}</p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
              {[...filtGood].sort(sortTaskFn).map(t=>{const pts=taskPts(t,child.id);const on=!!pressed[t.id];const isPending=(data.pendingApprovals||[]).some(p=>p.cid===child.id&&p.taskId===t.id);const cnt=myLogs.filter(l=>l.rid===t.id&&isTodayLocal(l.date)).length;return(<button key={t.id} onClick={()=>doTask(t)} style={{background:isPending?GOLDS:on?"#e8faf0":CARD,border:`2.5px solid ${isPending?GOLD:on?G:BORDER}`,borderRadius:18,padding:"13px 10px",cursor:isPending?"default":"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6,transform:on?"scale(.92)":"scale(1)",transition:"all .2s",fontFamily:F,position:"relative"}}>{isPending?<div style={{position:"absolute",top:4,right:4,fontSize:11,background:GOLD,color:"#fff",borderRadius:999,padding:"1px 5px",fontWeight:700}}>確認待ち</div>:cnt>0?<div style={{position:"absolute",top:4,right:4,fontSize:11,background:G,color:"#fff",borderRadius:999,padding:"1px 6px",fontWeight:700}}>✓{cnt}</div>:null}<span style={{fontSize:young?34:26}}>{t.emoji}</span><span style={{fontSize:young?15:12,fontWeight:700,color:TEXT,textAlign:"center"}}>{t.label}</span>{!young&&<Pt v={pts} sz={12}/>}</button>);})}
            </div>
          </>}
          {!young&&filtBad.length>0&&<>
            <div style={{display:"flex",alignItems:"center",gap:8,margin:"18px 0 10px"}}>
              <div style={{flex:1,height:1,background:RS}}/>
              <span style={{fontSize:11,fontWeight:700,color:R,padding:"3px 10px",background:RS,borderRadius:999}}>❌ わるいこと（マイナス）</span>
              <div style={{flex:1,height:1,background:RS}}/>
            </div>
            <div style={{background:`${R}08`,border:`1.5px dashed ${RS}`,borderRadius:14,padding:"10px 10px 4px",marginBottom:4}}>
              <p style={{margin:"0 0 8px",fontSize:11,color:R,fontWeight:600}}>やってしまったら正直に記録しよう</p>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[...filtBad].sort(sortTaskFn).map(t=>{const on=!!pressed[t.id];return(<button key={t.id} onClick={()=>doTask(t)} style={{background:on?"#fef0ef":CARD,border:`2.5px solid ${on?R:BORDER}`,borderRadius:18,padding:"13px 10px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6,transform:on?"scale(.92)":"scale(1)",transition:"all .2s",fontFamily:F}}><span style={{fontSize:26}}>{t.emoji}</span><span style={{fontSize:12,fontWeight:700,color:TEXT,textAlign:"center"}}>{t.label}</span><Pt v={taskPts(t,child.id)} sz={12}/></button>);})}</div>
            </div>
          </>}
          {filtGood.length===0&&filtBad.length===0&&(
            <div style={{textAlign:"center",padding:"32px 16px"}}>
              {(data.goodTasks||[]).length>0
                ?<><div style={{fontSize:40,marginBottom:12}}>✅</div><p style={{fontWeight:800,fontSize:15,color:TEXT,margin:"0 0 8px"}}>やることリストを作ろう！</p><p style={{color:MUTED,fontSize:12,margin:"0 0 16px"}}>お手伝いの中から好きなものを選んでね</p><button onClick={()=>setShowCustomizer(true)} style={{background:G,border:"none",borderRadius:12,padding:"12px 28px",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:F}}>リストを選ぶ →</button></>
                :<><div style={{fontSize:40,marginBottom:12}}>📋</div><p style={{fontWeight:800,fontSize:15,color:TEXT,margin:"0 0 8px"}}>お手伝いが登録されていないよ</p><p style={{color:MUTED,fontSize:12}}>🔐 おや管理からタスクを追加してもらおう！</p></>
              }
            </div>
          )}
        </div>);
      })()}
      {/* （旧）活動>投資 は廃止。はたけは「ためる>はたけ」に統一 */}
      {/* ── KAKEIBO ── */}
      {effectiveTab==="money" && (
        <div style={{padding:"12px 16px 0"}}>
          {/* iOS 26 セグメントコントロール */}
          <div style={{display:"flex",gap:3,padding:3,borderRadius:13,background:isJunior?"rgba(120,120,128,0.14)":"rgba(255,255,255,0.08)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)"}}>
          {(isJunior
            ?[["goals","🎯 もくひょう"],["rewards","🎁 こうかん"],...(!data.familySettings?.investOff?[["oshi","🌟 推し株"]]:[])]
            :[["goals","🎯 目標"],["rewards","🎁 こうかん"],["kakeibo","📊 使い道"],...(!data.familySettings?.investOff&&!young?[["oshi","🌟 推し株"]]:[])]
          ).map(([k,l])=>{
            const on=monTab===k;
            return (
            <button key={k} onClick={()=>{ taneHaptic("tap"); setMonTab(k); }}
              style={{flex:1,padding:"8px 4px",border:"none",borderRadius:10,
                background:on?(isJunior?"#fff":"rgba(255,255,255,0.18)"):"transparent",
                color:on?(isJunior?GP:"#fff"):(isJunior?MUTED:"rgba(255,255,255,0.55)"),
                fontWeight:on?800:600,fontSize:12,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap",
                boxShadow:on&&isJunior?"0 1px 3px rgba(0,0,0,0.16),0 1px 1px rgba(0,0,0,0.06)":"none",transition:"background .18s,color .18s"}}>
              {l}
            </button>
            );
          })}
          </div>
        </div>
      )}
      {/* 🌟 推し株：moneyタブ内にインライン表示（街づくり・全画面ワールドは廃止） */}
      {effectiveTab==="money" && monTab==="oshi" && !data.familySettings?.investOff && <OshiKabu child={child} data={data} update={update}/>}
      {effectiveTab==="money" && monTab==="kakeibo" && (()=>{
        // 手入力ナシ：ごほうび交換のログから「使い道」を自動集計。
        const _spend=(data.logs||[]).filter(l=>l.cid===child.id&&l.type==="reward"&&(l.pts||0)<0);
        const _mSpend=_spend.filter(l=>(l.date||"").startsWith(kMonth));
        const _total=_mSpend.reduce((s,l)=>s+Math.abs(l.pts||0),0);
        const _life=_spend.reduce((s,l)=>s+Math.abs(l.pts||0),0);
        const _inv=(data.logs||[]).filter(l=>l.cid===child.id&&l.type==="invest_buy"&&(l.date||"").startsWith(kMonth)).reduce((s,l)=>s+Math.abs(l.pts||0),0);
        const _by={}; _mSpend.forEach(l=>{const k=String(l.label||"そのほか").replace(/（.*$/,"").trim()||"そのほか"; _by[k]=(_by[k]||0)+Math.abs(l.pts||0);});
        const _PAL=[G,GOLD,B,P,R,"#E8855C","#5BBF9E","#9B7BD4"];
        const _items=Object.keys(_by).map((k,i)=>({id:k,label:k,v:_by[k],color:_PAL[i%_PAL.length]})).sort((a,b)=>b.v-a.v);
        const _max=_items.length?_items[0].v:1;
        return (
        <div>
          {/* month nav */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px",background:CARD,borderBottom:`1px solid ${BORDER}`}}>
            <button onClick={()=>{const d=new Date(kMonth+"-01");d.setMonth(d.getMonth()-1);setKMonth(monthKey(d));}} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:MUTED}}>‹</button>
            <span style={{fontWeight:800,fontSize:15}}>{(()=>{const d=new Date(kMonth+"-01");return `${d.getFullYear()}年${d.getMonth()+1}月`;})()}</span>
            <button onClick={()=>{const d=new Date(kMonth+"-01");d.setMonth(d.getMonth()+1);if(monthKey(d)<=monthKey())setKMonth(monthKey(d));}} disabled={kMonth>=monthKey()} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:kMonth>=monthKey()?BORDER:MUTED}}>›</button>
          </div>
          <p style={{color:MUTED,fontSize:11,fontWeight:700,textAlign:"center",padding:"8px 16px 0"}}>🌱 ごほうび交換から じどうで まとめてるよ（記録の手間ゼロ）</p>
          {/* summary */}
          <div style={{display:"grid",gridTemplateColumns:_inv>0?"1fr 1fr 1fr":"1fr 1fr",gap:8,padding:"10px 16px 12px"}}>
            <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"11px 12px"}}><div style={{color:MUTED,fontSize:11,fontWeight:700}}>今月 つかった</div><div style={{color:R,fontWeight:900,fontSize:19}}>{_total.toLocaleString()}pt</div></div>
            <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"11px 12px"}}><div style={{color:MUTED,fontSize:11,fontWeight:700}}>これまで 合計</div><div style={{color:TEXT,fontWeight:900,fontSize:19}}>{_life.toLocaleString()}pt</div></div>
            {_inv>0&&<div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"11px 12px"}}><div style={{color:MUTED,fontSize:11,fontWeight:700}}>投資にまわした</div><div style={{color:GP,fontWeight:900,fontSize:19}}>{_inv.toLocaleString()}pt</div></div>}
          </div>
          {/* 使い道 自動グラフ */}
          <div style={{padding:"0 16px"}}>
            {_items.length===0
              ? <p style={{color:MUTED,textAlign:"center",marginTop:28,fontSize:13,lineHeight:1.7}}>この月は まだ つかってないよ🌱<br/><span style={{fontSize:11}}>ごほうびと こうかんすると、ここに 使い道が でるよ</span></p>
              : <>
                  <div style={{display:"flex",gap:14,alignItems:"center",background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:18,padding:16,marginBottom:12}}>
                    <Pie data={_items} size={130}/>
                    <div style={{flex:1,minWidth:0}}>
                      {_items.map(c=>(
                        <div key={c.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                          <div style={{width:9,height:9,borderRadius:"50%",background:c.color,flexShrink:0}}/>
                          <span style={{fontSize:11,fontWeight:700,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.label}</span>
                          <span style={{fontSize:11,color:c.color,fontWeight:800,flexShrink:0}}>{Math.round(c.v/_total*100)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:18,padding:16,marginBottom:12}}>
                    <p style={{fontWeight:800,fontSize:12,color:MUTED,margin:"0 0 10px"}}>なにに つかった？</p>
                    {_items.map(c=>(
                      <div key={c.id} style={{marginBottom:9}}>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:700,marginBottom:3,gap:8}}><span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.label}</span><span style={{color:c.color,flexShrink:0}}>{c.v.toLocaleString()}pt</span></div>
                        <div style={{height:9,background:BORDER,borderRadius:5,overflow:"hidden"}}><div style={{height:"100%",width:`${c.v/_max*100}%`,background:c.color,borderRadius:5,transition:"width .5s"}}/></div>
                      </div>
                    ))}
                  </div>
                  <div style={{background:"#fef9e0",border:`1.5px solid ${Y}`,borderRadius:14,padding:14,marginBottom:12}}>
                    <p style={{margin:0,fontSize:13,fontWeight:700,lineHeight:1.6}}>
                      💡 今月は <span style={{color:_items[0].color,fontWeight:900}}>「{_items[0].label}」</span> に いちばん つかったよ！（{_items[0].v.toLocaleString()}pt）
                      {_items[0].v/_total>0.5 && <><br/><span style={{color:R}}>⚠ つかったお金の 半分いじょうが ここに あつまってるよ</span></>}
                    </p>
                  </div>
                </>
            }
          </div>
        </div>
        );
      })()}

      {/* ── GOALS ── */}
      {effectiveTab==="money" && monTab==="goals" && (
        <div style={{padding:"12px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}><Ico name="target" fb="🎯" size={14} style={{marginRight:4}}/>{young?"もくひょう":"貯金目標"}</p>
            <Btn c={P} label="＋ 追加" onClick={()=>setGAdd(s=>!s)}/>
          </div>
          {myGoals.map(g=>{
            const pct=Math.min(100,Math.round(myBal/g.target*100));
            return (
              <div key={g.id} style={{background:CARD,border:`2px solid ${g.done?G:BORDER}`,borderRadius:18,padding:16,marginBottom:12,position:"relative"}}>
                {g.done && <div style={{position:"absolute",top:-8,right:12,background:G,color:"#fff",fontSize:11,fontWeight:800,padding:"2px 10px",borderRadius:20}}>🎉 達成！</div>}
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                  <span style={{fontSize:28}}>{g.emoji}</span>
                  <div style={{flex:1}}><div style={{fontWeight:800,fontSize:15}}>{g.label}</div><div style={{color:MUTED,fontSize:12}}>目標: {g.target.toLocaleString()}pt</div></div>
                  <button onClick={()=>delGoal(g.id)} style={{background:"none",border:"none",color:MUTED,fontSize:15,cursor:"pointer"}}>✕</button>
                </div>
                <div style={{height:13,background:BORDER,borderRadius:7,overflow:"hidden",marginBottom:5}}><div style={{height:"100%",width:`${pct}%`,background:g.done?G:Y,borderRadius:7,transition:"width .6s"}}/></div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
                  <span style={{color:Y,fontWeight:800}}>{pct}% 達成</span>
                  {!g.done && <span style={{color:MUTED}}>あと {Math.max(0,g.target-myBal).toLocaleString()}pt</span>}
                </div>
                {!g.done && myBal>=g.target && <button onClick={()=>markGoal(g.id)} style={{marginTop:10,width:"100%",background:G,border:"none",borderRadius:10,padding:"10px",color:"#fff",fontWeight:900,fontSize:13,cursor:"pointer",fontFamily:F}}>🎉 目標達成！おめでとう！</button>}
              </div>
            );
          })}
          {myGoals.length===0 && !gAdd && <p style={{color:MUTED,textAlign:"center",marginTop:24,fontSize:13}}>目標をつくって貯金しよう！</p>}
          {gAdd && (
            <div style={{background:`${P}15`,border:`2px dashed ${P}`,borderRadius:16,padding:14}}>
              <p style={{fontWeight:800,fontSize:13,color:P,margin:"0 0 10px"}}>新しい目標を追加</p>
              <div style={{display:"flex",gap:8,marginBottom:8}}>
                <input value={gForm.emoji} onChange={e=>setGForm(f=>({...f,emoji:e.target.value}))} style={{...INP,width:58}}/>
                <input value={gForm.label} onChange={e=>setGForm(f=>({...f,label:e.target.value}))} placeholder="なにを買いたい？" style={INP}/>
              </div>
              <div style={{fontSize:11,color:MUTED,marginBottom:6,lineHeight:1.5}}>💡 ポイントは おてつだいで ためて、ごほうびと こうかんできるよ（例：ゲーム1本ぶん ≒ おうちの人ときめてね）</div>
              <input value={gForm.target} onChange={e=>setGForm(f=>({...f,target:e.target.value}))} type="number" placeholder="目標金額（pt）" style={{...INP,marginBottom:10}}/>
              <div style={{display:"flex",gap:8}}><Btn c={P} label="追加する" onClick={addGoal} disabled={!gForm.label||!gForm.target}/><Btn c={MUTED} label="キャンセル" onClick={()=>setGAdd(false)}/></div>
            </div>
          )}
        </div>
      )}

      {/* ── REWARDS ── */}
      {effectiveTab==="money" && monTab==="rewards" && (
        <div style={{padding:16}}>
          <p style={{color:MUTED,fontSize:12,fontWeight:700,marginBottom:12}}>🎁 ためたポイントでこうかんしよう！</p>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {(data.rewards||[]).map(r=>{
              const ok=myBal>=r.cost;
              const pct=r.cost>0?Math.min(100,Math.round(myBal/r.cost*100)):100;   // 達成度メーター(競合レビュー要望)
              const rem=Math.max(0,r.cost-myBal);
              const pending=(data.pendingRedemptions||[]).some(p=>p.cid===child.id&&p.rewardId===r.id);   // 承認待ちの見える化
              return (
                <button key={r.id} onClick={()=>setRewardPop(r)}
                  style={{background:ok?CARD:BG,border:`2.5px solid ${ok?P:BORDER}`,borderRadius:18,padding:"13px 16px",cursor:"pointer",display:"flex",flexDirection:"column",gap:9,textAlign:"left",fontFamily:F,opacity:ok?1:.85}}>
                  <div style={{display:"flex",alignItems:"center",gap:14,width:"100%"}}>
                    {/^r0\d$/.test(r.id)?<img src={`/assets/reward_${r.id}.png`} style={{width:48,height:48,objectFit:"contain",borderRadius:10,flexShrink:0}} alt=""/>:<span style={{fontSize:34}}>{r.emoji}</span>}
                    <div style={{flex:1,minWidth:0}}><div style={{fontWeight:800,fontSize:14}}>{r.label}</div><div style={{color:MUTED,fontSize:12,marginTop:2}}>{r.unit}</div></div>
                    <div style={{textAlign:"right",flexShrink:0}}><div style={{fontWeight:900,fontSize:16,color:ok?P:MUTED}}>{r.cost.toLocaleString()}pt</div><div style={{fontSize:11,color:pending?GOLD:ok?G:R,fontWeight:700}}>{pending?"✋ しんせい中":ok?"こうかんできる":`あと ${rem.toLocaleString()}pt`}</div></div>
                  </div>
                  {/* 達成メーター：ごほうびが貯まるまでの割合を視覚化 */}
                  <div style={{width:"100%",display:"flex",alignItems:"center",gap:8}}>
                    <div style={{flex:1,height:8,borderRadius:999,background:ok?GS:BORDER,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${pct}%`,borderRadius:999,background:ok?`linear-gradient(90deg,${G},#4ade80)`:`linear-gradient(90deg,${GOLD},#f59e0b)`,transition:"width .5s"}}/>
                    </div>
                    <span style={{fontSize:11,fontWeight:900,color:ok?G:GOLD,minWidth:34,textAlign:"right"}}>{pct}%</span>
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{marginTop:14,background:"#fef9e0",border:`1.5px solid ${Y}`,borderRadius:14,padding:"11px 14px"}}>
            <p style={{margin:0,fontSize:13,fontWeight:700}}><Ico name="coin" fb="💰" size={15} style={{marginRight:4}}/>いまの残高: <span style={{fontSize:16,color:G}}>{myBal.toLocaleString()}pt</span></p>
          </div>
        </div>
      )}

      {/* ── 図鑑セクション ── */}
      {/* 📊 今週のまとめ(稼ぐ/使う/貯める＝お金の学びの振り返り)。juniorは「more」タブが無く、がんばりボタンからランキングだけ表示する */}
      {effectiveTab==="more" && !isJunior && (()=>{
        const wkAgo=(()=>{const d=new Date();d.setDate(d.getDate()-7);return d.toISOString();})();
        const wl=myLogs.filter(l=>(l.date||"")>=wkAgo);
        const earned=wl.filter(l=>l.pts>0).reduce((s,l)=>s+l.pts,0);
        const spent=wl.filter(l=>l.pts<0).reduce((s,l)=>s-l.pts,0);
        const choreCount=wl.filter(l=>l.type==="good"||l.type==="daily").length;
        const net=earned-spent;
        return (
          <div style={{padding:"4px 16px 0"}}>
            <div style={{background:darkBG?"rgba(255,255,255,0.05)":CARD,border:`1.5px solid ${darkBG?"rgba(255,255,255,0.1)":BORDER}`,borderRadius:16,padding:"13px 15px",marginBottom:8}}>
              <div style={{fontWeight:800,fontSize:13,color:darkBG?"rgba(255,255,255,0.85)":TEXT,marginBottom:10}}>📊 今週のまとめ（7日間）</div>
              <div style={{display:"flex",gap:8,marginBottom:10}}>
                <div style={{flex:1,textAlign:"center",background:darkBG?"rgba(52,199,123,0.12)":GS,borderRadius:12,padding:"8px 4px"}}>
                  <div style={{fontSize:10,color:darkBG?"rgba(255,255,255,0.5)":TEXTS,fontWeight:700}}>かせいだ</div>
                  <div style={{fontSize:17,fontWeight:900,color:G}}>+{earned.toLocaleString()}</div>
                </div>
                <div style={{flex:1,textAlign:"center",background:darkBG?"rgba(217,92,85,0.12)":RS,borderRadius:12,padding:"8px 4px"}}>
                  <div style={{fontSize:10,color:darkBG?"rgba(255,255,255,0.5)":TEXTS,fontWeight:700}}>つかった</div>
                  <div style={{fontSize:17,fontWeight:900,color:R}}>-{spent.toLocaleString()}</div>
                </div>
                <div style={{flex:1,textAlign:"center",background:darkBG?"rgba(74,158,255,0.12)":BS,borderRadius:12,padding:"8px 4px"}}>
                  <div style={{fontSize:10,color:darkBG?"rgba(255,255,255,0.5)":TEXTS,fontWeight:700}}>のこり残高</div>
                  <div style={{fontSize:17,fontWeight:900,color:B}}>{myBal.toLocaleString()}</div>
                </div>
              </div>
              <div style={{display:"flex",justifyContent:"space-around",fontSize:11,color:darkBG?"rgba(255,255,255,0.6)":TEXTS,fontWeight:700}}>
                <span>🧹 お手伝い {choreCount}回</span>
                <span>💰 今週ためた {net>=0?"+":""}{net.toLocaleString()}pt</span>
              </div>
              {earned>0 && <div style={{marginTop:8,fontSize:11,color:darkBG?"rgba(255,255,255,0.5)":MUTED,textAlign:"center"}}>{spent<=earned*0.3?"よく がまんして ためたね！🌱":spent>=earned*0.8?"つかいすぎ かも？ためる練習もしよう🐷":"いいバランス！👍"}</div>}
            </div>
          </div>
        );
      })()}

      {/* ── LOG ── */}
      {effectiveTab==="more" && !isJunior && (
        <div style={{padding:16}}>
          {/* サブタブ: 履歴 / バッジ / ランキング（iOSセグメント統一） */}
          <div style={{display:"flex",gap:3,padding:3,borderRadius:13,background:darkBG?"rgba(255,255,255,0.08)":"rgba(120,120,128,0.14)",marginBottom:14}}>
            {[["log","📋 履歴"],["badges","🎖 バッジ"],["ranking","🏅 ランキング"]].map(([k,l])=>{
              const cur=(["badges","ranking"].includes(moreOpen)?moreOpen:"log");
              const on=cur===k;
              return (
              <button key={k} onClick={()=>{taneHaptic("tap");setMoreOpen(k==="log"?"log":k==="badges"?"badges":"ranking");}}
                style={{flex:1,padding:"8px 4px",border:"none",borderRadius:10,
                  background:on?(darkBG?"rgba(255,255,255,0.18)":"#fff"):"transparent",
                  color:on?(darkBG?"#fff":GP):(darkBG?"rgba(255,255,255,0.55)":MUTED),
                  fontWeight:on?800:600,fontSize:11,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap",
                  boxShadow:on&&!darkBG?"0 1px 3px rgba(0,0,0,0.16),0 1px 1px rgba(0,0,0,0.06)":"none",transition:"background .18s,color .18s"}}>
                {l}
              </button>
              );
            })}
          </div>
          {(["badges","ranking"].includes(moreOpen)?moreOpen:"log")==="log" && (
          <div>
          <div style={{marginBottom:12}}><SortBar options={[["new","新しい順"],["old","古い順"],["pts_high","pt高い順"],["pts_low","pt低い順"]]} value={logSort} onChange={setLogSort}/></div>
          {myLogs.length===0 && <p style={{color:MUTED,textAlign:"center",marginTop:20}}>まだきろくがないよ</p>}
          {(()=>{
            const sorted=[...myLogs].sort((a,b)=>logSort==="new"?(b.date||"").localeCompare(a.date||""):logSort==="old"?(a.date||"").localeCompare(b.date||""):logSort==="pts_high"?b.pts-a.pts:a.pts-b.pts).slice(0,50);
            const showDivider=logSort==="new"||logSort==="old";   // 日付順のときだけ区切り線(競合レビュー要望)
            let prevKey=null; const out=[];
            sorted.forEach(l=>{
              const key=(l.date||"").slice(0,10);
              if(showDivider && key!==prevKey){
                prevKey=key;
                const dt=new Date(l.date); const w=["日","月","火","水","木","金","土"][dt.getDay()];
                const lbl=isTodayLocal(l.date)?"きょう":`${dt.getMonth()+1}月${dt.getDate()}日(${w})`;
                out.push(<div key={"d_"+key} style={{display:"flex",alignItems:"center",gap:8,margin:"14px 2px 8px"}}><div style={{height:1,flex:1,background:BORDER}}/><span style={{fontSize:11,fontWeight:900,color:MUTED,whiteSpace:"nowrap"}}>{lbl}</span><div style={{height:1,flex:1,background:BORDER}}/></div>);
              }
              const emoji=l.type==="transfer_out"?"💸":l.type==="transfer_in"?"💌":l.type==="grant"?"🎁":l.type==="gacha"?"🎰":l.type==="reward"?"🎁":l.type==="interest"?"💹":l.type==="invest_buy"?"📈":l.type==="invest_sell"?"📉":l.type==="tips"?"💡":([...(data.goodTasks||[]),...(data.badTasks||[])].find(t=>t.id===l.rid)?.emoji||"📌");
              const canDelete=l.type!=="gacha"&&!(l.label||"").startsWith("🗑 取り消し:");
              out.push(<LogRow key={l.id} l={l} emoji={emoji} canDelete={canDelete} child={child} update={update} showFlash={showFlash}/>);
            });
            return out;
          })()}
          </div>
          )}
        </div>
      )}

      {/* ── BADGES ── */}
      {effectiveTab==="more"&&!isJunior&&(["badges","ranking"].includes(moreOpen)?moreOpen:"log")==="badges"&&<BadgesSection child={child} data={data} update={update}/>}

      {/* ── 記録タブ: ランキング ── */}
      {effectiveTab==="more"&&moreOpen==="ranking"&&(()=>{
        const allMembers=[...data.children,...(data.parents||[])];
        const rank=[...allMembers]
          .filter(m=>m.visibility?.rankingParticipation!==false)
          .map(m=>({member:m,pts:calcMonthlyActivity(m.id,data.logs),streak:(data.streak||{})[m.id]?.cur||0}))
          .sort((a,b)=>b.pts-a.pts)
          .map((r,i)=>({...r,rank:i+1}));
        const MEDAL=["🥇","🥈","🥉"];
        return(
          <div style={{padding:16}}>
            {isJunior && <button onClick={()=>{taneHaptic("tap");setTab("daily");}} style={{background:"none",border:"none",color:GP,fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F,padding:"2px 0 12px",display:"flex",alignItems:"center",gap:4}}>‹ もどる</button>}
            <div style={{background:CARD,borderRadius:16,padding:"16px",border:`1px solid ${BORDER}`,boxShadow:"0 4px 16px rgba(24,35,29,0.06)"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <span style={{fontSize:16}}>🌱</span>
                <span style={{fontSize:12,fontWeight:700,color:TEXT}}>今月、みんな がんばってる</span>
              </div>
              <div style={{fontSize:11,color:MUTED,marginBottom:12}}>くらべっこじゃないよ。おたがいの がんばりを おうえんしよう🌿</div>
              {rank.length===0&&<p style={{color:MUTED,textAlign:"center",padding:"16px 0"}}>参加メンバーがいません</p>}
              {rank.map((r,i)=>(
                <div key={r.member.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<rank.length-1?`1px solid ${BORDER}`:"none"}}>
                  <div style={{width:26,height:26,borderRadius:8,background:GS,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>🌱</div>
                  <ChildAvatar child={r.member} size={32}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{r.member.name}</div>
                    <div style={{fontSize:11,color:MUTED}}>🔥 {r.streak}日連続</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontWeight:800,fontSize:14,color:G}}>+{r.pts}pt</div>
                    <div style={{fontSize:11,color:MUTED}}>今月</div>
                  </div>
                </div>
              ))}
              {rank.length>0&&<div style={{fontSize:11.5,color:GP,fontWeight:800,textAlign:"center",marginTop:12,lineHeight:1.6}}>🌿 つづけてることが、いちばんの たからもの。<br/>きょうも おたがいを おうえんしよう！</div>}
            </div>
            {onFamily&&(
              <button onClick={onFamily} style={{width:"100%",marginTop:12,padding:"11px",background:GP,border:"none",borderRadius:12,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
                👨👩👧 ファミリー詳細を見る
              </button>
            )}
          </div>
        );
      })()}

      {/* ── TIPS (learn タブに移動済み) ── */}

      {/* ── RANKING ── */}

      <style>{`@keyframes popIn{from{transform:translate(-50%,-50%) scale(.5);opacity:0}to{transform:translate(-50%,-50%) scale(1);opacity:1}}`}</style>
      {showSettings&&<SettingsModal data={data} update={update} onClose={()=>setShowSettings(false)} currentMemberId={child.id}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// ── ParentDailyTab ────────────────────────────────────
function ParentDailyTab({data,update,sb}){
  const [selSetId,setSelSetId] = useState(null);
  const [showNewSet,setShowNewSet] = useState(false);
  const [addMode,setAddMode] = useState("pick");
  const [nd,setNd] = useState({emoji:"⭐",label:"",type:"check",pts:"",target:"1",reward:"pts"});
  // ごほうび種別: pts=ポイントのみ / yaku=⭐やくそくのみ(0pt) / both=ポイント＋⭐
  const REWARD_OPTS=[["pts","💰ポイント"],["yaku","⭐やくそく"],["both","💰＋⭐"]];
  const rewardOf = t => t.req ? (((t.pts||0)===0)?"yaku":"both") : "pts";
  const [editDt,setEditDt] = useState(null);
  const [newSetForm,setNewSetForm] = useState({name:"",emoji:"📋",bonus:"50",startDate:"",endDate:""});
  const [npv,setNpv] = useState({emoji:"🎁",label:""});

  const sets = (data.dailyTaskSets||[]).map(s=>({
    ...s,
    tasks: Array.isArray(s.tasks)?s.tasks:[],
    bonus: s.bonus??50,
    active: s.active!==false,
    startDate: s.startDate||"",
    endDate: s.endDate||"",
  }));
  const today = todayKey();

  // アクティブセットの自動判定（期間外なら非アクティブ）
  const getSetStatus = s => {
    const t = todayISO();
    if(!s.active) return "off";
    if(s.startDate && t < s.startDate) return "pending";
    if(s.endDate   && t > s.endDate)   return "expired";
    return "active";
  };
  const statusLabel = {active:"● 配信中",pending:"⏳ 開始前",expired:"終了",off:"停止中"};
  const statusColor = {active:G,pending:Y,expired:MUTED,off:MUTED};

  const selSet = sets.find(s=>s.id===selSetId)||null;

  const addSet = () => {
    if(!newSetForm.name) return;
    const newId = "set_"+uid();
    const newSet = {
      id:newId, name:newSetForm.name, emoji:newSetForm.emoji,
      tasks:[], bonus:parseInt(newSetForm.bonus)||50,
      startDate:newSetForm.startDate, endDate:newSetForm.endDate,
      active:true, updatedAt:Date.now(),
    };
    markLocalDefEdit();
    update(d=>({...d, dailyTaskSets:[...(d.dailyTaskSets||[]),newSet]}));
    setSelSetId(newId);
    setShowNewSet(false);
    setNewSetForm({name:"",emoji:"📋",bonus:"50",startDate:"",endDate:""});
  };

  const delSet = id => {
    if(sets.length<=1){alert("最低1つはセットが必要です");return;}
    markLocalDefEdit();
    update(d=>({...d,
      dailyTaskSets:(d.dailyTaskSets||[]).filter(s=>s.id!==id),
      activeSetId: d.activeSetId===id ? (d.dailyTaskSets.find(s=>s.id!==id)?.id||"") : d.activeSetId,
    }));
    setSelSetId(null);
  };

  const updateSet = (id,changes) => { markLocalDefEdit(); return update(d=>({...d,
    dailyTaskSets:(d.dailyTaskSets||[]).map(s=>s.id===id?{...s,...changes,updatedAt:Date.now()}:s)
  })); };

  // 最大4セットを同時アクティブにトグル(5つ目を選ぶと一番古い選択が外れる)
  const toggleActive = id => { markLocalDefEdit(); return update(d=>{
    const cur = Array.isArray(d.activeSetIds) ? d.activeSetIds.filter(x=>(d.dailyTaskSets||[]).some(s=>s.id===x)) : (d.activeSetId?[d.activeSetId]:[]);
    let next;
    if (cur.includes(id)) next = cur.filter(x=>x!==id);     // 解除
    else next = [...cur, id].slice(-4);                      // 追加(最大4・古いものから押し出し)
    if (next.length===0) next = [id];                        // 最低1つは残す
    return {...d, activeSetIds: next, activeSetId: next[0],
      dailyTaskSets:(d.dailyTaskSets||[]).map(s=>next.includes(s.id)?{...s,active:true,updatedAt:Date.now()}:s)};
  }); };

  const addTaskToSet = (setId, task) => { markLocalDefEdit(); return update(d=>({...d,
    dailyTaskSets:(d.dailyTaskSets||[]).map(s=>s.id===setId?{...s,tasks:[...s.tasks,task],updatedAt:Date.now()}:s)
  })); };
  const delTaskFromSet = (setId, taskId) => { markLocalDefEdit(); return update(d=>({...d,
    dailyTaskSets:(d.dailyTaskSets||[]).map(s=>s.id===setId?{...s,tasks:s.tasks.filter(t=>t.id!==taskId),updatedAt:Date.now()}:s)
  })); };
  const saveTaskEdit = (setId) => {
    markLocalDefEdit();
    if(!editDt) return;
    const rw=editDt.reward||rewardOf({...editDt,pts:parseInt(editDt.pts)||0});
    const pts=rw==="yaku"?0:parseInt(editDt.pts); if(isNaN(pts)) return;
    const {reward:_rw,...rest}=editDt;
    update(d=>({...d,
      dailyTaskSets:(d.dailyTaskSets||[]).map(s=>s.id===setId?{...s,tasks:s.tasks.map(t=>t.id===editDt.id?{...rest,pts,target:parseInt(editDt.target)||1,req:rw!=="pts"}:t),updatedAt:Date.now()}:s)
    }));
    setEditDt(null);
  };
  // 曜日チップ(dow)・やくそく(req)のトグル。dowなし/空=毎日(後方互換)
  const DOWS=["日","月","火","水","木","金","土"];
  const updateTaskInSet=(setId,taskId,fn)=>{ markLocalDefEdit(); return update(d=>({...d,
    dailyTaskSets:(d.dailyTaskSets||[]).map(s=>s.id===setId?{...s,tasks:(Array.isArray(s.tasks)?s.tasks:[]).map(t=>t.id===taskId?fn(t):t),updatedAt:Date.now()}:s)
  })); };
  const toggleDow=(setId,taskId,day)=>updateTaskInSet(setId,taskId,tt=>{
    const cur=Array.isArray(tt.dow)?tt.dow:[];
    return {...tt, dow: cur.includes(day)?cur.filter(x=>x!==day):[...cur,day].sort((a,b)=>a-b)};
  });

  const vacMode = !!(data.familySettings && data.familySettings.vacationMode);
  const toggleVacMode = () => update(d=>({...d,
    familySettings:{...(d.familySettings||{}), vacationMode: !(d.familySettings&&d.familySettings.vacationMode)}
  }));

  return(<div style={{padding:16}}>

    {/* ── 🏖 長期休みモード ── */}
    <div style={{background:vacMode?`${B}12`:CARD,border:`2px solid ${vacMode?B:BORDER}`,borderRadius:16,padding:"12px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:10}}>
      <span style={{fontSize:26,flexShrink:0}}>🏖</span>
      <div style={{flex:1}}>
        <div style={{fontWeight:900,fontSize:14,color:vacMode?B:TEXT}}>長期休みモード{vacMode?"（ON）":""}</div>
        <div style={{color:MUTED,fontSize:11,marginTop:2,lineHeight:1.5}}>夏休み・冬休みは 長期休み用セットに切り替え</div>
      </div>
      <button onClick={toggleVacMode}
        style={{background:vacMode?B:BORDER,border:"none",borderRadius:16,width:46,height:26,cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:0}}>
        <div style={{position:"absolute",top:3,left:vacMode?23:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
      </button>
    </div>

    {/* ── 🎁 やくそくのごほうび ── */}
    {(()=>{
      const privs=(data.familySettings&&Array.isArray(data.familySettings.privileges))?data.familySettings.privileges:[];
      const setPrivs=fn=>update(d=>{
        const cur=(d.familySettings&&Array.isArray(d.familySettings.privileges))?d.familySettings.privileges:[];
        return {...d, familySettings:{...(d.familySettings||{}), privileges:fn(cur)}};
      });
      return(<div style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:16,padding:"12px 14px",marginBottom:12}}>
        <p style={{fontWeight:900,fontSize:14,color:TEXT,margin:"0 0 4px"}}>🎁 やくそくのごほうび（あしたの おたのしみ）</p>
        <p style={{color:MUTED,fontSize:11,lineHeight:1.6,margin:"0 0 10px"}}>⭐やくそくを ぜんぶクリアすると、翌日に使えるごほうびです（ポイントとは別）</p>
        {privs.map(pv=>(
          <div key={pv.id} style={{display:"flex",alignItems:"center",gap:8,background:BG,borderRadius:10,padding:"7px 10px",marginBottom:6}}>
            <span style={{fontSize:18,flexShrink:0}}>{pv.emoji}</span>
            <span style={{flex:1,fontWeight:700,fontSize:13}}>{pv.label}</span>
            <button onClick={()=>setPrivs(cur=>cur.filter(x=>x.id!==pv.id))}
              style={{width:26,height:26,borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F,padding:0,lineHeight:1}}>✕</button>
          </div>
        ))}
        {privs.length===0&&<p style={{color:MUTED,fontSize:12,textAlign:"center",margin:"4px 0 8px"}}>まだごほうびがありません</p>}
        <div style={{display:"flex",gap:6}}>
          <input value={npv.emoji} onChange={e=>setNpv(v=>({...v,emoji:e.target.value}))} style={{...INP,width:50}} placeholder="絵文字"/>
          <input value={npv.label} onChange={e=>setNpv(v=>({...v,label:e.target.value}))} style={{...INP,flex:1}} placeholder="ごほうび名（例：ゲーム）"/>
          <Btn c={G} label="＋追加" onClick={()=>{
            if(!npv.label) return;
            setPrivs(cur=>[...cur,{id:"pv_"+uid(),emoji:npv.emoji||"🎁",label:npv.label}]);
            setNpv({emoji:"🎁",label:""});
          }} disabled={!npv.label} sm/>
        </div>
      </div>);
    })()}

    {/* ── セット一覧 ── */}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
      <p style={{fontWeight:900,fontSize:15,color:TEXT,margin:0}}>📋 タスクセット管理</p>
      <Btn c={G} label="＋ 新セット" onClick={()=>setShowNewSet(true)} sm/>
    </div>

    {/* 新セット作成フォーム */}
    {showNewSet&&<div style={{background:`${G}12`,border:`2px dashed ${G}`,borderRadius:16,padding:16,marginBottom:14}}>
      <p style={{fontWeight:800,fontSize:13,color:G,margin:"0 0 12px"}}>新しいタスクセットを作成</p>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <input value={newSetForm.emoji} onChange={e=>setNewSetForm(f=>({...f,emoji:e.target.value}))} style={{...INP,width:54}} placeholder="絵文字"/>
        <input value={newSetForm.name} onChange={e=>setNewSetForm(f=>({...f,name:e.target.value}))} placeholder="セット名（例：夏休み）" style={INP}/>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
        <span style={{color:MUTED,fontSize:12,fontWeight:700,flexShrink:0}}>全達成ボーナス</span>
        <input value={newSetForm.bonus} onChange={e=>setNewSetForm(f=>({...f,bonus:e.target.value}))} type="number" style={{...INP,flex:1}} placeholder="50"/>
        <span style={{color:MUTED,fontSize:12,flexShrink:0}}>pt</span>
      </div>
      <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 6px"}}>期間（省略可＝常時有効）</p>
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
        <input value={newSetForm.startDate} onChange={e=>setNewSetForm(f=>({...f,startDate:e.target.value}))} type="date" style={{...INP,flex:1}}/>
        <span style={{color:MUTED}}>〜</span>
        <input value={newSetForm.endDate} onChange={e=>setNewSetForm(f=>({...f,endDate:e.target.value}))} type="date" style={{...INP,flex:1}}/>
      </div>
      <div style={{display:"flex",gap:8}}>
        <Btn c={G} label="作成する" onClick={addSet} disabled={!newSetForm.name} sm/>
        <Btn c={MUTED} label="キャンセル" onClick={()=>setShowNewSet(false)} sm/>
      </div>
    </div>}

    {/* セットカード一覧 */}
    {sets.map(s=>{
      const status=getSetStatus(s);
      const activeIds=Array.isArray(data.activeSetIds)&&data.activeSetIds.length?data.activeSetIds:[data.activeSetId];
      const isActive=activeIds.includes(s.id);
      const isOpen=selSetId===s.id;
      return(<div key={s.id} style={{background:CARD,border:`2px solid ${isActive?G:isOpen?B:BORDER}`,borderRadius:18,marginBottom:10,overflow:"hidden"}}>

        {/* セットヘッダー */}
        <div style={{padding:"12px 14px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22,flexShrink:0}}>{s.emoji}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:14,color:TEXT}}>{s.name}</div>
            <div style={{display:"flex",gap:8,marginTop:2,flexWrap:"wrap"}}>
              <span style={{fontSize:11,fontWeight:700,color:statusColor[status]}}>{statusLabel[status]}</span>
              <span style={{fontSize:11,color:MUTED}}>{s.tasks.length}タスク · ボーナス{s.bonus}pt</span>
              {s.vacation&&<span style={{fontSize:11,fontWeight:700,color:B}}>🏖 長期休み用</span>}
              {s.startDate&&<span style={{fontSize:11,color:MUTED}}>{s.startDate}〜{s.endDate||"無期限"}</span>}
            </div>
          </div>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            {/* アクティブ切替（最大2つ同時。タップでON/OFF） */}
            {!isActive&&<button onClick={()=>toggleActive(s.id)}
              style={{padding:"4px 10px",background:`${G}15`,border:`1.5px solid ${G}`,borderRadius:8,color:G,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>
              ＋使う
            </button>}
            {isActive&&<button onClick={()=>toggleActive(s.id)}
              style={{padding:"4px 10px",background:`${G}30`,border:`1.5px solid ${G}`,borderRadius:8,color:G,fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F}}>使用中✓</button>}
            {/* 展開 */}
            <button onClick={()=>setSelSetId(isOpen?null:s.id)}
              style={{padding:"4px 8px",background:"transparent",border:`1px solid ${BORDER}`,borderRadius:8,color:MUTED,fontSize:13,cursor:"pointer",fontFamily:F}}>
              {isOpen?"▲":"▼"}
            </button>
            {/* 削除 */}
            {sb(R,"🗑",()=>delSet(s.id))}
          </div>
        </div>

        {/* セット詳細（展開時） */}
        {isOpen&&<div style={{borderTop:`1px solid ${BORDER}`,padding:"12px 14px"}}>

          {/* セット設定編集 */}
          <div style={{background:BG,borderRadius:12,padding:"10px 12px",marginBottom:12}}>
            <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>セット設定</p>
            <div style={{display:"flex",gap:8,marginBottom:6}}>
              <input value={s.emoji} onChange={e=>updateSet(s.id,{emoji:e.target.value})} style={{...INP,width:54}}/>
              <input value={s.name} onChange={e=>updateSet(s.id,{name:e.target.value})} style={INP}/>
            </div>
            <div style={{marginBottom:6}}>
              {/* 全クリアのごほうび: ポイント / やくそく(翌日のごほうび) / 両方 */}
              <div style={{display:"flex",gap:5,alignItems:"center",marginBottom:5}}>
                <span style={{color:MUTED,fontSize:11,flexShrink:0}}>全クリアで</span>
                {REWARD_OPTS.map(([x,l])=>{const cur=s.bonusReward||"pts";return(
                  <button key={x} onClick={()=>updateSet(s.id,{bonusReward:x})} style={{flex:1,padding:"5px 0",border:`2px solid ${cur===x?GOLD:BORDER}`,borderRadius:8,background:cur===x?`${GOLD}20`:"transparent",fontWeight:700,fontSize:10,cursor:"pointer",fontFamily:F,color:cur===x?"#9a7000":MUTED}}>{l}</button>
                );})}
              </div>
              {(s.bonusReward||"pts")!=="yaku"?(
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span style={{color:MUTED,fontSize:11,flexShrink:0}}>ボーナス</span>
                  <input value={s.bonus} onChange={e=>updateSet(s.id,{bonus:parseInt(e.target.value)||0})} type="number" style={{...INP,flex:1}}/>
                  <span style={{color:MUTED,fontSize:11,flexShrink:0}}>pt</span>
                </div>
              ):(
                <p style={{color:MUTED,fontSize:10,lineHeight:1.5,margin:0}}>ぜんぶクリアで、翌日の🎁ごほうび(スマホ等)が解放されます（ポイントは付きません）</p>
              )}
            </div>
            <div style={{display:"flex",gap:6,marginBottom:6,alignItems:"center"}}>
              <span style={{color:MUTED,fontSize:11,flexShrink:0}}>期間</span>
              <input value={s.startDate} onChange={e=>updateSet(s.id,{startDate:e.target.value})} type="date" style={{...INP,flex:1,fontSize:11}}/>
              <span style={{color:MUTED}}>〜</span>
              <input value={s.endDate} onChange={e=>updateSet(s.id,{endDate:e.target.value})} type="date" style={{...INP,flex:1,fontSize:11}}/>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{color:MUTED,fontSize:11}}>有効</span>
              <button onClick={()=>updateSet(s.id,{active:!s.active})}
                style={{background:s.active?G:BORDER,border:"none",borderRadius:16,width:40,height:22,cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:0}}>
                <div style={{position:"absolute",top:3,left:s.active?20:3,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
              </button>
              <span style={{color:s.active?G:MUTED,fontSize:11,fontWeight:700}}>{s.active?"ON":"OFF"}</span>
              <span style={{width:8}}/>
              <span style={{color:MUTED,fontSize:11}}>🏖 長期休み用</span>
              <button onClick={()=>updateSet(s.id,{vacation:!s.vacation})}
                style={{background:s.vacation?B:BORDER,border:"none",borderRadius:16,width:40,height:22,cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:0}}>
                <div style={{position:"absolute",top:3,left:s.vacation?20:3,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
              </button>
            </div>
          </div>

          {/* タスク一覧 */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <p style={{color:MUTED,fontSize:12,fontWeight:800,margin:0}}>タスク（{s.tasks.length}件）</p>
            <Btn c={G} label="＋ 追加" onClick={()=>{setAddMode("pick");}} sm/>
          </div>
          {s.tasks.map(t=>(
            <div key={t.id} style={{background:BG,borderRadius:12,padding:"9px 12px",marginBottom:6}}>
              {editDt?.id===t.id
                ?<div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}><input value={editDt.emoji} onChange={e=>setEditDt(v=>({...v,emoji:e.target.value}))} style={{...INP,width:50}}/><input value={editDt.label} onChange={e=>setEditDt(v=>({...v,label:e.target.value}))} style={INP}/></div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>
                    {[["check","✅ チェック"],["count","🔢 回数"]].map(([x,l])=><button key={x} onClick={()=>setEditDt(v=>({...v,type:x}))} style={{flex:1,padding:"6px 0",border:`2px solid ${editDt.type===x?G:BORDER}`,borderRadius:8,background:editDt.type===x?`${G}15`:"transparent",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,color:editDt.type===x?G:MUTED}}>{l}</button>)}
                  </div>
                  <p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>ごほうび</p>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>
                    {REWARD_OPTS.map(([x,l])=><button key={x} onClick={()=>setEditDt(v=>({...v,reward:x}))} style={{flex:1,padding:"6px 0",border:`2px solid ${(editDt.reward||"pts")===x?GOLD:BORDER}`,borderRadius:8,background:(editDt.reward||"pts")===x?`${GOLD}20`:"transparent",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,color:(editDt.reward||"pts")===x?"#9a7000":MUTED}}>{l}</button>)}
                  </div>
                  {(editDt.reward||"pts")==="yaku"&&<p style={{color:MUTED,fontSize:10,lineHeight:1.5,margin:"0 0 6px"}}>ポイントは付きません。クリアすると翌日の🎁ごほうび(スマホ等)の条件になります</p>}
                  <div style={{display:"flex",gap:6,marginBottom:6}}>
                    {(editDt.reward||"pts")!=="yaku"&&<div style={{flex:1}}><p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>pt</p><input value={editDt.pts} onChange={e=>setEditDt(v=>({...v,pts:e.target.value}))} type="number" style={INP}/></div>}
                    {editDt.type==="count"&&<div style={{flex:1}}><p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>目標回数</p><input value={editDt.target} onChange={e=>setEditDt(v=>({...v,target:e.target.value}))} type="number" style={INP}/></div>}
                  </div>
                  <div style={{display:"flex",gap:6}}><Btn c={G} label="保存" onClick={()=>saveTaskEdit(s.id)} sm/><Btn c={MUTED} label="キャンセル" onClick={()=>setEditDt(null)} sm/></div>
                </div>
                :<div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:18,flexShrink:0}}>{t.emoji}</span>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13}}>{t.label}</div>
                      <div style={{color:MUTED,fontSize:11}}>{t.type==="check"?"✅":"🔢"} {(t.pts||0)===0?<span style={{color:"#9a7000",fontWeight:700}}>⭐やくそく（ポイントなし）</span>:`+${t.pts}pt`}{t.type==="count"&&` · 目標${t.target||1}回`}</div>
                    </div>
                    <div style={{display:"flex",gap:4}}>
                      <Btn c={B} label="✏" onClick={()=>setEditDt({...t,pts:String(t.pts),target:String(t.target||1),reward:rewardOf(t)})} sm/>
                      <Btn c={R} label="🗑" onClick={()=>delTaskFromSet(s.id,t.id)} sm/>
                    </div>
                  </div>
                  {/* 曜日チップ（選んだ曜日だけ表示。なにも選ばないと毎日） */}
                  <div style={{display:"flex",gap:4,marginTop:7,alignItems:"center",flexWrap:"wrap"}}>
                    {DOWS.map((lb,day)=>{
                      const on=Array.isArray(t.dow)&&t.dow.includes(day);
                      const c=day===0?R:day===6?B:GP;
                      return(<button key={day} onClick={()=>toggleDow(s.id,t.id,day)}
                        style={{width:26,height:26,borderRadius:"50%",border:`1.5px solid ${on?c:BORDER}`,background:on?c:CARD,color:on?"#fff":(day===0?R:day===6?B:MUTED),fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F,padding:0,lineHeight:1}}>
                        {lb}
                      </button>);
                    })}
                    <button onClick={()=>updateTaskInSet(s.id,t.id,tt=>({...tt,req:!tt.req}))}
                      style={{marginLeft:2,padding:"4px 9px",borderRadius:999,border:`1.5px solid ${t.req?Y:BORDER}`,background:t.req?`${Y}25`:CARD,color:t.req?"#9a7000":MUTED,fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F}}>
                      ⭐やくそく{t.req?"✓":""}
                    </button>
                  </div>
                  <p style={{color:MUTED,fontSize:10,margin:"5px 0 0"}}>曜日：なにも選ばないと毎日 ／ ⭐やくそく＝あしたのごほうびの条件</p>
                </div>}
            </div>
          ))}

          {/* タスク追加パネル */}
          {(()=>{
            const allTasks=(data.goodTasks||[]);   // 追加済みでも除外しない＝同じタスクを何個でも入れられる
            return(<div style={{background:`${G}10`,border:`1.5px dashed ${G}`,borderRadius:12,padding:12,marginTop:4}}>
              <div style={{display:"flex",gap:0,background:BORDER,borderRadius:8,overflow:"hidden",marginBottom:10}}>
                {[["pick","📋 お手伝いから選ぶ"],["manual","✏ 手動入力"]].map(([v,l])=>(
                  <button key={v} onClick={()=>setAddMode(v)} style={{flex:1,padding:"7px 0",border:"none",background:addMode===v?G:"transparent",color:addMode===v?"#fff":MUTED,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>
                ))}
              </div>
              {addMode==="pick"?(
                <div style={{maxHeight:220,overflowY:"auto",display:"flex",flexDirection:"column",gap:5}}>
                  {allTasks.length===0&&<p style={{color:MUTED,fontSize:12,textAlign:"center",padding:"8px 0"}}>お手伝いが まだ登録されていません</p>}
                  {allTasks.map(t=>{
                    const cnt=s.tasks.filter(x=>(x.srcId||"")===t.id).length;   // このセットに何個入っているか
                    return (
                    <button key={t.id} onClick={()=>addTaskToSet(s.id,{id:uid(),srcId:t.id,emoji:t.emoji,label:t.label,type:"check",pts:t.pts,target:1})}
                      style={{background:CARD,border:`1.5px solid ${cnt>0?G:BORDER}`,borderRadius:10,padding:"8px 12px",display:"flex",alignItems:"center",gap:8,cursor:"pointer",textAlign:"left",fontFamily:F}}>
                      <span style={{fontSize:18,flexShrink:0}}>{t.emoji}</span>
                      <div style={{flex:1}}><div style={{fontWeight:700,fontSize:12}}>{t.label}</div><div style={{color:MUTED,fontSize:11}}>+{t.pts}pt{cnt>0&&<span style={{color:G,fontWeight:800}}> ・ {cnt}こ追加ずみ</span>}</div></div>
                      <span style={{color:G,fontSize:16,fontWeight:900}}>＋</span>
                    </button>
                    );
                  })}
                </div>
              ):(
                <div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}><input value={nd.emoji} onChange={e=>setNd(v=>({...v,emoji:e.target.value}))} style={{...INP,width:50}}/><input value={nd.label} onChange={e=>setNd(v=>({...v,label:e.target.value}))} placeholder="タスク名" style={INP}/></div>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>{[["check","✅"],["count","🔢"]].map(([x,l])=><button key={x} onClick={()=>setNd(v=>({...v,type:x}))} style={{flex:1,padding:"5px 0",border:`2px solid ${nd.type===x?G:BORDER}`,borderRadius:8,background:nd.type===x?`${G}15`:"transparent",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,color:nd.type===x?G:MUTED}}>{l}</button>)}</div>
                  <p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>ごほうび</p>
                  <div style={{display:"flex",gap:6,marginBottom:6}}>
                    {REWARD_OPTS.map(([x,l])=><button key={x} onClick={()=>setNd(v=>({...v,reward:x}))} style={{flex:1,padding:"5px 0",border:`2px solid ${(nd.reward||"pts")===x?GOLD:BORDER}`,borderRadius:8,background:(nd.reward||"pts")===x?`${GOLD}20`:"transparent",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F,color:(nd.reward||"pts")===x?"#9a7000":MUTED}}>{l}</button>)}
                  </div>
                  {(nd.reward||"pts")==="yaku"&&<p style={{color:MUTED,fontSize:10,lineHeight:1.5,margin:"0 0 6px"}}>ポイントは付きません。クリアすると翌日の🎁ごほうび(スマホ等)の条件になります</p>}
                  <div style={{display:"flex",gap:6,marginBottom:8}}>
                    {(nd.reward||"pts")!=="yaku"&&<div style={{flex:1}}><p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>pt</p><input value={nd.pts} onChange={e=>setNd(v=>({...v,pts:e.target.value}))} type="number" style={INP}/></div>}
                    {nd.type==="count"&&<div style={{flex:1}}><p style={{color:MUTED,fontSize:11,margin:"0 0 2px"}}>目標回数</p><input value={nd.target} onChange={e=>setNd(v=>({...v,target:e.target.value}))} type="number" style={INP}/></div>}
                  </div>
                  <Btn c={G} label="追加する" onClick={()=>{
                    const rw=nd.reward||"pts";
                    const pts=rw==="yaku"?0:parseInt(nd.pts);if(!nd.label||isNaN(pts))return;
                    addTaskToSet(s.id,{id:uid(),emoji:nd.emoji,label:nd.label,type:nd.type,pts,target:parseInt(nd.target)||1,req:rw!=="pts"});
                    setNd({emoji:"⭐",label:"",type:"check",pts:"",target:"1",reward:"pts"});
                  }} disabled={!nd.label||((nd.reward||"pts")!=="yaku"&&!nd.pts)} sm/>
                </div>
              )}
            </div>);
          })()}

          {/* 今日の達成状況 */}
          <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${BORDER}`}}>
            <p style={{color:MUTED,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>今日の達成状況</p>
            {data.children.map(child=>{
              const prog=(data.dailyProgress||{})[child.id]?.[today]||{};
              const vis=s.tasks.filter(t=>!Array.isArray(t.dow)||t.dow.length===0||t.dow.includes(new Date().getDay()));
              const done=vis.filter(t=>t.type==="check"?!!prog[t.id]:(prog[t.id]||0)>=(t.target||1)).length;
              const allD=done===vis.length&&vis.length>0;
              return(<div key={child.id} style={{display:"flex",alignItems:"center",gap:8,background:allD?"#e8faf0":BG,border:`1px solid ${allD?G:BORDER}`,borderRadius:10,padding:"7px 10px",marginBottom:6}}>
                <ChildAvatar child={child} size={24}/>
                <span style={{fontWeight:700,fontSize:12,flex:1}}>{child.name}</span>
                <span style={{color:allD?G:MUTED,fontWeight:800,fontSize:11}}>{done}/{vis.length} {allD?"🌟":""}</span>
                <PromptModalButton btnLabel="🎁 付与" title={`${child.name}に ボーナスpt`} desc={`${s.name} のごほうび。何ポイント あげる？`} type="number" maxLen={4} initial={String((data.childDailyBonus||{})[child.id]??s.bonus)} placeholder="pt"
                  btnStyle={{padding:"3px 8px",background:`${Y}20`,border:`1px solid ${Y}`,borderRadius:7,color:"#9a7000",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}
                  onSubmit={(val)=>{ const amt=parseInt(val); if(!isNaN(amt)&&amt>0){const _e={id:uid(),cid:child.id,type:"grant",label:`🌟 ボーナスpt（${s.name}）`,pts:amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);} }}/>
              </div>);
            })}
          </div>
        </div>}
      </div>);
    })}

    {sets.length===0&&<div style={{textAlign:"center",padding:"32px 0"}}>
      <p style={{color:MUTED,fontSize:14}}>まだタスクセットがないよ</p>
      <Btn c={G} label="＋ 最初のセットを作る" onClick={()=>setShowNewSet(true)}/>
    </div>}
  </div>);
}


// ── AI Advisor Tab ────────────────────────────────────
function AiAdvisorTab({data}){
  const [loading,setLoading]=useState(false);
  const [result,setResult]=useState(null);
  const [error,setError]=useState(null);

  // 本番(Vercel)ではAPIキー無しの直接呼び出しが401になるため機能を停止。
  // 子どもの行動データを外部AIへ送る導線でもあり、サーバ経由化するまで「準備中」を表示
  if(!hasCloudStorage()){
    return (
      <div style={{textAlign:"center",padding:"40px 20px"}}>
        <div style={{fontSize:48,marginBottom:10}}>🤖</div>
        <div style={{fontWeight:900,fontSize:16,color:TEXT,marginBottom:6}}>AI分析はじゅんび中です</div>
        <p style={{color:MUTED,fontSize:13,lineHeight:1.8,maxWidth:300,margin:"0 auto"}}>
          家族のがんばりをAIが分析してアドバイスする機能を準備しています。もうしばらくお待ちください！
        </p>
      </div>
    );
  }

  const buildPrompt=()=>{
    const logs=data.logs||[];
    const children=data.children||[];
    const goodTasks=data.goodTasks||[];
    const badTasks=data.badTasks||[];
    const rewards=data.rewards||[];
    const childStats=children.map(c=>{
      const cLogs=logs.filter(l=>l.cid===c.id);
      const earned=cLogs.filter(l=>l.pts>0).reduce((s,l)=>s+l.pts,0);
      const spent=Math.abs(cLogs.filter(l=>l.pts<0).reduce((s,l)=>s+l.pts,0));
      const taskLogs=cLogs.filter(l=>l.type==="good");
      const rewardLogs=cLogs.filter(l=>l.type==="reward");
      const balance=bal(logs,c.id);
      const taskCounts={};
      taskLogs.forEach(l=>{taskCounts[l.label]=(taskCounts[l.label]||0)+1;});
      const topTasks=Object.entries(taskCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([l,n])=>l+"("+n+"回)");
      const rewCounts={};
      rewardLogs.forEach(l=>{rewCounts[l.label]=(rewCounts[l.label]||0)+1;});
      const topRews=Object.entries(rewCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([l,n])=>l+"("+n+"回)");
      return{name:c.name,age:c.ageMode,balance,earned,spent,ratio:spent>0?(earned/spent).toFixed(1):"0",taskCount:taskLogs.length,topTasks,topRews};
    });
    const taskList=goodTasks.map(t=>t.label+":"+t.pts+"pt").join(", ");
    const badList=badTasks.map(t=>t.label+":"+t.pts+"pt").join(", ");
    const rewardList=rewards.map(r=>r.label+":"+r.cost+"pt").join(", ");
    const statsText=childStats.map(c=>
      "\n- "+c.name+"("+c.age+"): 残高"+c.balance+"pt / 獲得"+c.earned+"pt / 使用"+c.spent+"pt / 稼ぎ消費比"+c.ratio+"倍 / お手伝い"+c.taskCount+"回"+
      " / よくやるタスク:["+(c.topTasks.join(",")||"なし")+"] / よく使うこうかん:["+(c.topRews.join(",")||"なし")+"]"
    ).join("");
    return "あなたは子どもの家庭内ポイント制度のアドバイザーです。以下データを分析して日本語で具体的なアドバイスをください。\n\n"+
      "【お手伝いタスク（プラス）】\n"+taskList+"\n\n"+
      "【マイナスタスク】\n"+badList+"\n\n"+
      "【こうかん一覧】\n"+rewardList+"\n\n"+
      "【子どもの実績】"+statsText+"\n\n"+
      "以下の観点で分析してください（各項目に★1〜5で評価）：\n"+
      "1. ポイントバランスの評価（稼ぎやすさと使いやすさのバランス）\n"+
      "2. タスクptの妥当性（各タスクのpt設定は労力に見合っているか）\n"+
      "3. こうかんptの妥当性（ご褒美のコストは適切か）\n"+
      "4. 子どもごとの行動パターン分析\n"+
      "5. 具体的な改善提案（数値を含む提案3〜5点）\n"+
      "前向きな表現で、家族が実践しやすいアドバイスをお願いします。";
  };

  const runAnalysis=async()=>{
    if(!hasCloudStorage())return; // 二重ガード: 本番では外部AIへ送信しない（UIゲートと独立に保証）
    setLoading(true);setResult(null);setError(null);
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",max_tokens:1000,
          messages:[{role:"user",content:buildPrompt()}]
        })
      });
      const json=await res.json();
      const text=json.content?.find(b=>b.type==="text")?.text||"分析結果を取得できませんでした";
      setResult(text);
    }catch(e){
      setError("分析中にエラーが発生しました。もう一度お試しください。");
    }finally{setLoading(false);}
  };

  const renderResult=text=>text.split("\n").map((line,i)=>{
    const isBold=line.match(/^\d+\./) || line.startsWith("**");
    const isItem=line.startsWith("-")||line.startsWith("・");
    const cleaned=line.replace(/\*\*/g,"").trim();
    if(!cleaned) return <div key={i} style={{height:6}}/>;
    return <p key={i} style={{margin:0,marginBottom:2,fontSize:isBold?13:12,fontWeight:isBold?900:400,color:isBold?TEXT:MUTED,paddingLeft:isItem?12:0,lineHeight:1.7}}>{cleaned}</p>;
  });

  const logs=data.logs||[];
  const totalEarned=logs.filter(l=>l.pts>0).reduce((s,l)=>s+l.pts,0);
  const totalSpent=Math.abs(logs.filter(l=>l.pts<0).reduce((s,l)=>s+l.pts,0));
  const taskCount=logs.filter(l=>l.type==="good").length;
  const rewardCount=logs.filter(l=>l.type==="reward").length;

  return(
    <div style={{padding:16,paddingBottom:40,fontFamily:F}}>
      <div style={{background:"linear-gradient(135deg,#1a1a2e,#16213e)",borderRadius:20,padding:"20px",marginBottom:16,color:"#fff",textAlign:"center"}}>
        <div style={{fontSize:48,marginBottom:8}}>🤖</div>
        <h2 style={{fontWeight:900,fontSize:18,margin:"0 0 6px",color:"#fff"}}>AI ポイント分析</h2>
        <p style={{color:"#aaa",fontSize:12,margin:"0 0 16px",lineHeight:1.6}}>タスクpt・こうかんコスト・行動パターンを総合分析します</p>
        <button onClick={runAnalysis} disabled={loading}
          style={{background:loading?"#333":"linear-gradient(135deg,#f5c842,#34c77b)",border:"none",borderRadius:14,padding:"13px 32px",color:loading?"#888":"#1a1a2e",fontWeight:900,fontSize:15,cursor:loading?"default":"pointer",fontFamily:F,opacity:loading?0.7:1,width:"100%"}}>
          {loading?"🔄 分析中（10〜20秒）...":"✨ AI分析をスタート"}
        </button>
      </div>

      {!result&&!loading&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
          {[["📈","獲得合計",totalEarned.toLocaleString()+"pt",G],["📉","使用合計",totalSpent.toLocaleString()+"pt",R],["🏆","お手伝い",taskCount+"回",B],["🎁","こうかん",rewardCount+"回",P]].map(([e,l,v,c])=>(
            <div key={l} style={{background:CARD,border:"1.5px solid "+BORDER,borderRadius:14,padding:"12px 14px",textAlign:"center"}}>
              <div style={{fontSize:22,marginBottom:4}}>{e}</div>
              <div style={{color:MUTED,fontSize:11,fontWeight:700,marginBottom:2}}>{l}</div>
              <div style={{fontWeight:900,fontSize:16,color:c}}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {error&&<div style={{background:"#fef0ef",border:"1.5px solid "+R,borderRadius:14,padding:"14px 16px",marginBottom:16}}>
        <p style={{color:R,fontWeight:700,fontSize:13,margin:0}}>{error}</p>
      </div>}

      {result&&(
        <div style={{background:CARD,border:"2px solid "+G,borderRadius:20,padding:"18px 16px"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,paddingBottom:12,borderBottom:"1px solid "+BORDER}}>
            <span style={{fontSize:20}}>🤖</span>
            <div>
              <div style={{fontWeight:900,fontSize:14,color:TEXT}}>AI分析レポート</div>
              <div style={{color:MUTED,fontSize:11}}>{new Date().toLocaleDateString("ja-JP")} 生成</div>
            </div>
          </div>
          <div>{renderResult(result)}</div>
          <div style={{marginTop:16,paddingTop:12,borderTop:"1px solid "+BORDER,display:"flex",gap:8}}>
            <button onClick={runAnalysis} style={{flex:1,padding:"10px 0",background:G+"15",border:"1.5px solid "+G,borderRadius:12,color:G,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>🔄 再分析</button>
            <button onClick={()=>navigator.clipboard?.writeText(result)} style={{flex:1,padding:"10px 0",background:B+"15",border:"1.5px solid "+B,borderRadius:12,color:B,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>📋 コピー</button>
          </div>
        </div>
      )}
    </div>
  );
}


// ── 運用損益コンポーネント（株・為替） ────────────────────────
function InvestLearnTab({child, data, update, onRanking}){
  const [sub,setSub]=useState("stocks");
  const perm=(child.permissions||{});
  const canTrade=perm[sub]==="trade";
  const op=calcMemberOperation(child.id,data,sub);
  const stocks=data.stocks||[];
  const forex=data.forex||{};

  return(
    <div style={{padding:"16px 20px"}}>
      <div style={{background:"#E5F0FF",borderRadius:12,padding:"10px 14px",marginBottom:14,fontSize:11,color:"#3478D4",fontWeight:600}}>
        📊 これは実際のお金を使わない投資シミュレーションです。価格は上下し、増えることも減ることもあります。
      </div>
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        {[["stocks","株式"]].map(([k,l])=>(
          <button key={k} onClick={()=>setSub(k)} style={{flex:1,padding:"8px 0",border:"none",borderRadius:10,background:sub===k?GP:"transparent",color:sub===k?"#fff":MUTED,fontWeight:sub===k?700:400,fontSize:12,cursor:"pointer",fontFamily:F}}>{l}</button>
        ))}
      </div>
      {op&&(
        <div style={{background:CARD,borderRadius:16,padding:"14px",marginBottom:12,boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
          <div style={{fontSize:11,color:MUTED,marginBottom:8}}>運用成績（手数料込み）</div>
          <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:4}}>
            <span style={{fontSize:28,fontWeight:900,color:op.rate>=0?G:R,lineHeight:1}}>{op.rate>=0?"+":""}{op.rate.toFixed(1)}%</span>
            <span style={{fontSize:14,fontWeight:700,color:op.pt>=0?G:R}}>{op.pt>=0?"+":""}{op.pt}pt</span>
          </div>
          <div style={{fontSize:11,color:MUTED}}>投資額：{op.cost}pt → 現在評価：{op.net}pt</div>
          <div style={{fontSize:11,color:MUTED,marginTop:3}}>手数料：{sub==="stocks"?"売買2%":"売買0.5%"}</div>
          {onRanking&&(
            <button onClick={onRanking} style={{marginTop:10,width:"100%",padding:"8px",background:GS,border:`1px solid ${G}30`,borderRadius:10,color:GP,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F}}>
              🏆 運用ランキングを見る
            </button>
          )}
        </div>
      )}
      {/* 株式一覧 */}
      {sub==="stocks"&&stocks.map((s,i)=>(
        <div key={i} style={{background:CARD,borderRadius:14,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10,boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
          <div style={{width:36,height:36,borderRadius:10,background:GS,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{s.emoji}</div>
          <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13,color:TEXT}}>{s.name}</div><div style={{fontSize:11,color:MUTED}}>{s.ticker}</div></div>
          <div style={{textAlign:"right"}}>
            <div style={{fontWeight:700,fontSize:14,color:TEXT}}>{s.price?.toLocaleString()}{s.currency==="JPY"?"円":"$"}</div>
            <div style={{fontSize:11,fontWeight:600,color:(s.lastChange||0)>=0?G:R}}>{(s.lastChange||0)>=0?"+":""}{(s.lastChange||0).toFixed(1)}%</div>
            {s.realData===false&&<div style={{fontSize:11,color:R,fontWeight:700}}>サンプル値</div>}
          </div>
        </div>
      ))}
      {/* 為替一覧 */}
      {sub==="forex"&&Object.values(forex).map((fx,i)=>(
        <div key={i} style={{background:CARD,borderRadius:14,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10,boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
          <div style={{width:36,height:36,borderRadius:10,background:"#E5F0FF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{fx.flag}</div>
          <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13,color:TEXT}}>{fx.name||fx.code}</div><div style={{fontSize:11,color:MUTED}}>1 {fx.code} = ¥{(fx.price||0).toFixed(fx.code==="KRW"?3:2)}</div></div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,fontWeight:600,color:(fx.changePct||0)>=0?G:R}}>{(fx.changePct||0)>=0?"+":""}{(fx.changePct||0).toFixed(2)}%</div>
            {fx.realData?<div style={{fontSize:11,color:G,fontWeight:600}}>LIVE</div>:<div style={{fontSize:11,color:R,fontWeight:700}}>サンプル値</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── ファミリー公開画面（子ども・親共通） ───────────────────────
function FamilyPublicScreen({data, viewerRole, onBack}){
  const [metric,setMetric]=useState("approved_activity_points");
  const [opTab,setOpTab]=useState("total");
  const fs=data.familySettings||INIT.familySettings;
  const allMembers=[...data.children,...(data.parents||[])];

  // 活動ランキング（投資除外・承認済み活動のみ）
  const actRank=[...allMembers]
    .filter(m=>m.visibility?.rankingParticipation!==false)
    .map(m=>({member:m,pts:calcMonthlyActivity(m.id,data.logs),streak:(data.streak||{})[m.id]?.cur||0}))
    .sort((a,b)=>b.pts-a.pts)
    .map((r,i)=>({...r,rank:i+1}));

  // 運用ランキング（手数料込み損益率）
  const opRank=[...allMembers]
    .filter(m=>m.visibility?.operationRankingParticipation!==false&&(m.permissions||{}).investment==="trade")
    .map(m=>{
      const op=calcMemberOperation(m.id,data,opTab);
      if(!op) return null;
      return{member:m,op};
    })
    .filter(Boolean)
    .sort((a,b)=>b.op.rate-a.op.rate)
    .map((r,i)=>({...r,rank:i+1}));

  const METRICS=[
    ["approved_activity_points","活動"],
    ["streak","継続"],
    ["goals_completed","目標"],
    ["operation_return_rate","運用"],
  ];
  const MEDAL=["🥇","🥈","🥉"];

  return(
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,paddingBottom:40}}>
      <div style={{padding:"52px 20px 16px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",boxShadow:"0 2px 8px rgba(24,35,29,0.05)",fontSize:18,color:TEXTS}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:15,color:GP}}>ファミリー</div>
        </div>
        {/* ランキング切替 */}
        <div style={{background:CARD,borderRadius:14,padding:"6px",display:"flex",gap:2,boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
          {METRICS.map(([k,l])=>(
            <button key={k} onClick={()=>setMetric(k)} style={{flex:1,padding:"7px 4px",border:"none",borderRadius:10,background:metric===k?GP:"transparent",color:metric===k?"#fff":MUTED,fontWeight:metric===k?700:400,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{padding:"0 20px",display:"flex",flexDirection:"column",gap:12}}>
        {/* 家族ミッション */}
        {fs.familyMission?.enabled&&(()=>{
          const missionPts=(data.logs||[]).filter(l=>["daily","good","bad"].includes(l.type)&&l.pts>0).reduce((s,l)=>s+l.pts,0);
          const target=fs.familyMission?.target||3000;
          const pct=Math.min(100,Math.floor(missionPts/target*100));
          return(
            <div style={{background:`linear-gradient(135deg,${GP}E8,#0d5c38)`,borderRadius:20,padding:"18px",color:"#fff"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12}}>
                <span style={{fontSize:13}}>❤</span>
                <span style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.75)"}}>今月の家族ミッション</span>
              </div>
              <div style={{fontSize:14,fontWeight:700,marginBottom:8}}>{fs.familyMission?.label||"みんなの活動で育てよう"}</div>
              <div style={{background:"rgba(255,255,255,0.15)",borderRadius:999,height:8,overflow:"hidden",marginBottom:6}}>
                <div style={{width:`${pct}%`,height:"100%",background:"#86efac",borderRadius:999}}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:11,color:"rgba(255,255,255,0.55)"}}>{missionPts.toLocaleString()} / {target.toLocaleString()}pt</span>
                <span style={{fontSize:13,fontWeight:800,color:"#86efac"}}>{pct}%</span>
              </div>
              <div style={{marginTop:8,fontSize:11,color:"rgba(255,255,255,0.45)"}}>🎁 {fs.familyMission?.reward||"達成報酬"} · 活動・お手伝いのみ対象</div>
            </div>
          );
        })()}

        {/* 活動ランキング */}
        {metric!=="operation_return_rate"&&(
          <div style={{background:CARD,borderRadius:18,padding:"16px",boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <Ico name="trophy" fb="🏆" size={16}/>
                <span style={{fontSize:11,fontWeight:700,color:TEXT}}>{METRICS.find(m=>m[0]===metric)?.[1]}ランキング</span>
              </div>
              <span style={{fontSize:11,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:600}}>
                {metric==="approved_activity_points"?"今月の活動pt":metric==="streak"?"継続日数":"目標達成"}
              </span>
            </div>
            <div style={{fontSize:11,color:MUTED,marginBottom:12}}>残高・投資損益は含みません</div>
            {actRank.map((r,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<actRank.length-1?`1px solid ${BORDER}`:"none"}}>
                <div style={{width:26,height:26,borderRadius:8,background:i===0?GOLDS:i===1?CARDS:BG,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,flexShrink:0}}>{MEDAL[i]||i+1}</div>
                <ChildAvatar child={r.member} size={32}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{r.member.name}</div>
                  <div style={{fontSize:11,color:MUTED}}>🔥 {r.streak}日連続</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:800,fontSize:14,color:G}}>+{r.pts}pt</div>
                  <div style={{fontSize:11,color:MUTED}}>今月</div>
                </div>
              </div>
            ))}
            <div style={{marginTop:10,padding:"7px 12px",background:BG,borderRadius:10,display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:11}}>🔒</span>
              <span style={{fontSize:11,color:MUTED}}>残高・目標は本人と管理者のみ閲覧</span>
            </div>
          </div>
        )}

        {/* 運用ランキング（親子全員参加） */}
        {metric==="operation_return_rate"&&(
          <div style={{background:CARD,borderRadius:18,padding:"16px",boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
              <span style={{fontSize:14}}>📊</span>
              <span style={{fontSize:11,fontWeight:700,color:TEXT}}>運用ランキング</span>
            </div>
            <div style={{background:"#E5F0FF",borderRadius:9,padding:"7px 10px",marginBottom:12,fontSize:11,color:"#3478D4"}}>
              これは実際のお金を使わないシミュレーションです。手数料を含めた損益率で比較しています。
            </div>
            {/* サブタブ */}
            <div style={{display:"flex",gap:6,marginBottom:12}}>
              {[["total","総合"],["stocks","株式"]].map(([k,l])=>(
                <button key={k} onClick={()=>setOpTab(k)} style={{flex:1,padding:"6px 0",border:"none",borderRadius:8,background:opTab===k?"#3478D4":"transparent",color:opTab===k?"#fff":MUTED,fontWeight:opTab===k?700:400,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>
              ))}
            </div>
            {opRank.length===0&&(
              <div style={{textAlign:"center",padding:"20px 0",color:MUTED,fontSize:13}}>まだ運用を始めているメンバーがいません</div>
            )}
            {opRank.map((r,i)=>{
              const isPos=r.op.rate>=0;
              const showDetail=r.member.visibility?.investmentResultToFamily==="full";
              return(
                <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<opRank.length-1?`1px solid ${BORDER}`:"none"}}>
                  <div style={{width:26,height:26,borderRadius:8,background:i===0?GOLDS:i===1?CARDS:BG,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,flexShrink:0}}>{MEDAL[i]||i+1}</div>
                  <ChildAvatar child={r.member} size={32}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,color:TEXT}}>{r.member.name}</div>
                    {showDetail
                      ?<div style={{fontSize:11,color:MUTED}}>元本{r.op.cost}pt</div>
                      :<div style={{fontSize:11,color:MUTED,display:"flex",alignItems:"center",gap:3}}>🔒 損益のみ公開</div>
                    }
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontWeight:900,fontSize:16,color:isPos?G:R}}>{isPos?"+":""}{r.op.rate.toFixed(1)}%</div>
                    <div style={{fontSize:11,fontWeight:600,color:isPos?G:R}}>{isPos?"+":""}{r.op.pt}pt</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 親専用ファミリー管理画面 ─────────────────────────────────
function FamilyGuardianScreen({data, onBack, onPublicView}){
  const children=data.children||[];
  return(
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,paddingBottom:40}}>
      <div style={{padding:"52px 20px 16px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",boxShadow:"0 2px 8px rgba(24,35,29,0.05)",fontSize:18,color:TEXTS}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:15,color:GP}}>ファミリー管理</div>
        </div>
        <button onClick={onPublicView} style={{background:GS,borderRadius:12,padding:"10px 14px",border:`1px solid ${G}30`,display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontFamily:F,width:"100%",textAlign:"left",marginBottom:16}}>
          <span style={{fontSize:14}}>👁</span>
          <div style={{flex:1,fontSize:12,fontWeight:700,color:GP}}>公開表示プレビューを見る</div>
          <ChevronRightIcon/>
        </button>
      </div>
      <div style={{padding:"0 20px",display:"flex",flexDirection:"column",gap:12}}>
        <div style={{fontSize:11,fontWeight:700,color:MUTED,letterSpacing:.5}}>子どもの詳細状況</div>
        {children.map((m,idx)=>{
          const b=bal(data.logs,m.id);
          const monthAct=calcMonthlyActivity(m.id,data.logs);
          const topG=(data.goals||[]).filter(g=>g.cid===m.id&&!g.done)[0];
          const pct=topG?Math.min(100,Math.floor(b/topG.target*100)):0;
          const op=calcMemberOperation(m.id,data,"total");
          return(
            <div key={m.id} style={{background:CARD,borderRadius:18,padding:"16px",boxShadow:"0 4px 16px rgba(24,35,29,0.06)",border:`1px solid ${BORDER}`}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                <ChildAvatar child={m} size={40}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14,color:TEXT}}>{m.name}</div>
                  <div style={{fontSize:11,color:MUTED}}>{m.gradeLabel||""} · {m.displayMode}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:800,fontSize:18,color:TEXT}}>{b.toLocaleString()}pt</div>
                  <div style={{fontSize:11,color:G,fontWeight:600}}>+{monthAct}pt 今月</div>
                </div>
              </div>
              {topG&&(
                <div style={{background:BG,borderRadius:10,padding:"8px 12px",marginBottom:op?8:0}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <span style={{fontSize:11,color:TEXTS}}>{topG.label}</span>
                    <span style={{fontSize:11,fontWeight:700,color:GP}}>{pct}%</span>
                  </div>
                  <div style={{background:BORDER,borderRadius:999,height:5,overflow:"hidden"}}>
                    <div style={{width:`${pct}%`,height:"100%",background:G,borderRadius:999}}/>
                  </div>
                </div>
              )}
              {op&&(
                <div style={{background:BG,borderRadius:10,padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:11,color:TEXTS}}>運用成績（総合）</span>
                  <span style={{fontSize:12,fontWeight:700,color:op.rate>=0?G:R}}>{op.rate>=0?"+":""}{op.rate.toFixed(1)}%（{op.pt>=0?"+":""}{op.pt}pt）</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function ParentScreen({ data, update, onBack }) {
  const [tab, setTab] = useState("overview");

  // grant
  const [grantChild, setGrantChild] = useState(null);
  const [grantAmt,   setGrantAmt]   = useState("");
  const [grantLabel, setGrantLabel] = useState("おこづかい");

  // child mgmt
  const [editChild,     setEditChild]     = useState(null);
  const [showAddChild,  setShowAddChild]  = useState(false);
  const [delChild,      setDelChild]      = useState(null);
  const [ncName, setNcName] = useState(""); const [ncEmoji, setNcEmoji] = useState("😊");
  const [ncPin,  setNcPin]  = useState(""); const [ncMode,  setNcMode]  = useState("middle");

  // tasks
  const [editTask,  setEditTask]  = useState(null);
  const [newTask,   setNewTask]   = useState(null);
  const [overModal, setOverModal] = useState(null);
  const [ntLabel, setNtLabel]=useState(""); const [ntEmoji, setNtEmoji]=useState("⭐"); const [ntPts, setNtPts]=useState("");
  // タスクのドラッグ並び替え(iPhone風)
  const [dragTask,setDragTask]=useState(null);   // {k,id,dy}
  const dragRef=useRef({startY:0});
  const rowRefs=useRef({});
  const moveTask=(k,id,steps)=>{ if(!steps) return; markLocalDefEdit(); update(d=>{ const arr=[...(d[k]||[])]; const i=arr.findIndex(t=>t.id===id); if(i<0) return d; const j=Math.max(0,Math.min(arr.length-1,i+steps)); if(i===j) return d; const [it]=arr.splice(i,1); arr.splice(j,0,it); return {...d,[k]:arr}; }); };

  // rewards
  const [editReward,    setEditReward]    = useState(null);
  const [showAddReward, setShowAddReward] = useState(false);
  const [nrLabel,setNrLabel]=useState(""); const [nrEmoji,setNrEmoji]=useState("🎁"); const [nrCost,setNrCost]=useState(""); const [nrUnit,setNrUnit]=useState("");

  // gacha
  const [gachaEdit, setGachaEdit] = useState(null);

  // kakeibo child picker
  const [kChild, setKChild] = useState(null);

  // categories
  const [editCat,    setEditCat]    = useState(null);
  const [showAddCat, setShowAddCat] = useState(false);
  const [ncatEmoji, setNcatEmoji]=useState("🏷"); const [ncatLabel, setNcatLabel]=useState(""); const [ncatColor, setNcatColor]=useState("#6b7280");

  const sb = (c,l,fn,dis) => <Btn c={c} label={l} onClick={fn} disabled={dis} sm/>;

  const doGrant = () => {
    const amt=parseInt(grantAmt); if(!amt||!grantChild)return;
    if(!txGuard("grant2_"+grantChild.id)) return;   // 連打ガード(二重付与防止)
    (()=>{const _e={id:uid(),cid:grantChild.id,type:"grant",label:grantLabel||"おこづかい",pts:amt,date:new Date().toISOString()};update(d=>({...d,logs:[_e,...d.logs]}));addLogToFirestore(_e);})();
    setGrantChild(null); setGrantAmt(""); setGrantLabel("おこづかい");
  };

  const addChild = () => {
    if(!ncName||ncPin.length!==4)return;
    const newId=uid();
    update(d=>({...d,children:[...d.children,{id:newId,name:ncName,emoji:ncEmoji,pinh:pinHash(ncPin),ageMode:ncMode}],pinChanged:{...(d.pinChanged||{}),[newId]:true}}));
    setShowAddChild(false); setNcName(""); setNcEmoji("😊"); setNcPin(""); setNcMode("middle");
  };
  const confirmDelChild = id => {
    // 意図的な一括削除。急減ガードを免除しないと logs/expenses が巻き戻り、孤児データが残ってblob肥大の二次被害になる。
    markLocalUserDataEdit();   // goals/expenses 両方を消すので全フィールド保護（引数なし）
    update(d=>({...d,children:d.children.filter(c=>c.id!==id),logs:d.logs.filter(l=>l.cid!==id),expenses:(d.expenses||[]).filter(e=>e.cid!==id),goals:(d.goals||[]).filter(g=>g.cid!==id)}), {allowShrink:true});
    setDelChild(null);
  };

  const saveTask = () => {
    if(!editTask)return; const pts=parseInt(editTask.pts); if(isNaN(pts))return;
    const k=editTask.kind==="good"?"goodTasks":"badTasks";
    markLocalDefEdit();
    update(d=>({...d,[k]:d[k].map(t=>t.id===editTask.id?{...t,label:editTask.label,emoji:editTask.emoji,pts}:t)}));
    setEditTask(null);
  };
  const delTask = (kind,id) => { const k=kind==="good"?"goodTasks":"badTasks"; markLocalDefEdit(); update(d=>({...d,[k]:d[k].filter(t=>t.id!==id)})); };
  const addTask = () => {
    if(!ntLabel||!ntPts)return; const pts=parseInt(ntPts); if(isNaN(pts))return;
    const kind=newTask.kind; const k=kind==="good"?"goodTasks":"badTasks";
    const fp=kind==="bad"&&pts>0?-pts:pts;
    markLocalDefEdit();
    update(d=>({...d,[k]:[...d[k],{id:uid(),emoji:ntEmoji,label:ntLabel,pts:fp,over:{}}]}));
    setNewTask(null); setNtLabel(""); setNtEmoji("⭐"); setNtPts("");
  };
  const setOver = (taskId, kind, cid, val) => {
    const k=kind==="good"?"goodTasks":"badTasks";
    const v=val===""?undefined:parseInt(val);
    markLocalDefEdit();
    update(d=>({...d,[k]:d[k].map(t=>t.id===taskId?{...t,over:{...t.over,[cid]:v}}:t)}));
    setOverModal(m=>m?{...m,task:{...m.task,over:{...m.task.over,[cid]:v}}}:m);
  };

  const saveReward = () => {
    if(!editReward)return; const cost=parseInt(editReward.cost); if(isNaN(cost)||cost<=0)return;
    update(d=>({...d,rewards:d.rewards.map(r=>r.id===editReward.id?{...editReward,cost}:r)}));
    setEditReward(null);
  };
  const delReward = id => update(d=>({...d,rewards:d.rewards.filter(r=>r.id!==id)}));
  const addReward = () => {
    const cost=parseInt(nrCost); if(!nrLabel||isNaN(cost)||cost<=0)return;
    update(d=>({...d,rewards:[...d.rewards,{id:uid(),emoji:nrEmoji,label:nrLabel,cost,unit:nrUnit||"特典"}]}));
    setShowAddReward(false); setNrLabel(""); setNrEmoji("🎁"); setNrCost(""); setNrUnit("");
  };

  const saveCat=()=>{if(!editCat)return;update(d=>({...d,cats:(d.cats||[]).map(c=>c.id===editCat.id?editCat:c)}));setEditCat(null);};
  const delCat=id=>update(d=>({...d,cats:(d.cats||[]).filter(c=>c.id!==id)}));
  const addCat=()=>{if(!ncatLabel)return;update(d=>({...d,cats:[...(d.cats||[]),{id:uid(),emoji:ncatEmoji,label:ncatLabel,color:ncatColor}]}));setShowAddCat(false);setNcatLabel("");setNcatEmoji("🏷");setNcatColor("#6b7280");};

  const TABS=[["overview","ホーム"],["family","ファミリー"],["children","承認・管理"],["tasks","タスク"],["daily","毎日"],["rewards","特典"],["learn","学ぶ"],["log","履歴"]];
  const AGE_MODES={young:{emoji:"🐣",label:"低学年（ふりがな）"},middle:{emoji:"⭐",label:"中学年"},senior:{emoji:"🔥",label:"高学年・中学生"}};

  // kakeibo child view
  if (kChild) {
    const child = data.children.find(c=>c.id===kChild);
    if (!child) { setKChild(null); return null; }
    return (
      <div style={{minHeight:"100vh",background:BG,fontFamily:F}}>
        <div style={{background:TEXT,padding:"14px 18px",display:"flex",alignItems:"center",gap:12}}>
          <button onClick={()=>setKChild(null)} style={{background:"none",border:"none",color:MUTED,fontSize:26,cursor:"pointer"}}>‹</button>
          <Emo e={child.emoji} size={22}/>
          <span style={{color:Y,fontSize:17,fontWeight:900}}>{child.name}の家計簿</span>
        </div>
        <ChildScreen child={child} data={data} update={update} onBack={()=>setKChild(null)}/>
      </div>
    );
  }

  return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,paddingBottom:80}}>
      {/* 新ヘッダー */}
      <div style={{background:BG,padding:"52px 20px 0"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <button onClick={onBack} style={{width:36,height:36,borderRadius:10,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,color:TEXTS,boxShadow:"0 2px 8px rgba(24,35,29,0.05)"}}>‹</button>
          <div style={{fontFamily:FB,fontWeight:800,fontSize:14,color:GP,letterSpacing:.5}}>Tane Money</div>
          <button onClick={()=>setTab("children")} style={{width:36,height:36,borderRadius:10,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:15,boxShadow:"0 2px 8px rgba(24,35,29,0.05)"}}><Ico name="gear" fb="⚙" size={18}/></button>
        </div>
        {/* 親自身の残高カード */}
        {(()=>{
          const parentMember=(data.parents||[])[0];
          if(!parentMember) return null;
          const pBal=bal(data.logs,parentMember.id);
          const thisMonth=new Date().toISOString().slice(0,7);
          const pDelta=(data.logs||[]).filter(l=>l.cid===parentMember.id&&(l.date||"").startsWith(thisMonth)).reduce((s,l)=>s+l.pts,0);
          const pStreak=(data.streak||{})[parentMember.id]?.cur||0;
          const topGoal=(data.goals||[]).filter(g=>g.cid===parentMember.id&&!g.done)[0];
          const pct=topGoal?Math.min(100,Math.floor(pBal/topGoal.target*100)):0;
          return(
            <div style={{background:GP,borderRadius:22,padding:"20px",marginBottom:20,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:-24,right:-24,width:120,height:120,borderRadius:"50%",background:"rgba(255,255,255,0.06)"}}/>
              <div style={{position:"relative",zIndex:1}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                  <ChildAvatar child={parentMember} size={32}/>
                  <div>
                    <div style={{color:"rgba(255,255,255,0.75)",fontSize:11,fontWeight:600}}>こんにちは、{parentMember.name}</div>
                    <div style={{color:"rgba(255,255,255,0.45)",fontSize:11}}>現在のタネ</div>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"flex-end",gap:6,marginBottom:10}}>
                  <div style={{color:"#fff",fontSize:40,fontWeight:900,lineHeight:1,letterSpacing:-1}}>{pBal.toLocaleString()}</div>
                  <div style={{color:"rgba(255,255,255,0.65)",fontSize:14,fontWeight:600,marginBottom:5}}>pt</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:12,fontWeight:700,color:pDelta>=0?"#86efac":"#fca5a5"}}>{pDelta>=0?"+":""}{pDelta.toLocaleString()}pt</span>
                  <span style={{fontSize:11,color:"rgba(255,255,255,0.45)"}}>今月</span>
                  {pStreak>=3&&<div style={{display:"flex",alignItems:"center",gap:3,background:"rgba(255,255,255,0.12)",padding:"3px 8px",borderRadius:999}}>
                    <span style={{fontSize:11,color:"#fff",fontWeight:600}}>🔥 {pStreak}日連続</span>
                  </div>}
                </div>
                {topGoal&&(
                  <div style={{marginTop:12,background:"rgba(255,255,255,0.1)",borderRadius:10,padding:"8px 12px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                      <span style={{fontSize:11,color:"rgba(255,255,255,0.7)"}}>{topGoal.label}</span>
                      <span style={{fontSize:11,fontWeight:700,color:"#86efac"}}>{pct}%</span>
                    </div>
                    <div style={{background:"rgba(255,255,255,0.2)",borderRadius:999,height:5,overflow:"hidden"}}>
                      <div style={{width:`${pct}%`,height:"100%",background:"#86efac",borderRadius:999}}/>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
      {/* タブナビゲーション */}
      <div style={{display:"flex",background:CARD,borderBottom:`1px solid ${BORDER}`,overflowX:"auto",scrollbarWidth:"none",position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 8px rgba(24,35,29,0.04)"}}>
        {TABS.map(([v,l])=>(
          <button key={v} onClick={()=>setTab(v)}
            style={{flex:"0 0 auto",padding:"12px 14px 10px",border:"none",borderBottom:tab===v?`2.5px solid ${GP}`:"2.5px solid transparent",background:"none",color:tab===v?GP:MUTED,fontWeight:tab===v?700:500,fontSize:11,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap",transition:"all .15s"}}>
            {l}
          </button>
        ))}
            </div>

      {/* OVERVIEW */}
      {tab==="overview" && (
        <div style={{padding:16}}>
          {/* 🌱 はじめてガイド（最初の5分）: ログが少ない家庭にだけ表示・✕で消せる */}
          {!data.parentGuideDone && (data.logs||[]).length<15 && (
            <div style={{background:`linear-gradient(135deg,${GS},#fff)`,border:`2px solid ${G}`,borderRadius:18,padding:"14px 16px",marginBottom:14,position:"relative"}}>
              <button onClick={()=>update(d=>({...d,parentGuideDone:true}))} style={{position:"absolute",top:8,right:10,background:"none",border:"none",fontSize:15,cursor:"pointer",color:MUTED,fontFamily:F}}>✕</button>
              <div style={{fontWeight:900,fontSize:14,color:GP,marginBottom:8}}>🌱 はじめかた（3ステップ・5分）</div>
              {[["1","お手伝いを決める","「タスク」タブで、わが家のお手伝いとポイントを設定（初期リストのままでもOK）"],
                ["2","ごほうびを決める","「特典」タブで、貯めたポイントの使い道を設定（例: ゲーム30分 = 100pt）"],
                ["3","子どもと一緒に1回やる","子どもの画面でお手伝いを1つタップ→ポイントが貯まるのを一緒に見る。ここまでできれば準備完了！"]].map(([n,t,b])=>(
                <div key={n} style={{display:"flex",gap:10,marginBottom:8}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:GP,color:"#fff",fontSize:12,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{n}</div>
                  <div style={{flex:1}}><div style={{fontWeight:800,fontSize:13,color:TEXT}}>{t}</div><div style={{fontSize:11.5,color:TEXTS,lineHeight:1.5}}>{b}</div></div>
                </div>
              ))}
              <div style={{fontSize:11,color:MUTED,fontWeight:700,marginTop:4}}>💡 ポイントの相場は「1回のお手伝い = 10〜50pt」くらいが続きやすいです</div>
            </div>
          )}
          {data.children.map(child=>(
            <div key={child.id} style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:20,padding:16,marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
                <Emo e={child.emoji} size={34}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:15}}>{child.name} <span style={{background:`${P}20`,color:P,fontSize:11,fontWeight:700,padding:"2px 6px",borderRadius:8}}>{AGE_MODES[child.ageMode||"middle"].label}</span></div>
                  <div style={{fontWeight:900,fontSize:24,color:G}}>{bal(data.logs,child.id).toLocaleString()}pt</div>
                </div>
              </div>
              {grantChild?.id===child.id ? (
                <div style={{background:"#fef9e0",borderRadius:14,padding:14}}>
                  <p style={{margin:"0 0 8px",fontWeight:700,fontSize:13}}>おこづかいを付与する</p>
                  <input value={grantLabel} onChange={e=>setGrantLabel(e.target.value)} placeholder="ラベル" style={{...INP,marginBottom:8}}/>
                  <input value={grantAmt} onChange={e=>setGrantAmt(e.target.value)} type="number" placeholder="金額（pt）" style={{...INP,marginBottom:10}}/>
                  <div style={{display:"flex",gap:8}}>{sb(G,"✅ 付与する",doGrant)}{sb(MUTED,"キャンセル",()=>setGrantChild(null))}</div>
                </div>
              ) : (
                <button onClick={()=>setGrantChild(child)} style={{width:"100%",background:Y,border:"none",borderRadius:12,padding:11,fontWeight:800,fontSize:13,color:TEXT,cursor:"pointer",fontFamily:F}}>🎁 おこづかいを付与する</button>
              )}
            </div>
          ))}
          {/* 🌟 子どもの推し株×会話のタネ: 推し理由を親に見せて会話のきっかけに */}
          {(()=>{
            const rows=data.children.flatMap(c=>((data.holdings||{})[c.id]||[]).map(h=>{
              const st=(data.stocks||[]).find(x=>x.id===h.stockId);
              return st?{c,st,h}:null;
            }).filter(Boolean));
            if(rows.length===0) return null;
            return (
              <div style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:18,padding:16,marginBottom:14}}>
                <p style={{fontWeight:800,fontSize:13,color:MUTED,margin:"0 0 4px"}}>🌟 子どもの推し株</p>
                <p style={{fontSize:11.5,color:TEXTS,margin:"0 0 10px",lineHeight:1.5}}>「なんでこの会社を推したの？」と聞いてみてください。お金の会話が いちばんの学びです。</p>
                {rows.map(({c,st,h},i)=>(
                  <div key={c.id+st.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderTop:i>0?`1px solid ${BORDER}`:"none"}}>
                    <Emo e={c.emoji} size={18}/>
                    <span style={{fontSize:20,flexShrink:0}}>{st.emoji}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:800,fontSize:13,color:TEXT}}>{c.name} × {st.name} <span style={{fontSize:11,color:MUTED,fontWeight:700}}>{h.qty}株</span></div>
                      <div style={{fontSize:11.5,color:h.reason?GP:MUTED,fontWeight:700}}>{h.reason?`「${h.reason}」`:"（推し理由は まだ聞けてない）"}</div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
          {/* monthly summary */}
          <div style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:18,padding:16,marginTop:4}}>
            <p style={{fontWeight:800,fontSize:13,color:MUTED,margin:"0 0 12px"}}>📋 今月のまとめ</p>
            {data.children.map(child=>{
              const ym=monthKey();
              const logs=(data.logs||[]).filter(l=>l.cid===child.id&&(l.date||"").startsWith(ym));
              const earned=logs.filter(l=>l.type==="good").reduce((s,l)=>s+l.pts,0);
              const spent=(data.expenses||[]).filter(e=>e.cid===child.id&&(e.date||"").startsWith(ym)).reduce((s,e)=>s+e.amt,0);
              const streak=data.streak?.[child.id]?.cur||0;
              return (
                <div key={child.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:`1px solid ${BORDER}`}}>
                  <Emo e={child.emoji} size={24}/>
                  <span style={{fontWeight:700,fontSize:14,flex:1}}>{child.name}</span>
                  <div style={{textAlign:"right",fontSize:12}}>
                    <div style={{color:G,fontWeight:700}}>お手伝い +{earned}pt</div>
                    <div style={{color:R,fontWeight:700}}>支出 -{spent}pt</div>
                    <div style={{color:MUTED}}>🔥{streak}日連続</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* CHILDREN */}
      {tab==="children" && (
        <div style={{padding:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}>こどもの管理</p>
            <Btn c={G} label="＋ 追加" onClick={()=>setShowAddChild(true)}/>
          </div>
          {data.children.map(child=>(
            <div key={child.id} style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:18,padding:14,marginBottom:12}}>
              {delChild===child.id ? (
                <div style={{textAlign:"center"}}>
                  <p style={{fontWeight:800,color:R,marginBottom:8}}>⚠ {child.name}のデータを全て削除しますか？</p>
                  <p style={{color:MUTED,fontSize:12,marginBottom:12}}>履歴・家計簿・目標も全部消えます。</p>
                  <div style={{display:"flex",gap:8,justifyContent:"center"}}>{sb(R,"削除する",()=>confirmDelChild(child.id))}{sb(MUTED,"キャンセル",()=>setDelChild(null))}</div>
                </div>
              ) : editChild?.id===child.id ? (
                <div>
                  {/* アバター編集 */}
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
                    <div style={{position:"relative",flexShrink:0}}>
                      <ChildAvatar child={editChild} size={60}/>
                      <label style={{position:"absolute",bottom:-4,right:-4,width:24,height:24,borderRadius:"50%",background:B,border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:13,color:"#fff"}}>
                        +
                        <input type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
                          const file=e.target.files&&e.target.files[0]; if(!file) return;
                          const reader=new FileReader();
                          reader.onload=ev=>{
                            const img=new Image();
                            img.onload=()=>{
                              const canvas=document.createElement("canvas");
                              canvas.width=200; canvas.height=200;
                              const ctx=canvas.getContext("2d");
                              const s=Math.min(img.width,img.height);
                              const sx=(img.width-s)/2, sy=(img.height-s)/2;
                              ctx.drawImage(img,sx,sy,s,s,0,0,200,200);
                              setEditChild(c=>({...c,avatar:canvas.toDataURL("image/jpeg",0.8)}));
                            };
                            img.src=ev.target.result;
                          };
                          reader.readAsDataURL(file);
                        }}/>
                      </label>
                    </div>
                    <div style={{flex:1}}>
                      <p style={{color:MUTED,fontSize:11,margin:"0 0 4px"}}>絵文字 / アバター（写真がない場合）</p>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <input value={(editChild.emoji||"").startsWith("ico:")?"":editChild.emoji} placeholder="絵文字" onChange={e=>setEditChild(c=>({...c,emoji:e.target.value}))} style={{...INP,width:60}}/>
                        {editChild.avatar&&<button onClick={()=>setEditChild(c=>({...c,avatar:undefined}))}
                          style={{padding:"5px 9px",border:`1px solid ${R}`,borderRadius:8,background:"transparent",color:R,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>
                          写真を削除
                        </button>}
                      </div>
                      <p style={{color:MUTED,fontSize:11,margin:"8px 0 4px"}}>ドット絵アバターから選ぶ</p>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        {["dad","mom","boy","girl","toddler","baby","grandpa","grandma"].map(av=>{
                          const sel=editChild.emoji===`ico:${av}`;
                          return <button key={av} onClick={()=>setEditChild(c=>({...c,emoji:`ico:${av}`}))}
                            style={{width:42,height:42,borderRadius:10,border:`2px solid ${sel?GP:BORDER}`,background:sel?GS:CARD,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",padding:0}}>
                            <Ico name={av} size={32}/>
                          </button>;
                        })}
                      </div>
                    </div>
                  </div>
                  <input value={editChild.name} onChange={e=>setEditChild(c=>({...c,name:e.target.value}))} placeholder="なまえ" style={{...INP,marginBottom:8}}/>
                  <input value={editChild.pin} onChange={e=>setEditChild(c=>({...c,pin:e.target.value.slice(0,4)}))} type="number" placeholder="新しい暗証番号（変更する時だけ入力）" style={{...INP,marginBottom:8}}/>
                  {(editChild.pin||"").length>0&&(editChild.pin||"").length!==4 && <p style={{color:R,fontSize:11,margin:"0 0 8px"}}>4けたで入力してください</p>}
                  {/* ロック設定 */}
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,padding:"8px 12px",background:BG,borderRadius:10}}>
                    <span style={{color:MUTED,fontSize:12,fontWeight:700,flex:1}}>暗証番号ロック</span>
                    <button onClick={()=>setEditChild(c=>({...c,lockEnabled:!c.lockEnabled}))}
                      style={{background:editChild.lockEnabled?G:BORDER,border:"none",borderRadius:20,width:44,height:24,cursor:"pointer",position:"relative",transition:"background .2s"}}>
                      <div style={{position:"absolute",top:3,left:editChild.lockEnabled?22:3,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
                    </button>
                    <span style={{color:editChild.lockEnabled?G:MUTED,fontSize:11,fontWeight:700}}>{editChild.lockEnabled?"ON":"OFF"}</span>
                  </div>
                  <div style={{display:"flex",gap:6,marginBottom:10}}>
                    {Object.entries(AGE_MODES).map(([k,v])=>(
                      <button key={k} onClick={()=>setEditChild(c=>({...c,ageMode:k}))}
                        style={{flex:1,padding:"7px 4px",border:`2px solid ${editChild.ageMode===k?P:BORDER}`,borderRadius:10,background:editChild.ageMode===k?`${P}20`:"transparent",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F,color:editChild.ageMode===k?P:MUTED}}>
                        {v.emoji}<br/>{v.label}
                      </button>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:8}}>{sb(G,"保存",()=>{
                    const np=(editChild.pin||"");
                    if(np.length>0&&np.length!==4)return;
                    const {pin,...rest}=editChild;
                    const saved=np.length===4?{...rest,pinh:pinHash(np)}:rest;
                    // lockEnabledをdataにも反映
                    update(d=>({...d,
                      children:d.children.map(c=>c.id===editChild.id?saved:c),
                      lockEnabled:{...(d.lockEnabled||{}),[editChild.id]:!!editChild.lockEnabled},
                      ...(np.length===4?{pinChanged:{...(d.pinChanged||{}),[editChild.id]:true}}:{})
                    }));
                    setEditChild(null);
                  })}{sb(MUTED,"キャンセル",()=>setEditChild(null))}</div>
                </div>
              ) : (
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
                    <ChildAvatar child={child} size={40}/>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:800,fontSize:15}}>{child.name}</div>
                      <div style={{color:MUTED,fontSize:12}}>{AGE_MODES[child.ageMode||"middle"].emoji} {AGE_MODES[child.ageMode||"middle"].label} · {bal(data.logs,child.id).toLocaleString()}pt</div>
                    </div>
                    <div style={{display:"flex",gap:6}}>{sb(B,"✏",()=>setEditChild({...child,pin:"",lockEnabled:!!(data.lockEnabled&&data.lockEnabled[child.id])}))}
                    {sb(R,"🗑",()=>setDelChild(child.id))}</div>
                  </div>
                  <div style={{background:BG,borderRadius:10,padding:"7px 12px",display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:14}}>🔐</span>
                    <span style={{color:MUTED,fontSize:11,fontWeight:700}}>暗証番号ロック:</span>
                    <span style={{fontWeight:800,fontSize:12,color:data.lockEnabled&&data.lockEnabled[child.id]?G:MUTED}}>
                      {data.lockEnabled&&data.lockEnabled[child.id]?"ON":"OFF（ロックなし）"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
          {showAddChild && (
            <div style={{background:`${G}12`,border:`2px dashed ${G}`,borderRadius:18,padding:16}}>
              <p style={{fontWeight:800,fontSize:13,color:G,margin:"0 0 12px"}}>新しいこどもを追加</p>
              <div style={{display:"flex",gap:8,marginBottom:8}}>
                <input value={ncEmoji} onChange={e=>setNcEmoji(e.target.value)} style={{...INP,width:56}}/>
                <input value={ncName} onChange={e=>setNcName(e.target.value)} placeholder="なまえ" style={INP}/>
              </div>
              <input value={ncPin} onChange={e=>setNcPin(e.target.value.slice(0,4))} type="number" placeholder="暗証番号（4けた）" style={{...INP,marginBottom:10}}/>
              <div style={{display:"flex",gap:6,marginBottom:12}}>
                {Object.entries(AGE_MODES).map(([k,v])=>(
                  <button key={k} onClick={()=>setNcMode(k)}
                    style={{flex:1,padding:"7px 4px",border:`2px solid ${ncMode===k?P:BORDER}`,borderRadius:10,background:ncMode===k?`${P}20`:"transparent",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F,color:ncMode===k?P:MUTED}}>
                    {v.emoji}<br/>{v.label}
                  </button>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={addChild} disabled={!ncName||ncPin.length!==4} style={{background:ncName&&ncPin.length===4?G:BORDER,border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>追加する</button>
                {sb(MUTED,"キャンセル",()=>setShowAddChild(false))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TASKS */}
      {tab==="tasks" && (
        <div style={{padding:16}}>
          {overModal && (
            <div style={{position:"fixed",inset:0,background:"#0008",zIndex:800,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
              <div style={{background:CARD,borderRadius:20,padding:24,width:"100%",maxWidth:340,fontFamily:F}}>
                <h3 style={{fontWeight:900,fontSize:16,margin:"0 0 4px"}}>{overModal.task.emoji} {overModal.task.label}</h3>
                <p style={{color:MUTED,fontSize:12,margin:"0 0 16px"}}>こどもごとに金額を個別設定（空欄=デフォルト {overModal.task.pts}円）</p>
                {data.children.map(child=>(
                  <div key={child.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <Emo e={child.emoji} size={20}/>
                    <span style={{fontWeight:700,fontSize:14,flex:1}}>{child.name}</span>
                    <input type="number" placeholder={`${overModal.task.pts}`}
                      value={overModal.task.over?.[child.id]??""} onChange={e=>setOver(overModal.task.id,overModal.kind,child.id,e.target.value)}
                      style={{...INP,width:100,padding:"6px 8px",fontSize:13}}/>
                  </div>
                ))}
                <button onClick={()=>setOverModal(null)} style={{marginTop:12,width:"100%",background:G,border:"none",borderRadius:10,padding:11,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F}}>完了</button>
              </div>
            </div>
          )}
          {[["good","✅ いいこと（プラス）",G],["bad","❌ わるいこと（マイナス）",R]].map(([kind,title,color])=>{
            const tasks=kind==="good"?data.goodTasks:data.badTasks;
            const k=kind==="good"?"goodTasks":"badTasks";
            return (
              <div key={kind} style={{marginBottom:24}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}>{title}</p>
                  <Btn c={color} label="＋ 追加" onClick={()=>{setNewTask({kind});setNtLabel("");setNtEmoji("⭐");setNtPts("");}} sm/>
                </div>
                {tasks.length>1&&<p style={{color:MUTED,fontSize:10.5,margin:"-4px 0 8px",fontWeight:600}}>≡ をつかんで ドラッグすると 並び替えできます</p>}
                {tasks.map(task=>{
                  const isDragging=dragTask&&dragTask.k===k&&dragTask.id===task.id;
                  return (
                  <div key={task.id} ref={el=>{rowRefs.current[task.id]=el;}}
                    style={{background:CARD,border:`1.5px solid ${isDragging?GP:BORDER}`,borderRadius:14,padding:"10px 13px",marginBottom:8,position:"relative",
                      transform:isDragging?`translateY(${dragTask.dy}px) scale(1.02)`:"none",
                      boxShadow:isDragging?"0 12px 30px rgba(0,0,0,0.18)":"none",zIndex:isDragging?50:1,opacity:isDragging?0.97:1,
                      transition:isDragging?"none":"transform .18s ease"}}>
                    {editTask?.id===task.id ? (
                      <div>
                        <div style={{display:"flex",gap:8,marginBottom:8}}>
                          <input value={editTask.emoji} onChange={e=>setEditTask(t=>({...t,emoji:e.target.value}))} style={{...INP,width:56}}/>
                          <input value={editTask.label} onChange={e=>setEditTask(t=>({...t,label:e.target.value}))} style={INP}/>
                        </div>
                        <input value={editTask.pts} onChange={e=>setEditTask(t=>({...t,pts:e.target.value}))} type="number" placeholder="デフォルトpt数" style={{...INP,marginBottom:8}}/>
                        <div style={{display:"flex",gap:8}}>{sb(G,"保存",saveTask)}{sb(MUTED,"キャンセル",()=>setEditTask(null))}</div>
                      </div>
                    ) : (
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <div
                          onTouchStart={e=>{ e.stopPropagation(); dragRef.current={startY:e.touches[0].clientY}; setDragTask({k,id:task.id,dy:0}); }}
                          onTouchMove={e=>{ if(dragTask&&dragTask.id===task.id) setDragTask(d=>({...d,dy:e.touches[0].clientY-dragRef.current.startY})); }}
                          onTouchEnd={()=>{ if(dragTask&&dragTask.id===task.id){ const h=(rowRefs.current[task.id]?.offsetHeight||56)+8; const steps=Math.round((dragTask.dy||0)/h); moveTask(k,task.id,steps); setDragTask(null); } }}
                          onMouseDown={e=>e.preventDefault()}
                          aria-label="ドラッグして並び替え"
                          style={{touchAction:"none",cursor:"grab",padding:"6px 4px",marginLeft:-4,color:MUTED,fontSize:19,lineHeight:1,userSelect:"none",flexShrink:0}}>≡</div>
                        <span style={{fontSize:20}}>{task.emoji}</span>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:700,fontSize:14}}>{task.label}</div>
                          <div style={{color:MUTED,fontSize:11}}>デフォルト: {task.pts}pt{Object.keys(task.over||{}).length>0&&<span style={{color:P}}> · 個別設定あり</span>}</div>
                        </div>
                        <div style={{display:"flex",gap:5}}>
                          <button onClick={()=>setOverModal({task:{...task,over:{...(task.over||{})}},kind})} style={{background:`${P}18`,border:`1px solid ${P}`,borderRadius:7,padding:"3px 7px",color:P,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>個別</button>
                          {sb(B,"✏",()=>setEditTask({...task,pts:String(task.pts)}))}
                          {sb(R,"🗑",()=>delTask(kind,task.id))}
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
                {newTask?.kind===kind && (
                  <div style={{background:`${color}12`,border:`2px dashed ${color}`,borderRadius:14,padding:14,marginTop:8}}>
                    <div style={{display:"flex",gap:8,marginBottom:8}}>
                      <input value={ntEmoji} onChange={e=>setNtEmoji(e.target.value)} style={{...INP,width:56}} placeholder="絵文字"/>
                      <input value={ntLabel} onChange={e=>setNtLabel(e.target.value)} placeholder="タスク名（例：皿洗い）" style={INP}/>
                    </div>
                    <input value={ntPts} onChange={e=>setNtPts(e.target.value)} type="number" placeholder={`ポイント数（例：${kind==="good"?"30":"-50"}）`} style={{...INP,marginBottom:6}}/>
                    {ntPts&&isNaN(parseInt(ntPts))&&<p style={{color:R,fontSize:11,margin:"0 0 6px"}}>数字で入力してください</p>}
                    {(!ntLabel||!ntPts)&&<p style={{color:MUTED,fontSize:11,margin:"0 0 6px"}}>タスク名とポイント数を入力してください</p>}
                    <div style={{display:"flex",gap:8}}>{sb(color,"✅ 追加する",addTask,!ntLabel||!ntPts||isNaN(parseInt(ntPts)))}{sb(MUTED,"キャンセル",()=>setNewTask(null))}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* DAILY TASKS MANAGEMENT */}
      {tab==="daily" && <ParentDailyTab data={data} update={update} sb={sb}/>}

      {/* REWARDS */}
      {tab==="rewards" && (
        <div style={{padding:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}>こうかん特典の管理</p>
            <Btn c={P} label="＋ 追加" onClick={()=>setShowAddReward(true)} sm/>
          </div>
          {data.rewards.map(r=>(
            <div key={r.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"10px 13px",marginBottom:8}}>
              {editReward?.id===r.id ? (
                <div>
                  <div style={{display:"flex",gap:8,marginBottom:8}}>
                    <input value={editReward.emoji} onChange={e=>setEditReward(v=>({...v,emoji:e.target.value}))} style={{...INP,width:56}}/>
                    <input value={editReward.label} onChange={e=>setEditReward(v=>({...v,label:e.target.value}))} style={INP}/>
                  </div>
                  <input value={editReward.cost} onChange={e=>setEditReward(v=>({...v,cost:e.target.value}))} type="number" style={{...INP,marginBottom:8}}/>
                  <input value={editReward.unit} onChange={e=>setEditReward(v=>({...v,unit:e.target.value}))} style={{...INP,marginBottom:10}}/>
                  <div style={{display:"flex",gap:8}}>{sb(G,"保存",saveReward)}{sb(MUTED,"キャンセル",()=>setEditReward(null))}</div>
                </div>
              ) : (
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  {/^r0\d$/.test(r.id)?<img src={`/assets/reward_${r.id}.png`} style={{width:30,height:30,objectFit:"contain",borderRadius:6,flexShrink:0}} alt=""/>:<span style={{fontSize:22}}>{r.emoji}</span>}
                  <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14}}>{r.label}</div><div style={{color:MUTED,fontSize:12}}>{r.unit}</div></div>
                  <span style={{fontWeight:800,color:P,marginRight:6}}>{r.cost.toLocaleString()}pt</span>
                  <div style={{display:"flex",gap:5}}>{sb(B,"✏",()=>setEditReward({...r,cost:String(r.cost)}))}{sb(R,"🗑",()=>delReward(r.id))}</div>
                </div>
              )}
            </div>
          ))}
          {showAddReward && (
            <div style={{background:`${P}12`,border:`2px dashed ${P}`,borderRadius:14,padding:14,marginTop:8}}>
              <div style={{display:"flex",gap:8,marginBottom:8}}>
                <input value={nrEmoji} onChange={e=>setNrEmoji(e.target.value)} style={{...INP,width:56}}/>
                <input value={nrLabel} onChange={e=>setNrLabel(e.target.value)} placeholder="特典名" style={INP}/>
              </div>
              <input value={nrCost} onChange={e=>setNrCost(e.target.value)} type="number" placeholder="必要ポイント（pt）" style={{...INP,marginBottom:8}}/>
              <input value={nrUnit} onChange={e=>setNrUnit(e.target.value)} placeholder="内容説明（例: 30分延長）" style={{...INP,marginBottom:10}}/>
              <div style={{display:"flex",gap:8}}>{sb(P,"追加する",addReward)}{sb(MUTED,"キャンセル",()=>setShowAddReward(false))}</div>
            </div>
          )}
        </div>
      )}

      {/* KAKEIBO picker */}
      {tab==="kakeibo" && (
        <div style={{padding:16}}>
          <p style={{color:MUTED,fontSize:13,fontWeight:800,marginBottom:12}}>💸 こどもを選んでください</p>
          {data.children.map(child=>(
            <button key={child.id} onClick={()=>setKChild(child.id)}
              style={{width:"100%",background:CARD,border:`2px solid ${BORDER}`,borderRadius:18,padding:"13px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:14,cursor:"pointer",textAlign:"left",fontFamily:F}}>
              <Emo e={child.emoji} size={32}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:800,fontSize:15}}>{child.name}</div>
                <div style={{color:MUTED,fontSize:12}}>今月支出: {(data.expenses||[]).filter(e=>e.cid===child.id&&(e.date||"").startsWith(monthKey())).reduce((s,e)=>s+e.amt,0).toLocaleString()}pt</div>
              </div>
              <span style={{color:MUTED,fontSize:22}}>›</span>
            </button>
          ))}
          {/* category settings */}
          <div style={{paddingTop:16,borderTop:`2px solid ${BORDER}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <p style={{color:MUTED,fontSize:13,fontWeight:800,margin:0}}>カテゴリ設定</p>
              <Btn c={B} label="＋" onClick={()=>setShowAddCat(true)} sm/>
            </div>
            {(data.cats||[]).map(cat=>(
              <div key={cat.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"8px 12px",marginBottom:7}}>
                {editCat?.id===cat.id ? (
                  <div>
                    <div style={{display:"flex",gap:8,marginBottom:8}}>
                      <input value={editCat.emoji} onChange={e=>setEditCat(c=>({...c,emoji:e.target.value}))} style={{...INP,width:56}}/>
                      <input value={editCat.label} onChange={e=>setEditCat(c=>({...c,label:e.target.value}))} style={INP}/>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
                      <span style={{fontSize:12,color:MUTED,fontWeight:700}}>カラー:</span>
                      <input type="color" value={editCat.color} onChange={e=>setEditCat(c=>({...c,color:e.target.value}))} style={{width:44,height:30,border:"none",cursor:"pointer"}}/>
                    </div>
                    <div style={{display:"flex",gap:8}}>{sb(G,"保存",saveCat)}{sb(MUTED,"キャンセル",()=>setEditCat(null))}</div>
                  </div>
                ) : (
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:cat.color,flexShrink:0}}/>
                    <span style={{fontSize:16}}>{cat.emoji}</span>
                    <span style={{flex:1,fontWeight:700,fontSize:13}}>{cat.label}</span>
                    <div style={{display:"flex",gap:5}}>{sb(B,"✏",()=>setEditCat({...cat}))}{sb(R,"🗑",()=>delCat(cat.id))}</div>
                  </div>
                )}
              </div>
            ))}
            {showAddCat && (
              <div style={{background:`${B}12`,border:`2px dashed ${B}`,borderRadius:12,padding:14,marginTop:8}}>
                <div style={{display:"flex",gap:8,marginBottom:8}}>
                  <input value={ncatEmoji} onChange={e=>setNcatEmoji(e.target.value)} style={{...INP,width:56}}/>
                  <input value={ncatLabel} onChange={e=>setNcatLabel(e.target.value)} placeholder="カテゴリ名" style={INP}/>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                  <span style={{fontSize:12,color:MUTED,fontWeight:700}}>カラー:</span>
                  <input type="color" value={ncatColor} onChange={e=>setNcatColor(e.target.value)} style={{width:44,height:30,border:"none",cursor:"pointer"}}/>
                </div>
                <div style={{display:"flex",gap:8}}>{sb(B,"追加する",addCat)}{sb(MUTED,"キャンセル",()=>setShowAddCat(false))}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* まいにちのタネ settings（ガチャ→ログインボーナス化。確率設定は廃止） */}
      {tab==="gacha" && (
        <div style={{padding:16}}>
          <div style={{background:CARD,border:`2px solid ${BORDER}`,borderRadius:18,padding:16,marginBottom:16}}>
            <p style={{fontWeight:900,fontSize:14,margin:"0 0 6px"}}>🌱 まいにちのタネ</p>
            <p style={{color:TEXTS,fontSize:12.5,margin:"0 0 10px",lineHeight:1.6}}>毎日ひらくと ボーナスポイントがもらえる ログインボーナスです。ランダム（ガチャ）や レア確率は使わず、<b>誠実さ重視</b>で だれでも同じ・射幸性なし。</p>
            <div style={{background:GS,borderRadius:12,padding:"10px 13px",fontSize:12,color:GP,fontWeight:700,lineHeight:1.7}}>
              ・毎日 +5pt<br/>
              ・連続3日 +3 / 7日 +5 / 14日 +10 / 30日 +15pt<br/>
              ・図鑑は ひらくたびに 順番に集まる（ぜんぶ集められる）
            </div>
          </div>
          <p style={{color:MUTED,fontSize:13,fontWeight:800,marginBottom:8}}>今日の受け取り状況</p>
          {data.children.map(child=>{
            const done=data.gachaDate?.[child.id]===todayKey();
            return (
              <div key={child.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"11px 13px",marginBottom:8,display:"flex",alignItems:"center",gap:12}}>
                <Emo e={child.emoji} size={26}/>
                <span style={{flex:1,fontWeight:700,fontSize:14}}>{child.name}</span>
                <span style={{fontWeight:800,fontSize:12,color:done?G:MUTED}}>{done?"✅ 受け取り済み":"⏳ まだ"}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── ファミリータブ（FamilyGuardianScreen埋め込み） ── */}
      {tab==="family" && (
        <FamilyGuardianScreen
          data={data}
          onBack={()=>setTab("overview")}
          onPublicView={()=>{
            // App側のscreen管理でfamily_publicへ遷移（ここでは無効化）
            setTab("overview");
          }}
        />
      )}

      {/* ── 学ぶタブ（親向け投資・為替） ── */}
      {tab==="learn" && (
        <InvestLearnTab
          child={(data.parents||[])[0]||{id:"p1",name:"パパ",emoji:"👨",permissions:{investment:"trade",forex:"trade"}}}
          data={data}
          update={update}
          onRanking={()=>setTab("overview")}
        />
      )}

      {/* LOG */}
      {tab==="log" && (
        <div style={{padding:16}}>
          {data.children.map(child=>{
            const logs=data.logs.filter(l=>l.cid===child.id).slice(0,20);
            return (
              <div key={child.id} style={{marginBottom:24}}>
                <p style={{fontWeight:800,fontSize:13,color:MUTED,marginBottom:8}}><Emo e={child.emoji} size={13} style={{marginRight:3}}/>{child.name}　<span style={{color:G}}>{bal(data.logs,child.id).toLocaleString()}pt</span></p>
                {logs.map(l=>{
                  const emoji=l.type==="grant"?"🎁":l.type==="gacha"?"🎰":l.type==="reward"?"🎁":([...data.goodTasks,...data.badTasks].find(t=>t.id===l.rid)?.emoji||"📌");
                  return (
                    <div key={l.id} style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"10px 13px",marginBottom:6,display:"flex",alignItems:"center",gap:10}}>
                      <span style={{fontSize:17}}>{emoji}</span>
                      <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{l.label}</div><div style={{color:MUTED,fontSize:11}}>{fmtDate(l.date)}</div></div>
                      <Pt v={l.pts}/>
                    </div>
                  );
                })}
                {logs.length===0 && <p style={{color:MUTED,fontSize:12,textAlign:"center"}}>まだ履歴がありません</p>}
              </div>
            );
          })}
        </div>
      )}

      {/* ── AI分析タブ ── */}
      {tab==="ai" && <AiAdvisorTab data={data}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// HOME
// ═══════════════════════════════════════════════════════
function HomeScreen({ data, update, onChild, onParent, onParentCard, onSettings }) {
  const [showOnboardGuide, setShowOnboardGuide] = useState(false);
  const [showDash, setShowDash] = useState(false);   // 親ダッシュボード(今日/今週)の折りたたみ
  const allMembers = [
    ...data.children.map(c=>({...c, isChild:true})),
    ...(data.parents||[]).map(p=>({...p, isChild:false})),
  ];
  const thisMonth = new Date().toISOString().slice(0,7);
  const monthDelta = (memberId) => {
    return (data.logs||[])
      .filter(l=>l.cid===memberId && (l.date||"").startsWith(thisMonth))
      .reduce((s,l)=>s+l.pts,0);
  };
  const todayDelta = (memberId) => {
    const td = todayKey();
    return (data.logs||[])
      .filter(l=>l.cid===memberId && (l.date||"").startsWith(td) && l.pts>0)
      .reduce((s,l)=>s+l.pts,0);
  };
  const topGoal = (memberId) => {
    const goals=(data.goals||[]).filter(g=>g.cid===memberId&&!g.done);
    if(!goals.length) return null;
    const g=goals[0];
    const cur=bal(data.logs,memberId);
    const pct=Math.min(100,Math.floor(cur/g.target*100));
    return{label:g.label,pct,target:g.target};
  };

  const onboardChecks = {
    pin: !parentPinIsDefault(data),
    tasks: !!(data.onboardingChecks?.tasksOpened),
    rewards: !!(data.onboardingChecks?.rewardsOpened),
  };
  const onboardRemaining = Object.values(onboardChecks).filter(v=>!v).length;
  const showOnboard = data.setupComplete === true && onboardRemaining > 0;
  const pendCount = (data.pendingApprovals||[]).length+(data.pendingRedemptions||[]).length;

  return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,paddingBottom:32}}>
      {/* ヘッダー */}
      <div style={{padding:"52px 20px 12px"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:40,height:40,borderRadius:12,background:GP,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,boxShadow:`0 4px 12px ${GP}40`}}>🌱</div>
            <div>
              <div style={{fontFamily:FB,fontWeight:900,fontSize:19,color:GP,letterSpacing:.5}}>Tane Money</div>
              <div style={{fontSize:11,color:MUTED,letterSpacing:.3}}>お金は、未来を育てるタネ。</div>
            </div>
          </div>
          <button onClick={()=>onSettings&&onSettings()}
            style={{width:38,height:38,borderRadius:11,background:CARD,border:`1.5px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",boxShadow:"0 2px 8px rgba(24,35,29,0.05)",position:"relative"}}>
            ⚙
            {parentPinIsDefault(data)&&<div style={{position:"absolute",top:-4,right:-4,width:10,height:10,borderRadius:"50%",background:R,border:"2px solid #fff"}}/>}
          </button>
        </div>
      </div>

      {/* 未承認だけは緊急性が高いので 上部に細いアラートで残す */}
      {pendCount>0 && (
        <div onClick={()=>onParent&&onParent()} style={{margin:"0 20px 12px",background:RS,border:`1.5px solid ${R}`,borderRadius:12,padding:"9px 14px",display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
          <span style={{fontSize:16}}>🔔</span>
          <span style={{flex:1,fontSize:13,fontWeight:800,color:R}}>みしょうにんが {pendCount}けん あります</span>
          <span style={{fontSize:12,color:R,fontWeight:700}}>かくにん ›</span>
        </div>
      )}

      <div style={{padding:"0 20px"}}>
        <div style={{fontSize:15,fontWeight:800,color:TEXT,marginBottom:12}}>だれの ページを ひらく？</div>
        {/* 子ども */}
        <div style={{fontSize:13,fontWeight:800,color:MUTED,letterSpacing:.5,marginBottom:10}}>おこさま</div>
        {allMembers.filter(m=>m.isChild).map(member=>{
          const goal=topGoal(member.id);
          return (
            <button key={member.id} onClick={()=>onChild(member)}
              style={{width:"100%",background:CARD,border:`1px solid ${BORDER}`,borderRadius:20,padding:"14px 16px",marginBottom:10,display:"block",textAlign:"left",cursor:"pointer",fontFamily:F,boxShadow:"0 4px 16px rgba(24,35,29,0.06)"}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:goal?12:0}}>
                <ChildAvatar child={member} size={44}/>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                    <span style={{fontWeight:700,fontSize:15,color:TEXT}}>{member.name}</span>
                    <span style={{fontSize:11,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:600}}>こども</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,color:MUTED}}>{member.gradeLabel||"中高生"}</span>
                    <span style={{fontSize:11,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:700}}>累計 {bal(data.logs,member.id).toLocaleString()}pt</span>
                    {(()=>{const td=todayDelta(member.id);return td>0&&<span style={{fontSize:11,background:GOLDS,color:GOLD,padding:"2px 7px",borderRadius:999,fontWeight:700}}>今日 +{td}pt</span>;})()}
                  </div>
                </div>
                <ChevronRightIcon/>
              </div>
              {goal&&(
                <div style={{background:BG,borderRadius:10,padding:"8px 12px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <span style={{fontSize:11,color:TEXTS,fontWeight:600}}>{goal.label}</span>
                    <span style={{fontSize:11,fontWeight:700,color:GP}}>{goal.pct}%</span>
                  </div>
                  <div style={{background:BORDER,borderRadius:999,height:5,overflow:"hidden"}}>
                    <div style={{width:`${goal.pct}%`,height:"100%",background:G,borderRadius:999}}/>
                  </div>
                </div>
              )}
            </button>
          );
        })}

        {/* 親 */}
        {allMembers.filter(m=>!m.isChild).length>0&&(
          <div style={{fontSize:13,fontWeight:800,color:MUTED,letterSpacing:.5,margin:"16px 0 10px"}}>おうちのかた</div>
        )}
        {allMembers.filter(m=>!m.isChild).map(member=>{
          const childCount = data.children.length;
          const monthTotal = data.children.reduce((s,c)=>s+monthDelta(c.id),0);
          return (
          <button key={member.id} onClick={()=>onParentCard(member)}
            style={{width:"100%",background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:"14px 16px",marginBottom:8,display:"flex",alignItems:"center",gap:12,cursor:"pointer",textAlign:"left",fontFamily:F,boxShadow:"0 4px 16px rgba(24,35,29,0.06)"}}>
            <ChildAvatar child={member} size={44}/>
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <span style={{fontWeight:700,fontSize:14,color:TEXT}}>{member.name}</span>
                <span style={{fontSize:11,background:CARDS,color:TEXTS,padding:"2px 7px",borderRadius:999,fontWeight:600}}>おとな</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:MUTED}}>子ども {childCount}人</span>
                <span style={{fontSize:11,background:GS,color:GP,padding:"2px 7px",borderRadius:999,fontWeight:700}}>今月計 {monthTotal.toLocaleString()}pt</span>
              </div>
            </div>
            <ChevronRightIcon/>
          </button>
          );
        })}

        {/* 📊 おうちの方へ：今日のようす・今週のまとめ(折りたたみ＝メンバーを優先) */}
        {data.children&&data.children.length>0 && (()=>{
          const td=todayKey();
          const kids=data.children||[];
          const didToday=kids.filter(c=>(data.logs||[]).some(l=>l.cid===c.id&&(l.type==="good"||l.type==="daily")&&(l.date||"").startsWith(td)));
          const gachaLeft=kids.filter(c=>(data.gachaDate?.[c.id])!==td);
          const wkAgo=(()=>{const d=new Date();d.setDate(d.getDate()-7);return d.toISOString();})();
          return (
            <div style={{marginTop:20}}>
              <button onClick={()=>setShowDash(v=>!v)} style={{width:"100%",background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"12px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",fontFamily:F}}>
                <span style={{fontSize:13,fontWeight:800,color:TEXT}}>📊 おうちの方へ（今日・今週のまとめ）</span>
                <span style={{fontSize:12,color:MUTED}}>{showDash?"▲":"▼"}</span>
              </button>
              {showDash && (<>
                <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"14px 16px",boxShadow:SHADOW,marginTop:10}}>
                  <div style={{fontSize:12,fontWeight:800,color:MUTED,marginBottom:10,letterSpacing:.5}}>📋 きょうの ようす</div>
                  <div style={{display:"flex",alignItems:"stretch",gap:8}}>
                    <div onClick={()=>pendCount>0&&onParent&&onParent()} style={{flex:1,textAlign:"center",cursor:pendCount>0?"pointer":"default"}}>
                      <div style={{fontSize:24,fontWeight:900,color:pendCount>0?R:TEXT,lineHeight:1.1}}>{pendCount}</div>
                      <div style={{fontSize:12,color:MUTED,fontWeight:700,marginTop:2}}>みしょうにん{pendCount>0?" 👆":""}</div>
                    </div>
                    <div style={{width:1,background:BORDER}}/>
                    <div style={{flex:1,textAlign:"center"}}>
                      <div style={{fontSize:24,fontWeight:900,color:G,lineHeight:1.1}}>{didToday.length}<span style={{fontSize:13,color:MUTED,fontWeight:700}}>/{kids.length}</span></div>
                      <div style={{fontSize:12,color:MUTED,fontWeight:700,marginTop:2}}>きょう おてつだい</div>
                    </div>
                    <div style={{width:1,background:BORDER}}/>
                    <div style={{flex:1,textAlign:"center"}}>
                      <div style={{fontSize:24,fontWeight:900,color:gachaLeft.length>0?GOLD:MUTED,lineHeight:1.1}}>{gachaLeft.length}</div>
                      <div style={{fontSize:12,color:MUTED,fontWeight:700,marginTop:2}}>ガチャ まだ</div>
                    </div>
                  </div>
                  {gachaLeft.length>0 && <div style={{fontSize:11,color:MUTED,marginTop:10,paddingTop:8,borderTop:`1px solid ${BORDER}`,lineHeight:1.5}}>🌱 タネが まだの子：<b style={{color:"#9a7000"}}>{gachaLeft.map(c=>c.name).join("、")}</b></div>}
                </div>
                <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"14px 16px",boxShadow:SHADOW,marginTop:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
                    <span style={{fontSize:12,fontWeight:800,color:MUTED,letterSpacing:.5}}>📊 今週のまとめ（7日間）</span>
                    <span style={{fontSize:10,color:MUTED}}>かせいだ・つかった・🧹回数</span>
                  </div>
                  {data.children.map((c,idx)=>{
                    const wl=(data.logs||[]).filter(l=>l.cid===c.id&&(l.date||"")>=wkAgo);
                    const earned=wl.filter(l=>l.pts>0).reduce((s,l)=>s+l.pts,0);
                    const spent=wl.filter(l=>l.pts<0).reduce((s,l)=>s-l.pts,0);
                    const chores=wl.filter(l=>l.type==="good"||l.type==="daily").length;
                    return (
                      <div key={c.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderTop:idx===0?"none":`1px solid ${BORDER}`}}>
                        <ChildAvatar child={c} size={30}/>
                        <span style={{flex:1,fontSize:13,fontWeight:700,color:TEXT,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name}</span>
                        <span style={{fontSize:12,color:G,fontWeight:900,minWidth:54,textAlign:"right"}}>+{earned.toLocaleString()}</span>
                        <span style={{fontSize:12,color:R,fontWeight:900,minWidth:48,textAlign:"right"}}>-{spent.toLocaleString()}</span>
                        <span style={{fontSize:12,color:MUTED,fontWeight:800,minWidth:30,textAlign:"right"}}>🧹{chores}</span>
                      </div>
                    );
                  })}
                </div>
              </>)}
            </div>
          );
        })()}

        {/* 同期 */}
        <div style={{marginTop:20,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",background:CARD,borderRadius:12,border:`1px solid ${BORDER}`}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:G}}/>
            <span style={{fontSize:11,color:TEXTS}}>同期済み</span>
          </div>
          <span style={{fontSize:11,color:MUTED,letterSpacing:1.5,fontWeight:700}}>
            {(()=>{try{return localStorage.getItem("tane_money_family_code")||"---";}catch(e){return "---";}})()}
          </span>
        </div>
      </div>

      {/* 初心者ガイド 浮きボタン（LINE Farm風） */}
      {showOnboard&&(
        <div style={{position:"fixed",left:10,top:220,zIndex:500}}>
          <button onClick={()=>setShowOnboardGuide(true)} style={{background:CARD,border:`2px solid ${GP}`,borderRadius:20,padding:"10px 7px",boxShadow:`0 4px 18px ${GP}30`,display:"flex",flexDirection:"column",alignItems:"center",gap:3,cursor:"pointer",fontFamily:F,position:"relative",width:54}}>
            {onboardRemaining>0&&<div style={{position:"absolute",top:-7,right:-7,width:20,height:20,borderRadius:"50%",background:R,color:"#fff",fontSize:11,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center",border:"2px solid #fff"}}>{onboardRemaining}</div>}
            <span style={{fontSize:22}}>📋</span>
            <span style={{fontSize:11,fontWeight:800,color:GP,lineHeight:1.3,textAlign:"center"}}>初心者<br/>ガイド</span>
          </button>
        </div>
      )}

      {/* 初心者ガイド モーダル */}
      {showOnboardGuide&&(
        <div style={{position:"fixed",inset:0,background:"#0008",zIndex:9100,display:"flex",alignItems:"flex-end",fontFamily:F}} onClick={()=>setShowOnboardGuide(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:CARD,borderRadius:"24px 24px 0 0",width:"100%",padding:"24px 20px 48px",boxShadow:"0 -8px 32px rgba(24,35,29,0.12)"}}>
            <div style={{width:36,height:4,borderRadius:999,background:BORDER,margin:"0 auto 16px"}}/>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
              <span style={{fontSize:22}}>📋</span>
              <h3 style={{fontWeight:900,fontSize:17,color:TEXT,margin:0}}>初心者ガイド</h3>
              {onboardRemaining>0&&<span style={{background:R,color:"#fff",borderRadius:999,padding:"2px 9px",fontSize:11,fontWeight:900}}>{onboardRemaining}つ残り</span>}
            </div>
            <p style={{color:MUTED,fontSize:12,margin:"0 0 18px"}}>最初に設定しておくと安心！</p>
            {[
              {key:"pin",emoji:"🔐",title:"PINを変更する",desc:"おや管理 → 詳細設定 → PIN タブ",done:onboardChecks.pin,
               action:()=>{setShowOnboardGuide(false);onParent();}},
              {key:"tasks",emoji:"📋",title:"タスクを確認する",desc:"おや管理 → 詳細設定 → タスク タブ",done:onboardChecks.tasks,
               action:()=>{if(update)update(d=>({...d,onboardingChecks:{...(d.onboardingChecks||{}),tasksOpened:true}}));setShowOnboardGuide(false);onParent();}},
              {key:"rewards",emoji:"🎁",title:"特典を確認する",desc:"おや管理 → 詳細設定 → 特典 タブ",done:onboardChecks.rewards,
               action:()=>{if(update)update(d=>({...d,onboardingChecks:{...(d.onboardingChecks||{}),rewardsOpened:true}}));setShowOnboardGuide(false);onParent();}},
            ].map(item=>(
              <div key={item.key} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 0",borderBottom:`1px solid ${BORDER}`}}>
                <div style={{width:44,height:44,borderRadius:14,background:item.done?GS:BG,border:`2px solid ${item.done?G:BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
                  {item.done?"✅":item.emoji}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14,color:item.done?MUTED:TEXT,textDecoration:item.done?"line-through":"none"}}>{item.title}</div>
                  <div style={{fontSize:11,color:MUTED,marginTop:2}}>{item.desc}</div>
                </div>
                {!item.done&&<button onClick={item.action} style={{padding:"8px 14px",background:GP,border:"none",borderRadius:10,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,flexShrink:0}}>開く →</button>}
              </div>
            ))}
            <button onClick={()=>setShowOnboardGuide(false)} style={{width:"100%",marginTop:16,padding:"11px",background:"transparent",border:`1.5px solid ${BORDER}`,borderRadius:12,color:MUTED,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F}}>
              後で確認する
            </button>
          </div>
        </div>
      )}

      {/* 設定モーダル */}
    </div>
  );
}

// 小さなシェブロン右
function ChevronRightIcon(){
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>;
}

// 操作部アイコン（lucide不使用・stroke=currentColorで親colorを継承＝新色を作らない）。
// 世界側のemoji(➕🌟💧みのり等)は対象外。UIクロムの機能emojiのみ置換する。
function FIcon({name,size=18,style}){
  const c={width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round",style:{display:"block",flexShrink:0,...style}};
  switch(name){
    case"streak": return <svg {...c}><path d="M12 3c2 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.5.6-2.7 1.4-3.6C9.6 8 9 9 9 11a3 3 0 0 0 .2 1C8.5 11.4 8 10.3 8 9c0-2.4 1.8-4.4 4-6Z"/></svg>;
    case"water": return <svg {...c}><path d="M12 3.5c3 3.6 5.5 6.4 5.5 9.6a5.5 5.5 0 0 1-11 0c0-3.2 2.5-6 5.5-9.6Z"/></svg>;
    case"coin":  return <svg {...c}><circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M9.5 10.2c0-1 1.1-1.7 2.5-1.7s2.5.7 2.5 1.7-1.1 1.6-2.5 1.6-2.5.7-2.5 1.7 1.1 1.7 2.5 1.7 2.5-.7 2.5-1.7"/></svg>;
    case"book":  return <svg {...c}><path d="M12 6.5C10.5 5.4 8.4 5 6 5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1c2.4 0 4.5.4 6 1.5"/><path d="M12 6.5C13.5 5.4 15.6 5 18 5a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1c-2.4 0-4.5.4-6 1.5"/><path d="M12 6.5v13"/></svg>;
    case"palette": return <svg {...c}><path d="M12 4a8 8 0 0 0 0 16c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.9-.5-1.2-.3-.4-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a4 4 0 0 0 4-4c0-3.9-3.6-6.4-8-6.4Z"/><circle cx="8.5" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="8.5" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10.5" r="1" fill="currentColor" stroke="none"/></svg>;
    case"bucket": return <svg {...c}><path d="M5 7h14l-1.4 11.2a2 2 0 0 1-2 1.8H8.4a2 2 0 0 1-2-1.8L5 7Z"/><path d="M4 7h16"/><path d="M8.5 7a3.5 3.5 0 0 1 7 0"/></svg>;
    case"vault": return <svg {...c}><path d="M4 10.5 12 4l8 6.5"/><path d="M5.5 10v9.5h13V10"/><rect x="9.5" y="13" width="5" height="6.5"/></svg>;
    default: return null;
  }
}


function PinResetScreen({ data, update, onBack }) {
  const [target, setTarget] = useState(null);
  const [newPin, setNewPin]  = useState("");

  const doReset = () => {
    if (newPin.length!==4) return;
    if (target==="parent") update(d=>{const{parentPin,...rest}=d;return{...rest,parentPinH:pinHash(newPin)};});
    else update(d=>({...d,children:d.children.map(c=>c.id===target?(({pin,...r})=>({...r,pinh:pinHash(newPin)}))(c):c),pinChanged:{...(d.pinChanged||{}),[target]:true}}));
    onBack();
  };

  return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,position:"relative"}}>
      <button onClick={onBack} style={{position:"absolute",top:20,left:20,background:"none",border:"none",fontSize:28,cursor:"pointer",color:MUTED}}>‹</button>
      <div style={{fontSize:46,marginBottom:8}}>🔑</div>
      <h2 style={{fontWeight:900,fontSize:20,margin:"0 0 6px"}}>PINを再設定</h2>
      <p style={{color:MUTED,fontSize:12,marginBottom:22,textAlign:"center"}}>変更するアカウントを選んでください</p>
      <div style={{width:"100%",maxWidth:340,marginBottom:18}}>
        {[{id:"parent",name:"おや管理画面",emoji:"🔐"},...data.children].map(item=>(
          <button key={item.id} onClick={()=>setTarget(item.id)}
            style={{width:"100%",background:target===item.id?"#fef9e0":CARD,border:`2px solid ${target===item.id?Y:BORDER}`,borderRadius:14,padding:"11px 15px",marginBottom:8,display:"flex",alignItems:"center",gap:12,cursor:"pointer",fontFamily:F}}>
            <span style={{fontSize:26}}>{item.emoji}</span>
            <span style={{fontWeight:800,fontSize:14}}>{item.name}</span>
          </button>
        ))}
      </div>
      {target && (
        <div style={{width:"100%",maxWidth:340}}>
          <p style={{color:MUTED,fontSize:13,fontWeight:700,marginBottom:8}}>新しい暗証番号（4けた）</p>
          <input value={newPin} onChange={e=>setNewPin(e.target.value.slice(0,4))} type="number" placeholder="0000" style={{...INP,marginBottom:14,fontSize:22,textAlign:"center",letterSpacing:10}}/>
          <Btn c={G} label="✅ 保存する" onClick={doReset} disabled={newPin.length!==4} full/>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// APP ROOT
// ═══════════════════════════════════════════════════════
// Child avatar: photo or emoji

// ── SortBar ──────────────────────────────────────────
// iOS 26 セグメントコントロール：グラスのトラック＋白いサム(選択)＋やわらか影
function SortBar({options,value,onChange}){
  return(<div style={{display:"inline-flex",gap:3,padding:3,borderRadius:12,background:"rgba(120,120,128,0.14)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",maxWidth:"100%",overflowX:"auto",scrollbarWidth:"none"}}>
    {options.map(([v,l])=>{
      const on=value===v;
      return(<button key={v} onClick={()=>onChange(v)}
        style={{flex:"0 0 auto",padding:"6px 13px",border:"none",borderRadius:9,background:on?"#fff":"transparent",color:on?TEXT:MUTED,fontWeight:on?800:600,fontSize:11.5,cursor:"pointer",fontFamily:F,whiteSpace:"nowrap",boxShadow:on?"0 1px 3px rgba(0,0,0,0.16),0 1px 1px rgba(0,0,0,0.06)":"none",transition:"background .18s,color .18s"}}>
        {l}
      </button>);
    })}
  </div>);
}

// ── Interest System ───────────────────────────────────
function applyInterest(data,update,cid){
  if(!data.interestEnabled||!data.interestRate) return;
  const today=todayKey();
  // 付与判定・残高計算・付与日記録をすべて update の中(最新のd)で原子的に行う＝
  // 多重呼び出し/再マウント/同期巻き戻しでも二重付与されない
  update(d=>{
    if(!d.interestEnabled||!d.interestRate) return d;
    const last=(d.interestLastDate||{})[cid];
    if(last===today) return d;                       // 同日は付与済み
    if(last){
      const diff=(new Date(today.replace(/-/g,'/'))-new Date(last.replace(/-/g,'/')))/86400000;
      if(diff<7) return d;                            // 前回から7日未満はスキップ(週次)
    }
    const cur=bal(d.logs,cid);
    if(cur<=0) return d;
    const interest=Math.floor(cur*d.interestRate);
    if(interest<=0) return d;
    // idを「利子_cid_日付」で決定的に＝2端末が同時付与しても同一idになり、reconcile/onSnapshotの重複排除で1件に集約(二重加算防止)。
    const _e={id:`interest_${cid}_${today}`,cid,type:"interest",label:`💹 週次利子（残高×${Math.round(d.interestRate*100)}%）`,pts:interest,date:new Date().toISOString()};
    addLogToFirestore(_e);
    return {...d, logs:[_e,...d.logs], interestLastDate:{...(d.interestLastDate||{}),[cid]:today}};
  });
}

// ── 配当（毎週・控えめ週0.3〜0.5%）。株価変動より小さく＝「持てば必ず増える」誤学習をしない健全設計 ─────
// 配当は控えめ(週0.3〜0.5%)＝株価変動より小さく。短期売買は手数料で損しやすく、長く持つと配当でコツコツ。ただし株価が下がればトータルでは損もある(健全)
function applyHoldingBonus(data,update,cid){
  const week=Math.floor(Date.now()/(7*86400000));  // 週単位で支払い
  if((data.holdings||{})[cid]==null || !((data.holdings||{})[cid]||[]).length) return;
  const toPts=(s,p)=>s.currency==="USD"?Math.max(1,Math.round(p*1.5)):Math.max(1,Math.round(p/100));
  const now=Date.now();
  // 付与判定・記録を update の中(最新のd)で原子的に＝二重付与しない
  update(d=>{
    if((d.holdBonusLastDate||{})[cid]===week) return d;   // 今週は付与済み
    const holdings=(d.holdings||{})[cid]||[];
    if(!holdings.length) return d;
    const stocks=d.stocks||[];
    let totalBonus=0;
    holdings.forEach(h=>{
      const st=stocks.find(x=>x.id===h.stockId);
      if(!st) return;
      const days=h.firstBuyDate?(now-new Date(h.firstBuyDate).getTime())/86400000:0;
      // 配当: 週0.3%(長く持つと少しだけUP・上限0.5%)。株価の値動きより小さい＝「持てば必ず増える」わけではない(健全な投資観)
      const rate = days>=90?0.005 : days>=30?0.004 : 0.003;
      totalBonus+=Math.round(toPts(st,st.price)*h.qty*rate);
    });
    if(totalBonus<=0) return d;
    // idを「配当_cid_週」で決定的に＝2端末同時付与でも同一idで1件に集約(二重加算防止)。
    const _e={id:`dividend_${cid}_${week}`,cid,type:"interest",label:`💰 配当（株を持っていると もらえる）`,pts:totalBonus,date:new Date().toISOString()};
    addLogToFirestore(_e);
    return {...d, logs:[_e,...d.logs], holdBonusLastDate:{...(d.holdBonusLastDate||{}),[cid]:week}};
  });
}

// ── Stock News & Fetch ────────────────────────────────
const STOCK_NEWS={
  "7974.T":["新作スイッチソフトが大ヒット！","為替の影響で利益が変動","海外市場での販売好調","次世代機の噂が広まる","人気IPの新作発表"],
  "6758.T":["PlayStation新作が世界トップセールス","半導体不足が解消に向かう","映画・音楽部門が好調","円安でドル収益が増加","AI技術への投資を発表"],
  "7203.T":["EV新モデルが好評","半導体供給が安定化","米国市場でシェア拡大","環境対応で補助金獲得","新工場の建設を発表"],
  "MCD":["新メニューが世界的にヒット","原材料コストが上昇","デジタル注文が急増","アジア市場での出店加速","健康志向メニューを拡充"],
  "AAPL":["iPhone新モデルが記録的売上","インドでの生産を拡大","サービス部門の収益が増加","新型Macが高評価","AIチップ搭載で注目集める"],
};

async function fetchRealStockPrices(data,update){
  const today=todayKey();
  const stockAlreadyFetched = data.stockLastUpdate===today && data.stockFetchStatus==="ok";
  // 為替は毎回取得（株は1日1回）
  update(d=>({...d,stockFetchStatus:stockAlreadyFetched?"ok":"loading"}));

  // プロキシを複数用意してフォールバック
  const fetchWithProxy = async (url, timeout=12000) => {
    const proxies = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    ];
    for(const proxy of proxies){
      try{
        const ctrl = new AbortController();
        const timer = setTimeout(()=>ctrl.abort(), timeout);
        const r = await fetch(proxy, {signal:ctrl.signal});
        clearTimeout(timer);
        if(!r.ok) continue;
        const text = await r.text();
        if(!text || text.length < 10) continue;
        try { return JSON.parse(text); } catch(e) { continue; }
      }catch(e){ continue; }
    }
    throw new Error("All proxies failed for: " + url);
  };

  const forexMap = {}; // 為替データを蓄積

  // ── 為替レート取得（1通貨ずつ順番に・レート制限対策）──
  const FOREX_PAIRS=["USDJPY=X","EURJPY=X","GBPJPY=X","CNYJPY=X","KRWJPY=X"];
  const FOREX_LABELS={
    "USDJPY=X":{code:"USD",flag:"🇺🇸",name:"アメリカ ドル"},
    "EURJPY=X":{code:"EUR",flag:"🇪🇺",name:"ユーロ"},
    "GBPJPY=X":{code:"GBP",flag:"🇬🇧",name:"イギリス ポンド"},
    "CNYJPY=X":{code:"CNY",flag:"🇨🇳",name:"中国 人民元"},
    "KRWJPY=X":{code:"KRW",flag:"🇰🇷",name:"韓国 ウォン"},
  };
  const FOREX_FALLBACKS={
    "USDJPY=X":155,"EURJPY=X":168,"GBPJPY=X":196,"CNYJPY=X":21.4,"KRWJPY=X":0.112
  };
  // フォールバック用の30日分ダミー履歴を生成（変動させてグラフを見せる）
  const makeFallbackHistory=(base)=>{
    const h=[];
    let v=base*0.97;
    for(let i=0;i<30;i++){
      v=v*(1+(Math.random()-0.48)*0.008);
      h.push(Math.round(v*1000)/1000);
    }
    h[h.length-1]=base;
    return h;
  };

  // 1通貨ずつ順番に取得（800ms間隔でレート制限を回避）
  for(let i=0;i<FOREX_PAIRS.length;i++){
    const ticker=FOREX_PAIRS[i];
    if(i>0) await new Promise(res=>setTimeout(res,800));
    try{
      const json=await fetchWithProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=30d`);
      const meta=json?.chart?.result?.[0]?.meta;
      const closes=json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if(!meta) throw new Error("no meta");
      const valid=(closes||[]).filter(v=>v!=null).slice(-30);
      const price=meta.regularMarketPrice||valid[valid.length-1]||FOREX_FALLBACKS[ticker];
      const prev=meta.previousClose||valid[valid.length-2]||price;
      const history=valid.length>=5
        ? valid.map(v=>Math.round(v*1000)/1000)
        : makeFallbackHistory(price);
      forexMap[ticker]={
        ...FOREX_LABELS[ticker],
        price:Math.round(price*1000)/1000,
        prev:Math.round(prev*1000)/1000,
        history,
        changePct:((price-prev)/prev)*100,
        realData:true
      };
      // 取得できたら即座にupdateで反映
      const snapshot={...forexMap};
      update(d=>({...d,forex:snapshot}));
          }catch(e){
      const fb=FOREX_FALLBACKS[ticker];
      forexMap[ticker]={
        ...FOREX_LABELS[ticker],
        price:fb,
        prev:fb,
        history:makeFallbackHistory(fb),
        changePct:0,
        realData:false
      };
      // フォールバックも即座に反映
      const snapshot={...forexMap};
      update(d=>({...d,forex:snapshot}));
      console.warn(`Forex fallback: ${ticker}`);
    }
  }

  // ── 株価取得（1銘柄ずつ順番・1日1回）──
  const stocks = data.stocks||[];

  // 架空銘柄のシミュレーション（リアル取得の「1日1回」ゲートとは独立）。
  // 画面を開くたびに動くと1日に何歩も進む＋Firestore書き込みが増えるため、30分に1回まで（端末ごと）
  const _fakeSimOk=(()=>{ try{ const t=+localStorage.getItem("tane_fake_sim_ts")||0; if(Date.now()-t<30*60*1000) return false; localStorage.setItem("tane_fake_sim_ts",String(Date.now())); return true; }catch(e){ return true; } })();
  if(_fakeSimOk && stocks.some(s=>s.fake)){
    update(d=>({...d,stocks:(d.stocks||[]).map(st=>{
      if(!st.fake) return st;
      const _h=(st.history&&st.history.length)?st.history.slice(-30):[st.price];
      const _last=_h[_h.length-1]||st.price;
      let _nv=_last*(1+(st.bias||0)*(st.power||1)+(Math.random()*2-1)*(st.vol||0.03));
      if(st.floor&&_nv<st.floor)_nv=st.floor*(1+Math.random()*0.06);
      _nv=Math.max(1,Math.round(_nv));
      return {...st,price:_nv,history:[..._h,_nv].slice(-30),lastChange:Math.round((_nv-_last)/(_last||1)*1000)/10,realData:false};
    })}));
  }

  if(stockAlreadyFetched){
    // リアル株はスキップ（為替＋架空銘柄は上で更新済み）
    return;
  }
  const stockResults = {};

  // まず自前API(/api/stocks)で全銘柄を1リクエストでまとめて取得（同一オリジン=CORS不要・外部プロキシ非依存）。
  // 失敗時(ローカル開発・API障害)は従来の外部プロキシに1銘柄ずつフォールバック
  let batchStocks=null;
  try{
    const _rt=stocks.filter(s=>!s.fake&&s.ticker).map(s=>s.ticker);
    if(_rt.length){
      const _r=await fetch(`/api/stocks?tickers=${encodeURIComponent(_rt.join(","))}`);
      if(_r.ok){ const _j=await _r.json(); if(_j&&typeof _j==="object"&&!_j.error) batchStocks=_j; }
    }
  }catch(e){}

  // バッチが効かなかった銘柄だけ、少し間隔をあけて取得（レート制限対策）
  for(let i=0;i<stocks.length;i++){
    const s = stocks[i];
    if(s.fake){
      // 架空銘柄は上の「毎セッション」パスで更新済み。ここではスキップ（二重適用防止）
    } else {
    try{
      let json = batchStocks ? batchStocks[s.ticker] : null;
      if(!json){
        if(i>0) await new Promise(res=>setTimeout(res,500)); // 外部プロキシ利用時のみ500ms待機
        json = await fetchWithProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${s.ticker}?interval=1d&range=30d`);
      }
      const meta=json?.chart?.result?.[0]?.meta;
      const closes=json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if(!meta||!closes) throw new Error("No data");
      const valid=closes.filter(v=>v!=null).slice(-30);
      const price=meta.regularMarketPrice||valid[valid.length-1];
      const prev=meta.previousClose||valid[valid.length-2]||price;
      const currency=meta.currency||s.currency;
      stockResults[s.id]={
        price: currency==="JPY"?Math.round(price):Math.round(price*100)/100,
        history: valid.map(v=>currency==="JPY"?Math.round(v):Math.round(v*100)/100),
        changePct: ((price-prev)/prev)*100,
        currency, realData:true
      };
    }catch(e){
      // 取得失敗: 履歴が無い/短い銘柄(新銘柄など)はダミー30日履歴を作ってチャートを出せるように。既存銘柄は前回値を維持
      if(!s.history||s.history.length<2){ stockResults[s.id]={price:s.price,history:makeFallbackHistory(s.price),changePct:0,currency:s.currency,realData:false}; }
      else stockResults[s.id]=null;
    }
    }
    // 取得できたものから随時update
    const currentResults = {...stockResults};
    update(d=>{
      const newStocks=(d.stocks||[]).map(st=>{
        const r=currentResults[st.id];
        if(!r) return st;
        const comments=STOCK_NEWS[st.ticker]||["市場が変動した"];
        return{...st,
          price:r.price,
          history:r.history,
          lastChange:Math.round(r.changePct*10)/10,
          lastComment:comments[Math.floor(Math.random()*comments.length)],
          currency:r.currency,
          realData:true
        };
      });
      const allDone = i===stocks.length-1;
      return{...d,
        stocks:newStocks,
        forex:forexMap,
        stockFetchStatus:allDone?"ok":"loading",
        stockLastUpdate:allDone?today:d.stockLastUpdate
      };
    });
  }
}

// 🌱 4匹のタネモン（お金の4つのこと）＝タネマネーの看板。最初に相棒を1匹えらぶ。
const BUDDY_DEF = {
  tame:  {name:"ためタネ", e:"🐷", role:"ためる"},
  nobi:  {name:"のびタネ", e:"🚀", role:"ふやす"},
  tsukai:{name:"つかいタネ", e:"🛍", role:"つかう"},
  wake:  {name:"わけタネ", e:"🎁", role:"わける"},
};
const BUDDY_ORDER = ["tame","nobi","tsukai","wake"];
const BUDDY_HINT = { tame:"コツコツ ためる子", nobi:"チャレンジで ふやす子", tsukai:"かしこく つかう子", wake:"やさしく わける子" };
const BUDDY_TALK = ["わ〜い！","えへへ♪","うれしい！","なでなで ありがと","きょうも がんばろ！","だいすき♡","ぷにぷに〜","いっしょに いこ！"];
// 🐣 相棒タネモン：選んだ子を状態に応じた表情＋呼吸/タップ跳ね＋吹き出しで表示（絵は1枚をコードで動かす）
function Buddy({ child, data, update, size=110 }) {
  const [bounce, setBounce] = useState(false);
  const [picking, setPicking] = useState(false);
  const [speech, setSpeech] = useState(null);
  const buddy = (data.buddy||{})[child.id] || null;
  const myLogs = (data.logs||[]).filter(l=>l.cid===child.id);
  // 表情を状態で出し分け（4表情を意味づけて使う）
  const hour = new Date().getHours();
  const doneToday = myLogs.some(l=>(l.type==="good"||l.type==="daily")&&isTodayLocal(l.date));
  const streak = (data.streak?.[child.id]?.cur)||0;
  let expr = "joy";
  if(hour>=21||hour<6) expr="sleepy";      // 夜はねむい
  else if(!doneToday) expr="go";           // まだ今日がんばってない→がんばれ！
  else if(streak>=3) expr="cheer";         // 連続がんばり→応援
  else expr="joy";                          // 今日やった→よろこぶ
  const pick = (id)=>{ update(d=>({...d,buddy:{...(d.buddy||{}),[child.id]:id}})); setPicking(false); taneHaptic("success"); };

  if(!buddy || picking){
    return (
      <div style={{width:"100%",background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:18,padding:"14px 12px"}}>
        <div style={{textAlign:"center",fontSize:14,fontWeight:900,color:"#fff",marginBottom:2}}>🌱 あいぼうの タネを えらぼう</div>
        <div style={{textAlign:"center",fontSize:10.5,fontWeight:800,color:"rgba(255,255,255,.7)",marginBottom:10}}>すきな子を えらんでね（あとで かえられるよ）</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9}}>
          {BUDDY_ORDER.map((id,i)=>{const d=BUDDY_DEF[id];const sel=buddy===id;return(
            <button key={id} onClick={()=>pick(id)} style={{background:"rgba(255,255,255,0.95)",border:`2.5px solid ${sel?G:"transparent"}`,borderRadius:16,padding:"10px 6px 8px",cursor:"pointer",fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",gap:3,boxShadow:SHADOW_SM}}>
              <img src={`/assets/tanemon_${id}_joy.png`} alt={d.name} style={{width:60,height:60,objectFit:"contain",imageRendering:"pixelated",transformOrigin:"bottom center",animation:`buddyBreath ${2.4+i*0.22}s ease-in-out infinite`}} onError={e=>{e.target.replaceWith(Object.assign(document.createElement("span"),{textContent:d.e,style:"font-size:40px"}));}}/>
              <div style={{fontSize:12.5,fontWeight:900,color:TEXT}}>{d.name}</div>
              <div style={{fontSize:9.5,fontWeight:800,color:GP,background:GS,borderRadius:999,padding:"1px 8px"}}>{d.e}{d.role}</div>
              <div style={{fontSize:9,fontWeight:700,color:MUTED,lineHeight:1.2,marginTop:1}}>{BUDDY_HINT[id]}</div>
            </button>
          );})}
        </div>
        {buddy&&<button onClick={()=>setPicking(false)} style={{marginTop:10,width:"100%",background:"none",border:"none",color:"rgba(255,255,255,.7)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F}}>やめる</button>}
        <style>{`@keyframes buddyBreath{0%,100%{transform:translateY(0) scaleX(1) scaleY(1)}50%{transform:translateY(-3px) scaleX(.98) scaleY(1.04)}}`}</style>
      </div>
    );
  }
  const onPat = ()=>{ taneHaptic("tap"); setBounce(true); setTimeout(()=>setBounce(false),480);
    setSpeech(BUDDY_TALK[Math.floor(Math.random()*BUDDY_TALK.length)]); setTimeout(()=>setSpeech(null),1300); };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
      <div onClick={onPat} style={{position:"relative",width:size,height:size,cursor:"pointer",display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
        {/* 吹き出し（タップ時のリアクション） */}
        {speech&&<div style={{position:"absolute",top:-14,left:"50%",transform:"translateX(-50%)",background:"#fff",color:GP,fontWeight:900,fontSize:11,whiteSpace:"nowrap",borderRadius:12,padding:"4px 10px",boxShadow:SHADOW_SM,zIndex:3,animation:"buddyPop .3s cubic-bezier(.34,1.56,.64,1)"}}>{speech}<span style={{position:"absolute",bottom:-4,left:"50%",transform:"translateX(-50%)",width:0,height:0,borderLeft:"5px solid transparent",borderRight:"5px solid transparent",borderTop:"5px solid #fff"}}/></div>}
        <img src={`/assets/tanemon_${buddy}_${expr}.png`} alt={BUDDY_DEF[buddy]?.name||"タネモン"}
          style={{width:"100%",height:"100%",objectFit:"contain",imageRendering:"pixelated",transformOrigin:"bottom center",animation:bounce?"buddyBounce .48s cubic-bezier(.34,1.56,.64,1)":"buddyBreath 2.8s ease-in-out infinite"}}
          onError={e=>{e.target.replaceWith(Object.assign(document.createElement("span"),{textContent:BUDDY_DEF[buddy]?.e||"🌱",style:`font-size:${Math.round(size*0.6)}px`}));}}/>
      </div>
      <button onClick={()=>setPicking(true)} style={{background:"none",border:"none",color:"rgba(255,255,255,.55)",fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:F,padding:"2px 6px"}}>🔄 かえる</button>
      <style>{`@keyframes buddyBreath{0%,100%{transform:translateY(0) scaleX(1) scaleY(1)}50%{transform:translateY(-3px) scaleX(.98) scaleY(1.04)}}@keyframes buddyBounce{0%{transform:translateY(0) scale(1)}30%{transform:translateY(-16px) scale(1.07)}62%{transform:translateY(0) scale(.93)}100%{transform:translateY(0) scale(1)}}@keyframes buddyPop{0%{transform:translateX(-50%) scale(0);opacity:0}100%{transform:translateX(-50%) scale(1);opacity:1}}`}</style>
    </div>
  );
}

// ── Point Transfer Modal ───────────────────────────────
function PointTransferModal({ child, data, update, onClose }) {
  const [toId,      setToId]      = useState(null);
  const [amount,    setAmount]    = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [done,      setDone]      = useState(false);

  const myBal      = bal(data.logs, child.id);
  const allMembers = [...data.children, ...(data.parents||[])].filter(m => m.id !== child.id);
  const receiver   = allMembers.find(m => m.id === toId);
  const amt        = parseInt(amount);
  const amtOk      = !isNaN(amt) && amt >= 10 && amt <= myBal;

  const doTransfer = () => {
    const now = new Date().toISOString();
    const outE = { id:uid(), cid:child.id,    type:"transfer_out", label:`💸 ${receiver.name}へ送金`,            pts:-amt, toId:receiver.id,  date:now };
    const inE  = { id:uid(), cid:receiver.id, type:"transfer_in",  label:`💌 ${child.name}からのプレゼント！`,   pts: amt, fromId:child.id,   date:now };
    update(d => ({...d, logs:[outE, inE, ...d.logs]}));
    addLogToFirestore(outE);
    addLogToFirestore(inE);
    setDone(true);
  };

  const backdrop = { position:"fixed",inset:0,background:"rgba(0,0,0,0.52)",zIndex:800,display:"flex",alignItems:"flex-end",justifyContent:"center" };
  const sheet    = { background:CARD,borderRadius:"24px 24px 0 0",padding:"28px 22px 36px",width:"100%",maxWidth:480,fontFamily:F,maxHeight:"88vh",overflowY:"auto" };

  if (done) return (
    <div style={backdrop}>
      <div style={{...sheet, textAlign:"center", padding:"40px 24px 48px"}}>
        <div style={{fontSize:64, marginBottom:10}}>🎉</div>
        <div style={{fontWeight:900,fontSize:20,color:GP,marginBottom:6}}>おくったよ！</div>
        <div style={{color:MUTED,fontSize:14,marginBottom:24}}>
          {receiver?.emoji} <strong style={{color:TEXT}}>{receiver?.name}</strong> に{" "}
          <strong style={{color:GP,fontSize:16}}>{amt.toLocaleString()}pt</strong> 届きました
        </div>
        <button onClick={onClose} style={{width:"100%",background:GP,border:"none",borderRadius:14,padding:"14px",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>
          とじる
        </button>
      </div>
    </div>
  );

  if (confirmed) return (
    <div style={backdrop}>
      <div style={{...sheet}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <h3 style={{margin:0,fontWeight:900,fontSize:18,color:TEXT}}>これを送りますか？</h3>
          <button onClick={()=>setConfirmed(false)} style={{background:BG,border:"none",borderRadius:10,width:32,height:32,cursor:"pointer",fontSize:16,color:MUTED,fontFamily:F}}>✕</button>
        </div>
        <div style={{background:GS,border:`2px solid ${G}`,borderRadius:18,padding:"20px 16px",marginBottom:20,textAlign:"center"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:18,marginBottom:14}}>
            <div style={{textAlign:"center"}}>
              <div style={{lineHeight:1}}><Emo e={child.emoji} size={30}/></div>
              <div style={{fontSize:11,fontWeight:700,color:TEXT,marginTop:4}}>{child.name}</div>
              <div style={{fontSize:11,color:R,fontWeight:700}}>-{amt.toLocaleString()}pt</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:26,color:GP}}>→</div>
              <div style={{fontSize:11,color:GP,fontWeight:800}}>{amt.toLocaleString()}pt</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:30,lineHeight:1}}>{receiver?.emoji}</div>
              <div style={{fontSize:11,fontWeight:700,color:TEXT,marginTop:4}}>{receiver?.name}</div>
              <div style={{fontSize:11,color:GP,fontWeight:700}}>+{amt.toLocaleString()}pt</div>
            </div>
          </div>
          <div style={{fontSize:11,color:MUTED}}>送信後の残高: <strong style={{color:GP}}>{(myBal-amt).toLocaleString()}pt</strong></div>
        </div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={()=>setConfirmed(false)} style={{flex:1,background:BORDER,border:"none",borderRadius:14,padding:13,fontWeight:800,color:MUTED,cursor:"pointer",fontFamily:F,fontSize:14}}>
            もどる
          </button>
          <button onClick={doTransfer} style={{flex:2,background:GP,border:"none",borderRadius:14,padding:13,fontWeight:900,color:"#fff",fontSize:15,cursor:"pointer",fontFamily:F}}>
            ✈ 送る！
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={backdrop} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={sheet}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <h3 style={{margin:0,fontWeight:900,fontSize:18,color:TEXT}}>💸 ポイントを送る</h3>
          <button onClick={onClose} style={{background:BG,border:"none",borderRadius:10,width:32,height:32,cursor:"pointer",fontSize:16,color:MUTED,fontFamily:F}}>✕</button>
        </div>
        <div style={{fontSize:12,color:MUTED,marginBottom:16}}>
          💰 いまの残高: <strong style={{color:GP,fontSize:14}}>{myBal.toLocaleString()}pt</strong>
        </div>

        {/* メンバー選択 */}
        <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8,letterSpacing:0.3}}>だれに送る？</div>
        <div style={{marginBottom:16}}>
          {allMembers.map(m => {
            const mBal = bal(data.logs, m.id);
            const sel  = toId === m.id;
            return (
              <button key={m.id} onClick={()=>{setToId(sel?null:m.id);setAmount("");}}
                style={{
                  width:"100%",marginBottom:8,
                  background:sel?`${GP}12`:BG,
                  border:`2px solid ${sel?GP:BORDER}`,
                  borderRadius:14,padding:"11px 14px",
                  display:"flex",alignItems:"center",gap:12,
                  cursor:"pointer",textAlign:"left",fontFamily:F,
                }}>
                <div style={{width:38,height:38,borderRadius:11,background:sel?GP:CARD,border:`1.5px solid ${sel?GP:BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
                  <Emo e={m.emoji} size={20}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14,color:TEXT}}>{m.name}</div>
                  <div style={{fontSize:11,color:MUTED}}>{m.gradeLabel||m.displayMode||""} · {mBal.toLocaleString()}pt 所持</div>
                </div>
                <div style={{fontSize:18,color:sel?GP:MUTED,fontWeight:700}}>{sel?"✓":"›"}</div>
              </button>
            );
          })}
        </div>

        {/* 金額入力（相手選択後のみ表示） */}
        {toId && (
          <div>
            <div style={{width:"100%",height:1,background:BORDER,marginBottom:16}}/>
            <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8}}>何pt送る？</div>
            <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
              {[10,50,100,200,500,1000].filter(v=>v<=myBal).map(v=>(
                <button key={v} onClick={()=>setAmount(String(v))}
                  style={{
                    padding:"6px 13px",
                    border:`1.5px solid ${amount===String(v)?GP:BORDER}`,
                    borderRadius:8,
                    background:amount===String(v)?`${GP}18`:"transparent",
                    fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,
                    color:amount===String(v)?GP:MUTED,
                  }}>
                  {v}pt
                </button>
              ))}
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
              <input
                type="number" value={amount} onChange={e=>setAmount(e.target.value)}
                placeholder="pt数を入力（最小10pt）"
                style={{...INP,flex:1,fontSize:15,fontWeight:700}}
              />
              <span style={{fontSize:13,color:MUTED,fontWeight:700,flexShrink:0}}>pt</span>
            </div>
            {!isNaN(amt)&&amt>0&&amt<10&&<div style={{color:R,fontSize:11,fontWeight:700,marginBottom:6}}>最小10ptから送れます</div>}
            {!isNaN(amt)&&amt>myBal&&<div style={{color:R,fontSize:11,fontWeight:700,marginBottom:6}}>残高が足りません</div>}
            <button
              disabled={!amtOk}
              onClick={()=>setConfirmed(true)}
              style={{
                marginTop:8,width:"100%",
                background:amtOk?GP:BORDER,
                border:"none",borderRadius:14,padding:"13px",
                color:amtOk?"#fff":MUTED,
                fontWeight:900,fontSize:15,
                cursor:amtOk?"pointer":"default",
                fontFamily:F,transition:"all 0.2s",
              }}>
              つぎへ →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Weekly Report ─────────────────────────────────────
function WeeklyReport({child,data,onClose}){
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-7);
  const logs=(data.logs||[]).filter(l=>l.cid===child.id&&l.date>=cutoff.toISOString());
  const earned=logs.filter(l=>["good","daily","gacha","interest"].includes(l.type)).reduce((s,l)=>s+l.pts,0);
  const deducted=Math.abs(logs.filter(l=>["bad","violation"].includes(l.type)).reduce((s,l)=>s+l.pts,0));
  const taskCount=logs.filter(l=>l.type==="good").length;
  const gachaCount=logs.filter(l=>l.type==="gacha").length;
  const curBal=bal(data.logs,child.id);
  const interest=data.interestEnabled?Math.floor(curBal*(data.interestRate||0.05)):0;
  // ── C: お金の学び 計測指標 ──
  const validQuiz=new Set(ALL_TIPS.map(t=>t.id));
  const quizMastered=((data.tipsQuiz||{})[child.id]||[]).filter(id=>validQuiz.has(id)).length;  // クイズ正解(累計マスター)
  const tipsWeek=logs.filter(l=>l.type==="tips").length;                                          // 今週読んだまめちしき
  const investWeek=logs.filter(l=>["invest_buy","invest_sell","forex_buy","forex_sell"].includes(l.type)).length; // 投資チャレンジ
  const goalsDone=(data.goals||[]).filter(g=>g.cid===child.id&&g.done).length;                    // 目標達成(累計)
  const streakCur=(data.streak||{})[child.id]?.cur||0;
  const netWeek=earned-deducted;
  // おかねの学びスコア(0-100): 学び30+継続20+お手伝い20+お金の行動20+収支プラス10。週ごとの伸びを親が追える単一指標
  const sLearn=Math.round(quizMastered/ALL_TIPS.length*30);
  const sStreak=Math.round(Math.min(streakCur,7)/7*20);
  const sTask=Math.round(Math.min(taskCount,10)/10*20);
  const sMoney=Math.min(20, goalsDone*8 + Math.min(investWeek,4)*3);
  const sNet=netWeek>=0?10:0;
  const learnScore=Math.min(100, sLearn+sStreak+sTask+sMoney+sNet);
  return(
    <div style={{position:"fixed",inset:0,background:"#0009",zIndex:990,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:F}}>
      <div style={{background:CARD,borderRadius:"24px 24px 0 0",padding:"24px 20px 40px",width:"100%",maxWidth:420,boxShadow:"0 -8px 40px #0004"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
          <ChildAvatar child={child} size={40}/>
          <div style={{flex:1}}><div style={{fontWeight:900,fontSize:17,color:TEXT}}>{child.name}の週次レポート</div><div style={{color:MUTED,fontSize:12}}>過去7日間のまとめ</div></div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:MUTED}}>✕</button>
        </div>
        <div style={{background:`linear-gradient(135deg,${Y}30,${G}20)`,borderRadius:16,padding:"14px 18px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{color:MUTED,fontSize:12,fontWeight:700}}>現在の残高</div><div style={{fontWeight:900,fontSize:28,color:TEXT}}>{curBal.toLocaleString()}pt</div></div>
          {data.interestEnabled&&interest>0&&<div style={{textAlign:"right"}}><div style={{color:MUTED,fontSize:11,fontWeight:700}}>次回利子（予定）</div><div style={{fontWeight:900,fontSize:18,color:G}}>+{interest}pt</div></div>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
          {[["🏆","お手伝い",`${taskCount}回`,null,"#34c77b"],["🌱","まいにちのタネ",`${gachaCount}回`,null,"#f5c842"],["💰","獲得合計",null,earned,"#34c77b"],["📉","マイナス",null,-deducted,"#f0605a"]].map(([e,l,v,p,c],i)=>(
            <div key={i} style={{background:BG,borderRadius:12,padding:"10px 8px",textAlign:"center"}}>
              <div style={{fontSize:20,marginBottom:4}}>{e}</div>
              <div style={{color:MUTED,fontSize:11,fontWeight:700,marginBottom:2}}>{l}</div>
              {p!==null?<div style={{fontWeight:900,fontSize:14,color:c}}>{p>=0?"+":""}{p}pt</div>:<div style={{fontWeight:900,fontSize:14,color:c}}>{v}</div>}
            </div>
          ))}
        </div>
        {/* ── C: お金の学び 計測サマリ ── */}
        <div style={{background:PS,border:`1.5px solid ${P}40`,borderRadius:14,padding:"13px 14px",marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <span style={{fontWeight:800,fontSize:13,color:TEXT}}>🧠 おかねの学び</span>
            <span style={{fontWeight:900,fontSize:18,color:P}}>{learnScore}<span style={{fontSize:11,color:MUTED,fontWeight:700}}>/100</span></span>
          </div>
          <div style={{height:9,borderRadius:999,background:"#0001",overflow:"hidden",marginBottom:4}}>
            <div style={{height:"100%",width:`${learnScore}%`,background:`linear-gradient(90deg,${P},${G})`,borderRadius:999,transition:"width .5s"}}/>
          </div>
          <div style={{fontSize:11,color:MUTED,marginBottom:10}}>学び{sLearn}＋継続{sStreak}＋お手伝い{sTask}＋お金の行動{sMoney}＋収支{sNet}。毎週どう伸びたか比べてみてください</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[
              ["💡","まめちしきクイズ正解",`${quizMastered}/${ALL_TIPS.length}`,"累計マスター"],
              ["📖","今週 読んだ知識",`${tipsWeek}`,"件"],
              ["📈","投資チャレンジ",`${investWeek}`,"今週の回数"],
              ["🎯","目標 達成",`${goalsDone}`,"累計"],
            ].map(([e,l,v,sub],i)=>(
              <div key={i} style={{background:CARD,borderRadius:10,padding:"9px 11px",display:"flex",alignItems:"center",gap:9}}>
                <span style={{fontSize:18}}>{e}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:11,color:MUTED,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{l}</div>
                  <div style={{fontWeight:900,fontSize:14,color:TEXT}}>{v}<span style={{fontSize:10,color:MUTED,fontWeight:600,marginLeft:3}}>{sub}</span></div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{background:`${G}15`,border:`1.5px solid ${G}40`,borderRadius:14,padding:"12px 14px",marginBottom:16}}>
          <p style={{margin:0,fontSize:13,fontWeight:700,lineHeight:1.7,color:TEXT}}>
            {learnScore>=70?"🌟 お金の学びがぐんぐん伸びています！この調子で続けましょう。":quizMastered<5?"💡 まめちしきクイズに挑戦すると『お金の知識』が伸びます。お子さんに勧めてみて。":taskCount>=5?"🌟 すごい！今週はお手伝いをたくさんしたね！":taskCount>=3?"👍 いい調子！来週もがんばろう！":"💪 来週はもっとお手伝いに挑戦してみよう！"}
          </p>
        </div>
        <button onClick={onClose} style={{width:"100%",background:G,border:"none",borderRadius:14,padding:"13px",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>とじる</button>
      </div>
    </div>
  );
}

// ── シェアカード生成（達成の瞬間をSNSへ。canvasで画像化→navigator.share）──
async function shareCard({ emoji, title, subtitle, color, img, rarity }){
  try{
    const W=1080,H=1080; const accent=color||GP;
    const cv=document.createElement("canvas"); cv.width=W; cv.height=H;
    const x=cv.getContext("2d");
    const rr=(X,Y,w,h,r)=>{x.beginPath();x.moveTo(X+r,Y);x.arcTo(X+w,Y,X+w,Y+h,r);x.arcTo(X+w,Y+h,X,Y+h,r);x.arcTo(X,Y+h,X,Y,r);x.arcTo(X,Y,X+w,Y,r);x.closePath();};
    // 画像があれば先読み(同一オリジン)
    let im=null;
    if(img){ im=await new Promise(res=>{const i=new Image(); i.onload=()=>res(i); i.onerror=()=>res(null); i.src=img;}); }
    // 背景グラデ＋アクセント光彩
    const g=x.createLinearGradient(0,0,0,H); g.addColorStop(0,"#F7F5EF"); g.addColorStop(1,"#E3F3E8"); x.fillStyle=g; x.fillRect(0,0,W,H);
    const rg=x.createRadialGradient(W/2,500,40,W/2,500,460); rg.addColorStop(0,accent+"40"); rg.addColorStop(1,accent+"00"); x.fillStyle=rg; x.fillRect(0,0,W,H);
    x.fillStyle=accent; x.fillRect(0,0,W,20);
    x.textAlign="center"; x.textBaseline="middle";
    // ヘッダー
    x.fillStyle=accent; x.font="700 50px sans-serif"; x.fillText("🌱 Tane Money", W/2, 112);
    // レア度バッジ
    if(rarity){ x.font="800 46px sans-serif"; const tw=x.measureText(rarity).width; const pw=tw+76, ph=80, py=158; rr(W/2-pw/2,py,pw,ph,40); x.fillStyle=accent; x.fill(); x.fillStyle="#fff"; x.fillText(rarity, W/2, py+ph/2+2); }
    // メダリオン
    const cy=510, cr=280;
    x.save(); x.shadowColor=accent+"77"; x.shadowBlur=70; x.beginPath(); x.arc(W/2,cy,cr,0,Math.PI*2); x.fillStyle="#ffffff"; x.fill(); x.restore();
    x.lineWidth=16; x.strokeStyle=accent; x.beginPath(); x.arc(W/2,cy,cr,0,Math.PI*2); x.stroke();
    // アイテム(画像優先・なければ絵文字)
    if(im){ const s=390, ratio=Math.min(s/im.width,s/im.height), dw=im.width*ratio, dh=im.height*ratio; x.imageSmoothingEnabled=false; x.drawImage(im, W/2-dw/2, cy-dh/2, dw, dh); }
    else { x.font="300px sans-serif"; x.fillText(emoji||"🌟", W/2, cy+8); }
    // キラキラ
    x.font="62px sans-serif"; x.fillText("✨", W/2-cr-6, cy-cr+70); x.fillText("⭐", W/2+cr+8, cy-cr+120); x.fillText("✨", W/2+cr-6, cy+cr-6);
    // タイトル
    x.fillStyle="#18231D"; x.font="bold 80px sans-serif"; x.fillText((title||"").toString().slice(0,20), W/2, 868);
    // サブ
    x.fillStyle=accent; x.font="bold 62px sans-serif"; x.fillText((subtitle||"").toString().slice(0,26), W/2, 956);
    // フッター
    x.fillStyle="#929B95"; x.font="600 40px sans-serif"; x.fillText("おてつだいで お金を学ぶ · tane-money.vercel.app", W/2, 1018);
    const blob=await new Promise(r=>cv.toBlob(r,"image/png"));
    const file=new File([blob],"tane-money.png",{type:"image/png"});
    const payload={ title:"Tane Money", text:`${title||""} ${subtitle||""}`.trim()+" #タネマネー", url:"https://tane-money.vercel.app" };
    if(navigator.canShare && navigator.canShare({files:[file]})){
      await navigator.share({ ...payload, files:[file] });
    } else if(navigator.share){
      await navigator.share(payload);
    } else {
      const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="tane-money.png"; a.click();
    }
  }catch(e){ /* キャンセル/非対応は無視 */ }
}

// 🎓 金融リテラシー認定証（賞状デザインのシェア画像）。級到達のごほうび＝継続・口コミに効く
async function shareCertificate({ name, rank, date, supervisor }){
  try{
    const W=1080,H=1080; const cv=document.createElement("canvas"); cv.width=W; cv.height=H; const x=cv.getContext("2d");
    x.textAlign="center"; x.textBaseline="middle";
    // クリーム地＋淡い光彩
    const g=x.createLinearGradient(0,0,0,H); g.addColorStop(0,"#FBF8F0"); g.addColorStop(1,"#F1F6EC"); x.fillStyle=g; x.fillRect(0,0,W,H);
    const rg=x.createRadialGradient(W/2,470,40,W/2,470,520); rg.addColorStop(0,"#E8B83E22"); rg.addColorStop(1,"#E8B83E00"); x.fillStyle=rg; x.fillRect(0,0,W,H);
    // 金の二重枠
    x.strokeStyle="#E8B83E"; x.lineWidth=10; x.strokeRect(46,46,W-92,H-92);
    x.strokeStyle="#C9A33A"; x.lineWidth=3; x.strokeRect(70,70,W-140,H-140);
    // タイトル
    x.fillStyle="#187A4E"; x.font="900 62px 'M PLUS Rounded 1c',sans-serif"; x.fillText("金融リテラシー認定証", W/2, 210);
    x.fillStyle="#929B95"; x.font="700 24px sans-serif"; x.fillText("CERTIFICATE OF FINANCIAL LITERACY", W/2, 268);
    // 氏名
    x.fillStyle="#18231D"; x.font="900 84px 'M PLUS Rounded 1c',serif"; x.fillText((name||"") + " さん", W/2, 440);
    x.strokeStyle="#E8B83E"; x.lineWidth=4; x.beginPath(); x.moveTo(W/2-280,506); x.lineTo(W/2+280,506); x.stroke();
    // 本文＋級
    x.fillStyle="#59645E"; x.font="700 32px 'M PLUS Rounded 1c',sans-serif"; x.fillText("タネマネー金融教育プログラムにおいて", W/2, 596);
    x.fillStyle="#187A4E"; x.font="900 78px 'M PLUS Rounded 1c',sans-serif"; x.fillText(rank||"", W/2, 690);
    x.fillStyle="#59645E"; x.font="700 32px 'M PLUS Rounded 1c',sans-serif"; x.fillText("に到達したことを 証します。", W/2, 784);
    // 日付・監修・印
    x.fillStyle="#929B95"; x.font="700 26px sans-serif"; x.fillText(date||"", W/2, 872);
    if(supervisor){ x.fillStyle="#7a5a00"; x.font="800 26px 'M PLUS Rounded 1c',sans-serif"; x.fillText("監修：" + supervisor, W/2, 916); }
    x.fillStyle="#187A4E"; x.font="900 40px 'M PLUS Rounded 1c',sans-serif"; x.fillText("🌱 Tane Money", W/2, 988);
    const blob=await new Promise(r=>cv.toBlob(r,"image/png"));
    const file=new File([blob],"tane-money-certificate.png",{type:"image/png"});
    const payload={ title:"タネマネー 認定証", text:`${name||""}さんが ${rank||""} に到達！ #タネマネー`, url:"https://tane-money.vercel.app" };
    if(navigator.canShare && navigator.canShare({files:[file]})){ await navigator.share({ ...payload, files:[file] }); }
    else if(navigator.share){ await navigator.share(payload); }
    else { const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="tane-money-certificate.png"; a.click(); }
  }catch(e){ /* キャンセル/非対応は無視 */ }
}

// ── GoalCelebration ───────────────────────────────────
function GoalCelebration({goal,onClose}){
  return(
    <div style={{position:"fixed",inset:0,background:"#000c",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>
      <div style={{textAlign:"center"}}>
        <div style={{position:"fixed",inset:0,pointerEvents:"none",overflow:"hidden"}}>
          {[...Array(24)].map((_,i)=>(
            <div key={i} style={{position:"absolute",left:`${Math.random()*100}%`,top:`-${Math.random()*20}%`,fontSize:18,animation:`confetti ${1.5+Math.random()}s ${Math.random()*0.8}s linear forwards`}}>
              {["🎊","🎉","⭐","✨","🌟"][i%5]}
            </div>
          ))}
        </div>
        <div style={{background:CARD,borderRadius:28,padding:"40px 44px",boxShadow:`0 20px 80px ${Y}80`,border:`4px solid ${Y}`,position:"relative"}}>
          <div style={{fontSize:64,marginBottom:12}}>{goal.emoji}</div>
          <div style={{color:Y,fontWeight:900,fontSize:20,marginBottom:8}}>目標達成おめでとう！</div>
          <div style={{fontWeight:900,fontSize:22,color:TEXT,marginBottom:8}}>{goal.label}</div>
          <div style={{color:MUTED,fontSize:14,marginBottom:24}}>{goal.target.toLocaleString()}pt 貯まったよ！</div>
          <div style={{display:"flex",gap:10,justifyContent:"center"}}>
            <button onClick={()=>shareCard({emoji:goal.emoji, title:`${goal.label} 達成！`, subtitle:`${goal.target.toLocaleString()}pt ためたよ`, color:Y})}
              style={{background:"#fff",border:`2px solid ${Y}`,borderRadius:14,padding:"14px 22px",color:"#9a7000",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>シェア 📤</button>
            <button onClick={onClose} style={{background:Y,border:"none",borderRadius:14,padding:"14px 32px",color:TEXT,fontWeight:900,fontSize:16,cursor:"pointer",fontFamily:F}}>やったー！🎉</button>
          </div>
        </div>
      </div>
      <style>{`@keyframes confetti{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}`}</style>
    </div>
  );
}

// 🌟 推し株：好きな会社を「推し（応援）」する、やさしい投資。街づくり・為替・損益演出は無し。損益は控えめに残す。
function OshiKabu({child,data,update}){
  const [sel,setSel]=useState(null);       // 選択中の銘柄id
  const [qty,setQty]=useState("1");
  const [reason,setReason]=useState("");
  const [toast,setToast]=useState(null);
  const [showAll,setShowAll]=useState(false);
  const [dragY,setDragY]=useState(0);      // シートの下スワイプ量(iOS風ドラッグ閉じ)
  const dragStart=useRef(null);
  const closeSheet=()=>{ setSel(null); setDragY(0); };
  const myBal=bal(data.logs,child.id);
  const stocks=(data.stocks||[]);
  const myHoldings=(data.holdings||{})[child.id]||[];
  const heldIds=new Set(myHoldings.map(h=>h.stockId));
  const toPts=(s,p)=>s.currency==="USD"?Math.max(1,Math.round(p*1.5)):Math.max(1,Math.round(p/100));
  const FEE=0.02;
  const flash=(msg,color)=>{ setToast({msg,color}); setTimeout(()=>setToast(null),1600); };
  // 推し候補（応援おすすめ）: 子ども定番＋架空。ぜんぶ見るで全銘柄。
  const FAV=new Set(["f1","f2","f3","f4","f5","s1","s7","s4","s6","s21","s11","s10","s5","s26"]);
  const listStocks = showAll? stocks : stocks.filter(s=>FAV.has(s.id)||heldIds.has(s.id));
  const selStock=stocks.find(s=>s.id===sel);
  const selHold=myHoldings.find(h=>h.stockId===sel);
  const qtyN=Math.max(1,Math.round(parseFloat(qty)||1));   // 推し株は「株」単位で整数（やさしく）
  const unitPts=selStock?toPts(selStock,selStock.price):0;
  const buyCost=Math.ceil(unitPts*qtyN*(1+FEE));
  const sellGet=selStock&&selHold?Math.floor(unitPts*Math.min(qtyN,selHold.qty)*(1-FEE)):0;
  const portVal=myHoldings.reduce((s,h)=>{const st=stocks.find(x=>x.id===h.stockId);return s+(st?toPts(st,st.price)*h.qty:0);},0);
  const portCost=myHoldings.reduce((s,h)=>s+h.avgPrice*h.qty,0);
  const portGain=Math.round(portVal*0.98)-portCost;

  function cheer(){   // 応援する = 買う
    if(!selStock||qtyN<1||myBal<buyCost) return;
    if(!txGuard("oshi_buy_"+child.id)) return;
    markLocalUserDataEdit('holdings');   // 保有株は原則サーバ優先マージ＝自端末の売買を12秒だけ保護
    update(d=>{
      const ex=(d.holdings?.[child.id]||[]).find(h=>h.stockId===selStock.id);
      let nh; const tq=(ex?.qty||0)+qtyN;
      if(ex) nh=(d.holdings[child.id]).map(h=>h.stockId===selStock.id?{...h,qty:tq,avgPrice:Math.round((ex.avgPrice*ex.qty+buyCost)/tq),...(reason?{reason}:{})}:h);
      else nh=[...(d.holdings?.[child.id]||[]),{stockId:selStock.id,qty:qtyN,avgPrice:Math.round(buyCost/qtyN),firstBuyDate:new Date().toISOString(),...(reason?{reason}:{})}];
      const _e={id:uid(),cid:child.id,type:"invest_buy",label:`🌟 ${selStock.emoji}${selStock.name} を ${qtyN}株 おうえん${reason?` ・ ${reason}`:""}`,pts:-buyCost,date:new Date().toISOString()};
      addLogToFirestore(_e);
      return {...d,holdings:{...(d.holdings||{}),[child.id]:nh},logs:[_e,...d.logs]};
    });
    flash(`💚 ${selStock.emoji}${selStock.name} を おうえんした！`,"#22c55e");
    setSel(null);setQty("1");setReason("");
  }
  function stopCheer(){   // 応援をやめる = 売る
    if(!selStock||!selHold) return;
    if(!txGuard("oshi_sell_"+child.id)) return;
    markLocalUserDataEdit('holdings');   // 保有株は原則サーバ優先マージ＝自端末の売買を12秒だけ保護
    const q=Math.min(qtyN,selHold.qty);
    const get=Math.floor(unitPts*q*(1-FEE));
    const profit=Math.round(get-selHold.avgPrice*q);
    update(d=>{
      const _e={id:uid(),cid:child.id,type:"invest_sell",label:`👋 ${selStock.emoji}${selStock.name} ${q}株 おうえん おわり`,pts:get,date:new Date().toISOString()};
      addLogToFirestore(_e);
      return {...d,holdings:{...(d.holdings||{}),[child.id]:(d.holdings[child.id]).map(h=>h.stockId===selStock.id?{...h,qty:h.qty-q}:h).filter(h=>h.qty>0)},logs:[_e,...d.logs]};
    });
    flash(profit>=0?`👋 ${get.toLocaleString()}pt もどってきた！`:`👋 ${get.toLocaleString()}pt。つぎの推しを さがそう`, profit>=0?"#34C77B":"#D95C55");
    setSel(null);setQty("1");
  }

  return(<div style={{padding:"14px 16px 32px",fontFamily:F}}>
    {toast&&(
      <div style={{position:"fixed",top:0,left:0,right:0,zIndex:1400,display:"flex",justifyContent:"center",pointerEvents:"none"}}>
        <div style={{marginTop:14,background:toast.color,color:"#fff",fontWeight:900,fontSize:14,padding:"11px 20px",borderRadius:14,boxShadow:"0 8px 24px rgba(0,0,0,.3)"}}>{toast.msg}</div>
      </div>
    )}
    {/* ヘッダー：残高＋応援中サマリ */}
    <div style={{background:`linear-gradient(160deg,${GS},#eafaf0)`,border:`2px solid ${G}`,borderRadius:20,padding:"14px 16px",marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
        <span style={{fontSize:22}}>🌟</span>
        <span style={{fontWeight:900,fontSize:16,color:GP}}>推し株</span>
      </div>
      <div style={{fontSize:12,color:TEXTS,fontWeight:700,lineHeight:1.6,marginBottom:10}}>すきな会社を「推し」に えらんで おうえんしよう。ポイントで株を もつと、上がったり下がったり…なんで推してるか おうちの人に 話してみてね。</div>
      <div style={{display:"flex",gap:8}}>
        <div style={{flex:1,textAlign:"center",background:"#fff",borderRadius:12,padding:"8px 4px"}}>
          <div style={{fontSize:10,color:MUTED,fontWeight:700}}>のこりポイント</div>
          <div style={{fontSize:16,fontWeight:900,color:G}}>{myBal.toLocaleString()}</div>
        </div>
        <div style={{flex:1,textAlign:"center",background:"#fff",borderRadius:12,padding:"8px 4px"}}>
          <div style={{fontSize:10,color:MUTED,fontWeight:700}}>おうえん中</div>
          <div style={{fontSize:16,fontWeight:900,color:GP}}>{myHoldings.length}社</div>
        </div>
        {portCost>0&&(
          <div style={{flex:1,textAlign:"center",background:"#fff",borderRadius:12,padding:"8px 4px"}}>
            <div style={{fontSize:10,color:MUTED,fontWeight:700}}>いま うると</div>
            <div style={{fontSize:14,fontWeight:900,color:portGain>=0?G:R}}>{portGain>=0?"+":""}{portGain.toLocaleString()}</div>
          </div>
        )}
      </div>
    </div>
    {/* 応援中の推し */}
    {myHoldings.length>0&&(
      <div style={{marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:900,color:GP,marginBottom:8}}>💚 おうえん中の推し</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {myHoldings.map(h=>{
            const st=stocks.find(x=>x.id===h.stockId); if(!st) return null;
            const val=toPts(st,st.price)*h.qty; const gain=Math.round(val*0.98)-h.avgPrice*h.qty;
            const up=(st.lastChange||0)>=0;
            return (
              <button key={h.stockId} onClick={()=>{setSel(st.id);setQty("1");setDragY(0);}}
                style={{background:CARD,border:`2px solid ${G}`,borderRadius:16,padding:"11px 14px",cursor:"pointer",fontFamily:F,textAlign:"left",display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:30}}>{st.emoji}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:800,fontSize:14,color:TEXT}}>{st.name}</div>
                  <div style={{fontSize:11,color:MUTED,fontWeight:700}}>{h.qty}株 もってる{h.reason?` ・「${h.reason}」`:""}</div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:11,fontWeight:700,color:up?G:R}}>{up?"▲":"▼"}{Math.abs(st.lastChange||0).toFixed(1)}%</div>
                  <div style={{fontSize:11,fontWeight:800,color:gain>=0?G:R}}>{gain>=0?"+":""}{gain.toLocaleString()}pt</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    )}
    {/* 推し候補 */}
    <div style={{fontSize:12,fontWeight:900,color:TEXT,marginBottom:8}}>🔎 推しを さがす</div>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {listStocks.filter(s=>!heldIds.has(s.id)).map(s=>{
        const up=(s.lastChange||0)>=0;
        return (
          <button key={s.id} onClick={()=>{setSel(s.id);setQty("1");setDragY(0);}}
            style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"11px 14px",cursor:"pointer",fontFamily:F,textAlign:"left",display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:28}}>{s.emoji}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:800,fontSize:14,color:TEXT}}>{s.name}</div>
              <div style={{fontSize:11,color:MUTED,fontWeight:700}}>{s.sector}</div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontWeight:900,fontSize:14,color:GP}}>{toPts(s,s.price).toLocaleString()}pt</div>
              <div style={{fontSize:11,fontWeight:700,color:up?G:R}}>{up?"▲":"▼"}{Math.abs(s.lastChange||0).toFixed(1)}%</div>
            </div>
          </button>
        );
      })}
    </div>
    {!showAll&&(
      <button onClick={()=>setShowAll(true)} style={{width:"100%",marginTop:10,padding:"11px",background:`${GP}12`,border:`2px dashed ${GP}`,borderRadius:12,color:GP,fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>ぜんぶの会社を見る（{stocks.length}社）</button>
    )}
    {/* 応援シート（選択時） */}
    {selStock&&(
      <div style={{position:"fixed",inset:0,background:`rgba(0,0,0,${0.32*Math.max(0,1-dragY/320)})`,backdropFilter:"blur(2px)",WebkitBackdropFilter:"blur(2px)",zIndex:900,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={closeSheet}>
        <div onClick={e=>e.stopPropagation()}
          onTouchStart={e=>{dragStart.current=e.touches[0].clientY;}}
          onTouchMove={e=>{ if(dragStart.current!=null){ const dy=e.touches[0].clientY-dragStart.current; if(dy>0) setDragY(dy); } }}
          onTouchEnd={()=>{ if(dragY>110) closeSheet(); else setDragY(0); dragStart.current=null; }}
          style={{background:"rgba(255,255,255,0.9)",backdropFilter:"saturate(180%) blur(24px)",WebkitBackdropFilter:"saturate(180%) blur(24px)",borderTop:"1px solid rgba(255,255,255,0.6)",borderRadius:"28px 28px 0 0",padding:"10px 20px calc(env(safe-area-inset-bottom,0px) + 20px)",width:"100%",maxWidth:480,fontFamily:F,boxShadow:"0 -8px 40px rgba(0,0,0,0.18)",transform:`translateY(${dragY}px)`,transition:dragY===0?"transform .34s cubic-bezier(.32,1.24,.4,1)":"none",animation:dragY===0?"oshiSheetUp .38s cubic-bezier(.32,1.24,.4,1)":"none"}}>
          <style>{`@keyframes oshiSheetUp{0%{transform:translateY(100%)}100%{transform:translateY(0)}}`}</style>
          <div style={{width:38,height:5,borderRadius:999,background:"rgba(0,0,0,0.16)",margin:"0 auto 14px"}}/>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
            <span style={{fontSize:38}}>{selStock.emoji}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:900,fontSize:17,color:TEXT}}>{selStock.name}</div>
              <div style={{fontSize:12,color:MUTED,fontWeight:700}}>{selStock.sector} ・ 1株 {toPts(selStock,selStock.price).toLocaleString()}pt <span style={{color:(selStock.lastChange||0)>=0?G:R}}>{(selStock.lastChange||0)>=0?"▲":"▼"}{Math.abs(selStock.lastChange||0).toFixed(1)}%</span></div>
            </div>
            <button onClick={closeSheet} style={{background:BG,border:"none",borderRadius:10,width:32,height:32,fontSize:15,cursor:"pointer",color:MUTED,fontFamily:F,flexShrink:0}}>✕</button>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
            <span style={{fontSize:13,fontWeight:800,color:TEXTS}}>何株？</span>
            <button onClick={()=>setQty(q=>String(Math.max(1,(parseInt(q)||1)-1)))} style={{width:38,height:38,borderRadius:10,border:`1.5px solid ${BORDER}`,background:BG,fontSize:20,fontWeight:900,cursor:"pointer",color:GP,fontFamily:F}}>−</button>
            <div style={{minWidth:44,textAlign:"center",fontSize:20,fontWeight:900,color:TEXT}}>{Math.max(1,parseInt(qty)||1)}</div>
            <button onClick={()=>setQty(q=>String((parseInt(q)||1)+1))} style={{width:38,height:38,borderRadius:10,border:`1.5px solid ${BORDER}`,background:BG,fontSize:20,fontWeight:900,cursor:"pointer",color:GP,fontFamily:F}}>＋</button>
            <div style={{flex:1,textAlign:"right",fontSize:13,fontWeight:800,color:GP}}>{buyCost.toLocaleString()}pt</div>
          </div>
          {!selHold&&(
            <input value={reason} onChange={e=>setReason(e.target.value)} placeholder="なんで推す？（れい：ゲームが好き）" style={{width:"100%",boxSizing:"border-box",border:`1.5px solid ${BORDER}`,borderRadius:12,padding:"11px 14px",fontSize:14,fontFamily:F,marginBottom:12,background:BG,color:TEXT}}/>
          )}
          {selHold&&(
            <div style={{background:GS,borderRadius:12,padding:"9px 13px",marginBottom:12,fontSize:12,color:GP,fontWeight:700}}>いま {selHold.qty}株 おうえん中{selHold.reason?`「${selHold.reason}」`:""}</div>
          )}
          <div style={{display:"flex",gap:10}}>
            <button onClick={cheer} disabled={myBal<buyCost}
              style={{flex:1,background:myBal<buyCost?BORDER:G,border:"none",borderRadius:14,padding:14,fontWeight:900,fontSize:15,color:"#fff",cursor:myBal<buyCost?"default":"pointer",fontFamily:F}}>💚 おうえんする</button>
            {selHold&&(
              <button onClick={stopCheer} style={{flex:1,background:RS,border:`1.5px solid ${R}`,borderRadius:14,padding:14,fontWeight:900,fontSize:15,color:R,cursor:"pointer",fontFamily:F}}>👋 やめる（{sellGet.toLocaleString()}pt）</button>
            )}
          </div>
          {myBal<buyCost&&<div style={{textAlign:"center",fontSize:12,color:R,fontWeight:700,marginTop:8}}>ポイントが たりないよ</div>}
        </div>
      </div>
    )}
  </div>);
}


function calcBadgeStats(child, data){
  const logs=(data.logs||[]).filter(l=>l.cid===child.id);
  let run=0, maxBal=0;
  [...logs].reverse().forEach(l=>{run+=l.pts;if(run>maxBal)maxBal=run;});
  return{
    taskCount: logs.filter(l=>["good","bad"].includes(l.type)).length,
    goodCount: logs.filter(l=>l.type==="good").length,
    gachaCount: logs.filter(l=>l.type==="gacha").length,
    rewardCount: logs.filter(l=>l.type==="reward").length,
    investBuy: logs.filter(l=>l.type==="invest_buy").length,
    investSell: logs.filter(l=>l.type==="invest_sell").length,
    interestCount: logs.filter(l=>l.type==="interest").length,
    tipsRead: logs.filter(l=>l.type==="tips").length,
    goalsDone: (data.goals||[]).filter(g=>g.cid===child.id&&g.done).length,
    maxStreak: (data.streak||{})[child.id]?.max||0,
    curStreak: (data.streak||{})[child.id]?.cur||0,
    maxBal,
    totalLogs: logs.length,
    balance: bal(data.logs, child.id),
    perfectDays: Object.values((data.dailyProgress||{})[child.id]||{}).filter(day=>{
      const tasks=(data.dailyTaskSets||[]).find(s=>s.id===data.activeSetId)?.tasks||data.dailyTasks||[];
      return tasks.length>0&&tasks.every(t=>t.type==="check"?!!day[t.id]:(day[t.id]||0)>=(t.target||1));
    }).length,
  };
}

const ALL_BADGES = [
  // 達成系
  {id:"b01",emoji:"🌱",name:"はじめての一歩",desc:"初めてお手伝いをした",type:"achieve",check:s=>s.goodCount>=1},
  {id:"b02",emoji:"🌿",name:"お手伝いビギナー",desc:"お手伝いを10回した",type:"achieve",check:s=>s.goodCount>=10},
  {id:"b03",emoji:"🌳",name:"お手伝いマスター",desc:"お手伝いを50回した",type:"achieve",check:s=>s.goodCount>=50},
  {id:"b04",emoji:"🏆",name:"お手伝いレジェンド",desc:"お手伝いを100回した",type:"achieve",check:s=>s.goodCount>=100},
  {id:"b05",emoji:"💰",name:"初めての100pt",desc:"残高100ptを達成した",type:"achieve",check:s=>s.maxBal>=100},
  {id:"b06",emoji:"💎",name:"1000ptクラブ",desc:"残高1000ptを達成した",type:"achieve",check:s=>s.maxBal>=1000},
  {id:"b07",emoji:"👑",name:"5000ptキング",desc:"残高5000ptを達成した",type:"achieve",check:s=>s.maxBal>=5000},
  {id:"b08",emoji:"🎯",name:"目標達成者",desc:"目標貯金を達成した",type:"achieve",check:s=>s.goalsDone>=1},
  {id:"b09",emoji:"🎊",name:"目標達成マスター",desc:"目標貯金を3回達成した",type:"achieve",check:s=>s.goalsDone>=3},
  // 行動系
  {id:"b10",emoji:"🌱",name:"タネ デビュー",desc:"初めて まいにちのタネを ひらいた",type:"action",check:s=>s.gachaCount>=1},
  {id:"b11",emoji:"🎲",name:"ガチャはかせ",desc:"ガチャを30回引いて確率を体験した",type:"action",check:s=>s.gachaCount>=30},
  {id:"b12",emoji:"🛍",name:"こうかんデビュー",desc:"初めてこうかんした",type:"action",check:s=>s.rewardCount>=1},
  {id:"b13",emoji:"🛒",name:"こうかん上手",desc:"こうかんを10回した",type:"action",check:s=>s.rewardCount>=10},
  {id:"b14",emoji:"📈",name:"投資デビュー",desc:"初めて株を買った",type:"action",check:s=>s.investBuy>=1},
  {id:"b15",emoji:"📊",name:"投資家",desc:"株を売買5回した",type:"action",check:s=>s.investBuy+s.investSell>=5},
  {id:"b16",emoji:"💹",name:"投資マスター",desc:"株を売買20回した",type:"action",check:s=>s.investBuy+s.investSell>=20},
  {id:"b17",emoji:"💸",name:"利子ゲット",desc:"初めて利子をもらった",type:"action",check:s=>s.interestCount>=1},
  // ストリーク系
  {id:"b18",emoji:"🔥",name:"3日連続",desc:"3日連続でガチャを引いた",type:"streak",check:s=>s.maxStreak>=3},
  {id:"b19",emoji:"⚡",name:"週間チャンピオン",desc:"7日連続でガチャを引いた",type:"streak",check:s=>s.maxStreak>=7},
  {id:"b20",emoji:"🌟",name:"毎日パーフェクト",desc:"毎日タスクを全達成した日がある",type:"streak",check:s=>s.perfectDays>=1},
  // 追加バッジ（達成系）
  {id:"b21",emoji:"💫",name:"お手伝い30回",desc:"お手伝いを30回した",type:"achieve",check:s=>s.goodCount>=30},
  {id:"b22",emoji:"🌈",name:"2000ptクラブ",desc:"残高2000ptを達成した",type:"achieve",check:s=>s.maxBal>=2000},
  {id:"b23",emoji:"🏅",name:"3000ptクラブ",desc:"残高3000ptを達成した",type:"achieve",check:s=>s.maxBal>=3000},
  {id:"b24",emoji:"💰",name:"こうかん5回",desc:"こうかんを5回した",type:"action",check:s=>s.rewardCount>=5},
  {id:"b25",emoji:"🎯",name:"目標達成2回",desc:"目標貯金を2回達成した",type:"achieve",check:s=>s.goalsDone>=2},
  {id:"b26",emoji:"📅",name:"14日連続",desc:"14日連続でガチャを引いた",type:"streak",check:s=>s.maxStreak>=14},
  {id:"b27",emoji:"🗓",name:"30日連続",desc:"30日連続でガチャを引いた",type:"streak",check:s=>s.maxStreak>=30},
  {id:"b28",emoji:"🎪",name:"ガチャ10回",desc:"ガチャを10回引いた",type:"action",check:s=>s.gachaCount>=10},
  {id:"b29",emoji:"🎡",name:"ガチャ50回",desc:"ガチャを50回引いた",type:"action",check:s=>s.gachaCount>=50},
  {id:"b30",emoji:"📚",name:"まめちしき5回",desc:"まめちしきを5回読んだ",type:"action",check:s=>s.tipsRead>=5},
  {id:"b31",emoji:"📖",name:"まめちしき10回",desc:"まめちしきを10回読んだ",type:"action",check:s=>s.tipsRead>=10},
  {id:"b32",emoji:"🧠",name:"まめちしきマスター",desc:"まめちしきを20回読んだ",type:"action",check:s=>s.tipsRead>=20},
  {id:"b33",emoji:"🚀",name:"投資10回",desc:"株を売買10回した",type:"action",check:s=>s.investBuy+s.investSell>=10},
  {id:"b34",emoji:"🌙",name:"夜の投資家",desc:"株を売買30回した",type:"action",check:s=>s.investBuy+s.investSell>=30},
  {id:"b35",emoji:"💎",name:"お手伝い200回",desc:"お手伝いを200回した",type:"achieve",check:s=>s.goodCount>=200},
  {id:"b36",emoji:"👑",name:"10000ptキング",desc:"残高10000ptを達成した",type:"achieve",check:s=>s.maxBal>=10000},
  {id:"b37",emoji:"🌺",name:"パーフェクト5回",desc:"毎日タスクを5日全達成した",type:"streak",check:s=>s.perfectDays>=5},
  {id:"b38",emoji:"🏆",name:"パーフェクト10回",desc:"毎日タスクを10日全達成した",type:"streak",check:s=>s.perfectDays>=10},
  {id:"b39",emoji:"⭐",name:"利子10回",desc:"利子を10回もらった",type:"action",check:s=>s.interestCount>=10},
  {id:"b40",emoji:"🌠",name:"全部やる人",desc:"お手伝い・投資・こうかんを全部経験した",type:"achieve",check:s=>s.goodCount>=1&&s.investBuy>=1&&s.rewardCount>=1},
];

function BadgesSection({child,data,update}){
  const [filter,setFilter]=useState("all");
  const stats=calcBadgeStats(child,data);
  const badges=ALL_BADGES.map(b=>({...b,earned:b.check(stats)}));
  const earned=badges.filter(b=>b.earned);
  const filtered=filter==="all"?badges:filter==="locked"?badges.filter(b=>!b.earned):badges.filter(b=>b.type===filter);

  // バッジ獲得ポイント（1バッジ=5pt）をまだもらっていないバッジ分だけ付与
  const BADGE_PT = 5;
  const claimedBadges = (data.claimedBadges||{})[child.id]||[];
  const newlyEarned = earned.filter(b=>!claimedBadges.includes(b.id));
  React.useEffect(()=>{
    if(newlyEarned.length===0||!update) return;
    const pts = newlyEarned.length * BADGE_PT;
    const newIds = newlyEarned.map(b=>b.id);
    const entry = {id:uid(),cid:child.id,type:"badge",label:`🏅 バッジ獲得ボーナス（${newlyEarned.map(b=>b.emoji).join("")}）`,pts,date:new Date().toISOString()};
    update(d=>({
      ...d,
      logs:[entry,...d.logs],
      claimedBadges:{...(d.claimedBadges||{}),[child.id]:[...(d.claimedBadges?.[child.id]||[]),...newIds]}
    }));
    addLogToFirestore(entry);
  },[earned.length]);
  return(<div style={{padding:"12px 16px"}}>
    <div style={{background:`linear-gradient(135deg,${Y}20,${G}15)`,border:`1.5px solid ${Y}`,borderRadius:18,padding:"14px 18px",marginBottom:14,display:"flex",alignItems:"center",gap:14}}>
      <div style={{fontSize:40}}>🎖</div>
      <div><div style={{fontWeight:900,fontSize:22,color:TEXT}}>{earned.length}<span style={{fontSize:14,color:MUTED,fontWeight:700}}>/{badges.length}</span></div><div style={{color:MUTED,fontSize:12}}>バッジを獲得中！</div></div>
      <div style={{flex:1}}><div style={{height:10,background:BORDER,borderRadius:5,overflow:"hidden"}}><div style={{height:"100%",width:`${earned.length/badges.length*100}%`,background:`linear-gradient(90deg,${Y},${G})`,borderRadius:5}}/></div><div style={{color:MUTED,fontSize:11,marginTop:4,textAlign:"right"}}>{Math.round(earned.length/badges.length*100)}%達成</div></div>
    </div>
    <div style={{marginBottom:12}}><SortBar options={[["all","すべて"],["achieve","達成系"],["action","行動系"],["locked","未獲得"]]} value={filter} onChange={setFilter}/></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      {filtered.map(b=>(
        <div key={b.id} style={{background:b.earned?CARD:BG,border:`2px solid ${b.earned?(b.type==="achieve"?Y:G):BORDER}`,borderRadius:16,padding:"14px 12px",textAlign:"center",opacity:b.earned?1:0.5,position:"relative"}}>
          {b.earned&&<div style={{position:"absolute",top:-6,right:-6,width:18,height:18,borderRadius:"50%",background:G,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",fontWeight:900}}>✓</div>}
          <img src={`/assets/badge_${b.id}.png`} alt={b.name} style={{width:52,height:52,objectFit:"contain",display:"block",margin:"0 auto 6px",borderRadius:8,filter:b.earned?"none":"grayscale(1) opacity(0.35)"}}/>
          <div style={{fontWeight:800,fontSize:12,color:b.earned?TEXT:MUTED,marginBottom:4,lineHeight:1.3}}>{b.name}</div>
          <div style={{fontSize:11,color:MUTED,lineHeight:1.4}}>{b.desc}</div>
        </div>
      ))}
    </div>
  </div>);
}

// ── Tips ──────────────────────────────────────────────
// ===== 年齢別の読みやすさ：ふりがな自動付与＋読み上げ（低学年= young 時のみ適用）=====
// 48本の本文データは1文字も書き換えず、表示時に <ruby> でルビを振る。
// 誤読を避けるため「複合語・読みが安定した語」を中心にマップ化。取りこぼしは読み上げ(🔊)で補う。
const RUBY_MAP={
  "お金":"おかね","銀行":"ぎんこう","利息":"りそく","利子":"りし","複利":"ふくり","単利":"たんり","金利上昇":"きんりじょうしょう","金利":"きんり","利率":"りりつ","利回":"りまわ",
  "物価":"ぶっか","値段":"ねだん","価値":"かち","価格":"かかく","為替":"かわせ","円安":"えんやす","円高":"えんだか","輸入品":"ゆにゅうひん","輸入":"ゆにゅう","輸出":"ゆしゅつ",
  "消費税":"しょうひぜい","所得税":"しょとくぜい","住民税":"じゅうみんぜい","税金":"ぜいきん","非課税":"ひかぜい","課税":"かぜい","貯金":"ちょきん","節約":"せつやく","口座":"こうざ","預金":"よきん",
  "投資信託":"とうししんたく","投資家":"とうしか","投資":"とうし","分散投資":"ぶんさんとうし","分散":"ぶんさん","株価":"かぶか","配当金":"はいとうきん","配当":"はいとう","銘柄":"めいがら","元本":"がんぽん",
  "資産":"しさん","金額":"きんがく","現金":"げんきん","借金":"しゃっきん","数千円":"すうせんえん","出費":"しゅっぴ","家計簿":"かけいぼ","固定費":"こていひ","変動費":"へんどうひ","家賃":"やちん",
  "保険":"ほけん","詐欺":"さぎ","解約":"かいやく","手数料":"てすうりょう","積立":"つみたて","制度":"せいど","確率":"かくりつ","平均法":"へいきんほう","平均":"へいきん","法則":"ほうそく","暴落":"ぼうらく","起業":"きぎょう",
  "経済不安":"けいざいふあん","経済":"けいざい","不景気":"ふけいき","景気":"けいき","業績悪化":"ぎょうせきあっか","業績":"ぎょうせき","上昇":"じょうしょう","戦争":"せんそう","原因":"げんいん","需要":"じゅよう","供給":"きょうきゅう","不安":"ふあん",
  "世界":"せかい","日本":"にほん","同様":"どうよう","関係":"かんけい","企業統治":"きぎょうとうち","企業":"きぎょう","環境":"かんきょう","社会":"しゃかい","配慮":"はいりょ","地球":"ちきゅう","応援":"おうえん","発展":"はってん","時代":"じだい","未来":"みらい","人口":"じんこう","土地":"とち","目安":"めやす","合計":"ごうけい","元気":"げんき",
  "海外旅行":"かいがいりょこう","旅行":"りょこう","言葉":"ことば","仕組":"しく","仕事":"しごと","会社":"かいしゃ","社長":"しゃちょう","商品":"しょうひん","商売":"しょうばい","事業":"じぎょう","労働":"ろうどう","給料":"きゅうりょう","経験":"けいけん","業界":"ぎょうかい","規模":"きぼ","副業":"ふくぎょう","利益":"りえき","約束":"やくそく","発行":"はっこう","方法":"ほうほう","種類":"しゅるい",
  "学校":"がっこう","道路":"どうろ","病院":"びょういん","病気":"びょうき","事故":"じこ","成長":"せいちょう","目標":"もくひょう","目的":"もくてき","途中":"とちゅう","具体的":"ぐたいてき","効果的":"こうかてき","無駄遣":"むだづか","記録":"きろく","練習":"れんしゅう","責任感":"せきにんかん","計画性":"けいかくせい","計画的":"けいかくてき","達成感":"たっせいかん","基礎":"きそ","基本":"きほん","対価":"たいか","勉強":"べんきょう","知識":"ちしき","人的資本":"じんてきしほん","可能性":"かのうせい",
  "大切":"たいせつ","大事":"だいじ","一部":"いちぶ","全部":"ぜんぶ","全体的":"ぜんたいてき","自分":"じぶん","将来":"しょうらい","安全":"あんぜん","安心":"あんしん","注意":"ちゅうい","必要":"ひつよう","本当":"ほんとう","魔法":"まほう","強力":"きょうりょく","運用":"うんよう","予測":"よそく","傾向":"けいこう","理由":"りゆう","長期投資":"ちょうきとうし","長期":"ちょうき","短期":"たんき","有名":"ゆうめい","格言":"かくげん","複数":"ふくすう","意味":"いみ","危険":"きけん","許容度":"きょようど",
  "一番":"いちばん","一発":"いっぱつ","一度":"いちど","家族":"かぞく","競争":"きょうそう","昨日":"きのう","体験":"たいけん","初心者":"しょしんしゃ","王道":"おうどう","視点":"してん","名前":"なまえ","順番":"じゅんばん","絶対":"ぜったい","特別":"とくべつ","相談":"そうだん","大人":"おとな","失敗":"しっぱい","挑戦":"ちょうせん","何度":"なんど","自然":"しぜん","仲間":"なかま","上手":"じょうず","時間":"じかん","味方":"みかた","年数":"ねんすう","計算":"けいさん","早見":"はやみ","見直":"みなお","全然":"ぜんぜん","反面":"はんめん","便利":"べんり","中学":"ちゅうがく","達人":"たつじん","貝殻":"かいがら","後払":"あとばら","先払":"さきばら","翌月":"よくげつ","世":"よ",
  "使":"つか","買":"か","売":"う","持":"も","働":"はたら","考":"かんが","学":"まな","育":"そだ","続":"つづ","集":"あつ","稼":"かせ","貯":"た","払":"はら","預":"あず","増":"ふ","減":"へ","助":"たす","守":"まも","届":"とど",
  "株":"かぶ","貸":"か","別":"べつ","量":"りょう","同":"おな","良":"よ","必":"かなら","種":"たね","倍":"ばい","昔":"むかし","券":"けん","石":"いし","紙":"かみ","裏":"うら","客":"きゃく","店":"みせ","役":"やく","急":"きゅう","広":"ひろ"
};
const _RUBY_KEYS=Object.keys(RUBY_MAP).sort((a,b)=>b.length-a.length);
// 文字列→React要素配列（young時のみ呼ぶ）。マップのキーを最長一致でルビ化、その他は素通し。
function furi(text){
  if(text==null) return text;
  const s=String(text);
  const out=[]; let i=0, buf="", k=0;
  const flush=()=>{ if(buf){ out.push(buf); buf=""; } };
  while(i<s.length){
    let hit=null;
    for(const key of _RUBY_KEYS){ if(s.startsWith(key,i)){ hit=key; break; } }
    if(hit){ flush(); out.push(<ruby key={"r"+(k++)}>{hit}<rt style={{fontSize:"0.62em",fontWeight:400,letterSpacing:0}}>{RUBY_MAP[hit]}</rt></ruby>); i+=hit.length; }
    else { buf+=s[i]; i++; }
  }
  flush();
  return out;
}
// 🔊 読み上げ（非識字の低学年に最も効く・ブラウザTTSが漢字を正しく読む）
function taneSpeak(text){
  try{
    if(typeof window==="undefined"||!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(String(text).replace(/\s+/g," "));
    u.lang="ja-JP"; u.rate=0.92; u.pitch=1.05;
    window.speechSynthesis.speak(u);
  }catch(e){}
}
const ALL_TIPS=[
  {id:"t01",cat:"お金のきほん",emoji:"💴",title:"お金ってなに？",body:"お金は「ものやサービスと交換できる券」だよ。昔は貝殻や石が使われていたんだ！",q:"むかし、お金のかわりに 使われていたものは？",o:["貝殻や石","プラスチック","紙のシール"],a:0},
  {id:"t02",cat:"お金のきほん",emoji:"🏦",title:"銀行の仕組み",body:"銀行にお金を預けると、銀行はそのお金を別の人に貸して利息をとる。その一部をあなたに「利子」として払ってくれるよ。",q:"銀行に お金を あずけると もらえるのは？",o:["罰金","利子(りし)","税金"],a:1},
  {id:"t03",cat:"お金のきほん",emoji:"💳",title:"クレジットカードの仕組み",body:"クレジットカードは「後払い」の仕組み。使った分は翌月に口座から引き落とされるよ。使いすぎに注意！",q:"クレジットカードは どんな しくみ？",o:["先払い","後払い","ただ"],a:1},
  {id:"t04",cat:"お金のきほん",emoji:"📊",title:"物価ってなに？",body:"物の値段のことを「物価」という。お金が世の中に増えすぎると物価が上がる「インフレ」が起きるよ。",q:"物の値段が 全体的に 上がることを なんという？",o:["デフレ","インフレ","セール"],a:1},
  {id:"t05",cat:"お金のきほん",emoji:"🌐",title:"為替ってなに？",body:"1ドル=150円のように、国によってお金の価値が違う。この交換レートを「為替」という。円安になると輸入品が高くなるよ。",q:"円安に なると 輸入品の ねだんは？",o:["高くなる","安くなる","変わらない"],a:0},
  {id:"t06",cat:"お金のきほん",emoji:"🧾",title:"税金の種類",body:"消費税・所得税・住民税など税金は種類がたくさん。集まった税金は学校・道路・病院などに使われるよ。",q:"集めた税金は 何に 使われる？",o:["一部の人の おこづかい","学校や道路など みんなのため","会社の もうけ"],a:1},
  {id:"t07",cat:"お金のきほん",emoji:"💰",title:"お金を稼ぐ3つの方法",body:"①労働（働く）②投資（お金を増やす）③事業（商売をする）。この3つを組み合わせると豊かになりやすいよ！",q:"お金を かせぐ 方法に ふくまれないのは？",o:["働く","投資する","ねがいごとする"],a:2},
  {id:"t08",cat:"貯金・節約",emoji:"🐷",title:"貯金のコツ",body:"もらったら先に貯金する「先取り貯金」が効果的。使った残りを貯めようとすると、つい使い切ってしまうよ。",q:"貯金が じょうずに できる コツは？",o:["先に 貯金する","余ったら 貯金","ぜんぶ 使う"],a:0},
  {id:"t09",cat:"貯金・節約",emoji:"📝",title:"家計簿をつけよう",body:"何にいくら使ったか記録するだけで、無駄遣いに気づける。1週間試すだけで節約できる金額がわかるよ！",q:"家計簿を つけると 何が いいの？",o:["お金が 勝手に 増える","むだづかいに 気づける","税金が 0になる"],a:1},
  {id:"t10",cat:"貯金・節約",emoji:"🎯",title:"目標を決めると貯まりやすい",body:"「3000ptでゲームを買う」など具体的な目標があると、貯金が続きやすい。目的のない貯金は途中でやめがちだよ。",q:"貯金が つづきやすいのは どんな とき？",o:["目標を 決めたとき","なんとなく の とき","だれにも 言わない とき"],a:0},
  {id:"t11",cat:"貯金・節約",emoji:"⚖",title:"欲しいvs必要",body:"ものを買う前に「欲しいもの？必要なもの？」と考えよう。欲しいものは後回しにすると、本当に必要かわかるよ。",q:"買う前に 考えると いいことは？",o:["欲しい？ 必要？","だれが 見てる？","何色 かな？"],a:0},
  {id:"t12",cat:"貯金・節約",emoji:"🔄",title:"複利の魔法",body:"利子にさらに利子がつく「複利」はとても強力。100ptを年5%で運用すると20年後には約265ptになるよ！",q:"利子に さらに 利子が つくことを なんという？",o:["単利","複利","金利ゼロ"],a:1},
  {id:"t13",cat:"投資",emoji:"📈",title:"株ってなに？",body:"株は会社の「一部オーナー権」。会社が成長すると株価が上がり、持っているだけで「配当金」ももらえることがあるよ。",q:"株を もつと どうなる？",o:["会社の 一部オーナーに なる","すぐ 社長に なる","タダで 商品が もらえる"],a:0},
  {id:"t14",cat:"投資",emoji:"🎲",title:"リスクとリターン",body:"大きく儲かるものほどリスクも大きい。株より預金は安全だけど増えにくい。自分のリスク許容度を知ることが大切。",q:"大きく もうかる ものは ふつう？",o:["リスクも 大きい","ぜったい 安全","必ず 儲かる"],a:0},
  {id:"t15",cat:"投資",emoji:"🧺",title:"卵は1つのカゴに盛るな",body:"投資の有名な格言。1つの銘柄だけに全部つぎ込むのは危険。複数に分けて投資することを「分散投資」というよ。",q:"「卵は1つの カゴに もるな」の 意味は？",o:["1つに 全部 入れない","卵を 大切に する","カゴを たくさん 買う"],a:0},
  {id:"t16",cat:"投資",emoji:"⏳",title:"長期投資が強い理由",body:"短期の株価は予測できないが、長期的に見ると良い会社の株は成長する傾向がある。焦らずじっくり持つのが基本。",q:"投資の 基本的な 持ち方は？",o:["すぐ 売る","じっくり 長く 持つ","毎日 売り買い する"],a:1},
  {id:"t17",cat:"投資",emoji:"🤔",title:"なぜ企業は株を発行するの？",body:"会社は成長するためのお金が必要。株を売ってお金を集める代わりに、投資家に利益を分けることを約束するよ。",q:"会社が 株を 売る 理由は？",o:["成長の お金を 集めるため","あそぶ ため","税金の ため"],a:0},
  {id:"t18",cat:"投資",emoji:"📉",title:"株が下がるのはなぜ？",body:"業績悪化・経済不安・金利上昇・戦争などが原因。みんなが「将来不安だ」と思うと株を売るので価格が下がるよ。",q:"みんなが 将来 不安だと 思うと 株は？",o:["上がる","下がる","変わらない"],a:1},
  {id:"t19",cat:"社会・経済",emoji:"🌍",title:"世界の経済はつながっている",body:"アメリカで不景気が起きると日本の株も下がる。世界の経済はインターネット同様つながっているんだよ。",q:"アメリカの 不景気は 日本の株に？",o:["関係 ない","えいきょう する","良く する"],a:1},
  {id:"t20",cat:"社会・経済",emoji:"🏭",title:"モノの値段が決まる仕組み",body:"「需要（欲しい人）」と「供給（売りたい量）」のバランスで価格が決まる。欲しい人が多いほど高くなるよ。",q:"ものの ねだんは 何で 決まる？",o:["需要と 供給","じゃんけん","お店の 気分"],a:0},
  {id:"t21",cat:"社会・経済",emoji:"🤖",title:"AIと仕事の未来",body:"AIの発展で一部の仕事はなくなる。でも新しい仕事も生まれる。大切なのは「考える力」と「学び続ける力」だよ。",q:"AI時代に 大切なのは？",o:["考える力・学び続ける力","何も しない こと","暗記 だけ"],a:0},
  {id:"t22",cat:"社会・経済",emoji:"♻",title:"ESG投資ってなに？",body:"環境(E)・社会(S)・企業統治(G)に配慮した企業に投資すること。地球にいい企業を応援しながら増やせるよ。",q:"ESG投資が 大切に するのは？",o:["環境や 社会","スピード だけ","見た目 だけ"],a:0},
  {id:"t23",cat:"社会・経済",emoji:"📱",title:"デジタルマネーの時代",body:"PayPayやクレカで現金を使わない人が増えている。便利な反面、使いすぎに気づきにくいので注意が必要だよ。",q:"キャッシュレスの 注意点は？",o:["使いすぎに 気づきにくい","重くて 持てない","すぐ さびる"],a:0},
  {id:"t24",cat:"働くこと",emoji:"💼",title:"給料ってどう決まる？",body:"スキル・経験・業界・会社の規模などで変わる。同じ仕事でも会社によって全然違うことも。副業も増えているよ。",q:"給料は 同じ仕事でも？",o:["会社で ちがう","ぜんぶ 同じ","くじで 決まる"],a:0},
  {id:"t25",cat:"働くこと",emoji:"🌱",title:"お手伝いは社会の練習",body:"お手伝いは実はすごく大事。責任感・計画性・達成感を学べる。これが将来の仕事への基礎になるよ！",q:"お手伝いで 学べる ことは？",o:["責任感や 計画性","運の よさ だけ","なにも ない"],a:0},
  {id:"t26",cat:"働くこと",emoji:"🤝",title:"価値を作るとお金になる",body:"人が「欲しい・助かる」と思うものを作ったり、サービスを提供したりすることで対価（お金）がもらえるよ。",q:"お金が もらえるのは どんな とき？",o:["人の 役に 立つものを 作る","ただ ねがう","じっと まつ"],a:0},
  {id:"t27",cat:"働くこと",emoji:"📚",title:"勉強がお金につながる理由",body:"知識・スキルは「人的資本」。勉強に使うお金は投資と同じ。学べば学ぶほど将来稼げる可能性が上がるよ。",q:"勉強は 何に つながる？",o:["将来 かせぐ 力","むだ づかい","ただの 運"],a:0},
  {id:"t28",cat:"Tane Money",emoji:"🌱",title:"Tane Moneyのコンセプト",body:"「お金は種」。種を蒔いて育てるように、小さなお手伝いの積み重ねが大きな力になる。毎日コツコツが一番！",q:"Tane Moneyの 考えは？",o:["お金は 種、コツコツ 育てる","一発 大もうけ","運 だめし"],a:0},
  {id:"t29",cat:"Tane Money",emoji:"🏆",title:"ランキングで成長できる理由",body:"家族でランキングを競うことで「やる気」が生まれる。競争ではなく「昨日の自分より成長する」ことが大切。",q:"ランキングで 大切なのは？",o:["昨日の 自分より 成長","1位 いがいは だめ","人を ばかに する"],a:0},
  {id:"t30",cat:"Tane Money",emoji:"🎰",title:"ガチャと上手につきあう",body:"ガチャは「確率」の体験。レアが出るかはランダムで、たくさん引いても必ず当たるわけじゃない。お金は計画的に使い、貯金やコツコツの積み重ねが一番たしかな力になるよ。",q:"ガチャと 上手に つきあうには？",o:["お金は 計画的に、コツコツが 一番","全部 つぎこむ","借金して 引く"],a:0},
  {id:"t31",cat:"投資",emoji:"🪙",title:"ドルコスト平均法",body:"毎月おなじ金額で 買い続けると、高い時は少なく・安い時は多く買えて、買う値段が ならされる。タイミングを当てなくていいから、初心者にやさしい王道のやり方だよ。",q:"ドルコスト平均法の よさは？",o:["高い時に少なく、安い時に多く 買える","必ず もうかる","一度に 全部 買う"],a:0},
  {id:"t32",cat:"投資",emoji:"🏛",title:"NISAってなに？",body:"ふつう 投資のもうけには 約20%の税金がかかる。でも「NISA」という国の制度を使うと、その税金が0になるんだ。長くコツコツ 積み立てる人ほどお得な、応援の仕組みだよ。",q:"NISAを 使うと？",o:["もうけの 税金が 0になる","お金が 2倍になる","買い物が 無料"],a:0},
  {id:"t33",cat:"社会・経済",emoji:"📊",title:"インフレとデフレ",body:"物の値段が だんだん上がるのが「インフレ」、下がるのが「デフレ」。インフレだと 同じ100円で買えるものが減る＝お金の価値が下がる。だから お金を ねかせず 育てる視点も大事。",q:"インフレとは？",o:["物の値段が 上がること","お金が増える 魔法","銀行の 名前"],a:0},
  {id:"t34",cat:"貯金・節約",emoji:"🆘",title:"もしもの備え",body:"急な出費（こわれた・病気など）に備えて、すぐ使わない「もしものお金」を 少し貯めておくと安心。投資の前に、まず この安心のお金を 用意するのが順番だよ。",q:"もしもの備えは？",o:["使わないお金を 少し貯めておく","全部 使う","借りれば いい"],a:0},
  {id:"t35",cat:"お金のきほん",emoji:"🤐",title:"お金の詐欺に注意",body:"「絶対もうかる」「あなただけ特別」はウソのサイン。うまい話には 裏がある。あやしいと思ったら お金を出す前に、かならず 大人に相談しようね。",q:"『絶対もうかる』と 言われたら？",o:["あやしい！大人に 相談","すぐ お金を 出す","ひみつに する"],a:0},
  {id:"t36",cat:"投資",emoji:"🧮",title:"複利でふえる例",body:"毎年5%ずつ増えると、10年で約1.6倍、20年で約2.6倍、30年で約4.3倍に。早く始めて 長く続けるほど、時間が味方してくれる。これが複利の力だよ。",q:"複利で 一番 大事なのは？",o:["長い 時間","一発の 大勝負","運だけ"],a:0},
  // ── 純増コンテンツ 第1弾（コンテンツ枯渇対策・48話へ）──
  {id:"t37",cat:"投資",emoji:"📜",title:"72の法則",body:"「72 ÷ 年の利率」で、お金が2倍になるまでの年数がだいたい分かる。年6%なら72÷6=12年。早見できる便利な計算だよ。",q:"年6%だと お金が2倍に なるのは およそ？",o:["12年","2年","50年"],a:0},
  {id:"t38",cat:"投資",emoji:"🛟",title:"暴落はこわくない",body:"株が大きく下がる「暴落」は、長く投資する人にはむしろ安く買えるチャンス。みんなが売ってあわてる時こそ、コツコツ続ける人が強いよ。",q:"暴落のとき コツコツ投資の人は？",o:["あわてず 続ける","全部 売る","借金して 買う"],a:0},
  {id:"t39",cat:"お金のきほん",emoji:"📐",title:"金利ってなに？",body:"お金を借りたり預けたりするときの「レンタル料」が金利。借りると払う・預けるともらえる。低い金利で借り、高い利回りで増やすのが基本だよ。",q:"金利は お金の？",o:["レンタル料","重さ","色"],a:0},
  {id:"t40",cat:"貯金・節約",emoji:"🏠",title:"固定費と変動費",body:"毎月きまってかかるのが「固定費」（サブスク・家賃など）、月で変わるのが「変動費」（おやつ・遊び）。節約は まず固定費を見直すと効果が大きいよ。",q:"節約で 先に見直すと よいのは？",o:["固定費","変動費","おこづかい全部"],a:0},
  {id:"t41",cat:"社会・経済",emoji:"💱",title:"円安と円高",body:"1ドル=100円→150円になるのが「円安」、150円→100円が「円高」。円安だと輸入品が高く、海外旅行も高くつく。ニュースでよく出る言葉だよ。",q:"1ドル100円→150円は？",o:["円安","円高","金利"],a:0},
  {id:"t42",cat:"働くこと",emoji:"🚀",title:"会社をつくるってどんなこと？",body:"自分でサービスや商品を考えて売るのが「起業」。うまくいけば大きく稼げるけど、お客さんに価値を届けられるかが すべて。失敗から学ぶ力も大事だよ。",q:"起業で 一番 大切なのは？",o:["お客さんに 価値を届ける","運だけ","ねがうこと"],a:0},
  {id:"t43",cat:"投資",emoji:"🎁",title:"配当ってなに？",body:"会社がもうけの一部を、株を持つ人に分けてくれるのが「配当」。ただし会社の調子が悪いと減ったり止まったりする。「持てば必ずもらえる」わけではないよ。",q:"配当について 正しいのは？",o:["減ったり止まったり する","ぜったい もらえる","税金が 0になる"],a:0},
  {id:"t44",cat:"お金のきほん",emoji:"☂",title:"保険ってなに？",body:"みんなで少しずつお金を出し合い、だれかに「もしも」が起きた時に助ける仕組みが保険。大きな事故や病気の備え。かけすぎ・入りすぎにも注意だよ。",q:"保険は どんな しくみ？",o:["みんなで 出し合い 助け合う","必ず もうかる","税金の こと"],a:0},
  {id:"t45",cat:"貯金・節約",emoji:"🔁",title:"サブスクの見直し",body:"毎月じわじわ引かれるサブスクは、使っていないものを 1つ解約するだけで 年に数千円の節約に。「なんとなく続けている」を見つけよう。",q:"使ってない サブスクは？",o:["解約して 節約","ぜんぶ 続ける","気にしない"],a:0},
  {id:"t46",cat:"社会・経済",emoji:"🌐",title:"GDPってなに？",body:"その国で1年間に作られたモノ・サービスの合計が「GDP」。国の経済の元気さをはかるものさし。増えると景気が良い、減ると不景気の目安だよ。",q:"GDPは 何を はかる？",o:["国の経済の 元気さ","人口の 多さ","土地の 広さ"],a:0},
  {id:"t47",cat:"Tane Money",emoji:"💪",title:"失敗から学ぶ",body:"投資もお手伝いも、うまくいかない日がある。大事なのは「なぜ？」と考えて次に活かすこと。失敗は学びの種。タネマネーは何度でも挑戦できるよ。",q:"失敗したとき 大切なのは？",o:["なぜか考えて 次に活かす","あきらめる","かくす"],a:0},
  {id:"t48",cat:"投資",emoji:"🧰",title:"投資信託・ETFってなに？",body:"たくさんの会社の株を 1つにまとめた「おべんとうパック」が投資信託やETF。1本買うだけで自然に分散できる。オルカンやS&P500もこの仲間だよ。",q:"投資信託・ETFの よさは？",o:["1本で 分散できる","必ず 勝てる","税金0になる"],a:0},
];

// 🎓 金融教育プログラム: まめちしきを「順番のある8コース」に再編＝学びの地図(カリキュラム)
const CURRICULUM=[
  {id:"c1",e:"💴",t:"お金の基本",tips:["t01","t02","t03","t23","t39"]},
  {id:"c2",e:"⚖",t:"つかう・えらぶ",tips:["t11","t04","t20","t44"]},
  {id:"c3",e:"🐷",t:"ためる・もくひょう",tips:["t08","t09","t10","t12","t34","t40","t45"]},
  {id:"c4",e:"💼",t:"かせぐ・はたらく",tips:["t07","t24","t25","t26","t27"]},
  {id:"c5",e:"📈",t:"投資デビュー",tips:["t13","t17","t18","t31","t43"]},
  {id:"c6",e:"🧺",t:"リスクと分散",tips:["t14","t15","t16","t36","t48"]},
  {id:"c7",e:"🧾",t:"税金・世界のお金",tips:["t06","t05","t19","t22","t32","t33","t41"]},
  {id:"c8",e:"🛡",t:"かしこく・だまされない",tips:["t21","t30","t28","t29","t35"]},
  // 🏅 1級修了後の「次の山」＝達人への道（中学〜・やり込み向け）
  {id:"c9",e:"🏅",t:"達人への道（中学〜）",tips:["t37","t38","t42","t46","t47"],adv:true},
];
function TipsSection({ageMode,child,data,update}){
  // 低学年(young)のときだけ漢字に自動ふりがな。middle/seniorは素通し（既存挙動を壊さない）
  const young2=ageMode==="young";
  const ruby=(t)=> young2 ? furi(t) : t;
  const [cat,setCat]=useState("すべて");
  const [course,setCourse]=useState(null);   // 選択中コース(カリキュラム)
  const [reviewOn,setReviewOn]=useState(false);  // 🔁 おさらいクイズ(間隔反復)
  const [rList,setRList]=useState([]);
  const [rIdx,setRIdx]=useState(0);
  const [rPick,setRPick]=useState(null);
  const [openId,setOpenId]=useState(null);
  const readIds=(data.tipsRead||{})[child.id]||[];
  const TIP_PTS=5;
  const QUIZ_EXP=5;
  const quizDone=(data.tipsQuiz||{})[child.id]||[];   // クイズ正解済みのtip id
  const [quizPick,setQuizPick]=useState({});          // tipId -> えらんだ選択肢index(セッション中)
  // クイズに正解(初回のみ): モンスターにEXP=お金の知識→ゲームの成長を直結
  const answerQuiz=(tip,idx)=>{
    setQuizPick(p=>({...p,[tip.id]:idx}));
    if(idx===tip.a){ markLearn("quiz"); }
    if(idx===tip.a && !quizDone.includes(tip.id)){
      update(d=>({...d,
        tipsQuiz:{...(d.tipsQuiz||{}),[child.id]:[...((d.tipsQuiz?.[child.id])||[]),tip.id]},
        monsterExp:{...(d.monsterExp||{}),[child.id]:((d.monsterExp?.[child.id])||0)+QUIZ_EXP}
      }));
    }
  };
  // 🔥 学習れんぞく＋きょうのミッション（毎日もどってくる理由＝子の継続フック）
  // 日付キーはローカル暦(0時JST境界)で算出＝アプリ他機能(todayISO/isTodayLocal)と揃える。
  // ※旧実装はUTC(toISOString)で、JST 0〜9時に「きょう」判定がズレ連続日数を誤カウントしていた。
  const _dISO=(off)=>{const d=new Date();d.setDate(d.getDate()-off);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;};
  const _todayISO=_dISO(0);
  const _yISO=_dISO(1);
  const ld=(data.learnDays||{})[child.id]||{last:"",streak:0,best:0,read:false,quiz:false};
  const ldToday=ld.last===_todayISO;
  const missRead=ldToday&&ld.read, missQuiz=ldToday&&ld.quiz, missDone=missRead&&missQuiz;
  const learnStreak=ld.last===_todayISO?ld.streak:(ld.last===_yISO?ld.streak:0);
  const _d2ISO=_dISO(2);
  const markLearn=(kind)=>update(d=>{
    const k=child.id; const cur=(d.learnDays||{})[k]||{last:"",streak:0,best:0,read:false,quiz:false,freeze:""};
    let {last,streak,best,read,quiz,freeze}=cur;
    if(last!==_todayISO){
      if(last===_yISO){ streak=(streak||0)+1; }
      // 🛡 ストリーク保護: 1日の抜けは週1回まで救済(やる気が折れないように)
      else if(last===_d2ISO && (!freeze || (Date.now()-new Date(freeze).getTime())/86400000>=7)){ streak=(streak||0)+1; freeze=_todayISO; }
      else { streak=1; }
      last=_todayISO; read=false; quiz=false;
    }
    if(kind==="read")read=true; if(kind==="quiz")quiz=true;
    best=Math.max(best||0,streak||0);
    return {...d,learnDays:{...(d.learnDays||{}),[k]:{last,streak,best,read,quiz,freeze:freeze||""}}};
  });
  // 🔔 リマインダー: 起動時に「今日のミッション未達」なら通知（許可済みのみ・同意ベース）
  const reminderOn=!!((data.reminders||{})[child.id]);
  useEffect(()=>{
    try{
      if(!reminderOn) return;
      if(!("Notification"in window)||Notification.permission!=="granted") return;
      if(missDone) return;
      const k="tane_remind_"+child.id+"_"+_todayISO;
      if(localStorage.getItem(k)) return;   // 1日1回まで
      localStorage.setItem(k,"1");
      new Notification("タネマネー",{body:`${child.name}の きょうの学習ミッションが まってるよ📖 れんぞくを のばそう！`});
    }catch(e){}
  },[reminderOn,missDone]);
  const enableReminder=async()=>{
    try{
      if(!("Notification"in window)){update(d=>({...d,reminders:{...(d.reminders||{}),[child.id]:true}}));return;}
      let perm=Notification.permission;
      if(perm==="default") perm=await Notification.requestPermission();
      if(perm==="granted"){
        update(d=>({...d,reminders:{...(d.reminders||{}),[child.id]:true}}));
        try{new Notification("タネマネー",{body:"まいにちリマインダーをオンにしたよ🔔"});}catch(e){}
        // サーバープッシュ用トークンを登録（アプリを閉じていても引き戻せるように）。VAPID未設定なら自動スキップ。
        const pt=await taneGetPushToken();
        if(pt.ok) update(d=>({...d,pushTokens:{...(d.pushTokens||{}),[child.id]:{token:pt.token,role:"child",name:child.name,ts:Date.now()}}}));
      }
    }catch(e){}
  };
  const ageCats=ageMode==="young"?["お金のきほん","貯金・節約","Tane Money"]:null;
  const cats=["すべて",...Array.from(new Set(ALL_TIPS.map(t=>t.cat)))];
  // 🎓 プログラム(カリキュラム)進捗と金融リテラシー級
  const courseProg=(c)=>c.tips.filter(id=>quizDone.includes(id)).length;
  const courseDone=(c)=>c.tips.length>0 && c.tips.every(id=>quizDone.includes(id));
  const LADDER=CURRICULUM.filter(c=>!c.adv);   // 9級→1級の本道(8コース)
  const ADV=CURRICULUM.filter(c=>c.adv);        // 達人への道(1級後の次の山)
  const ladderDone=LADDER.filter(courseDone).length;
  const advDone=ADV.filter(courseDone).length;
  const completedCourses=ladderDone;            // 級ラダー＝成長レポートのベースライン基準
  const oneKyu=ladderDone>=LADDER.length;       // 1級到達
  const rank=oneKyu?(advDone>=ADV.length?"達人 🏅":"1級 修了🎓"):`${9-ladderDone}級`;
  const curCourse=course?CURRICULUM.find(c=>c.id===course):null;
  const filtered=curCourse?ALL_TIPS.filter(t=>curCourse.tips.includes(t.id)):ALL_TIPS.filter(t=>(ageCats?ageCats.includes(t.cat):true)&&(cat==="すべて"||t.cat===cat));
  // 📈 成長レポート(保護者向けROI): 入会時ベースラインを記録し Before/After を見せる
  const quizMasteredN=quizDone.filter(id=>ALL_TIPS.find(t=>t.id===id)).length;
  const baseline=(data.learnBaseline||{})[child.id];
  useEffect(()=>{ if(!((data.learnBaseline||{})[child.id])){ update(d=>(d.learnBaseline?.[child.id]?d:{...d,learnBaseline:{...(d.learnBaseline||{}),[child.id]:{date:new Date().toISOString(),courses:completedCourses,quiz:quizMasteredN}}})); } },[]);
  const baseRank=baseline?(9-(baseline.courses||0)):9;
  const ymNow=new Date().toISOString().slice(0,7);
  const choresThisMonth=(data.logs||[]).filter(l=>l.cid===child.id&&(l.type==="good"||l.type==="daily")&&(l.date||"").startsWith(ymNow)).length;
  // 🔁 おさらいクイズ(間隔反復): 正解済みでも7日以上おさらいしていない問題を再出題＝「暗記でなく定着」
  const reviewLog=(data.tipsReview||{})[child.id]||{};
  const dueTips=ALL_TIPS.filter(t=>quizDone.includes(t.id)).filter(t=>{const dd=reviewLog[t.id];if(!dd)return true;return (Date.now()-new Date(dd).getTime())/86400000>=7;});
  const startReview=()=>{const due=dueTips.slice(0,10);if(!due.length)return;setRList(due.map(t=>t.id));setRIdx(0);setRPick(null);setReviewOn(true);};
  const rTip=reviewOn?ALL_TIPS.find(t=>t.id===rList[rIdx]):null;
  const reviewAnswer=(tip,idx)=>{ if(rPick!=null)return; setRPick(idx); if(idx===tip.a){ update(d=>({...d,tipsReview:{...(d.tipsReview||{}),[child.id]:{...((d.tipsReview?.[child.id])||{}),[tip.id]:new Date().toISOString()}},monsterExp:{...(d.monsterExp||{}),[child.id]:((d.monsterExp?.[child.id])||0)+2}})); } };
  const nextReview=()=>{ if(rIdx+1>=rList.length){setReviewOn(false);} else {setRIdx(rIdx+1);setRPick(null);} };
  const totalRead=readIds.filter(id=>ALL_TIPS.find(t=>t.id===id)).length;
  const handleOpen=tipId=>{
    if(openId===tipId){setOpenId(null);return;}
    setOpenId(tipId);
    markLearn("read");
    if(!readIds.includes(tipId)){
      update(d=>({...d,tipsRead:{...(d.tipsRead||{}),[child.id]:[...(d.tipsRead?.[child.id]||[]),tipId]},logs:(()=>{const _e={id:uid(),cid:child.id,type:"tips",label:`💡 まめちしき読んだ！+${TIP_PTS}pt`,pts:TIP_PTS,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})()}));
    }
  };
  return(<div style={{padding:"12px 16px"}}>
    {/* 📅 今月のまめちしき（毎月 自動で3話 入れ替わる注目テーマ＝継続のフレッシュさ） */}
    {(()=>{const d=new Date();const mi=d.getFullYear()*12+d.getMonth();const pick=[0,1,2].map(k=>ALL_TIPS[(mi*3+k)%ALL_TIPS.length]);const ft=pick[0];const sub=pick.slice(1);return(
      <div style={{background:GOLDS,border:`1.5px solid ${GOLD}`,borderRadius:14,padding:"11px 13px",marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:3}}>
          <div style={{fontSize:10,fontWeight:900,color:"#8a6a00"}}>📅 今月のまめちしき（毎月かわる）</div>
          <div style={{fontSize:9,fontWeight:800,color:"#8a6a00",opacity:.8}}>全{ALL_TIPS.length}話</div>
        </div>
        <div style={{fontWeight:900,fontSize:14,color:TEXT,marginBottom:4}}>{ft.emoji} {ruby(ft.title)}</div>
        <div style={{fontSize:11.5,color:TEXTS,fontWeight:600,lineHeight:young2?1.9:1.6,marginBottom:6}}>{ruby(ft.body)}</div>
        <div style={{display:"flex",gap:6}}>
          {sub.map(s=>(<div key={s.id} style={{flex:1,background:"rgba(255,255,255,.55)",borderRadius:9,padding:"5px 7px"}}>
            <div style={{fontSize:9.5,fontWeight:900,color:"#8a6a00",marginBottom:1}}>つづき</div>
            <div style={{fontSize:10.5,fontWeight:800,color:TEXT,lineHeight:1.3}}>{s.emoji} {s.title}</div>
          </div>))}
        </div>
      </div>
    );})()}
    {/* 🔥 きょうの学習ミッション＋れんぞく日数（毎日もどってくる理由＝子の継続フック） */}
    <div style={{background:missDone?GS:CARD,border:`1.5px solid ${missDone?G:BORDER}`,borderRadius:16,padding:"11px 13px",marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        <span style={{fontSize:20}}>🔥</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:900,fontSize:13,color:TEXT}}>きょうの学習ミッション</div>
          <div style={{fontSize:10.5,color:learnStreak>0?GP:MUTED,fontWeight:800,marginTop:1}}>{learnStreak>0?`${learnStreak}日れんぞくで 学習中！`:"きょうから れんぞく学習を はじめよう"}</div>
        </div>
        {missDone&&<span style={{fontSize:10,fontWeight:900,color:"#fff",background:G,borderRadius:8,padding:"3px 8px"}}>コンプリート！</span>}
      </div>
      <div style={{display:"flex",gap:6}}>
        {[["📖 まめちしきを 1つよむ",missRead],["✏ クイズに 1問せいかい",missQuiz]].map(([k,ok])=>(
          <div key={k} style={{flex:1,display:"flex",alignItems:"center",gap:6,background:ok?GS:BG,border:`1px solid ${ok?G:BORDER}`,borderRadius:10,padding:"7px 9px"}}>
            <span style={{fontSize:14}}>{ok?"✅":"⬜"}</span>
            <span style={{fontSize:10.5,fontWeight:800,color:ok?GP:TEXTS,lineHeight:1.25}}>{k}</span>
          </div>
        ))}
      </div>
      {!missDone&&<div style={{fontSize:10,color:MUTED,fontWeight:700,marginTop:6}}>2つ クリアで きょうのミッション達成。あしたも つづけて れんぞくを のばそう！</div>}
      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,paddingTop:8,borderTop:`1px solid ${BORDER}`}}>
        <span style={{flex:1,fontSize:10,color:TEXTS,fontWeight:700,lineHeight:1.4}}>🛡 1日 おやすみしても、れんぞくは 週1回まで まもられるよ。</span>
        {!reminderOn?(
          <button onClick={enableReminder} style={{flexShrink:0,background:BS,border:`1.5px solid ${B}`,borderRadius:9,padding:"6px 10px",color:B,fontWeight:800,fontSize:10.5,cursor:"pointer",fontFamily:F}}>🔔 リマインダーON</button>
        ):(
          <span style={{flexShrink:0,fontSize:10,fontWeight:800,color:GP}}>🔔 通知ON</span>
        )}
      </div>
    </div>
    {/* 🎓 金融教育プログラム（学びの地図＋金融リテラシー級） */}
    <div style={{background:"linear-gradient(135deg,#2d2640,#1f2b3e)",borderRadius:18,padding:"14px 16px",marginBottom:12,color:"#fff"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
        <span style={{fontSize:26}}>🎓</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:900,fontSize:15}}>おうち金融教育プログラム</div>
          <div style={{fontSize:11,color:"rgba(255,255,255,.6)",fontWeight:700}}>コースをクリアして 級を上げよう</div>
        </div>
        <div style={{background:"#ffd966",borderRadius:12,padding:"5px 11px",textAlign:"center",flexShrink:0}}>
          <div style={{fontSize:9,fontWeight:800,color:"#7a5a00"}}>金融リテラシー</div>
          <div style={{fontSize:15,fontWeight:900,color:"#5a4300",lineHeight:1.1}}>{rank}</div>
        </div>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
        {CURRICULUM.map((c,i)=>{const prog=courseProg(c);const done=courseDone(c);const sel=course===c.id;const locked=c.adv&&!oneKyu;return(
          <button key={c.id} disabled={locked} onClick={()=>{if(locked)return;setCourse(sel?null:c.id);setOpenId(null);}}
            style={{flex:"1 1 46%",minWidth:0,textAlign:"left",opacity:locked?0.55:1,background:c.adv&&!locked?"rgba(255,217,102,.16)":sel?"rgba(255,255,255,.16)":"rgba(255,255,255,.07)",border:done?`1.5px solid #34C77B`:c.adv?"1.5px solid #ffd966":sel?"1.5px solid #ffd966":"1.5px solid rgba(255,255,255,.12)",borderRadius:12,padding:"7px 9px",cursor:locked?"default":"pointer",fontFamily:F,display:"flex",alignItems:"center",gap:7}}>
            <span style={{fontSize:18,flexShrink:0}}>{locked?"🔒":done?"✅":c.e}</span>
            <span style={{flex:1,minWidth:0}}>
              <span style={{display:"block",fontSize:11,fontWeight:800,color:"#fff",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.adv?"🏅 ":`${i+1}. `}{ruby(c.t)}</span>
              <span style={{display:"block",fontSize:9.5,fontWeight:700,color:done?"#7be0a0":"rgba(255,255,255,.5)"}}>{locked?"1級になると ひらく":done?"クリア！":`${prog}/${c.tips.length} クイズ正解`}</span>
            </span>
          </button>
        );})}
      </div>
      {course&&<button onClick={()=>setCourse(null)} style={{marginTop:10,background:"rgba(255,255,255,.12)",border:"none",borderRadius:10,padding:"6px 12px",color:"#fff",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F}}>← ぜんぶのコースに もどる</button>}
      {/* 🏅 認定証（級を1つでも取ったら発行・賞状をシェア/保存できる） */}
      {ladderDone>=1&&(
        <div style={{marginTop:10,background:"rgba(255,217,102,.14)",border:"1.5px solid #ffd966",borderRadius:12,padding:"10px 12px",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22}}>🏅</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:900,fontSize:12.5,color:"#ffe9a8"}}>{rank} 認定証</div>
            <div style={{fontSize:10,color:"rgba(255,255,255,.6)",fontWeight:700}}>がんばりの証。おうちの人とシェアしよう</div>
          </div>
          <button onClick={()=>shareCertificate({name:child.name,rank,date:`${new Date().getFullYear()}年${new Date().getMonth()+1}月${new Date().getDate()}日`,supervisor:SUPERVISOR.name?`${SUPERVISOR.title} ${SUPERVISOR.name}`.trim():""})}
            style={{flexShrink:0,background:"#ffd966",border:"none",borderRadius:10,padding:"8px 12px",color:"#5a4300",fontWeight:900,fontSize:11.5,cursor:"pointer",fontFamily:F}}>認定証を出す 📤</button>
        </div>
      )}
      {SUPERVISOR.name&&<div style={{marginTop:8,fontSize:10,color:"rgba(255,255,255,.72)",fontWeight:700,textAlign:"center"}}>🎓 {`${SUPERVISOR.title} ${SUPERVISOR.name}`.trim()} 監修</div>}
    </div>
    {/* 📈 成長レポート（保護者向け・¥980のROIを見せる Before/After） */}
    <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"12px 14px",marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
        <span style={{fontSize:16}}>📈</span>
        <span style={{fontWeight:900,fontSize:13,color:TEXT}}>成長レポート</span>
        <span style={{fontSize:10,color:MUTED,fontWeight:700}}>（保護者向け）</span>
      </div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,background:GS,borderRadius:12,padding:"10px",marginBottom:8}}>
        <div style={{textAlign:"center"}}><div style={{fontSize:9,fontWeight:800,color:TEXTS}}>入会時</div><div style={{fontSize:16,fontWeight:900,color:MUTED}}>{baseRank}級</div></div>
        <span style={{fontSize:18,color:GP}}>→</span>
        <div style={{textAlign:"center"}}><div style={{fontSize:9,fontWeight:800,color:GP}}>いま</div><div style={{fontSize:18,fontWeight:900,color:GP}}>{rank}</div></div>
        {(9-completedCourses)<baseRank&&<span style={{fontSize:11,fontWeight:900,color:"#fff",background:G,borderRadius:8,padding:"3px 8px"}}>↑{baseRank-(9-completedCourses)}級UP</span>}
      </div>
      <div style={{display:"flex",gap:6,marginBottom:8}}>
        {[["クイズ正解",`${quizMasteredN}/${ALL_TIPS.length}`],["コースクリア",`${completedCourses}/8`],["今月お手伝い",`${choresThisMonth}回`]].map(([k,v])=>(
          <div key={k} style={{flex:1,background:BG,borderRadius:10,padding:"7px 4px",textAlign:"center"}}><div style={{fontSize:13,fontWeight:900,color:TEXT}}>{v}</div><div style={{fontSize:9,color:MUTED,fontWeight:700}}>{k}</div></div>
        ))}
      </div>
      <div style={{fontSize:10.5,color:TEXTS,fontWeight:700,lineHeight:1.5}}>習得した分野：{completedCourses>0?CURRICULUM.filter(courseDone).map(c=>c.t).join("・"):"まだクリアしたコースはありません。クイズに挑戦して級を上げよう！"}</div>
    </div>
    {/* 💰 金銭感覚の育ち（保護者向け・"級"とは別軸の実生活の成果＝課金者価値の証明 R4） */}
    {(()=>{
      const myL=(data.logs||[]).filter(l=>l.cid===child.id);
      const saved=myL.reduce((s,l)=>s+(l.pts||0),0);
      const divTotal=myL.filter(l=>l.type==="interest").reduce((s,l)=>s+(l.pts||0),0);
      const buyCount=myL.filter(l=>l.type==="invest_buy").length;
      const totalChores=myL.filter(l=>l.type==="good"||l.type==="daily").length;
      const rewardCount=myL.filter(l=>l.type==="reward").length;
      return(<div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"12px 14px",marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
          <span style={{fontSize:16}}>💰</span>
          <span style={{fontWeight:900,fontSize:13,color:TEXT}}>金銭感覚の育ち</span>
          <span style={{fontSize:10,color:MUTED,fontWeight:700}}>（保護者向け）</span>
        </div>
        <div style={{fontSize:10.5,color:TEXTS,fontWeight:700,lineHeight:1.5,marginBottom:8}}>“貯める・ふやす・はたらいて得る・考えて使う”の実体験が、どれだけ積み上がっているか。</div>
        <div style={{display:"flex",gap:6,marginBottom:8}}>
          {[["いま貯まっている",`${saved.toLocaleString()}pt`,GP],["配当・利子でふえた",`${divTotal.toLocaleString()}pt`,GOLD],["投資にチャレンジ",`${buyCount}回`,B]].map(([k,v,c])=>(
            <div key={k} style={{flex:1,background:BG,borderRadius:10,padding:"7px 4px",textAlign:"center"}}><div style={{fontSize:13,fontWeight:900,color:c}}>{v}</div><div style={{fontSize:9,color:MUTED,fontWeight:700,lineHeight:1.3,marginTop:2}}>{k}</div></div>
          ))}
        </div>
        <div style={{display:"flex",gap:6}}>
          {[["はたらいて得た（お手伝い）",`${totalChores}回`],["考えて使った（こうかん）",`${rewardCount}回`]].map(([k,v])=>(
            <div key={k} style={{flex:1,background:BG,borderRadius:10,padding:"7px 6px",textAlign:"center"}}><div style={{fontSize:13,fontWeight:900,color:TEXT}}>{v}</div><div style={{fontSize:9,color:MUTED,fontWeight:700,lineHeight:1.3,marginTop:2}}>{k}</div></div>
          ))}
        </div>
        <div style={{fontSize:10,color:MUTED,fontWeight:700,lineHeight:1.5,marginTop:8}}>※ クイズの“級”は知識、こちらは実際のお金の行動。両方そろって本物の金銭感覚が育ちます。</div>
      </div>);
    })()}
    {/* 🔁 おさらいクイズ（間隔反復＝暗記でなく定着。級の本物度を担保） */}
    {(quizDone.length>0)&&(
      <div style={{background:PS,border:`1.5px solid ${P}`,borderRadius:16,padding:"12px 14px",marginBottom:12}}>
        {!reviewOn?(
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:22}}>🔁</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:900,fontSize:13,color:P}}>おさらいクイズ</div>
              <div style={{fontSize:10.5,color:TEXTS,fontWeight:700,marginTop:1}}>{dueTips.length>0?`まえに正解した ${dueTips.length}問を おさらいして「本当に身についたか」たしかめよう`:"いまは おさらい対象なし。また数日後にね！"}</div>
            </div>
            {dueTips.length>0&&<button onClick={startReview} style={{background:P,border:"none",borderRadius:10,padding:"8px 13px",color:"#fff",fontWeight:900,fontSize:12,cursor:"pointer",fontFamily:F,flexShrink:0}}>おさらい</button>}
          </div>
        ):rTip&&(
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}><span style={{fontSize:11,fontWeight:900,color:P}}>🔁 おさらい {rIdx+1}/{rList.length}</span><button onClick={()=>setReviewOn(false)} style={{background:"none",border:"none",color:MUTED,fontSize:16,cursor:"pointer"}}>✕</button></div>
            <div style={{fontWeight:800,fontSize:13,color:TEXT,marginBottom:8}}>{rTip.emoji} {ruby(rTip.q)}</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {rTip.o.map((opt,i)=>{const ans=rPick!=null;const correct=i===rTip.a;const picked=rPick===i;return(
                <button key={i} onClick={()=>reviewAnswer(rTip,i)} disabled={ans}
                  style={{textAlign:"left",background:ans?(correct?GS:picked?RS:CARD):CARD,border:`2px solid ${ans?(correct?GP:picked?R:BORDER):BORDER}`,borderRadius:10,padding:"9px 11px",fontSize:12.5,fontWeight:700,color:TEXT,cursor:ans?"default":"pointer",fontFamily:F}}>
                  {ans&&correct?"✅ ":ans&&picked?"❌ ":""}{ruby(opt)}
                </button>
              );})}
            </div>
            {rPick!=null&&<button onClick={nextReview} style={{marginTop:9,width:"100%",background:GP,border:"none",borderRadius:10,padding:"10px",color:"#fff",fontWeight:900,fontSize:13,cursor:"pointer",fontFamily:F}}>{rIdx+1>=rList.length?"おさらい おわり！":"つぎの問題 →"}</button>}
          </div>
        )}
      </div>
    )}
    <div style={{marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontSize:20}}>💡</span>
      <div style={{flex:1}}><div style={{fontWeight:800,fontSize:15,color:"#fff"}}>まめちしき</div><div style={{color:"rgba(255,255,255,0.55)",fontSize:11}}>{filtered.length}件 · タップで詳しく読む</div></div>
      <div style={{background:GS,border:`1.5px solid ${G}`,borderRadius:12,padding:"4px 10px",textAlign:"center"}}>
        <div style={{fontWeight:900,fontSize:14,color:GP}}>{totalRead}<span style={{fontSize:11,color:TEXTS}}>/{ALL_TIPS.length}</span></div>
        <div style={{fontSize:11,color:TEXTS}}>読了</div>
      </div>
      <div style={{background:PS,border:`1.5px solid ${P}`,borderRadius:12,padding:"4px 10px",textAlign:"center"}}>
        <div style={{fontWeight:900,fontSize:14,color:P}}>{quizDone.filter(id=>ALL_TIPS.find(t=>t.id===id)).length}<span style={{fontSize:11,color:TEXTS}}>/{ALL_TIPS.length}</span></div>
        <div style={{fontSize:11,color:TEXTS}}>クイズ正解</div>
      </div>
    </div>
    <div style={{background:GOLDS,border:`1.5px solid ${Y}`,borderRadius:12,padding:"8px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <span style={{fontSize:12,color:"#7a5a00",fontWeight:700}}><Ico name="books" fb="📚" size={14} style={{marginRight:4}}/>読んで獲得したpt</span>
      <span style={{fontWeight:900,fontSize:15,color:Y}}>+{(totalRead*TIP_PTS).toLocaleString()}pt</span>
    </div>
    {course
      ? <div style={{marginBottom:14,fontSize:12,fontWeight:800,color:GP}}>📘 {CURRICULUM.find(c=>c.id===course)?.t} のレッスン（{filtered.length}）</div>
      : <div style={{marginBottom:14}}><SortBar options={cats.filter(c=>ageCats?ageCats.includes(c)||c==="すべて":true).map(c=>[c,c])} value={cat} onChange={setCat}/></div>}
    {filtered.map(tip=>{
      const isOpen=openId===tip.id;
      const isRead=readIds.includes(tip.id);
      return(<button key={tip.id} onClick={()=>handleOpen(tip.id)}
        style={{width:"100%",background:isOpen?BS:isRead?GS:CARD,border:`1.5px solid ${isOpen?B:isRead?G:BORDER}`,borderRadius:16,padding:"13px 14px",marginBottom:8,textAlign:"left",cursor:"pointer",fontFamily:F,transition:"all .2s"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22,flexShrink:0}}>{tip.emoji}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:13,color:isOpen?B:TEXT}}>{ruby(tip.title)}</div>
            <div style={{display:"flex",gap:6,marginTop:3,alignItems:"center"}}>
              <span style={{background:`${B}20`,color:B,padding:"1px 6px",borderRadius:8,fontWeight:700,fontSize:11}}>{ruby(tip.cat)}</span>
              {!isRead&&<span style={{background:`${Y}20`,color:"#9a7000",padding:"1px 6px",borderRadius:8,fontWeight:700,fontSize:11}}>+{TIP_PTS}pt</span>}
              {isRead&&<span style={{color:G,fontSize:11,fontWeight:700}}>✓ 読んだ</span>}
            </div>
          </div>
          <span style={{color:MUTED,fontSize:14,flexShrink:0,transform:isOpen?"rotate(180deg)":"none",transition:"transform .2s"}}>▼</span>
        </div>
        {isOpen&&<div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${B}30`,fontSize:young2?14:13,color:TEXT,lineHeight:young2?2.15:1.8,fontWeight:500}}>
          {young2&&<div onClick={e=>{e.stopPropagation();taneSpeak(tip.title+"。"+tip.body);}} role="button" style={{display:"inline-flex",alignItems:"center",gap:5,background:BS,border:`1.5px solid ${B}`,borderRadius:RAD_PILL,padding:"5px 12px",marginBottom:8,cursor:"pointer",color:B,fontWeight:900,fontSize:12}}>🔊 よみあげ</div>}
          {ruby(tip.body)}
          {!isRead&&<div style={{marginTop:8,background:`${G}15`,border:`1px solid ${G}`,borderRadius:8,padding:"6px 10px",display:"inline-block",fontSize:12,color:G,fontWeight:700}}>🎉 +{TIP_PTS}pt ゲット！</div>}
          {/* 💡→🎮 再接続: 読んだあとのミニクイズ。正解でモンスターにEXP */}
          {tip.q&&(()=>{
            const mastered=quizDone.includes(tip.id);
            const picked=quizPick[tip.id];
            const reveal=mastered||picked!=null;
            return (
              <div onClick={e=>e.stopPropagation()} style={{marginTop:12,background:CARDS,border:`1px solid ${BORDER}`,borderRadius:12,padding:"11px 12px"}}>
                <div style={{fontSize:12.5,fontWeight:800,color:TEXT,marginBottom:9}}>🧠 クイズ：{ruby(tip.q)}</div>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {tip.o.map((opt,i)=>{
                    const isCorrect=i===tip.a, isPicked=picked===i;
                    let bg=CARD,bd=BORDER,col=TEXT;
                    if(reveal&&isCorrect){bg=GS;bd=G;col=GP;}
                    else if(reveal&&isPicked&&!isCorrect){bg=RS;bd=R;col=R;}
                    return (
                      <div key={i} role="button" onClick={e=>{e.stopPropagation(); if(!mastered) answerQuiz(tip,i);}}
                        style={{display:"flex",alignItems:"center",gap:8,background:bg,border:`1.5px solid ${bd}`,borderRadius:10,padding:"9px 11px",cursor:mastered?"default":"pointer",fontFamily:F}}>
                        <span style={{flex:1,fontSize:12.5,fontWeight:700,color:col}}>{ruby(opt)}</span>
                        {reveal&&isCorrect&&<span style={{fontSize:14}}>⭕</span>}
                        {reveal&&isPicked&&!isCorrect&&<span style={{fontSize:14}}>❌</span>}
                      </div>
                    );
                  })}
                </div>
                {mastered
                  ? <div style={{marginTop:9,fontSize:12,color:GP,fontWeight:800}}>✓ せいかい！ モンスターに +{QUIZ_EXP}EXP（かくとくずみ）</div>
                  : picked!=null
                  ? (picked===tip.a
                      ? <div style={{marginTop:9,fontSize:12,color:GP,fontWeight:800}}>✨ せいかい！ モンスターに +{QUIZ_EXP}EXP！</div>
                      : <div style={{marginTop:9,fontSize:12,color:R,fontWeight:700}}>ざんねん！ もう一度 本文を 読んで えらんでみよう</div>)
                  : <div style={{marginTop:9,fontSize:11,color:MUTED,fontWeight:600}}>正解すると モンスターに EXPが もらえるよ</div>}
              </div>
            );
          })()}
        </div>}
      </button>);
    })}
  </div>);
}

// ── TaskCustomizer ────────────────────────────────────
function TaskCustomizer({child,data,update,onClose}){
  useEffect(()=>{ const prev=document.body.style.overflow; document.body.style.overflow="hidden"; return ()=>{ document.body.style.overflow=prev; }; },[]);
  const allGood=data.goodTasks||[];
  const allBad=data.badTasks||[];
  const myIds=(data.myTaskIds||{})[child.id]||[];
  const isAll=myIds.length===0;
  const [selected,setSelected]=useState(isAll?[...allGood.map(t=>t.id),...allBad.map(t=>t.id)]:myIds);
  const [section,setSection]=useState("good");
  const toggle=id=>setSelected(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);
  const selectSection=kind=>{const ids=(kind==="good"?allGood:allBad).map(t=>t.id);setSelected(prev=>[...new Set([...prev,...ids])]);};
  const clearSection=kind=>{const ids=new Set((kind==="good"?allGood:allBad).map(t=>t.id));setSelected(prev=>prev.filter(id=>!ids.has(id)));};
  const save=()=>{const allIds=[...allGood.map(t=>t.id),...allBad.map(t=>t.id)];const val=selected.length===allIds.length?[]:selected;update(d=>({...d,myTaskIds:{...(d.myTaskIds||{}),[child.id]:val}}));onClose();};
  const goodSel=allGood.filter(t=>selected.includes(t.id)).length;
  const badSel=allBad.filter(t=>selected.includes(t.id)).length;
  const col=section==="good"?G:R;
  const currentList=section==="good"?allGood:allBad;
  return(<div style={{position:"fixed",inset:0,background:"#0009",zIndex:900,display:"flex",alignItems:"flex-end",justifyContent:"center",fontFamily:F}}>
    <div style={{background:CARD,borderRadius:"24px 24px 0 0",width:"100%",maxWidth:440,maxHeight:"90vh",display:"flex",flexDirection:"column",boxShadow:"0 -8px 40px #0004"}}>
      <div style={{padding:"18px 20px 12px",borderBottom:`1px solid ${BORDER}`}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
          <h3 style={{fontWeight:900,fontSize:17,margin:0,color:TEXT}}><Emo e={child.emoji} size={17} style={{marginRight:4}}/>マイタスクリスト</h3>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:MUTED}}>✕</button>
        </div>
        <p style={{color:MUTED,fontSize:12,margin:"0 0 12px",lineHeight:1.6}}>自分が管理したいタスクをチェックしよう。</p>
        <div style={{display:"flex",gap:0,background:BG,borderRadius:12,overflow:"hidden",marginBottom:10}}>
          {[["good",`✅ プラス（${goodSel}/${allGood.length}）`],["bad",`❌ マイナス（${badSel}/${allBad.length}）`]].map(([v,l])=>(
            <button key={v} onClick={()=>setSection(v)} style={{flex:1,padding:"9px 0",border:"none",background:section===v?(v==="good"?G:R):"transparent",color:section===v?"#fff":MUTED,fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:F}}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>selectSection(section)} style={{flex:1,padding:"6px 0",border:`1.5px solid ${col}`,borderRadius:10,background:`${col}15`,color:col,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>全選択</button>
          <button onClick={()=>clearSection(section)} style={{flex:1,padding:"6px 0",border:`1.5px solid ${BORDER}`,borderRadius:10,background:"transparent",color:MUTED,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:F}}>全解除</button>
        </div>
      </div>
      <div style={{flex:1,minHeight:0,overflowY:"auto",WebkitOverflowScrolling:"touch",overscrollBehavior:"contain",padding:"12px 20px"}}>
        {currentList.map(t=>{const on=selected.includes(t.id);return(
          <button key={t.id} onClick={()=>toggle(t.id)} style={{width:"100%",background:on?`${col}10`:BG,border:`2px solid ${on?col:BORDER}`,borderRadius:14,padding:"11px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:12,cursor:"pointer",textAlign:"left",fontFamily:F,transition:"all .15s"}}>
            <span style={{fontSize:22,flexShrink:0}}>{t.emoji}</span>
            <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14,color:on?col:TEXT}}>{t.label}</div><div style={{color:MUTED,fontSize:11,marginTop:1}}>{t.pts>0?"+":""}{t.pts}pt</div></div>
            <div style={{width:24,height:24,borderRadius:6,border:`2px solid ${on?col:BORDER}`,background:on?col:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on&&<span style={{color:"#fff",fontSize:14,fontWeight:900}}>✓</span>}</div>
          </button>
        );})}
      </div>
      <div style={{padding:"12px 20px 32px",borderTop:`1px solid ${BORDER}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <span style={{color:MUTED,fontSize:12}}>合計 {selected.length}個を選択中</span>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setSelected([...allGood.map(t=>t.id),...allBad.map(t=>t.id)])} style={{padding:"4px 10px",border:`1px solid ${G}`,borderRadius:8,background:"transparent",color:G,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>全選択</button>
            <button onClick={()=>setSelected([])} style={{padding:"4px 10px",border:`1px solid ${BORDER}`,borderRadius:8,background:"transparent",color:MUTED,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F}}>全解除</button>
          </div>
        </div>
        <button onClick={save} style={{width:"100%",background:G,border:"none",borderRadius:14,padding:"14px",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>✅ このリストで決定！</button>
      </div>
    </div>
  </div>);
}


// ── Default Fallback Tasks (タスク未選択時のデフォルト) ──
const DEFAULT_FALLBACK_TASKS = [
  {id:"df01",emoji:"📝",label:"宿題をする",pts:50,over:{}},
  {id:"df02",emoji:"🍽",label:"食器を洗う",pts:20,over:{}},
  {id:"df03",emoji:"🧹",label:"掃除機をかける",pts:30,over:{}},
  {id:"df04",emoji:"⏰",label:"決めた時間に起きる",pts:20,over:{}},
  {id:"df05",emoji:"🗑",label:"ゴミを捨てる",pts:10,over:{}},
  {id:"df06",emoji:"🧺",label:"洗濯物を畳む",pts:15,over:{}},
  {id:"df07",emoji:"🛁",label:"お風呂掃除をする",pts:20,over:{}},
  {id:"df08",emoji:"🌙",label:"決めた時間に寝る",pts:15,over:{}},
];

// ── Task Templates (初回セットアップ用) ──────────────
const TASK_TEMPLATES = {
  junior: [
    { cat:"📚 勉強", tasks:[
      {id:"tj01",emoji:"📝",label:"宿題をする",pts:50},
      {id:"tj02",emoji:"📖",label:"音読をする（10分）",pts:20},
      {id:"tj03",emoji:"✏",label:"ドリルを1ページやる",pts:30},
      {id:"tj04",emoji:"🔤",label:"漢字練習をする",pts:25},
      {id:"tj05",emoji:"🔢",label:"計算練習をする",pts:25},
    ]},
    { cat:"🏠 お手伝い", tasks:[
      {id:"tj06",emoji:"🗑",label:"ゴミを捨てる",pts:10},
      {id:"tj07",emoji:"🍽",label:"食器を洗う",pts:20},
      {id:"tj08",emoji:"🧺",label:"洗濯物を畳む",pts:15},
      {id:"tj09",emoji:"🛁",label:"お風呂掃除をする",pts:20},
      {id:"tj10",emoji:"🍳",label:"ご飯の準備を手伝う",pts:25},
      {id:"tj11",emoji:"🧹",label:"掃き掃除をする",pts:20},
    ]},
    { cat:"😴 生活習慣", tasks:[
      {id:"tj12",emoji:"⏰",label:"自分で起きる",pts:15},
      {id:"tj13",emoji:"🌙",label:"決めた時間に寝る",pts:15},
      {id:"tj14",emoji:"🪥",label:"歯磨きをする",pts:10},
      {id:"tj15",emoji:"👋",label:"あいさつをする",pts:5},
    ]},
  ],
  teen: [
    { cat:"📚 勉強", tasks:[
      {id:"tt01",emoji:"📝",label:"宿題をする",pts:50},
      {id:"tt02",emoji:"📖",label:"自主学習（30分）",pts:60},
      {id:"tt03",emoji:"📒",label:"復習・予習をする",pts:60},
      {id:"tt04",emoji:"🔤",label:"単語を10個覚える",pts:30},
      {id:"tt05",emoji:"📐",label:"苦手科目を1時間勉強",pts:100},
    ]},
    { cat:"🏠 お手伝い", tasks:[
      {id:"tt06",emoji:"🗑",label:"ゴミ出しをする",pts:15},
      {id:"tt07",emoji:"🍽",label:"食器洗いをする",pts:20},
      {id:"tt08",emoji:"🧹",label:"掃除機をかける",pts:30},
      {id:"tt09",emoji:"🧺",label:"洗濯物を畳む",pts:15},
      {id:"tt10",emoji:"🛁",label:"お風呂掃除をする",pts:20},
      {id:"tt11",emoji:"🍳",label:"料理を手伝う",pts:35},
    ]},
    { cat:"😴 生活習慣", tasks:[
      {id:"tt12",emoji:"⏰",label:"決めた時間に起きる",pts:20},
      {id:"tt13",emoji:"🌙",label:"決めた時間に寝る",pts:20},
      {id:"tt14",emoji:"📵",label:"スマホを指定時間に置く",pts:30},
      {id:"tt15",emoji:"📚",label:"読書（30分）",pts:25},
    ]},
  ],
  parent: [
    { cat:"🏠 家事（親）", tasks:[
      {id:"tp01",emoji:"🍳",label:"夕食を作る",pts:50,parentOnly:true},
      {id:"tp02",emoji:"🧹",label:"掃除機をかける",pts:30,parentOnly:true},
      {id:"tp03",emoji:"👔",label:"洗濯をする・干す",pts:30,parentOnly:true},
      {id:"tp04",emoji:"🛒",label:"買い物をする",pts:20,parentOnly:true},
      {id:"tp05",emoji:"🍽",label:"食器洗いをする",pts:20,parentOnly:true},
      {id:"tp06",emoji:"🗑",label:"ゴミ出し",pts:10,parentOnly:true},
    ]},
    { cat:"💪 自己管理（親）", tasks:[
      {id:"tp07",emoji:"🏃",label:"運動をする（30分）",pts:50,parentOnly:true},
      {id:"tp08",emoji:"⏰",label:"早起きする（6時台）",pts:30,parentOnly:true},
      {id:"tp09",emoji:"🏠",label:"残業せず定時退社",pts:100,parentOnly:true},
      {id:"tp10",emoji:"📵",label:"寝る前スマホを控える",pts:30,parentOnly:true},
    ]},
  ],
};

// ── Setup Wizard ──────────────────────────────────────
function SetupWizard({ data, update, onComplete }) {
  const [step,        setStep]       = useState(0);
  const [familyName,  setFamilyName] = useState("");
  const [childName,   setChildName]  = useState("");
  const [childEmoji,  setChildEmoji] = useState("⚡");
  const [childMode,   setChildMode]  = useState("teen");
  const [childGrade,  setChildGrade] = useState(null); // 'young'|'middle'|'senior'（小学生のとき学年から初期レベルを提案）
  const [parentJoin,  setParentJoin] = useState(false);  // true/false
  const [parentName,  setParentName] = useState("");
  const [parentEmoji, setParentEmoji]= useState("👨");
  const [tmplCat,     setTmplCat]    = useState(0);
  const [selTasks,    setSelTasks]   = useState([]);    // task objects
  const [goalEmoji,   setGoalEmoji]  = useState("🎮");
  const [goalLabel,   setGoalLabel]  = useState("");
  const [goalTarget,  setGoalTarget] = useState("");
  const [goalSkipped, setGoalSkipped]= useState(false);
  const [notifDone,   setNotifDone]  = useState(false);

  const [familyCode] = useState(()=>{
    // 暗号学的乱数で8文字（ゼロ・オー等の紛らわしい文字を除外）。旧形式(4文字)は約168万通りで総当たり可能だった
    const chars="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let c="";
    try{
      const buf=new Uint32Array(8); crypto.getRandomValues(buf);
      for(let i=0;i<8;i++) c+=chars[buf[i]%chars.length];
    }catch(e){ for(let i=0;i<8;i++) c+=chars[Math.floor(Math.random()*chars.length)]; }
    return `TANE-${c.slice(0,4)}-${c.slice(4)}`;
  });
  const [joinMode, setJoinMode] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinErr,  setJoinErr]  = useState("");
  const [joinBusy, setJoinBusy] = useState(false);

  const CHILD_EMOJIS  = ["⚡","🌸","🌟","🦁","🐯","🐬","🦊","🐼","🐉","🌈","🎸","⚽","🚀","🎮","🦄","🐶","🐱","🍕"];
  const PARENT_EMOJIS = ["👨","👩","🧑","👨💼","👩💼","🧔","👴","👵","🦸","🧙","🎅","🦹"];
  const GOAL_EMOJIS   = ["🎮","📱","🎵","🚴","✈","👟","📚","🎨","⚽","🍰","💻","🎸","🏊","🎀","🌍","🍜"];

  const tmplGroups = [
    ...TASK_TEMPLATES[childMode],
    ...(parentJoin ? TASK_TEMPLATES.parent : []),
  ];

  const toggleTask = (task) => setSelTasks(prev =>
    prev.some(t=>t.id===task.id) ? prev.filter(t=>t.id!==task.id) : [...prev, task]
  );

  const handleComplete = (skipGoal=false, parentPin="0000") => {
    const childId  = uid();
    const parentId = uid();

    const newChild = {
      id:childId, name:childName.trim()||"こども", emoji:childEmoji,
      pinh:pinHash("0000"), displayMode:childMode, role:"child",
      gradeLabel:childMode==="junior"?({young:"小学校低学年",middle:"小学校中学年",senior:"小学校高学年"}[childGrade]||"小学生"):"中学生",
      // 案2: 学年を選んでいればそれを初期レベルに。未選択なら従来マッピング。あとで親が変更可。
      ageMode:childMode==="junior"?(childGrade||"young"):"middle",
      permissions:{canChangePin:true,canViewBalance:true,canCreateGoals:true,canRedeemRewards:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"},
    };

    const newParent = parentJoin && parentName.trim() ? {
      id:parentId, name:parentName.trim(), emoji:parentEmoji,
      pinh:pinHash(parentPin), displayMode:"adult", role:"parent", gradeLabel:"",
      participationMode:"player_and_guardian",
      permissions:{investment:"trade",forex:"trade",dailyBonus:true,ranking:true},
      visibility:{balanceToFamily:"hidden",goalToFamily:"progress_only",investmentResultToFamily:"ranking_only",rankingParticipation:true,operationRankingParticipation:true,rankingMetric:"approved_activity_points"},
    } : null;

    const goodTasksFromTmpl = selTasks.length > 0
      ? selTasks.map(({parentOnly, ...rest}) => ({...rest, over:{}}))
      : DEFAULT_FALLBACK_TASKS;

    const childTaskIds = selTasks.filter(t=>!t.parentOnly).map(t=>t.id);

    const newGoal = !skipGoal && goalLabel.trim() && parseInt(goalTarget)>0
      ? {id:uid(),cid:childId,emoji:goalEmoji,label:goalLabel.trim(),target:parseInt(goalTarget),done:false}
      : null;
    const bonusLog = {id:uid(),cid:childId,type:"grant",label:"🎉 タネマネースタートボーナス！",pts:100,date:new Date().toISOString()};

    try { localStorage.setItem(FAMILY_CODE_KEY, familyCode); } catch(e){}
    _familyCode = familyCode;

    update(d=>({
      ...d,
      familyName: familyName.trim()||"わが家",
      children:[newChild],
      parents:newParent ? [newParent] : [],
      goodTasks:goodTasksFromTmpl,
      goals:newGoal?[newGoal]:[],
      myTaskIds:childTaskIds.length>0?{[childId]:childTaskIds}:{},
      tutorialSeen:{[childId]:true},
      setupComplete:true,
      parentPinH:pinHash(parentPin||"0000"),
      logs:[bonusLog],
      gachaDate:{}, streak:{},
      firstActionPending:true,
    }));
    addLogToFirestore(bonusLog);
    onComplete("create");
  };

  const btnStyle = (ok) => ({
    width:"100%",background:ok?GP:BORDER,border:"none",borderRadius:16,
    padding:"15px",color:ok?"#fff":MUTED,fontWeight:900,fontSize:16,
    cursor:ok?"pointer":"default",fontFamily:F,transition:"all .2s",
  });

  return (
    <div style={{minHeight:"100vh",background:`linear-gradient(160deg,${GS} 0%,#fff 50%,${GOLDS} 100%)`,fontFamily:F,display:"flex",flexDirection:"column",padding:"56px 24px 40px",maxWidth:480,margin:"0 auto",boxSizing:"border-box"}}>

      {/* プログレスバー (step 1〜6) ドット表示 */}
      {step>=1&&step<=6&&(
        <div style={{marginBottom:28}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            {/* ドット */}
            <div style={{display:"flex",gap:7}}>
              {[1,2,3,4,5,6].map(i=>(
                <div key={i} style={{width:i===step?20:8,height:8,borderRadius:999,background:i<=step?GP:BORDER,transition:"all .3s ease"}}/>
              ))}
            </div>
            <span style={{fontSize:11,color:MUTED,fontWeight:700}}>{step} / 6</span>
            {step>1&&<button onClick={()=>setStep(s=>s-1)} style={{background:"none",border:"none",color:GP,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:F}}>← もどる</button>}
          </div>
        </div>
      )}

      {/* Step 0: ようこそ */}
      {step===0&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center"}}>
          <div style={{fontSize:88,marginBottom:16,lineHeight:1}}>🌱</div>
          <h1 style={{fontWeight:900,fontSize:30,color:GP,margin:"0 0 14px",lineHeight:1.2,fontFamily:FB}}>Tane Money</h1>
          <p style={{color:TEXTS,fontSize:15,lineHeight:1.9,margin:"0 0 16px",maxWidth:280}}>
            家族みんなで楽しく<br/>お金のことを学ぼう！
          </p>
          {/* 競合との差別化3点（家族共有・ずっと貯まる・編集自由）を入口で明示 */}
          <div style={{textAlign:"left",margin:"0 0 16px",display:"flex",flexDirection:"column",gap:7}}>
            {[["🌱","ポイントは ずっと貯まる（月でリセットされない）"],["👨👩👧","家族みんなで共有（何人でも）"],["✏","お手伝いも 金額も 自由に編集できる"]].map(([e,t])=>(
              <div key={t} style={{display:"flex",alignItems:"center",gap:9,background:"rgba(255,255,255,0.7)",borderRadius:12,padding:"8px 13px"}}>
                <span style={{fontSize:16,flexShrink:0}}>{e}</span>
                <span style={{fontSize:12.5,fontWeight:700,color:TEXT}}>{t}</span>
              </div>
            ))}
          </div>
          <p style={{color:MUTED,fontSize:12,margin:"0 0 24px"}}>⏱ セットアップは約3分で完了</p>
          <button onClick={()=>setStep(1)} style={{...btnStyle(true),fontSize:18,padding:"17px",boxShadow:`0 8px 24px ${GP}40`,marginBottom:16}}>
            はじめる 🌟
          </button>
          {!joinMode&&(
            <button onClick={()=>setJoinMode(true)} style={{background:"none",border:"none",color:MUTED,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:F,textDecoration:"underline"}}>
              すでにファミリーコードがある →
            </button>
          )}
          {joinMode&&(
            <div style={{width:"100%",maxWidth:320,background:CARD,borderRadius:18,padding:"20px",border:`1.5px solid ${BORDER}`,textAlign:"left",marginTop:4}}>
              <p style={{fontWeight:800,fontSize:14,color:TEXT,margin:"0 0 10px",textAlign:"center"}}>🔗 ファミリーコードを入力</p>
              <input value={joinCode}
                onChange={e=>{setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9\-]/g,""));setJoinErr("");}}
                placeholder="TANE-XXXX-XXXX" maxLength={20}
                inputMode="text" autoCapitalize="characters" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="go"
                onKeyDown={e=>{ if(e.key==="Enter" && !joinBusy) e.currentTarget.blur(); }}
                disabled={joinBusy}
                style={{...{width:"100%",padding:"12px 14px",border:`1.5px solid ${joinErr?R:BORDER}`,borderRadius:10,fontSize:16,fontFamily:F,background:BG,outline:"none",textAlign:"center",letterSpacing:3,fontWeight:900,color:GP,boxSizing:"border-box"},marginBottom:8}}/>
              {joinErr&&<p style={{color:R,fontSize:11,fontWeight:700,margin:"0 0 8px"}}>{joinErr}</p>}
              <button disabled={joinBusy} onClick={async()=>{
                const code=joinCode.trim().toUpperCase();
                if(!code||code.length<4){setJoinErr("コードを入力してください");return;}
                setJoinBusy(true); setJoinErr("");
                try{
                  // Firebaseの準備を待ってから、コードの家族が実在するか確認してから参加する。
                  // ※以前は未確認のままコードを保存してリロードし、誤り/不通だと空データで固まって
                  //   ウィザードにも戻れずロックアウトしていた（＝「コード入力がうまくいかない」の主因）。
                  await new Promise(res=>whenFirebaseReady(res));
                  try{localStorage.setItem(FAMILY_CODE_KEY,code);}catch(e){}
                  _familyCode=code;
                  const r=await forcePullFromCloud();   // 実在確認＋成功時はローカルにキャッシュ（リロード後は即表示）
                  if(!r||!r.ok){
                    // 見つからない/通信失敗 → コードを元に戻してエラー表示（ロックアウトしない）
                    try{localStorage.removeItem(FAMILY_CODE_KEY);}catch(e){}
                    _familyCode=null;
                    setJoinBusy(false);
                    setJoinErr(
                      (r&&r.err==="empty") ? "このコードの家族が見つかりませんでした。入力をご確認ください。"
                      : (r&&(r.err==="no_db"||r.err==="no_code")) ? "接続の準備ができませんでした。少し待って もう一度お試しください。"
                      : "通信を確認して もう一度お試しください。"
                    );
                    return;
                  }
                  onComplete("join");   // 実在確認OK → リロードして正規のロード経路で同期開始
                }catch(e){
                  try{localStorage.removeItem(FAMILY_CODE_KEY);}catch(_e){}
                  _familyCode=null;
                  setJoinBusy(false);
                  setJoinErr("通信を確認して もう一度お試しください。");
                }
              }} style={{...btnStyle(joinCode.trim().length>=4 && !joinBusy),marginBottom:8}}>
                {joinBusy ? "確認中…" : "参加する →"}
              </button>
              <button disabled={joinBusy} onClick={()=>{setJoinMode(false);setJoinCode("");setJoinErr("");}} style={{background:"none",border:"none",color:MUTED,fontSize:12,cursor:joinBusy?"default":"pointer",fontFamily:F,width:"100%",textAlign:"center",opacity:joinBusy?0.5:1}}>
                キャンセル
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 1: ファミリー名 */}
      {step===1&&(
        <div style={{flex:1}}>
          <div style={{fontSize:48,marginBottom:14}}>🏠</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>かぞくのなまえを決めよう！</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 22px",lineHeight:1.6}}>みんなで使うグループの名前です。あとで変えることもできます</p>
          <input value={familyName} onChange={e=>setFamilyName(e.target.value)}
            placeholder="例：田中家、スマイルファミリー"
            style={{...INP,fontSize:15,marginBottom:14}}/>
          {familyName.trim()&&(
            <div style={{background:GS,border:`1.5px solid ${G}`,borderRadius:14,padding:"12px 16px",marginBottom:22}}>
              <div style={{fontSize:11,color:MUTED,marginBottom:4}}>ファミリーコード（家族の合言葉）</div>
              <div style={{fontWeight:900,fontSize:17,color:GP,letterSpacing:1.5}}>{familyCode}</div>
              <div style={{fontSize:11,color:TEXTS,marginTop:6,lineHeight:1.6}}>家族のスマホでこのコードを入力すると、同じデータを一緒に使えます。<b>スクリーンショットかメモで保存しておいてください</b>（設定画面でいつでも確認できます）</div>
            </div>
          )}
          <button onClick={()=>setStep(2)} style={btnStyle(!!familyName.trim())} disabled={!familyName.trim()}>
            つぎへ →
          </button>
        </div>
      )}

      {/* Step 2: 子どもを追加 */}
      {step===2&&(
        <div style={{flex:1}}>
          <div style={{fontSize:48,marginBottom:14}}>👦</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>子どもを追加しよう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 16px"}}>あとで何人でも追加できます</p>
          <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8}}>絵文字を選ぼう</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:16}}>
            {CHILD_EMOJIS.map(e=>(
              <button key={e} onClick={()=>setChildEmoji(e)} style={{width:42,height:42,borderRadius:11,border:`2.5px solid ${childEmoji===e?GP:BORDER}`,background:childEmoji===e?`${GP}18`:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {e}
              </button>
            ))}
            {/* 自由入力（絵文字を文字入力でも選べる・競合レビュー要望） */}
            <input value={CHILD_EMOJIS.includes(childEmoji)?"":childEmoji} onChange={e=>setChildEmoji((e.target.value||"").slice(0,4)||"⚡")}
              placeholder="✏" aria-label="絵文字を入力"
              style={{width:42,height:42,borderRadius:11,border:`2.5px dashed ${!CHILD_EMOJIS.includes(childEmoji)?GP:BORDER}`,background:!CHILD_EMOJIS.includes(childEmoji)?`${GP}18`:"#fff",fontSize:20,textAlign:"center",fontFamily:F,flexShrink:0,boxSizing:"border-box",color:TEXT}}/>
          </div>
          <input value={childName} onChange={e=>setChildName(e.target.value)}
            placeholder="名前（例：かなと）"
            style={{...INP,fontSize:15,marginBottom:12}}/>
          <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8}}>年代</div>
          <div style={{display:"flex",gap:8,marginBottom:6}}>
            {[["junior","小学生","かんたん表示"],["teen","中学生・高校生","投資・家計簿つき"]].map(([v,l,desc])=>(
              <button key={v} onClick={()=>setChildMode(v)} style={{flex:1,padding:"11px 0",border:`2px solid ${childMode===v?GP:BORDER}`,borderRadius:12,background:childMode===v?`${GP}15`:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:F,color:childMode===v?GP:MUTED,transition:"all .15s"}}>
                {l}<br/><span style={{fontSize:11,fontWeight:600,color:MUTED}}>{desc}</span>
              </button>
            ))}
          </div>
          {childMode==="junior"&&(<>
            <div style={{fontSize:12,fontWeight:700,color:MUTED,margin:"10px 0 8px"}}>学年（文字のやさしさが変わります）</div>
            <div style={{display:"flex",gap:6,marginBottom:6}}>
              {[["young","1〜2年","ふりがな"],["middle","3〜4年","かんたん"],["senior","5〜6年","ふつう"]].map(([v,l,d])=>(
                <button key={v} onClick={()=>setChildGrade(v)} style={{flex:1,padding:"9px 0",border:`2px solid ${childGrade===v?GP:BORDER}`,borderRadius:10,background:childGrade===v?`${GP}15`:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,color:childGrade===v?GP:MUTED}}>
                  {l}<br/><span style={{fontSize:10,fontWeight:600,color:MUTED}}>{d}</span>
                </button>
              ))}
            </div>
          </>)}
          <p style={{color:MUTED,fontSize:11,margin:"6px 0 22px"}}>あとから保護者設定でいつでも変更できます</p>
          <button onClick={()=>setStep(3)} style={btnStyle(!!childName.trim())} disabled={!childName.trim()}>
            つぎへ →
          </button>
        </div>
      )}

      {/* Step 3: 親参加 */}
      {step===3&&(
        <div style={{flex:1}}>
          <div style={{marginBottom:14}}><Ico name="trophy" fb="🏆" size={48}/></div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>親も参加しますか？</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 6px",lineHeight:1.6}}>
            子どもと一緒にポイントを貯めてランキングで競えます
          </p>
          <p style={{color:MUTED,fontSize:11,margin:"0 0 18px"}}>参加しなくても管理機能はすべて使えます</p>
          <div style={{display:"flex",gap:10,marginBottom:20}}>
            <button onClick={()=>{setParentJoin(false);setTmplCat(0);setStep(4);}}
              style={{flex:1,padding:"16px 0",border:`2.5px solid ${parentJoin===false?GP:BORDER}`,borderRadius:16,background:parentJoin===false?`${GP}12`:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F,color:parentJoin===false?GP:TEXT,transition:"all .15s",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
              <span style={{fontSize:28}}>👀</span>
              <span>管理のみ（見るだけ）</span>
            </button>
            <button onClick={()=>setParentJoin(true)}
              style={{flex:1,padding:"16px 0",border:`2.5px solid ${parentJoin===true?B:BORDER}`,borderRadius:16,background:parentJoin===true?`${B}12`:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F,color:parentJoin===true?B:TEXT,transition:"all .15s",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
              <span style={{fontSize:28}}>🙋</span>
              <span>一緒に参加！</span>
            </button>
          </div>
          {parentJoin===true&&(
            <div style={{background:CARD,border:`1.5px solid ${BORDER}`,borderRadius:16,padding:"16px",marginBottom:16}}>
              <div style={{fontSize:12,fontWeight:700,color:MUTED,marginBottom:8}}>絵文字を選ぼう</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:14}}>
                {PARENT_EMOJIS.map(e=>(
                  <button key={e} onClick={()=>setParentEmoji(e)} style={{width:42,height:42,borderRadius:11,border:`2.5px solid ${parentEmoji===e?B:BORDER}`,background:parentEmoji===e?`${B}18`:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {e}
                  </button>
                ))}
                {/* 自由入力（絵文字を文字入力でも選べる・競合レビュー要望） */}
                <input value={PARENT_EMOJIS.includes(parentEmoji)?"":parentEmoji} onChange={e=>setParentEmoji((e.target.value||"").slice(0,4)||"👨")}
                  placeholder="✏" aria-label="絵文字を入力"
                  style={{width:42,height:42,borderRadius:11,border:`2.5px dashed ${!PARENT_EMOJIS.includes(parentEmoji)?B:BORDER}`,background:!PARENT_EMOJIS.includes(parentEmoji)?`${B}18`:"#fff",fontSize:20,textAlign:"center",fontFamily:F,flexShrink:0,boxSizing:"border-box",color:TEXT}}/>
              </div>
              <input value={parentName} onChange={e=>setParentName(e.target.value)}
                placeholder="名前（例：お父さん、ゆうた）"
                style={{...INP,fontSize:15}}/>
            </div>
          )}
          {parentJoin===true&&(
            <button onClick={()=>{setTmplCat(0);setStep(4);}} style={btnStyle(!!parentName.trim())} disabled={!parentName.trim()}>
              つぎへ →
            </button>
          )}
        </div>
      )}

      {/* Step 4: タスクテンプレートを選ぶ */}
      {step===4&&(
        <div style={{flex:1,display:"flex",flexDirection:"column"}}>
          <div style={{fontSize:48,marginBottom:14}}>📋</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 4px"}}>タスクを選ぼう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 6px",lineHeight:1.6}}>
            ポイントを割り振りたい項目をチェック<br/>（あとで自由に編集できます）
          </p>
          <div style={{fontSize:11,color:MUTED,marginBottom:10}}>pt＝ポイント（お手伝いで貯まる単位）</div>
          <div style={{display:"flex",gap:6,marginBottom:6,overflowX:"auto",paddingBottom:2}}>
            {tmplGroups.map((g,i)=>(
              <button key={i} onClick={()=>setTmplCat(i)} style={{flexShrink:0,padding:"7px 14px",border:`2px solid ${tmplCat===i?GP:BORDER}`,borderRadius:999,background:tmplCat===i?`${GP}12`:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:F,color:tmplCat===i?GP:MUTED,whiteSpace:"nowrap",transition:"all .15s"}}>
                {g.cat}
              </button>
            ))}
          </div>
          {tmplGroups.length > 1 && (
            <div style={{fontSize:13,color:MUTED,textAlign:"right",marginBottom:6}}>← スワイプで他のカテゴリを見る</div>
          )}
          <div style={{flex:1,overflowY:"auto",maxHeight:320,marginBottom:10}}>
            {(tmplGroups[tmplCat]?.tasks||[]).map(t=>{
              const sel=selTasks.some(s=>s.id===t.id);
              const col=t.parentOnly?B:GP;
              return(
                <button key={t.id} onClick={()=>toggleTask(t)}
                  style={{width:"100%",marginBottom:8,background:sel?`${col}12`:"#fff",border:`2px solid ${sel?col:BORDER}`,borderRadius:13,padding:"11px 14px",display:"flex",alignItems:"center",gap:12,cursor:"pointer",textAlign:"left",fontFamily:F,transition:"all .15s"}}>
                  <span style={{fontSize:22,flexShrink:0}}>{t.emoji}</span>
                  <span style={{flex:1,fontWeight:700,fontSize:13,color:sel?col:TEXT}}>{t.label}</span>
                  <span style={{fontSize:12,color:col,fontWeight:800,flexShrink:0}}>+{t.pts}pt</span>
                  {sel&&<span style={{color:col,fontSize:16,fontWeight:900,flexShrink:0}}>✓</span>}
                </button>
              );
            })}
          </div>
          <div style={{fontSize:12,color:MUTED,textAlign:"center",marginBottom:10}}>
            {selTasks.length > 0 ? `${selTasks.length}個を選択中` : "スキップするとあとで追加できます"}
          </div>
          <button onClick={()=>setStep(5)} style={btnStyle(true)}>
            {selTasks.length===0?"スキップ →":`${selTasks.length}個で決定 → つぎへ`}
          </button>
        </div>
      )}

      {/* Step 5: 最初の目標 */}
      {step===5&&(
        <div style={{flex:1}}>
          <div style={{marginBottom:14}}><Ico name="target" fb="🎯" size={48}/></div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 6px"}}>はじめての目標を決めよう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 16px",lineHeight:1.6}}>何のために貯める？<br/>スキップしてあとで設定もOK！</p>
          <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:14}}>
            {GOAL_EMOJIS.map(e=>(
              <button key={e} onClick={()=>setGoalEmoji(e)} style={{width:42,height:42,borderRadius:11,border:`2.5px solid ${goalEmoji===e?GOLD:BORDER}`,background:goalEmoji===e?GOLDS:"#fff",fontSize:22,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {e}
              </button>
            ))}
          </div>
          <input value={goalLabel} onChange={e=>setGoalLabel(e.target.value)}
            placeholder="例：ゲーム、自転車、旅行" style={{...INP,fontSize:15,marginBottom:10}}/>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:22}}>
            <input value={goalTarget} onChange={e=>setGoalTarget(e.target.value)} type="number"
              placeholder="目標pt（例：500）" style={{...INP,flex:1,fontSize:15}}/>
            <span style={{fontSize:13,color:MUTED,fontWeight:700,flexShrink:0}}>pt</span>
          </div>
          <button onClick={()=>{setGoalSkipped(false);setStep(6);}} style={{...btnStyle(true),marginBottom:10,background:GP,boxShadow:`0 6px 20px ${GP}40`}}>
            次へ → PIN設定
          </button>
          <button onClick={()=>{setGoalSkipped(true);setStep(6);}} style={{width:"100%",background:"transparent",border:"none",color:MUTED,fontSize:13,cursor:"pointer",fontFamily:F,fontWeight:700,padding:"6px"}}>
            スキップしてPIN設定へ
          </button>
        </div>
      )}

      {/* Step 6: おや用PIN設定 */}
      {step===6&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center"}}>
          <div style={{fontSize:56,marginBottom:16}}>🔐</div>
          <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 8px"}}>おや用PINを設定しよう</h2>
          <p style={{color:MUTED,fontSize:13,margin:"0 0 28px",lineHeight:1.7}}>子どもに見られないよう<br/>4けたの番号を決めよう</p>
          {!notifDone&&"Notification" in window&&Notification.permission==="default"&&(
            <div style={{width:"100%",background:GS,border:`1.5px solid ${G}`,borderRadius:16,padding:"14px 16px",marginBottom:20,textAlign:"left",boxSizing:"border-box"}}>
              <div style={{fontWeight:800,fontSize:13,color:GP,marginBottom:6}}>🔔 毎日のリマインドを受け取る</div>
              <div style={{color:TEXTS,fontSize:12,lineHeight:1.7,marginBottom:10}}>
                「今日のお手伝いを忘れずに」などの通知を受け取れます
              </div>
              <button onClick={async()=>{
                await Notification.requestPermission();
                setNotifDone(true);
              }} style={{background:GP,border:"none",borderRadius:10,padding:"9px 20px",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:F}}>
                通知を許可する
              </button>
              <button onClick={()=>setNotifDone(true)} style={{background:"none",border:"none",color:MUTED,fontSize:11,cursor:"pointer",fontFamily:F,marginLeft:12}}>スキップ</button>
            </div>
          )}
          <PinInput onDone={pin=>handleComplete(goalSkipped,pin)}/>
          <button onClick={()=>handleComplete(goalSkipped,"0000")} style={{width:"100%",background:"transparent",border:"none",color:MUTED,fontSize:12,cursor:"pointer",fontFamily:F,fontWeight:700,padding:"20px 0 0"}}>
            スキップして後で設定する
          </button>
          <div style={{marginTop:24,background:GS,border:`1.5px solid ${G}`,borderRadius:16,padding:"14px 16px",textAlign:"left",width:"100%",boxSizing:"border-box"}}>
            <div style={{fontWeight:800,fontSize:13,color:GP,marginBottom:6}}>📱 ホーム画面に追加すると便利！</div>
            <div style={{color:TEXTS,fontSize:12,lineHeight:1.7}}>
              ブラウザの「共有」→「ホーム画面に追加」でアプリのようにすぐ開けます
            </div>
          </div>
          <div style={{background:BS,border:`1.5px solid ${B}40`,borderRadius:14,padding:"13px 16px",marginBottom:14,textAlign:"left"}}>
            <div style={{fontWeight:800,fontSize:13,color:B,marginBottom:6}}>☁ データは自動でクラウドに保存されます</div>
            <div style={{color:TEXTS,fontSize:12,lineHeight:1.7}}>
              端末を変えてもファミリーコードで復元できます。子どもがはじめて自分のカードをタップすると、自分で暗証番号を決めます
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tutorial ──────────────────────────────────────────
// 15秒オンボーディング：お金の基本ループ「お手伝い→ポイント→ためる」だけを3枚で伝える。
// （ガチャ・投資はアプリ内で自然に出会う。最初は核だけ教えて迷わせない）
const CHILD_TUTORIAL = [
  {
    emoji:"🌱", title:"3ステップだけ おぼえよう",
    body:"① お手伝いをする → ② ポイントがたまる → ③ ためて 好きなものと交換！ これがTaneMoneyだよ。",
    hint:"むずかしくないよ。15秒で読めるよ🌟"
  },
  {
    emoji:"🏆", title:"① お手伝いでポイント",
    body:"「活動」タブを開いて、やったお手伝いをタップ。ポイントがどんどん貯まるよ！",
    hint:"正直に記録するのが いちばん大事💪"
  },
  {
    emoji:"🐷", title:"② ためて ③ 交換しよう",
    body:"すぐ使わず コツコツ貯めるのがコツ。「お金」タブで目標を決めて、貯まったら「こうかん」でご褒美と交換！",
    hint:"目標を決めて貯めると達成感が大きいよ🎯"
  },
];

const PARENT_TUTORIAL = [
  {
    emoji:"🔐", title:"Tane Money 管理へようこそ",
    body:"ここは親専用の管理画面です。子どものポイントや毎日タスク、ルールを設定できます。",
    hint:"暗証番号：0000（初回は必ず変更してください）"
  },
  {
    emoji:"👦", title:"子どもの設定",
    body:"「こども」タブで名前・写真・暗証番号・ロックのON/OFFを設定できます。",
    hint:"ロックOFFなら暗証番号なしで子どものページに入れます"
  },
  {
    emoji:"📋", title:"毎日タスクを設定しよう",
    body:"「毎日」タブで、毎日こなすべきタスクを設定できます。全部クリアするとボーナスポイントがもらえます。",
    hint:"お手伝い項目から選ぶか、手動で自由に追加できます"
  },
  {
    emoji:"🏆", title:"タスクとご褒美の管理",
    body:"「タスク」タブでお手伝い項目を追加・編集。「特典」タブでご褒美の交換メニューを管理できます。",
    hint:"子どもごとに個別ポイントを設定することもできます"
  },
  {
    emoji:"📊", title:"ランキングで家族を盛り上げよう",
    body:"「ランキング」タブで今月の頑張りをみんなで確認！親も参加できるので家族全員で競いましょう。",
    hint:"違反記録・利子設定・ポイント付与も管理画面から行えます"
  },
];

function Tutorial({ isParent, name, emoji, onDone, onBonus }) {
  const slides = isParent ? PARENT_TUTORIAL : CHILD_TUTORIAL;
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const cur = slides[step];
  const isLast = step === slides.length - 1;

  const handleDone = () => {
    setDone(true);
    onBonus && onBonus();
    setTimeout(onDone, 1800);
  };

  if (done) return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32}}>
      <div style={{fontSize:72,marginBottom:16}}>🎉</div>
      <h2 style={{fontWeight:900,fontSize:22,color:TEXT,margin:"0 0 8px"}}>チュートリアル完了！</h2>
      <p style={{color:MUTED,fontSize:14,textAlign:"center",marginBottom:24}}>さあ、Tane Moneyを始めよう！</p>
      {!isParent && <div style={{background:`${G}20`,border:`2px solid ${G}`,borderRadius:16,padding:"12px 32px",fontWeight:900,fontSize:18,color:G}}>+100pt ゲット！🌟</div>}
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:BG,fontFamily:F,display:"flex",flexDirection:"column"}}>
      {/* Progress bar */}
      <div style={{height:4,background:BORDER}}>
        <div style={{height:"100%",width:`${(step+1)/slides.length*100}%`,background:`linear-gradient(90deg,${Y},${G})`,transition:"width .4s"}}/>
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"32px 28px"}}>
        {/* Step indicator */}
        <div style={{display:"flex",gap:8,marginBottom:32}}>
          {slides.map((_,i)=>(
            <div key={i} style={{width:i===step?24:8,height:8,borderRadius:4,background:i===step?Y:i<step?G:BORDER,transition:"all .3s"}}/>
          ))}
        </div>

        {/* Card */}
        <div style={{background:CARD,borderRadius:28,padding:"36px 28px",width:"100%",maxWidth:360,textAlign:"center",boxShadow:"0 8px 40px #0002",marginBottom:24}}>
          <div style={{fontSize:72,marginBottom:16}}>{cur.emoji}</div>
          <h2 style={{fontWeight:900,fontSize:20,color:TEXT,margin:"0 0 12px",lineHeight:1.3}}>{cur.title}</h2>
          <p style={{color:MUTED,fontSize:14,lineHeight:1.8,margin:"0 0 20px"}}>{cur.body}</p>
          <div style={{background:`${Y}15`,border:`1.5px solid ${Y}40`,borderRadius:12,padding:"10px 14px"}}>
            <p style={{margin:0,fontSize:12,color:"#9a7000",fontWeight:700,lineHeight:1.6}}>💡 {cur.hint}</p>
          </div>
        </div>

        {/* Buttons */}
        {isLast ? (
          <button onClick={handleDone}
            style={{width:"100%",maxWidth:360,background:`linear-gradient(135deg,${Y},${G})`,border:"none",borderRadius:16,padding:"16px",color:"#fff",fontWeight:900,fontSize:16,cursor:"pointer",fontFamily:F,boxShadow:`0 4px 20px ${G}50`}}>
            {isParent ? "管理画面に進む →" : "Tane Moneyを始める！🌱"}
          </button>
        ) : (
          <div style={{display:"flex",gap:12,width:"100%",maxWidth:360}}>
            {step > 0 && <button onClick={()=>setStep(s=>s-1)}
              style={{flex:1,background:CARD,border:`2px solid ${BORDER}`,borderRadius:14,padding:"14px",color:MUTED,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:F}}>
              ← もどる
            </button>}
            <button onClick={()=>setStep(s=>s+1)}
              style={{flex:2,background:Y,border:"none",borderRadius:14,padding:"14px",color:TEXT,fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F}}>
              つぎへ →
            </button>
          </div>
        )}

        <button onClick={onDone} style={{marginTop:16,background:"none",border:"none",color:MUTED,fontSize:12,cursor:"pointer",fontFamily:F}}>
          スキップ
        </button>
      </div>
    </div>
  );
}

// ── TabHint ───────────────────────────────────────────
function TabHint({ id, text, data, update, cid }) {
  const seenKey = `hint_${id}`;
  const seen = (data.tutorialSeen||{})[seenKey];
  const [visible, setVisible] = useState(!seen);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    update(d => ({...d, tutorialSeen: {...(d.tutorialSeen||{}), [seenKey]: true}}));
  };

  return (
    <div style={{margin:"8px 16px 0",background:`${B}10`,border:`1.5px solid ${B}40`,borderRadius:12,padding:"10px 14px",display:"flex",alignItems:"flex-start",gap:10}}>
      <span style={{fontSize:18,flexShrink:0}}>💡</span>
      <p style={{margin:0,fontSize:12,color:B,fontWeight:700,lineHeight:1.6,flex:1}}>{text}</p>
      <button onClick={dismiss} style={{background:"none",border:"none",color:MUTED,fontSize:16,cursor:"pointer",flexShrink:0,padding:0}}>✕</button>
    </div>
  );
}


function PinInput({onDone}) {
  const [step,setStep]=useState("new");
  const [newPin,setNewPin]=useState("");
  const [conf,setConf]=useState("");
  const [err,setErr]=useState("");
  const cur=step==="new"?newPin:conf;
  const press=k=>{
    if(cur.length>=4) return;
    const next=cur+k;
    if(step==="new"){setNewPin(next);if(next.length===4)setTimeout(()=>{setStep("confirm");setConf("");setErr("");},200);}
    else{setConf(next);if(next.length===4)setTimeout(()=>{if(next===newPin){onDone(next);}else{setErr("一致しません");setConf("");setTimeout(()=>setErr(""),1500);}},200);}
  };
  return(
    <div style={{width:"100%",maxWidth:320,textAlign:"center"}}>
      <p style={{color:MUTED,fontSize:13,marginBottom:12}}>{step==="new"?"新しい暗証番号を入力":"もう一度同じ番号を入力"}</p>
      <div style={{display:"flex",gap:12,justifyContent:"center",marginBottom:20}}>
        {[0,1,2,3].map(i=><div key={i} style={{width:16,height:16,borderRadius:"50%",background:cur.length>i?Y:"transparent",border:`2.5px solid ${err?R:Y}`}}/>)}
      </div>
      {err&&<p style={{color:R,fontWeight:700,fontSize:13,marginBottom:8}}>{err}</p>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,68px)",gap:10,justifyContent:"center"}}>
        {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
          <button key={i} onClick={()=>{if(k==="⌫"){if(step==="new")setNewPin(p=>p.slice(0,-1));else setConf(p=>p.slice(0,-1));}else if(k!=="")press(String(k));}}
            style={{width:68,height:68,borderRadius:18,background:k===""?"transparent":CARD,border:k===""?"none":`2px solid ${BORDER}`,fontSize:22,fontWeight:700,color:TEXT,cursor:k===""?"default":"pointer",fontFamily:F}}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChildAvatar({ child, size=38, style={} }) {
  if (child && child.avatar) {
    return (
      <div style={{width:size,height:size,borderRadius:"50%",overflow:"hidden",flexShrink:0,border:`2px solid ${Y}`,...style}}>
        <img src={child.avatar} style={{width:"100%",height:"100%",objectFit:"cover"}} alt={child.name}/>
      </div>
    );
  }
  return <span style={{fontSize:size*0.85,flexShrink:0,...style}}>{child&&child.emoji||"👤"}</span>;
}

// Tane Money icon
const TANE_ICON = "data:image/png;base64,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";

// Safe write rule: always write to .tmp first, then rename
// Never use open('w') directly on production files

// ── Error Boundary ────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props){super(props);this.state={hasError:false,error:null};}
  static getDerivedStateFromError(e){return{hasError:true,error:e};}
  componentDidCatch(e,info){console.error("TaneMoney Error:",e,info);}
  render(){
    if(!this.state.hasError) return this.props.children;
    return(
      <div style={{minHeight:"100vh",background:"#f8f9fa",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,fontFamily:"sans-serif"}}>
        <div style={{fontSize:48,marginBottom:16}}>⚠</div>
        <h2 style={{color:"#333",marginBottom:8,fontSize:18}}>表示エラーが発生しました</h2>
        <p style={{color:"#666",fontSize:13,textAlign:"center",marginBottom:24,lineHeight:1.6}}>
          データを読み込めませんでした。<br/>
          Claude.aiのチャット画面から開いてください。<br/>
          または下のボタンでリセットできます。
        </p>
        <button onClick={()=>{
          // 実際のデータキーは code サフィックス付き（旧実装は素キー削除でno-op＝クラッシュ画面に閉じ込められていた）。
          try{
            const code=getFamilyCode()||"default";
            [LOCAL_KEY+"_"+code, LOCAL_KEY2+"_"+code, LOCAL_KEY, LOCAL_KEY2].forEach(k=>{try{localStorage.removeItem(k);}catch(e){}});
            // 保険: 別コードで書かれた残骸も一括削除
            for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i); if(k&&(k.indexOf(LOCAL_KEY)===0||k.indexOf(LOCAL_KEY2)===0)) localStorage.removeItem(k);}
          }catch(e){}
          window.location.reload();
        }} style={{background:"#34c77b",border:"none",borderRadius:12,padding:"12px 28px",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",marginBottom:10}}>
          データをリセットして再起動
        </button>
        <button onClick={()=>window.location.reload()}
          style={{background:"transparent",border:"1px solid #ccc",borderRadius:12,padding:"10px 24px",color:"#666",fontWeight:700,fontSize:13,cursor:"pointer"}}>
          再読み込み
        </button>
        <details style={{marginTop:20,maxWidth:320,fontSize:11,color:"#999"}}>
          <summary style={{cursor:"pointer"}}>エラー詳細</summary>
          <pre style={{whiteSpace:"pre-wrap",wordBreak:"break-all",marginTop:8}}>{this.state.error?.message}</pre>
        </details>
      </div>
    );
  }
}

export default function App() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncSt,  setSyncSt]  = useState("saved"); // saving | saved | error
  const [screen,  setScreen]  = useState("home");
  const [activeChild, setActiveChild] = useState(null);
  const [showAppSettings, setShowAppSettings] = useState(false);   // トップの⚙→設定(SettingsModalが自前でPIN認証。二重PIN防止)

  // Load from cloud on mount
  // リアルタイム同期＋5秒ポーリングの開始（マウント時と、セットアップ完了直後の両方から呼ぶ）
  // ※従来はマウントeffect内に閉じていたため、セットアップ完了後に同期が永遠に始まらないバグがあった
  const pollRef = useRef(null);
  const pollKeyRef = useRef("");
  const startSync = useCallback(()=>{
    whenFirebaseReady(()=>{
      if(!getFamilyCode()) return;
      startRealtimeSync((updater)=>{
        setData(prev => typeof updater === 'function' ? updater(prev) : updater);
      });
      startLogsRealtimeSync(setData);
      // 定期的にFirestoreから最新ログを取得（onSnapshotの取りこぼし・24h超・carry整合の backstop）。
      // ※旧実装は5秒毎に全件fetch+全件reconcile+Dateソートを"変化の有無に関わらず"実行し、ログ多い家庭で
      //   周期的にカクつき・通信/Firestore読取コストが嵩んでいた。非表示タブでは止め、サーバ変化時のみreconcileする。
      if(pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async()=>{
        if(typeof document!=="undefined" && document.hidden) return;   // 非表示タブでは往復しない
        const firestoreLogs = await loadLogsFromFirestore();
        if(!firestoreLogs || firestoreLogs.length===0) return;
        // サーバ側ログに変化が無ければ（件数＋最新date が前回と同じ）重いreconcile/setDataを丸ごとスキップ
        const key = firestoreLogs.length + "|" + ((firestoreLogs[0] && firestoreLogs[0].date) || "");
        if(key === pollKeyRef.current) return;
        pollKeyRef.current = key;
        setData(prev=>{
          if(!prev) return prev;
          const had = (prev.logs||[]).length;
          const hadCarry = (prev.logs||[]).some(_isCarryLog);
          const { merged } = reconcileFullLogs(prev.logs, firestoreLogs);
          // 件数が同じ＆carryも無い＝変化なし → 再描画しない
          if(merged.length===had && !hadCarry) return prev;
          return {...prev, logs: merged};
        });
      }, 20000);
    });
  },[]);

  useEffect(()=>{
    // _familyCodeをlocalStorageから直接設定してからcloudLoadを呼ぶ
    try {
      const code = localStorage.getItem("tane_money_family_code");
      if(code) { _familyCode = code; }
    } catch(e) {}

    // ① ローカル即時表示：手元にデータがあればネットを待たずに描画（起動高速化）
    let shownLocal = false;
    let localData = null;   // 起動時のFirestore上書きから お手伝い項目を守るため保持
    try {
      const local = localLoadSync();
      if(local){ localData = local; setData(migrate(local)); setLoading(false); shownLocal = true; }
    } catch(e) {}

    // ② Firebase(遅延ロード)の準備ができ次第、Firestoreから最新を取得して上書き＋同期開始
    whenFirebaseReady(()=>{
    cloudLoad().then(async d=>{
      const migrated = migrate(d);
      // ★ 起動時もローカルのお手伝い項目(タスク定義)を保護＝Firestoreが古くても項目が消えない(ユニオン)
      if(localData){
        try{
          const lm = migrate(localData);
          const _uni=(a,b)=>{const m={};[...(a||[]),...(b||[])].forEach(t=>{if(t&&t.id!=null)m[t.id]=t;});return Object.values(m);};
          if(lm.goodTasks) migrated.goodTasks=_uni(migrated.goodTasks, lm.goodTasks);
          if(lm.badTasks)  migrated.badTasks =_uni(migrated.badTasks,  lm.badTasks);
          if(lm.myTaskIds) migrated.myTaskIds={...(migrated.myTaskIds||{}),...lm.myTaskIds};
          if(lm.dailyTaskSets&&lm.dailyTaskSets.length>(migrated.dailyTaskSets||[]).length) migrated.dailyTaskSets=lm.dailyTaskSets;
          if(lm.dailyTasks&&lm.dailyTasks.length>(migrated.dailyTasks||[]).length) migrated.dailyTasks=lm.dailyTasks;
        }catch(e){}
      }
      // Firestoreのlogsサブコレクション(全件=唯一の正)へ収束＝端末間の残高ズレを解消
      const firestoreLogs = await loadLogsFromFirestore();
      if(firestoreLogs && firestoreLogs.length > 0) {
        const { merged, localOnly } = reconcileFullLogs(migrated.logs, firestoreLogs);
        migrated.logs = merged;
        // ローカルにしか無い(未同期の)ログをFirestoreへ送り、他端末にも反映させる
        try{ localOnly.forEach(l=>{ if(l && l.id && !_isCarryLog(l)) addLogToFirestore(l); }); }catch(e){}
      }
      setData(migrated);
      if(!shownLocal) setLoading(false);
      startSync();
    }).catch(()=>{
      // Firestore失敗時：ローカル未表示のときだけINITで起動（ローカル表示済みなら維持）
      if(!shownLocal){ setData({...INIT}); setLoading(false); }
    });
    });
    // クリーンアップ：アンマウント時にポーリング・リスナー停止（Strict Mode二重マウント対策）
    return ()=>{
      if(pollRef.current){ clearInterval(pollRef.current); pollRef.current=null; }
      try{ if(_unsubscribe){_unsubscribe();_unsubscribe=null;} }catch(e){}
      try{ if(_logsUnsubscribe){_logsUnsubscribe();_logsUnsubscribe=null;} }catch(e){}
    };
  },[]);

  // 実際のFirestore保存結果を同期バッジへ反映するコールバックを登録（楽観表示をやめる）
  useEffect(()=>{ setSyncStCb(setSyncSt); return ()=>setSyncStCb(null); },[]);

  // Save to cloud whenever data changes
  useEffect(()=>{
    if (!data) return;
    setSyncSt(s=>s==="saving"?s:"saving");   // 既にsavingなら再setStateしない(余分な再描画を防ぐ)
    // 実完了は _notifySyncSt→setSyncSt("saved"/"error") が知らせる。ここで楽観的に"saved"にしない。
    cloudSave(data);
  },[data]);

  const update = useCallback((fn, opts) => setData(prev => {
    if(!prev) return prev;
    const next = fn(prev);
    // allowShrink: 意図的な一括削除(子メンバー削除など)は急減ガードを免除する。
    if(opts && opts.allowShrink) return next;
    if(!next.logs||next.logs.length<(prev.logs||[]).length-2) next.logs=prev.logs;
    if(!next.expenses||next.expenses.length<(prev.expenses||[]).length-2) next.expenses=prev.expenses;
    if(next.rewards===undefined||next.rewards===null) next.rewards=prev.rewards;   // 空配列(全削除)は許可・undefinedのみ復元
    // お手伝い項目は1回の操作で大きく減らない=急減はバグとみなしてロールバック(意図的な1件削除は許容)
    if(!next.goodTasks || next.goodTasks.length < (prev.goodTasks||[]).length-1) next.goodTasks=prev.goodTasks;
    if(!next.badTasks  || next.badTasks.length  < (prev.badTasks||[]).length-1)  next.badTasks=prev.badTasks;
    return next;
  }),[]);
  const [forcePin,setForcePin]=useState(null);

  if(forcePin){
    return(
      <div style={{minHeight:"100vh",background:BG,fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:28}}>
        <div style={{fontSize:60,marginBottom:12}}>{forcePin.emoji}</div>
        <h2 style={{fontWeight:900,fontSize:20,color:TEXT,margin:"0 0 8px",textAlign:"center"}}>はじめての暗証番号設定</h2>
        <p style={{color:MUTED,fontSize:13,textAlign:"center",maxWidth:280,lineHeight:1.7,margin:"0 0 24px"}}>
          {forcePin.name}さん初回です！<br/>自分だけの4けたの暗証番号を設定してね。
        </p>
        <PinInput onDone={newPin=>{
          update(d=>({...d,
            children:d.children.map(c=>c.id===forcePin.id?(({pin,...r})=>({...r,pinh:pinHash(newPin)}))(c):c),
            pinChanged:{...(d.pinChanged||{}),[forcePin.id]:true}
          }));
          setForcePin(null);
          setScreen(forcePin.targetScreen||"child");
        }}/>
      </div>
    );
  }
    if (loading) return (
    <div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>
      <div style={{textAlign:"center"}}>
        <div style={{animation:"sp .6s linear infinite",display:"inline-block"}}><img src={TANE_ICON} style={{width:52,height:52,objectFit:"cover",borderRadius:14}}/></div>
        <p style={{color:MUTED,fontWeight:700,marginTop:12}}>データを読み込み中…</p>
      </div>
      <style>{`@keyframes sp{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // 新規ファミリー：ファミリーコード未設定ならウィザードを表示
  if (!loading && !getFamilyCode() && !data?.setupComplete) {
    return (
      <ErrorBoundary>
        <SetupWizard data={data} update={update} onComplete={(mode)=>{
          if(mode==="join"){
            // 既存ファミリー参加：コード設定済みの状態でフルリロードし、クラウドから正しいデータを取得
            location.reload();
            return;
          }
          // 新規作成：作ったばかりのdataを上書きしないよう、リロードせずに同期だけ開始
          startSync();
          setScreen("home");
        }}/>
      </ErrorBoundary>
    );
  }

  // 復旧ハッチ：コードは設定済みなのに家族データが読めていない（子が0人＝参加失敗/不通/不正コード）。
  // 以前はここで空のホーム画面に落ちてウィザードにも戻れずロックアウトしていた。コードを消して入れ直せるようにする。
  if (!loading && getFamilyCode() && (!data || !((data.children||[]).length))) {
    return (
      <ErrorBoundary>
        <div style={{minHeight:"100vh",background:BG,fontFamily:F,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:28,textAlign:"center"}}>
          <div style={{fontSize:60,marginBottom:12}}>🔌</div>
          <h2 style={{fontWeight:900,fontSize:20,color:TEXT,margin:"0 0 8px"}}>データを読み込めませんでした</h2>
          <p style={{color:MUTED,fontSize:13,lineHeight:1.7,maxWidth:300,margin:"0 0 24px"}}>
            ファミリーコード「<b style={{color:GP}}>{getFamilyCode()}</b>」の家族が見つからないか、通信が不安定です。<br/>コードを確認して入れ直すか、もう一度読み込んでください。
          </p>
          <button onClick={()=>location.reload()} style={{width:"100%",maxWidth:300,background:GP,border:"none",borderRadius:14,padding:"14px",color:"#fff",fontWeight:900,fontSize:15,cursor:"pointer",fontFamily:F,marginBottom:10}}>
            もう一度 読み込む
          </button>
          <button onClick={()=>{ try{localStorage.removeItem(FAMILY_CODE_KEY);}catch(e){} _familyCode=null; location.reload(); }}
            style={{width:"100%",maxWidth:300,background:"transparent",border:`1.5px solid ${BORDER}`,borderRadius:14,padding:"12px",color:TEXTS,fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:F}}>
            コードを入れ直す（最初の画面へ）
          </button>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
    <>
      {/* データ消失の防止ガード（保存失敗・サイズ上限接近を上部に警告） */}
      <SaveGuardBanner/>
      {/* Sync indicator - 左下に移動して設定ボタンと重ならないようにする */}
      <div style={{position:"fixed",bottom:12,left:12,zIndex:9000,pointerEvents:"none"}}>
        <SyncBadge status={syncSt}/>
      </div>

      {screen==="home" && (
        <HomeScreen data={data} update={update}
          onChild={child=>{
            setActiveChild(child);
            // PINなし設定の場合は直接画面へ
            if((data.noPinIds||{})[child.id]){
              setScreen("child");
              return;
            }
            if(!(data.lockEnabled&&data.lockEnabled[child.id])){
              if(!(data.pinChanged&&data.pinChanged[child.id])){
                setForcePin({id:child.id,name:child.name,emoji:child.emoji,targetScreen:"child"});
              } else if(!(data.tutorialSeen||{})[child.id]) {
                setScreen("tutorial-child");
              } else {
                setScreen("child");
              }
            } else {
              setScreen("pin-child");
            }
          }}
          onParent={()=>setScreen("pin-parent")}
          onSettings={()=>setShowAppSettings(true)}
          onParentCard={parent=>{
            setActiveChild(parent);
            if((data.noPinIds||{})[parent.id]){
              setScreen("child");
              return;
            }
            setScreen("pin-child");
          }}
        />
      )}
      {screen==="tutorial-child" && activeChild && (
        <Tutorial
          isParent={false}
          name={activeChild.name}
          emoji={activeChild.emoji}
          onDone={()=>{ setScreen("child"); }}
          onBonus={()=>{
            update(d=>({
              ...d,
              tutorialSeen:{...(d.tutorialSeen||{}),[activeChild.id]:true},
              logs:(()=>{const _e={id:uid(),cid:activeChild.id,type:"grant",label:"🎉 チュートリアル完了ボーナス！",pts:100,date:new Date().toISOString()};addLogToFirestore(_e);return[_e,...d.logs];})(),
            }));
          }}
        />
      )}
      {screen==="tutorial-parent" && (
        <Tutorial
          isParent={true}
          name="おや管理"
          emoji="🔐"
          onDone={()=>{
            update(d=>({...d, tutorialSeen:{...(d.tutorialSeen||{}),"parent":true}}));
            setScreen("parent");
          }}
        />
      )}
      {screen==="pin-child" && activeChild && (
        <PinPad title={`${activeChild.name}のPIN`} emoji={activeChild.emoji} hint="4けたの暗証番号を入力してね"
          check={p=>{
            // 子どものPINまたは親のPINをチェック
            const isChild = data.children.some(c=>c.id===activeChild.id);
            const isParent = (data.parents||[]).some(p=>p.id===activeChild.id);
            if(isChild||isParent) return pinMatches(p, activeChild);
            return false;
          }}
          onOk={()=>{
            if(!(data.tutorialSeen||{})[activeChild.id]){
              setScreen("tutorial-child");
            } else {
              setScreen("child");
            }
          }}
          onBack={()=>setScreen("home")}/>
      )}
      {screen==="pin-parent" && (
        <PinPad title="おや管理画面" emoji="🔐" hint="4けたの暗証番号を入力（初期：0000）" check={p=>parentPinMatches(p, data)}
          onOk={()=>{
            if(!(data.tutorialSeen||{})["parent"]){
              setScreen("tutorial-parent");
            } else {
              setScreen("parent");
            }
          }}
          onBack={()=>setScreen("home")}
          extra={<button onClick={()=>setScreen("pin-reset")} style={{background:"none",border:"none",color:B,fontSize:13,cursor:"pointer",fontFamily:F,fontWeight:700}}>🔑 PINを忘れた場合はこちら</button>}
        />
      )}
      {screen==="child" && activeChild && (
        <ChildScreen child={data.children.find(c=>c.id===activeChild.id)||activeChild} data={data} update={update} onBack={()=>setScreen("home")} onFamily={()=>setScreen("family_public")}/>
      )}
      {screen==="parent" && activeChild && (
        <ChildScreen child={activeChild} data={data} update={update} onBack={()=>setScreen("home")} onFamily={()=>setScreen("family_guardian")}/>
      )}
      {screen==="parent" && !activeChild && (
        <ChildScreen child={(data.parents||[])[0]||{id:"p1",name:"パパ",emoji:"👨",pin:"3333",ageMode:"senior"}} data={data} update={update} onBack={()=>setScreen("home")} onFamily={()=>setScreen("family_guardian")}/>
      )}
      {/* トップの⚙から開く全体管理：App直下に描画（個別ページに入れ子にしない＝二重PIN/スクロール抜けを防ぐ） */}
      {showAppSettings && <SettingsModal data={data} update={update} onClose={()=>setShowAppSettings(false)} currentMemberId={(data.parents||[])[0]?.id||(data.children||[])[0]?.id||"parent"}/>}
      {screen==="family_public" && (
        <FamilyPublicScreen data={data} viewerRole={activeChild?.role||"child"} onBack={()=>setScreen(activeChild?.role==="parent"?"parent":"child")}/>
      )}
      {screen==="family_guardian" && (
        <FamilyGuardianScreen data={data} onBack={()=>setScreen("parent")} onPublicView={()=>setScreen("family_public")}/>
      )}
      {screen==="pin-reset" && (
        <PinResetScreen data={data} update={update} onBack={()=>setScreen("home")}/>
      )}
    </>
    </ErrorBoundary>
  );
}
